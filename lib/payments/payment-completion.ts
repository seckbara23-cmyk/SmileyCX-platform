import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import type { ProviderMode } from '@/lib/payments/paytech-config'

const log = createLogger('payments/completion')

/**
 * THE payment completion chokepoint — XP-PAYTECH-01.
 *
 * This is the ONLY module in the repository permitted to call
 * `public.complete_payment()`. Migration 062's obligation 5 requires exactly
 * that, and a repo-wide test asserts it
 * (`__tests__/payments/xp-paytech-01-completion-chokepoint.test.ts`). Every
 * other module — the IPN route, any future provider, any admin tool — reaches
 * completion through `completeVerifiedPayment()` below.
 *
 * ── THE EIGHT OBLIGATIONS, AND WHERE EACH IS DISCHARGED ───────────────────
 *
 * Migration 062 states eight duties that cannot be enforced from inside the
 * database. They are answered here rather than assumed:
 *
 *  1. CONFIRM SERVER-TO-SERVER — *** PARTIALLY UNSATISFIABLE FOR PAYTECH ***
 *     PayDunya publishes a confirm endpoint; PayTech publishes none (see
 *     `paytech-client.ts`). So for PayTech the evidence is the IPN's HMAC
 *     signature over a message built from OUR OWN stored amount and reference
 *     (`paytech-ipn.ts`). That is a cryptographic attestation by the provider
 *     to the exact amount we are about to fulfil — strong, but it travels on a
 *     channel the payer can observe, which is why it is paired with the
 *     independent cross-check in step 3 and the replay defence in 062 itself.
 *     This difference from PayDunya is a REAL reduction in assurance and is
 *     reported as such; it is not papered over.
 *  2. NEVER TREAT A CONSTANT AS A SIGNATURE — enforced in `paytech-ipn.ts`,
 *     which refuses to reach `signature` strength on the sha256-constant check
 *     alone, and here, which refuses anything below `VERIFIED_STRENGTH`.
 *  3. PASS WHAT IT VERIFIED — the caller passes the verified amount, currency,
 *     reference, provider and mode. For PayTech the verified amount IS our
 *     stored amount, because that is what the signature covers, so 062's
 *     internal comparison is a consistency check rather than an independent
 *     one. The independent cross-check is therefore done BEFORE this module:
 *     the route compares the payload's own claimed amount against the row and
 *     refuses a mismatch, so a provider bug or a mis-signed notification is
 *     still caught.
 *  4. ONLY FOR A CONFIRMED-COMPLETE PAYMENT — `completeVerifiedPayment()`
 *     accepts no status argument. It is unreachable for a cancelled or pending
 *     notification; those go to `recordTerminalFailure()` instead.
 *  5. ONE CHOKEPOINT — this module, asserted by test.
 *  6. OWN THE FORENSICS — `touchIpnReceipt()` records `last_ipn_at` on every
 *     notification and `failure_reason` on every refusal, reading the
 *     structured `reason` out of the exception DETAIL. Those two columns exist:
 *     migration 060 added them.
 *  7. EVERY REFUSAL IS A RECONCILIATION EVENT — `isRetryable()` says so: only
 *     `entitlement_race` is safely retryable. Everything else needs a human
 *     and must NOT be answered with a provider retry.
 *  8. BE IDEMPOTENT — `already_completed` is reported as a SUCCESS so the
 *     provider stops redelivering.
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
  | { kind: 'completed'; entitlementId: string | null; review: unknown | null }
  | { kind: 'already_completed' }
  | { kind: 'refused'; reason: string; retryable: boolean }

/**
 * The only refusal that a retry can fix.
 *
 * `entitlement_race` means two transactions contended and this one lost; the
 * row it wanted now exists or will. Every other reason — any `*_mismatch`,
 * `entitlement_conflict`, `entitlement_revoked_requires_decision` — describes a
 * disagreement that retrying cannot resolve and that a human must look at.
 */
export function isRetryable(reason: string): boolean {
  return reason === 'entitlement_race'
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

/** Extracts the structured `reason` migration 062 puts in the exception DETAIL. */
export function reasonFromError(err: unknown): string {
  const e = err as { details?: unknown; message?: unknown } | null
  for (const field of [e?.details, e?.message]) {
    if (typeof field !== 'string') continue
    // 062 raises with detail = '{"reason":"amount_mismatch"}'
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
    // The provider token is a reconciliation key, not a credential (058's own
    // column comment says so), but it is still not logged: the payment id is
    // enough to find the row and the token is what an attacker would want.
    log.error(
      { provider: verified.provider, reference: verified.reference, reason },
      'complete_payment refused',
    )
    return { kind: 'refused', reason, retryable: isRetryable(reason) }
  }

  const result = (data ?? {}) as { outcome?: string; entitlement_id?: string; review?: unknown }

  if (result.outcome === 'already_completed') {
    return { kind: 'already_completed' }
  }

  return {
    kind: 'completed',
    entitlementId: result.entitlement_id ?? null,
    review: result.review ?? null,
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
 * logging.
 *
 * Correlation is by `provider_token`, the UNIQUE replay key, so this can only
 * ever touch one row. It never writes `status` and never writes a column that
 * could grant access.
 */
export async function touchIpnReceipt(opts: {
  providerToken: string
  failureReason?: string | null
}): Promise<void> {
  try {
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
    // Forensics must never be able to fail a request that was otherwise correct.
    log.error('recording the IPN receipt threw')
  }
}

/**
 * Move a payment to a terminal non-paid state.
 *
 * Used for an authenticated cancellation. It writes `status` and nothing that
 * grants access, and it refuses to touch a payment that is already `completed`
 * — an out-of-order cancellation notification arriving after a verified success
 * must NOT undo that success. That rule lives in the `.neq` below rather than
 * in a read-then-write, so two concurrent notifications cannot interleave
 * around it.
 */
export async function recordTerminalFailure(opts: {
  providerToken: string
  status: 'cancelled' | 'failed' | 'expired'
  failureReason: string
}): Promise<{ changed: boolean }> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('payments')
    .update({
      status:         opts.status,
      failure_reason: opts.failureReason,
      last_ipn_at:    new Date().toISOString(),
    })
    .eq('provider_token', opts.providerToken)
    // A completed payment is final. Cancellation never revokes a verified
    // purchase — Phase E of the brief, and simple correctness.
    .neq('status', 'completed')
    .select('id')

  if (error) {
    log.error({ status: opts.status }, 'could not record terminal payment state')
    return { changed: false }
  }
  return { changed: Array.isArray(data) && data.length > 0 }
}
