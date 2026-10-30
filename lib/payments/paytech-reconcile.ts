import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { resolvePaytechConfig, type EnvLike } from '@/lib/payments/paytech-config'
import { isProductionDeployment, paytechProcessingAvailability } from '@/lib/payments/providers'
import { confirmPaymentStatus, PAYTECH_CURRENCY } from '@/lib/payments/paytech-client'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import {
  closeAttemptAfterManualReconciliation,
  completeVerifiedPayment,
  IN_FLIGHT_STATUSES,
  recordSettlementNote,
  recordTerminalFailure,
} from '@/lib/payments/payment-completion'

const log = createLogger('payments/paytech-reconcile')

/**
 * PayTech reconciliation — XP-PAYTECH-04.
 *
 * ONE decision procedure for "what happened to this PayTech payment, and what
 * do we write?", shared by every path that can ask:
 *
 *   * the IPN route        — PayTech told us something happened;
 *   * the sweep            — nobody told us, and the payment is stale;
 *   * the admin action     — an operator asked;
 *   * checkout             — the learner is trying to pay again.
 *
 * Before XP-PAYTECH-04 only the IPN could settle a payment, and it
 * acknowledged every outcome it could not resolve, so a missed or failed
 * notification left money taken and nothing granted, forever. Now any of the
 * four paths reaches the same answer, through the same checks, and all of them
 * converge on `complete_payment()` — which serialises on the payment row and
 * is idempotent, so they may run concurrently (safeguard 5).
 *
 * What this module will NOT do:
 *   * infer settlement from anything but the confirmed contract (safeguard 3);
 *   * complete a TEST-mode payment on a production deployment (safeguard 4) —
 *     and migration 063 refuses it again in a live database;
 *   * close an opened payment unless the provider reliably said it failed or
 *     was cancelled, or a human attests to a manual check (safeguard 1).
 */

/** The columns every path reads. Never `metadata`, never anything personal. */
export const PAYTECH_PAYMENT_COLUMNS =
  'id, user_id, course_id, amount, currency, reference, status, provider, provider_mode, provider_token, created_at'

export interface PaytechPaymentRow {
  readonly id: string
  readonly user_id: string | null
  readonly course_id: string | null
  readonly amount: number | string
  readonly currency: string
  readonly reference: string
  readonly status: string
  readonly provider: string | null
  readonly provider_mode: string | null
  readonly provider_token: string | null
  readonly created_at: string
}

export type ReconcileSource = 'ipn' | 'sweep' | 'admin' | 'checkout'

export type ReconcileResult =
  /** Money moved and the entitlement now exists. */
  | { kind: 'completed'; requiresReview: boolean }
  | { kind: 'already_completed' }
  /** The provider reliably said the payment did not and cannot happen. */
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  /** Already closed by someone else — failed, cancelled, expired or refunded. */
  | { kind: 'already_terminal'; status: string }
  /** The provider reliably said: not paid yet, still payable. */
  | { kind: 'pending' }
  /** Nobody can say. Fulfils nothing, closes nothing, frees nothing. */
  | { kind: 'unknown'; reason: string }
  /** `complete_payment()` refused. */
  | { kind: 'refused'; reason: string; retryable: boolean }
  /** This row cannot be reconciled automatically — a human must look. */
  | { kind: 'ineligible'; reason: string }

export async function loadPaytechPaymentById(id: string): Promise<PaytechPaymentRow | null> {
  const { data } = await createAdminClient()
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  return (data as PaytechPaymentRow | null) ?? null
}

/**
 * Decide, and record, what happened to one PayTech payment.
 *
 * Never throws for a business outcome. The caller maps the result to its own
 * channel: an HTTP status for the IPN, a count for the sweep, a notice for the
 * admin, a message for the learner.
 */
