import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import type { ProviderMode } from '@/lib/payments/paytech-config'

const log = createLogger('payments/completion')

/**
 * THE payment completion chokepoint — XP-PAYTECH-01, hardened by XP-PAYTECH-04.
 *
 * This is the ONLY module in the repository permitted to call
 * `public.complete_payment()`. Migration 062's obligation 5 requires exactly
 * that, and a repo-wide test asserts it (`xp-paytech-01-checkout.test.ts`,
 * "exactly one chokepoint"). Every caller — the IPN route, the reconciliation
 * sweep, the admin "verify" action, checkout's own re-check — reaches
 * completion through `paytech-reconcile.ts`, which comes here.
 *
 * It is also the home of every OTHER status write a PayTech payment can
 * receive after it was opened, so the full set of transitions the
 * application performs can be read in one file. Migration 063 enforces the
 * same set in the database. Every function here first asks
 * `paymentDatabaseAuthority()`, so none of these writes can reach a database
 * this deployment may not act on.
 *
 * ── THE EIGHT OBLIGATIONS OF 062, AND WHERE EACH IS DISCHARGED ────────────
 *
 *  1. CONFIRM SERVER-TO-SERVER — `confirmPaymentStatus()` asks PayTech, and
 *     its answer is read ONLY through the written settlement contract
 *     (`paytech-settlement-contract.ts`). Until that contract is confirmed
 *     nothing is ever completed. The IPN's HMAC proves authenticity and binds
 *     our amount and reference; it never proves payment.
 *  2. NEVER TREAT A CONSTANT AS A SIGNATURE — `paytech-ipn.ts` cannot reach
 *     `signature` strength on the sha256-constant check alone.
 *  3. PASS WHAT IT VERIFIED — the amount, currency, reference, provider and
 *     mode passed here come from OUR stored row, after the provider's own
 *     amount was compared with it in `paytech-reconcile.ts`.
 *  4. ONLY FOR A CONFIRMED-COMPLETE PAYMENT — `completeVerifiedPayment()`
 *     accepts no status argument and is called only on a `paid` settlement.
 *  5. ONE CHOKEPOINT — this module, asserted by test.
 *  6. OWN THE FORENSICS — `last_ipn_at` on every notification; `failure_reason`
 *     on every refusal and every unresolved check.
 *  7. EVERY REFUSAL IS A RECONCILIATION EVENT — `isRetryable()` names the two
 *     that a retry can fix; everything else needs a human.
 *  8. BE IDEMPOTENT — `already_completed` is reported as a SUCCESS.
 */

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * What `complete_payment()` returned, or why it refused.
 *
 * `completed` and `already_completed` are both successes: the second is the
 * idempotent path a retrying provider requires. Everything else is a refusal
 * and nothing was written.
 */
export type CompletionOutcome =
  | { kind: 'completed'; entitlementId: string | null; requiresReview: boolean }
  | { kind: 'already_completed' }
  | { kind: 'refused'; reason: string; retryable: boolean }

/**
 * The refusals a retry can fix.
 *
 *   * `entitlement_race` — two transactions contended and this one lost.
 *   * `unknown_error`    — no structured reason came back: a transport fault,
 *     a timeout, a lock or statement timeout. 062 is all-or-nothing, so
 *     nothing was written and asking again is safe.
 *
 * Every other reason — any `*_mismatch`, `status_not_completable`,
 * `entitlement_conflict`, `entitlement_revoked_requires_decision`,
 * `test_payment_in_live_database`, `environment_refused` — describes a disagreement that retrying
 * cannot resolve and that a human must look at.
 */
export function isRetryable(reason: string): boolean {
  return reason === 'entitlement_race' || reason === 'unknown_error'
}

/** A refusal reason that means "this notification is not about a payment we know". */
export const UNKNOWN_PAYMENT_REASONS = ['payment_not_found'] as const

// ── The verified result a caller must supply ────────────────────────────────

