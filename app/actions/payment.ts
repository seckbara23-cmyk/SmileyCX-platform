'use server'
/**
 * Payment server action.
 *
 * Creates a pending payment record with the price fetched server-side — the
 * client never supplies the amount. Disabled during pilot (PAYMENTS_ENABLED).
 *
 * When payments are live:
 *   1. Set NEXT_PUBLIC_PAYMENTS_ENABLED=true
 *   2. Implement gateway redirect in the route handler that calls this action
 *   3. Add /api/webhooks/[provider] handlers that call complete_payment() SQL fn
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
