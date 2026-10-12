'use server'
/**
 * Payment server action — creates a payment INTENT, and nothing more.
 *
 * Creates a pending payment record with the price fetched server-side — the
 * client never supplies the amount. Disabled during pilot (PAYMENTS_ENABLED).
 *
 * ── THIS ACTION CANNOT COMPLETE A PAYMENT ──────────────────────────────────
 *
 * It writes exactly one row, with status 'pending'. It grants no access right
 * of any kind, creates no academic record, writes no audit row, and marks
 * nothing as paid. There is no code path from here to course access.
 *
 * Completion is the exclusive business of ONE privileged database function
 * installed by migration 062, which performs all four of its writes in a
 * single transaction or none of them. That function is SECURITY INVOKER with
 * EXECUTE granted to service_role alone — browser roles are refused — and it
 * is a PERSISTENCE authority, not a verification mechanism: it may only be
 * called after a trusted server-side caller has itself confirmed the payment
 * with the provider, server to server. A browser redirect, an admin button and
 * a provider notification are each, on their own, worth nothing.
 *
 * The previous version of this comment pointed at a completion function from
 * migration 003. That migration was PERMANENTLY WITHDRAWN and never applied:
 * no such function has ever existed in this database. Migration 062 is the
 * sole completion authority, and it REPLACES 003 rather than amending it.
 *
 * ── WHAT IS STILL MISSING BEFORE A PAYMENT CAN SUCCEED ─────────────────────
 *
 * No gateway client, no redirect to a gateway, and no notification handler
 * exist anywhere in this repository. Until a trusted caller is built, there is
 * no correct way to complete a payment, so there is nothing here that pretends
 * otherwise. See the PAY-2D design for the slice order; enabling
 * NEXT_PUBLIC_PAYMENTS_ENABLED is the LAST step, not the first.
 */

import { PAYMENTS_ENABLED } from '@/lib/pilot'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'
import type { PaymentMethod } from '@/types'

const log = createLogger('actions/payment')

export interface CreatePaymentResult {
  paymentId?: string
  error?:     string
}

export async function createPaymentRecord(input: {
  courseId: string
  method:   PaymentMethod
  metadata: Record<string, string>
}): Promise<CreatePaymentResult> {
  if (!PAYMENTS_ENABLED) {
    return { error: 'Payments are not available during the pilot phase.' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const parsed = UuidSchema.safeParse(input.courseId)
  if (!parsed.success) return { error: 'Invalid course.' }

  // Fetch authoritative price from the database — never trust client-provided amounts.
  const admin = createAdminClient()
  const { data: course } = await admin
    .from('courses')
    .select('id, price, currency, is_published')
    .eq('id', parsed.data)
    .single()

  if (!course?.is_published) return { error: 'Course not available.' }

  const reference = `SCX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`

  const { data: payment, error } = await admin
    .from('payments')
    .insert({
      user_id:            user.id,
      course_id:          course.id,
      amount:             course.price,   // server-side price only
      currency:           course.currency,
      method:             input.method,
      status:             'pending',
      reference,
      provider_reference: reference,
      metadata:           input.metadata,
    })
    .select('id')
    .single()

  if (error) {
    log.error({ userId: user.id, courseId: parsed.data, error: error.message }, 'Payment record creation failed')
    return { error: 'Payment initialization failed. Please try again.' }
  }

  return { paymentId: payment.id }
}