export interface VerifiedPayment {
  /** Which gateway. Written to `payments.provider`; unconstrained text by design. */
  readonly provider: string
  /** 'test' | 'live' — what `payments.provider_mode` accepts. */
  readonly providerMode: ProviderMode
  /** The provider's own identifier. The UNIQUE replay key (migration 060). */
  readonly providerToken: string
  /** The provider's transaction id, when it supplies one distinct from the token. */
  readonly providerReference: string
  /** Our order reference. Must equal `payments.reference`. */
  readonly reference: string
  /** Whole XOF francs, as verified. */
  readonly amount: number
  /** Always 'XOF'; 062 refuses anything else. */
  readonly currency: string
}

/**
 * Extracts the structured `reason` migrations 062 and 063 put in the
 * exception DETAIL. Anything without one is `unknown_error`.
 */
export function reasonFromError(err: unknown): string {
  const e = err as { details?: unknown; message?: unknown } | null
  for (const field of [e?.details, e?.message]) {
    if (typeof field !== 'string') continue
    const m = /"reason"\s*:\s*"([a-z_]+)"/.exec(field)
    if (m) return m[1]
  }
  return 'unknown_error'
}

// ── The single RPC call site ────────────────────────────────────────────────

/**
 * Complete a payment whose success the caller has already verified.
 *
 * This performs the four writes of migration 062 atomically — payment,
 * entitlement, enrollment, audit — or none of them. It is NOT a verification
 * mechanism: every argument is an assertion, and passing values a browser
 * supplied would make it worthless. See obligation 3 above.
 */
export async function completeVerifiedPayment(
  verified: VerifiedPayment,
): Promise<CompletionOutcome> {
  if (!(await paymentDatabaseAuthority()).allowed) {
    return { kind: 'refused', reason: 'environment_refused', retryable: false }
  }

  const admin = createAdminClient()

  const { data, error } = await admin.rpc('complete_payment', {
    p_provider:           verified.provider,
    p_provider_mode:      verified.providerMode,
    p_provider_token:     verified.providerToken,
    p_provider_reference: verified.providerReference,
    p_reference:          verified.reference,
    p_amount:             verified.amount,
    p_currency:           verified.currency,
  })

  if (error) {
    const reason = reasonFromError(error)
    // Never the provider token: the reference is enough to find the row.
    log.error(
      { provider: verified.provider, reference: verified.reference, reason },
      'complete_payment refused',
    )
    return { kind: 'refused', reason, retryable: isRetryable(reason) }
  }

  // 062 answers in camelCase: { outcome, paymentId, courseId, entitlementId,
  // preExistingEntitlement }. XP-PAYTECH-01 read `entitlement_id` and `review`,
  // which never existed, so the duplicate-purchase flag was always lost.
  const result = (data ?? {}) as {
    outcome?: string
    entitlementId?: string
    preExistingEntitlement?: boolean
  }

  if (result.outcome === 'already_completed') {
    return { kind: 'already_completed' }
  }

  return {
    kind: 'completed',
    entitlementId: result.entitlementId ?? null,
    requiresReview: result.preExistingEntitlement === true,
  }
}

// ── Forensics (obligation 6) ────────────────────────────────────────────────

/**
 * Record that the provider notified us about this token, and why we refused.
 *
 * Deliberately separate from `completeVerifiedPayment()`: 062 persists nothing
 * on a refusal, precisely so that the function can be all-or-nothing. The
 * forensics therefore belong outside it, and a failure to write them must never
 * change the fulfilment decision — so this swallows its own errors after
 * logging. It never writes `status` and never writes a column that could
 * grant access.
 */
export async function touchIpnReceipt(opts: {
  providerToken: string
  failureReason?: string | null
}): Promise<void> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return

    const admin = createAdminClient()
    const patch: Record<string, unknown> = { last_ipn_at: new Date().toISOString() }
    if (opts.failureReason) patch.failure_reason = opts.failureReason

    const { error } = await admin
      .from('payments')
      .update(patch)
      .eq('provider_token', opts.providerToken)

    if (error) {
      log.error({ reason: opts.failureReason ?? null }, 'could not record IPN receipt')
    }
  } catch {
    log.error('recording the IPN receipt threw')
  }
}

