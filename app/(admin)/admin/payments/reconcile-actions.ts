'use server'
/**
 * Operator reconciliation of PayTech payments — XP-PAYTECH-04.
 *
 * Kept apart from `actions.ts` on purpose: that file is PAY-2C-0's refusal and
 * must stay free of any database client, a property its test suite reads from
 * source. Nothing here can mark a payment PAID:
 *
 *   * `verifyPaytechPayment` asks PayTech, through the confirmed contract and
 *     the same procedure as the IPN. Only a provider-confirmed payment
 *     completes, and only through 062.
 *   * `closeUnpaidPaytechPayment` records an operator's attestation that an
 *     attempt was NOT paid, after checking the PayTech dashboard. It grants
 *     nothing — it frees the learner to open a new checkout. The provider is
 *     asked first, and the close is refused if PayTech says paid or pending.
 *
 * Both are platform-admin only, rate-limited, and audited whatever the
 * outcome. The operator's reason goes to the audit log, never to the payment.
 *
 * Both first ask `paymentDatabaseAuthority()`, BEFORE the rate limit and the
 * audit row: on a deployment that may not act on this database, neither action
 * writes anything at all.
 */

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { UuidSchema } from '@/lib/validation/schemas'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import {
  closeAfterManualReconciliation,
  loadPaytechPaymentById,
  reconcilePaytechPayment,
} from '@/lib/payments/paytech-reconcile'

const VERIFY_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 }
const CLOSE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 }

async function actorContext() {
  const h = await headers()
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown',
    userAgent: (h.get('user-agent') ?? '').slice(0, 256),
  }
}

function back(notice: string): never {
  revalidatePath('/admin/payments')
  redirect(`/admin/payments?filter=reconcile&notice=${encodeURIComponent(notice)}`)
}

export async function verifyPaytechPayment(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin()
  if (!(await paymentDatabaseAuthority()).allowed) back('environment_refused')
  const { ip, userAgent } = await actorContext()

  const parsed = UuidSchema.safeParse(formData.get('paymentId'))
  if (!parsed.success) back('invalid')
  const paymentId = parsed.data

  const rl = await rateLimitDb(`payment-verify:${admin.id}`, VERIFY_LIMIT)
  if (!rl.success) back('rate_limited')

  const row = await loadPaytechPaymentById(paymentId)
  if (!row) back('not_found')

  const result = await reconcilePaytechPayment(row, { source: 'admin' })

  await logAuditEvent({
    eventType:     'payment.verification_requested',
    actorType:     'admin',
    actorId:       admin.id,
    actorEmail:    admin.email,
    subjectUserId: row.user_id,
    method:        'admin_panel',
    outcome:       result.kind === 'completed' || result.kind === 'already_completed' ? 'success' : 'failure',
    reason:        'reason' in result ? result.reason : null,
    ip, userAgent,
    metadata:      { paymentId: row.id, reference: row.reference, result: result.kind },
  })

  back(`verify_${result.kind}`)
}

export async function closeUnpaidPaytechPayment(formData: FormData): Promise<void> {
  const admin = await requirePlatformAdmin()
  if (!(await paymentDatabaseAuthority()).allowed) back('environment_refused')
  const { ip, userAgent } = await actorContext()

  const parsed = UuidSchema.safeParse(formData.get('paymentId'))
  if (!parsed.success) back('invalid')
  const paymentId = parsed.data

  const reason = String(formData.get('reason') ?? '').trim()
  if (reason.length < 10 || reason.length > 500) back('close_reason_required')
  if (formData.get('attest') !== 'yes') back('close_attestation_required')

  const rl = await rateLimitDb(`payment-close:${admin.id}`, CLOSE_LIMIT)
  if (!rl.success) back('rate_limited')

  const row = await loadPaytechPaymentById(paymentId)
  if (!row) back('not_found')

  const outcome = await closeAfterManualReconciliation(row)
  const succeeded = outcome.kind === 'closed'

  await logAuditEvent({
    eventType:     'payment.manually_closed',
    actorType:     'admin',
    actorId:       admin.id,
    actorEmail:    admin.email,
    subjectUserId: row.user_id,
    method:        'admin_panel',
    outcome:       succeeded ? 'success' : 'failure',
    reason,
    ip, userAgent,
    metadata: {
      paymentId: row.id,
      reference: row.reference,
      previousStatus: row.status,
      outcome: outcome.kind,
      refusal: outcome.kind === 'refused' ? outcome.reason : null,
    },
  })

  if (outcome.kind === 'closed') back('close_done')
  if (outcome.kind === 'resolved_by_provider') back(`verify_${outcome.result.kind}`)
  back(`close_refused_${outcome.reason}`)
}
