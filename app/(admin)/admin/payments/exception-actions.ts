'use server'
/**
 * Operator decisions on payment exceptions — XP-PAYTECH-05.
 *
 * Kept apart from `actions.ts` for the same reason as `reconcile-actions.ts`.
 * Nothing here can mark a payment paid, grant access or issue a refund:
 *
 *   * `recordExceptionRefund` records a refund already confirmed OUTSIDE this
 *     system. It sends no request to anyone.
 *   * `recordExceptionAccess` records that an access grant exists. The grant is
 *     made in Admin > Accès under its own audit, and this refuses without one.
 *   * `recheckException` asks PayTech through the same procedure as the IPN. On a
 *     closed or completed payment it can only add to the record. On an in-flight
 *     one, a provider-confirmed answer may complete or close it, through 062 and
 *     063, exactly as the IPN would.
 *
 * A mistaken confirmation or refund decision can be withdrawn, with a reason,
 * until something rests on it, so it cannot block a learner's checkout for good.
 *
 * All are platform-admin only and rate-limited. Migration 064 holds the rules and
 * audits an accepted decision in the same transaction. A refusal is audited here.
 *
 * Each first asks `paymentDatabaseAuthority()`, before the rate limit and the
 * audit row: on a deployment that may not act on this database, none writes
 * anything at all.
 */

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { UuidSchema } from '@/lib/validation/schemas'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { loadPaytechPaymentById, reconcilePaytechPayment } from '@/lib/payments/paytech-reconcile'
import {
  decidePaymentException,
  recordPaymentExceptionRefund,
  type DecisionOutcome,
  type ExceptionAction,
  type ExceptionActor,
} from '@/lib/payments/payment-exceptions'

const DECISION_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 }
const RECHECK_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 }

const NoteSchema = z.string().trim().min(10).max(500)
/**
 * A real calendar day that has already happened. `2026-02-31` matches the shape and
 * is still refused, and a future date is refused rather than quietly becoming today.
 */
const isRealPastDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d && d <= new Date().toISOString().slice(0, 10)
}
const RefundSchema = z.object({
  reference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{2,119}$/),
  amount:    z.coerce.number().positive().finite(),
  currency:  z.literal('XOF'),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealPastDay),
})

/** Attested decisions rest on a check the operator says they made. */
const ATTESTED: readonly ExceptionAction[] = ['confirm_received', 'dismiss', 'acknowledge_report']

function back(notice: string): never {
  revalidatePath('/admin/payments')
  redirect(`/admin/payments?filter=exceptions&notice=${encodeURIComponent(notice)}`)
}

async function actor(admin: { id: string; email?: string | null }): Promise<ExceptionActor> {
  const h = await headers()
  return {
    id: admin.id,
    email: admin.email ?? null,
    ip: h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? null,
    userAgent: (h.get('user-agent') ?? '').slice(0, 256) || null,
  }
}

async function auditRefusal(who: ExceptionActor, exceptionId: string, action: string, note: string, reason: string) {
  await logAuditEvent({
    eventType:  'payment.exception_decision_refused',
    actorType:  'admin',
    actorId:    who.id,
    actorEmail: who.email,
    method:     'admin_panel',
    outcome:    'failure',
    reason:     note,
    ip:         who.ip,
    userAgent:  who.userAgent,
    metadata:   { exceptionId, action, refusal: reason },
  })
}

async function finish(who: ExceptionActor, exceptionId: string, action: string, note: string, result: DecisionOutcome): Promise<never> {
  if (!result.ok) {
    if (result.reason !== 'environment_refused') await auditRefusal(who, exceptionId, action, note, result.reason)
    back(`exception_refused_${result.reason}`)
  }
  if (action === 'record_refund') {
    back(result.outcome === 'already_recorded'
      ? 'exception_refund_already_recorded'
      : result.accessStillLive ? 'exception_refund_recorded_access_live' : 'exception_refund_recorded')
  }
  back(`exception_${action}_done`)
}

async function decision(formData: FormData, action: ExceptionAction): Promise<never> {
  const admin = await requirePlatformAdmin()
  if (!(await paymentDatabaseAuthority()).allowed) back('environment_refused')
  const who = await actor(admin)

  const id = UuidSchema.safeParse(formData.get('exceptionId'))
  if (!id.success) back('invalid')
  const note = NoteSchema.safeParse(formData.get('note'))
  if (!note.success) back('close_reason_required')
  if (ATTESTED.includes(action) && formData.get('attest') !== 'yes') back('close_attestation_required')

  const rl = await rateLimitDb(`payment-exception:${admin.id}`, DECISION_LIMIT)
  if (!rl.success) back('rate_limited')

  const result = await decidePaymentException({ exceptionId: id.data, action, actor: who, note: note.data })
  return finish(who, id.data, action, note.data, result)
}