/**
 * Record why a payment is still unresolved after a check that was NOT a
 * notification (the sweep, the admin action, checkout's re-check). Forensics
 * only: never `status`, never `last_ipn_at`. Swallows its own errors.
 */
export async function recordSettlementNote(opts: {
  paymentId: string
  failureReason: string
}): Promise<void> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return

    const { error } = await createAdminClient()
      .from('payments')
      .update({ failure_reason: opts.failureReason })
      .eq('id', opts.paymentId)
    if (error) log.error({ reason: opts.failureReason }, 'could not record settlement note')
  } catch {
    log.error('recording the settlement note threw')
  }
}

// ── Status writes — every one a compare-and-set ─────────────────────────────

/** The two states a payment may be in while money might still move. */
export const IN_FLIGHT_STATUSES = ['pending', 'processing'] as const

/**
 * Move an OPENED payment to a terminal non-paid state, because the provider
 * reliably said it failed or was cancelled.
 *
 * Compare-and-set on `status IN (pending, processing)`: a completed, refunded
 * or already-closed payment is never touched, so an out-of-order cancellation
 * can neither undo a verified purchase nor overwrite a refund. Migration 063
 * enforces the same rule in the database.
 */
export async function recordTerminalFailure(opts: {
  providerToken: string
  status: 'cancelled' | 'failed'
  failureReason: string
}): Promise<{ changed: boolean }> {
  if (!(await paymentDatabaseAuthority()).allowed) return { changed: false }

  const admin = createAdminClient()

  const { data, error } = await admin
    .from('payments')
    .update({
      status:         opts.status,
      failure_reason: opts.failureReason,
    })
    .eq('provider_token', opts.providerToken)
    .in('status', [...IN_FLIGHT_STATUSES])
    .select('id')

  if (error) {
    log.error({ status: opts.status }, 'could not record terminal payment state')
    return { changed: false }
  }
  return { changed: Array.isArray(data) && data.length > 0 }
}

/**
 * Close an intent that was NEVER OPENED with the provider — no token was ever
 * stored, so no checkout URL was ever handed to the learner, so no money can
 * have moved against it. This is the only automatic closure that needs no
 * provider answer (XP-PAYTECH-04 safeguard 1).
 *
 * Compare-and-set on `status = 'pending' AND provider_token IS NULL`.
 */
export async function closeUnopenedAttempt(opts: {
  paymentId: string
  failureReason: string
}): Promise<{ changed: boolean }> {
  if (!(await paymentDatabaseAuthority()).allowed) return { changed: false }

  const { data, error } = await createAdminClient()
    .from('payments')
    .update({ status: 'expired', failure_reason: opts.failureReason })
    .eq('id', opts.paymentId)
    .eq('status', 'pending')
    .is('provider_token', null)
    .select('id')

  if (error) {
    log.error({ paymentId: opts.paymentId }, 'could not close an unopened attempt')
    return { changed: false }
  }
  return { changed: Array.isArray(data) && data.length > 0 }
}

/**
 * Close an OPENED attempt after a human verified, in the PayTech dashboard,
 * that it was not paid — the "manual reconciliation" safeguard 1 allows when
 * the provider cannot answer. Only `paytech-reconcile.ts`'s admin path calls
 * this, after the provider was asked and did NOT say paid or pending.
 *
 * Compare-and-set on `status IN (pending, processing)`.
 */
export async function closeAttemptAfterManualReconciliation(opts: {
  paymentId: string
}): Promise<{ changed: boolean }> {
  if (!(await paymentDatabaseAuthority()).allowed) return { changed: false }

  const { data, error } = await createAdminClient()
    .from('payments')
    .update({ status: 'expired', failure_reason: 'manual_reconciliation_unpaid' })
    .eq('id', opts.paymentId)
    .eq('provider', 'paytech')
    .in('status', [...IN_FLIGHT_STATUSES])
    .select('id')

  if (error) {
    log.error({ paymentId: opts.paymentId }, 'could not close an attempt after manual reconciliation')
    return { changed: false }
  }
  return { changed: Array.isArray(data) && data.length > 0 }
}