export async function reconcilePaytechPayment(
  row: PaytechPaymentRow,
  opts: { source: ReconcileSource; env?: EnvLike },
): Promise<ReconcileResult> {
  const env = opts.env ?? process.env

  // ── 1. is this a PayTech payment that could still settle? ──
  if (row.provider !== 'paytech') return { kind: 'ineligible', reason: 'not_a_paytech_payment' }
  if (row.status === 'completed') return { kind: 'already_completed' }
  if (!(IN_FLIGHT_STATUSES as readonly string[]).includes(row.status)) {
    return { kind: 'already_terminal', status: row.status }
  }
  if (!row.provider_token) return { kind: 'ineligible', reason: 'never_opened' }
  if (!row.user_id || !row.course_id) {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'payment_identity_incomplete' })
    return { kind: 'ineligible', reason: 'payment_identity_incomplete' }
  }

  // ── 2. may THIS deployment act on it? ──
  const availability = paytechProcessingAvailability(env)
  if (!availability.available) return { kind: 'unknown', reason: 'processing_unavailable' }
  if (!(await paymentDatabaseAuthority(env)).allowed) return { kind: 'unknown', reason: 'environment_refused' }

  // Safeguard 4: a test-mode payment never becomes a sale on production.
  if (isProductionDeployment(env) && row.provider_mode !== 'live') {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'test_payment_in_production' })
    log.error({ paymentId: row.id, source: opts.source }, 'test-mode PayTech payment seen on production')
    return { kind: 'ineligible', reason: 'test_payment_in_production' }
  }
  const config = resolvePaytechConfig(env)
  if (row.provider_mode !== config.providerMode) {
    // A test payment checked with live credentials (or the reverse) cannot be
    // asked about meaningfully, and 062 would refuse it anyway.
    await recordSettlementNote({ paymentId: row.id, failureReason: 'provider_mode_mismatch' })
    return { kind: 'ineligible', reason: 'provider_mode_mismatch' }
  }

  // ── 3. ask the provider, under the confirmed contract only ──
  const settlement = await confirmPaymentStatus(
    { token: row.provider_token, refCommand: row.reference },
    { env },
  )

  if (settlement.outcome === 'unknown') {
    const reason = settlement.reason ?? 'unknown'
    await recordSettlementNote({ paymentId: row.id, failureReason: `settlement_unknown:${reason}` })
    if (settlement.shape) {
      // Key paths only — never values — so the contract can be corrected.
      log.warn({ paymentId: row.id, reason, shape: settlement.shape }, 'PayTech status response not recognised')
    }
    return { kind: 'unknown', reason }
  }

  // ── 4. the provider's facts must be ours ──
  const stored = Number(row.amount)
  if (settlement.amount !== null && settlement.amount !== stored) {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_amount_mismatch' })
    log.error({ paymentId: row.id }, 'PayTech reported an amount that is not the stored one')
    return { kind: 'refused', reason: 'settlement_amount_mismatch', retryable: false }
  }
  if (settlement.currency !== null && settlement.currency !== row.currency) {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_currency_mismatch' })
    return { kind: 'refused', reason: 'settlement_currency_mismatch', retryable: false }
  }

  // ── 5. act ──
  switch (settlement.outcome) {
    case 'paid': {
      if (row.currency !== PAYTECH_CURRENCY) {
        await recordSettlementNote({ paymentId: row.id, failureReason: 'currency_unsupported' })
        return { kind: 'refused', reason: 'currency_unsupported', retryable: false }
      }
      const outcome = await completeVerifiedPayment({
        provider:          'paytech',
        providerMode:      config.providerMode,
        providerToken:     row.provider_token,
        providerReference: row.reference,
        reference:         row.reference,
        amount:            stored,
        currency:          row.currency,
      })
      if (outcome.kind === 'already_completed') return outcome
      if (outcome.kind === 'refused') {
        await recordSettlementNote({ paymentId: row.id, failureReason: outcome.reason })
        return outcome
      }
      log.info({ paymentId: row.id, source: opts.source, requiresReview: outcome.requiresReview },
        'PayTech payment completed and entitlement granted')
      return { kind: 'completed', requiresReview: outcome.requiresReview }
    }
    case 'failed':
    case 'cancelled': {
      const { changed } = await recordTerminalFailure({
        providerToken: row.provider_token,
        status:        settlement.outcome,
        failureReason: `settlement_${settlement.outcome}`,
      })
      if (changed) return { kind: settlement.outcome }
      const now = await loadPaytechPaymentById(row.id)
      return now?.status === 'completed'
        ? { kind: 'already_completed' }
        : { kind: 'already_terminal', status: now?.status ?? 'unknown' }
    }
    case 'pending':
      await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_pending' })
      return { kind: 'pending' }
  }
}

/**
 * Close an opened attempt after a human checked the PayTech dashboard.
 *
 * The provider is asked FIRST. If it says paid, the payment is completed
 * instead; if it says pending, the checkout can still be paid and closing it
 * would let the learner pay twice, so the close is refused. Only when the
 * provider cannot answer (`unknown`) — today, always, until the contract is
 * confirmed — does the human's attestation decide.
 */
export async function closeAfterManualReconciliation(
  row: PaytechPaymentRow,
  env: EnvLike = process.env,
): Promise<
  | { kind: 'closed' }
  | { kind: 'refused'; reason: 'provider_says_paid' | 'provider_says_pending' | 'not_open' | 'ineligible' | 'race' | 'environment_refused' }
  | { kind: 'resolved_by_provider'; result: ReconcileResult }
> {
  if (row.provider !== 'paytech' || !(IN_FLIGHT_STATUSES as readonly string[]).includes(row.status)) {
    return { kind: 'refused', reason: 'not_open' }
  }
  // Checked first: "the provider cannot answer" below must never become "so a
  // human may close it" on a deployment that may not act on this database.
  if (!(await paymentDatabaseAuthority(env)).allowed) return { kind: 'refused', reason: 'environment_refused' }
  if (row.provider_token) {
    const result = await reconcilePaytechPayment(row, { source: 'admin', env })
    switch (result.kind) {
      case 'completed':
      case 'already_completed':
      // A refusal means the provider DID say paid — with a mismatch, or for a
      // learner 062 will not fulfil. Money moved; closing it as unpaid would
      // hide that. It needs a refund decision, not a close.
      case 'refused':
        return { kind: 'refused', reason: 'provider_says_paid' }
      case 'pending':
        return { kind: 'refused', reason: 'provider_says_pending' }
      case 'failed':
      case 'cancelled':
      case 'already_terminal':
        return { kind: 'resolved_by_provider', result }
      case 'ineligible':
        if (result.reason !== 'provider_mode_mismatch' && result.reason !== 'test_payment_in_production') {
          return { kind: 'refused', reason: 'ineligible' }
        }
        break
      case 'unknown':
        break
    }
  }
  const { changed } = await closeAttemptAfterManualReconciliation({ paymentId: row.id })
  return changed ? { kind: 'closed' } : { kind: 'refused', reason: 'race' }
}