/** The operator checked the PayTech dashboard and the money arrived. Grants nothing. */
export async function confirmExceptionReceipt(formData: FormData): Promise<void> {
  await decision(formData, 'confirm_received')
}

/** The operator checked: there is nothing to return. Refused once receipt is confirmed. */
export async function dismissException(formData: FormData): Promise<void> {
  await decision(formData, 'dismiss')
}

/** Withdraw this administrator's confirmation. Refused once a refund decision rests on it. */
export async function withdrawExceptionReceipt(formData: FormData): Promise<void> {
  await decision(formData, 'withdraw_receipt')
}

/** A paid report arrived after settlement, and the operator reviewed it. Changes no settled fact. */
export async function acknowledgeExceptionReport(formData: FormData): Promise<void> {
  await decision(formData, 'acknowledge_report')
}

/** The refund decision was a mistake. Refused once a refund is recorded. */
export async function withdrawExceptionRefund(formData: FormData): Promise<void> {
  await decision(formData, 'withdraw_refund')
}

/** The money must go back. Issues nothing: it records the obligation. */
export async function requireExceptionRefund(formData: FormData): Promise<void> {
  await decision(formData, 'require_refund')
}

/** Access was granted in Admin > Accès for this payment. Refused if no such access exists. */
export async function recordExceptionAccess(formData: FormData): Promise<void> {
  await decision(formData, 'record_access')
}

/** Record a full refund confirmed outside this system. It makes no request to anyone. */
export async function recordExceptionRefund(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin()
  if (!(await paymentDatabaseAuthority()).allowed) back('environment_refused')
  const who = await actor(admin)

  const id = UuidSchema.safeParse(formData.get('exceptionId'))
  if (!id.success) back('invalid')
  const note = NoteSchema.safeParse(formData.get('note'))
  if (!note.success) back('close_reason_required')
  const refund = RefundSchema.safeParse({
    reference: formData.get('externalReference'),
    amount:    formData.get('amount'),
    currency:  formData.get('currency'),
    date:      formData.get('refundedOn'),
  })
  if (!refund.success) back('exception_refund_invalid')
  if (formData.get('attest') !== 'yes') back('close_attestation_required')

  const rl = await rateLimitDb(`payment-exception:${admin.id}`, DECISION_LIMIT)
  if (!rl.success) back('rate_limited')

  // A date alone names a day: the end of it, and never later than now. Noon would
  // refuse a refund on the same day as a payment made that afternoon.
  const endOfDay = new Date(`${refund.data.date}T23:59:59Z`)
  const now = new Date()
  const when = endOfDay > now ? now : endOfDay

  const result = await recordPaymentExceptionRefund({
    exceptionId:         id.data,
    actor:               who,
    externalReference:   refund.data.reference,
    amount:              refund.data.amount,
    currency:            refund.data.currency,
    refundedAt:          when.toISOString(),
    note:                note.data,
  })
  return finish(who, id.data, 'record_refund', note.data, result)
}

/** Ask PayTech again. With no confirmed contract it sends nothing and changes nothing. */
// `recheck` also questions a completed payment, which the IPN only does on a cancellation.
export async function recheckException(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin()
  if (!(await paymentDatabaseAuthority()).allowed) back('environment_refused')
  const who = await actor(admin)

  const id = UuidSchema.safeParse(formData.get('exceptionId'))
  if (!id.success) back('invalid')

  const rl = await rateLimitDb(`payment-exception-recheck:${admin.id}`, RECHECK_LIMIT)
  if (!rl.success) back('rate_limited')

  const { data } = await createAdminClient()
    .from('payment_exceptions')
    .select('payment_id')
    .eq('id', id.data)
    .maybeSingle()
  if (!data) back('not_found')
  const row = await loadPaytechPaymentById(String(data.payment_id))
  if (!row) back('not_found')

  const result = await reconcilePaytechPayment(row, { source: 'admin', recheck: true })

  await logAuditEvent({
    eventType:     'payment.verification_requested',
    actorType:     'admin',
    actorId:       who.id,
    actorEmail:    who.email,
    subjectUserId: row.user_id,
    method:        'admin_panel',
    outcome:       result.kind === 'exception_unrecorded' ? 'failure' : 'success',
    ip:            who.ip,
    userAgent:     who.userAgent,
    metadata:      { paymentId: row.id, reference: row.reference, exceptionId: id.data, result: result.kind },
  })

  back(result.kind === 'exception_unrecorded' ? 'verify_exception_unrecorded' : 'exception_rechecked')
}
