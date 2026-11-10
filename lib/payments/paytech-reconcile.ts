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
import {
  hasOpenPaymentException,
  reportPaymentException,
  sendPendingExceptionAlerts,
  type ExceptionSignal,
  type ExceptionSource,
} from '@/lib/payments/payment-exceptions'
import type { PaytechEvent } from '@/lib/payments/paytech-ipn'
import { sendPaymentConfirmation } from '@/lib/payments/payment-confirmation'

const log = createLogger('payments/paytech-reconcile')

/**
 * How long an attempt the provider still calls "pending" keeps a manual close refused. The
 * old link may yet be payable, so a close could let a learner pay twice, and a late payment
 * comes back as an exception. But a provider saying "pending" for ever must not hold a
 * learner for ever. PayTech documents no token lifetime, so this is a judgement until it does.
 */
const PENDING_CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

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
 *     was cancelled, or a human attests to a manual check (safeguard 1);
 *   * re-open a closed payment. A paid report on one goes to the exception
 *     record (XP-PAYTECH-05), and it can neither complete it nor grant access.
 *
 * A paid notification is never dropped because of the payment's state. A completed
 * payment covers one, and any other may be a second real payment, so the database
 * counts it for a person.
 */

/** The columns every path reads. Never `metadata`, never anything personal. */
export const PAYTECH_PAYMENT_COLUMNS =
  'id, user_id, course_id, pack_id, amount, currency, reference, status, provider, provider_mode, provider_token, created_at'

export interface PaytechPaymentRow {
  readonly id: string
  readonly user_id: string | null
  readonly course_id: string | null
  /** XP-LAUNCH-FINAL-08 (065): the pack a payment buys, when it buys one; course_id is then null. */
  readonly pack_id?: string | null
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
  /** `complete_payment()` refused, or the provider said paid and its facts are not ours. */
  | { kind: 'refused'; reason: string; retryable: boolean }
  /** The provider did NOT say paid, and its facts are not ours. Recorded. A human decides. */
  | { kind: 'conflict'; reason: string }
  /** This row cannot be reconciled automatically — a human must look. */
  | { kind: 'ineligible'; reason: string }
  /** A report that must be kept could not be recorded. Never acknowledge this. */
  | { kind: 'exception_unrecorded' }

export async function loadPaytechPaymentById(id: string): Promise<PaytechPaymentRow | null> {
  const { data } = await createAdminClient()
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  return (data as PaytechPaymentRow | null) ?? null
}

export interface ReconcileOptions {
  source: ReconcileSource
  env?: EnvLike
  /**
   * What an AUTHENTIC notification claimed. A hint and never proof: `type_event`
   * is outside the signature. It decides whether a report is kept, and never
   * whether money moved.
   */
  hint?: PaytechEvent | null
  /** What that notification said, as a digest, so a repeat can be recognised. */
  fingerprint?: string | null
  /** Also ask the provider about a COMPLETED payment. An administrator's request, or the sweep's. */
  recheck?: boolean
}

/**
 * What a status answer says about an amount. An unpaid answer saying 0 claims nothing: PayTech
 * may well fill the field with it, and every abandoned checkout must not read as a conflict.
 */
function claimedAmount(settlement: { outcome: string; amount: number | null }): number | null {
  return settlement.outcome === 'paid' || (settlement.amount !== null && settlement.amount > 0) ? settlement.amount : null
}

/** The contract requires an amount for a paid answer, and this one had none it could read. */
const PAID_AMOUNT_UNREADABLE = 'amount_unreadable'

/** Record a signal, and say whether the caller may acknowledge the report. */
async function keep(
  row: PaytechPaymentRow,
  signal: ExceptionSignal,
  opts: { source: ExceptionSource; fingerprint?: string | null },
  detail: string | null = null,
  providerAmount: number | null = null,
): Promise<boolean> {
  const outcome = await reportPaymentException({
    paymentId: row.id, signal, source: opts.source, detail, fingerprint: opts.fingerprint,
    // An unpaid answer can well say 0. That is no amount received, and the report must not fail on it.
    providerAmount: providerAmount !== null && providerAmount > 0 ? providerAmount : null,
  })
  return outcome.recorded
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
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const done = { covered: false }
  const result = await decide(row, opts, done)

  // An authentic paid notification on a payment that did not settle is kept, so
  // a later closure cannot hide it. The database decides what it means under the
  // payment's row lock: `watching` while in flight, `open` once closed.
  if (opts.hint === 'sale_complete' && row.provider === 'paytech' && (
        result.kind === 'unknown' || result.kind === 'pending' || result.kind === 'ineligible'
     || result.kind === 'failed' || result.kind === 'cancelled'
     // A transient refusal: the retry settles it, and the report must survive if none comes.
     || (result.kind === 'refused' && result.retryable && result.reason !== 'environment_refused')
     // Something else closed it while the provider was being asked.
     || (result.kind === 'already_terminal' && (IN_FLIGHT_STATUSES as readonly string[]).includes(row.status)))
     && !(result.kind === 'unknown' && result.reason === 'environment_refused')) {
    const kept = await keep(row, 'paid_hint', opts)
    if (!kept) return { kind: 'exception_unrecorded' }
  }

  // On a completed payment too, unless this notification was remembered before it
  // completed the payment.
  if (opts.hint === 'sale_complete' && row.provider === 'paytech' && opts.fingerprint && !done.covered
      && result.kind === 'already_completed') {
    if (!(await keep(row, 'paid_hint', opts))) return { kind: 'exception_unrecorded' }
  }

  // A cancellation claimed while a person is deciding, or where access rests on this
  // attempt. The database keeps it only then, and it changes nothing about the payment.
  if (opts.hint === 'sale_canceled' && row.provider === 'paytech' && opts.fingerprint
      && result.kind !== 'completed' && result.kind !== 'already_completed' && result.kind !== 'exception_unrecorded'
      && !(result.kind === 'unknown' && result.reason === 'environment_refused')) {
    if (!(await keep(row, 'cancel_hint', opts))) return { kind: 'exception_unrecorded' }
  }
  return result
}

/** Ask the provider about a payment that is no longer in flight. Writes nothing. */
async function askAboutSettledRow(row: PaytechPaymentRow, env: EnvLike) {
  const availability = paytechProcessingAvailability(env)
  if (!availability.available || !row.provider_token) return null
  const config = resolvePaytechConfig(env)
  if (row.provider_mode !== config.providerMode) return null
  return confirmPaymentStatus({ token: row.provider_token, refCommand: row.reference }, { env })
}

/**
 * A report about a CLOSED payment. 063 makes the closure final, so this can only
 * keep the report. Asking the provider is safe: with no confirmed contract it
 * makes no request and answers `unknown`.
 */
async function decideClosed(row: PaytechPaymentRow, opts: ReconcileOptions, env: EnvLike): Promise<ReconcileResult> {
  const terminal: ReconcileResult = { kind: 'already_terminal', status: row.status }
  // Never opened: no URL was handed out, so nothing can have been paid.
  if (!row.provider_token) return terminal

  const hinted = opts.hint === 'sale_complete'
  if (!hinted && opts.source !== 'sweep' && opts.source !== 'admin') return terminal
  if (!(await paymentDatabaseAuthority(env)).allowed) return { kind: 'unknown', reason: 'environment_refused' }

  const settlement = await askAboutSettledRow(row, env)
  if (settlement?.shape) log.warn({ paymentId: row.id, reason: settlement.reason, shape: settlement.shape }, 'PayTech status response not recognised')
  let signal: ExceptionSignal | null = hinted ? 'paid_hint' : null
  let detail: string | null = null
  let providerAmount: number | null = null
  let wordAfter = false

  if (settlement) {
    const stored = Number(row.amount)
    if (settlement.outcome === 'paid') {
      const amountOff = settlement.amount !== null && settlement.amount !== stored
      const currencyOff = settlement.currency !== null && settlement.currency !== row.currency
      // Paid at nothing moved no money. It is a claim for a person, not a receipt.
      const paidSomething = settlement.amount === null || settlement.amount > 0
      signal = 'provider_paid'
      if (currencyOff) {
        signal = paidSomething ? 'completion_refused' : 'currency_mismatch'
        detail = 'settlement_currency_mismatch'
        // Both are kept. The amount goes last, because that is what a refund is decided on.
        if (amountOff && !(await keep(row, signal, opts, detail))) return { kind: 'exception_unrecorded' }
      }
      if (amountOff) {
        signal = paidSomething ? 'completion_refused' : 'amount_mismatch'
        detail = 'settlement_amount_mismatch'
        if (paidSomething) providerAmount = settlement.amount
      }
    } else if (settlement.outcome === 'unknown' && settlement.reason === PAID_AMOUNT_UNREADABLE) {
      signal = 'amount_mismatch'
      detail = 'settlement_amount_unreadable'
    } else if (settlement.outcome === 'unknown' && settlement.reason === 'status_unrecognised') {
      // A word nobody has defined may mean that money moved, so a person should read it. Beside a
      // notification, what the notification claimed stays what the record says, and the word is
      // kept after it as the provider's last word, so that no decision rests on an earlier one.
      if (hinted) {
        detail = 'provider_says_unrecognised'
        wordAfter = true
      } else {
        signal = 'amount_mismatch'
        detail = 'settlement_status_unrecognised'
      }
    } else if (settlement.outcome === 'pending') {
      // Closed here, still payable there: the learner could yet pay this attempt.
      if (hinted) detail = 'provider_says_pending'
      else signal = 'provider_pending'
    } else if (settlement.outcome === 'failed' || settlement.outcome === 'cancelled') {
      if (hinted) detail = `provider_says_${settlement.outcome}`
      // Only updates a record that already exists. An operator sees the answer, and from
      // a sweep the database keeps it only where an access decision rests on this attempt.
      else if (opts.source === 'admin' || opts.source === 'sweep') signal = 'provider_not_paid'
    }
  }

  if (signal && !(await keep(row, signal, opts, detail, providerAmount))) return { kind: 'exception_unrecorded' }
  if (wordAfter && !(await keep(row, 'amount_mismatch', { source: opts.source }, 'settlement_status_unrecognised'))) {
    return { kind: 'exception_unrecorded' }
  }
  return terminal
}

/**
 * A report that questions a COMPLETED payment. A paid notification asks the provider
 * nothing, and the caller keeps it. A cancellation, or a re-check by an administrator or the
 * sweep, may reveal a conflict. It reverses nothing and only records it for a human.
 */
async function decideCompleted(row: PaytechPaymentRow, opts: ReconcileOptions, env: EnvLike): Promise<ReconcileResult> {
  const done: ReconcileResult = { kind: 'already_completed' }
  const hinted = opts.hint === 'sale_canceled'
  if (!hinted && opts.recheck !== true) return done
  if (!(await paymentDatabaseAuthority(env)).allowed) return { kind: 'unknown', reason: 'environment_refused' }

  const settlement = await askAboutSettledRow(row, env)
  if (settlement?.shape) log.warn({ paymentId: row.id, reason: settlement.reason, shape: settlement.shape }, 'PayTech status response not recognised')
  let signal: ExceptionSignal | null = hinted ? 'cancel_hint' : null
  let detail: string | null = null
  let providerAmount: number | null = null
  if (settlement?.outcome === 'paid') {
    // Paid is no conflict, unless what it says was paid is not what this payment was.
    signal = null
    const amountOff = settlement.amount !== null && settlement.amount !== Number(row.amount)
    const currencyOff = settlement.currency !== null && settlement.currency !== row.currency
    if (currencyOff) {
      signal = 'currency_mismatch'
      detail = 'settlement_currency_mismatch'
      // Both are kept. The amount goes last, because that is what a refund is decided on.
      if (amountOff && !(await keep(row, signal, opts, detail))) return { kind: 'exception_unrecorded' }
    }
    if (amountOff) {
      signal = 'amount_mismatch'
      detail = 'settlement_amount_mismatch'
      providerAmount = settlement.amount
    }
    // Paid at ours takes back any other amount it named. No notification made it say so.
    if (!amountOff && !currencyOff && !(await keep(row, 'provider_paid', { source: opts.source }))) {
      return { kind: 'exception_unrecorded' }
    }
  } else if (settlement?.outcome === 'unknown' && settlement.reason === PAID_AMOUNT_UNREADABLE) {
    signal = 'amount_mismatch'
    detail = 'settlement_amount_unreadable'
  } else if (settlement?.outcome === 'unknown' && settlement.reason === 'status_unrecognised') {
    // It no longer says what it said when this completed, in a word nobody has defined. That
    // blocks nobody here, and a person should read it.
    signal = 'amount_mismatch'
    detail = 'settlement_status_unrecognised'
  } else if (settlement && settlement.outcome !== 'unknown') {
    // Not paid, or still payable: either contradicts a completed payment. The word is kept
    // so that the queue can say which.
    signal = 'provider_not_paid'
    detail = `provider_says_${settlement.outcome}`
  }

  if (signal && !(await keep(row, signal, opts, detail, providerAmount))) return { kind: 'exception_unrecorded' }
  return done
}

async function decide(row: PaytechPaymentRow, opts: ReconcileOptions, done: { covered: boolean }): Promise<ReconcileResult> {
  const env = opts.env ?? process.env

  // ── 1. is this a PayTech payment that could still settle? ──
  if (row.provider !== 'paytech') return { kind: 'ineligible', reason: 'not_a_paytech_payment' }
  if (row.status === 'completed') return decideCompleted(row, opts, env)
  if (!(IN_FLIGHT_STATUSES as readonly string[]).includes(row.status)) {
    return decideClosed(row, opts, env)
  }
  if (!row.provider_token) return { kind: 'ineligible', reason: 'never_opened' }
  // A payment buys one course or one pack (065): it needs a learner and one of the two.
  if (!row.user_id || (!row.course_id && !row.pack_id)) {
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
    // It said paid and gave no amount it could read. Nothing completes on that, and it must
    // not read as no answer at all: a person checks it, and can dismiss it.
    if (reason === PAID_AMOUNT_UNREADABLE) {
      if (!(await keep(row, 'amount_mismatch', opts, 'settlement_amount_unreadable'))) return { kind: 'exception_unrecorded' }
      return { kind: 'conflict', reason: 'settlement_amount_unreadable' }
    }
    // A word nobody has defined may mean that money moved, so a person should read it. A
    // notification is watched as it would be, and the next status check keeps the word.
    if (reason === 'status_unrecognised' && !opts.hint
        && !(await keep(row, 'amount_mismatch', opts, 'settlement_status_unrecognised'))) {
      return { kind: 'exception_unrecorded' }
    }
    return { kind: 'unknown', reason }
  }

  // ── 4. the provider's facts must be ours ──
  const stored = Number(row.amount)
  const amount = claimedAmount(settlement)
  const currencyOff = settlement.currency !== null && settlement.currency !== row.currency
  if (amount !== null && amount !== stored) {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_amount_mismatch' })
    log.error({ paymentId: row.id }, 'PayTech reported an amount that is not the stored one')
    // Paid at nothing moved no money. It is a conflict for a person, and not a receipt.
    const paidSomething = settlement.outcome === 'paid' && amount > 0
    // Both are kept. The amount goes last, because that is what a refund is decided on.
    if (currencyOff && !(await keep(row, paidSomething ? 'completion_refused' : 'currency_mismatch', opts, 'settlement_currency_mismatch'))) {
      return { kind: 'exception_unrecorded' }
    }
    const kept = paidSomething
      ? await keep(row, 'completion_refused', opts, 'settlement_amount_mismatch', amount)
      : await keep(row, 'amount_mismatch', opts, 'settlement_amount_mismatch')
    if (!kept) return { kind: 'exception_unrecorded' }
    return paidSomething
      ? { kind: 'refused', reason: 'settlement_amount_mismatch', retryable: false }
      : { kind: 'conflict', reason: 'settlement_amount_mismatch' }
  }
  if (currencyOff) {
    await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_currency_mismatch' })
    const kept = settlement.outcome === 'paid'
      ? await keep(row, 'completion_refused', opts, 'settlement_currency_mismatch')
      : await keep(row, 'currency_mismatch', opts, 'settlement_currency_mismatch')
    if (!kept) return { kind: 'exception_unrecorded' }
    return settlement.outcome === 'paid'
      ? { kind: 'refused', reason: 'settlement_currency_mismatch', retryable: false }
      : { kind: 'conflict', reason: 'settlement_currency_mismatch' }
  }

  // ── 5. act ──
  switch (settlement.outcome) {
    case 'paid': {
      if (row.currency !== PAYTECH_CURRENCY) {
        await recordSettlementNote({ paymentId: row.id, failureReason: 'currency_unsupported' })
        if (!(await keep(row, 'completion_refused', opts, 'currency_unsupported'))) {
          return { kind: 'exception_unrecorded' }
        }
        return { kind: 'refused', reason: 'currency_unsupported', retryable: false }
      }
      // Remembered first, so that the completion and what it covers cannot come apart.
      // If this cannot be written, nothing completes and the provider is asked to retry.
      if (opts.hint === 'sale_complete' && opts.fingerprint) {
        if (!(await keep(row, 'paid_hint', opts, 'ipn_completing_payment'))) return { kind: 'exception_unrecorded' }
        done.covered = true
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
        // The provider said paid and 062 would not fulfil it: money moved with
        // nothing granted. Includes a row closed while the provider was being
        // asked. A retryable refusal is transient, and a retry settles it.
        if (!outcome.retryable && outcome.reason !== 'environment_refused'
            && !(await keep(row, 'completion_refused', opts, outcome.reason))) {
          return { kind: 'exception_unrecorded' }
        }
        return outcome
      }
      log.info({ paymentId: row.id, source: opts.source, requiresReview: outcome.requiresReview },
        'PayTech payment completed and entitlement granted')
      // The completion may have flagged what it does not cover. A person hears of that now,
      // not at the next daily sweep. A normal payment has nothing due, and sends nothing.
      await sendPendingExceptionAlerts({ paymentId: row.id })
      // XP-LAUNCH-FINAL-11 (CGV art. 4.4): the learner's confirmation, once, on the fresh
      // completion only (`already_completed` returned above). It never throws.
      await sendPaymentConfirmation(row.id)
      return { kind: 'completed', requiresReview: outcome.requiresReview }
    }
    case 'failed':
    case 'cancelled': {
      const { changed } = await recordTerminalFailure({
        providerToken: row.provider_token,
        status:        settlement.outcome,
        failureReason: `settlement_${settlement.outcome}`,
      })
      if (changed) {
        // Migration 064's trigger opened any earlier paid notification on this row. What
        // the provider said is kept on it, or on an access decision that rests on it. The
        // alert goes out either way, because that record is there either way.
        const kept = await keep(row, 'provider_not_paid', opts)
        await sendPendingExceptionAlerts({ paymentId: row.id })
        if (!kept) return { kind: 'exception_unrecorded' }
        return { kind: settlement.outcome }
      }
      const now = await loadPaytechPaymentById(row.id)
      if (now?.status === 'completed') {
        // Another path completed it while the provider was answering that it was not paid.
        // The payment stands, and that answer goes to a person.
        if (!(await keep(row, 'provider_not_paid', opts))) return { kind: 'exception_unrecorded' }
        return { kind: 'already_completed' }
      }
      // Still in flight means the write failed, not that someone else closed it.
      if (!now || (IN_FLIGHT_STATUSES as readonly string[]).includes(now.status)) {
        return { kind: 'unknown', reason: 'terminal_write_failed' }
      }
      return { kind: 'already_terminal', status: now.status }
    }
    case 'pending':
      await recordSettlementNote({ paymentId: row.id, failureReason: 'settlement_pending' })
      // Only where it has said more on a record, which this then replaces as its last word.
      if (!(await keep(row, 'provider_pending', { source: opts.source }))) return { kind: 'exception_unrecorded' }
      return { kind: 'pending' }
  }
}

/**
 * Close an opened attempt after a human checked the PayTech dashboard.
 *
 * The provider is asked FIRST. If it says paid, the payment is completed
 * instead; if it says pending, the checkout can still be paid and closing it
 * would let the learner pay twice, so the close is refused for the first
 * `PENDING_CLOSE_AFTER_MS`. Only when the provider cannot answer (`unknown`) —
 * today, always, until the contract is confirmed — contradicts our record
 * without saying paid, or has said pending past that time does the human's
 * attestation decide.
 *
 * If PayTech had already sent an authentic paid notification for this attempt,
 * the close still happens, because the operator is entitled to decide, but
 * migration 064 opens an exception in the same transaction. `exceptionOpened`
 * says so.
 */
export async function closeAfterManualReconciliation(
  row: PaytechPaymentRow,
  env: EnvLike = process.env,
): Promise<
  | { kind: 'closed'; exceptionOpened: boolean }
  | { kind: 'refused'; reason: 'provider_says_paid' | 'provider_says_pending' | 'report_unrecorded' | 'not_open' | 'ineligible' | 'race' | 'environment_refused' }
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
      // A refusal means the provider DID say paid: with a mismatch, or for a
      // learner 062 will not fulfil. Money moved; closing it as unpaid would
      // hide that. It needs a refund decision, not a close.
      case 'refused':
        return { kind: 'refused', reason: 'provider_says_paid' }
      // A report could not be kept. Closing now would hide it, so this close stops here,
      // though the provider's own answer may already have closed the attempt.
      case 'exception_unrecorded':
        return { kind: 'refused', reason: 'report_unrecorded' }
      case 'pending':
        if (Date.now() - new Date(row.created_at).getTime() < PENDING_CLOSE_AFTER_MS) {
          return { kind: 'refused', reason: 'provider_says_pending' }
        }
        break
      case 'failed':
      case 'cancelled':
      case 'already_terminal':
        return { kind: 'resolved_by_provider', result }
      case 'ineligible':
        if (result.reason !== 'provider_mode_mismatch' && result.reason !== 'test_payment_in_production') {
          return { kind: 'refused', reason: 'ineligible' }
        }
        break
      // The provider did not say paid, and what it did say is recorded. The human who
      // checked the dashboard decides, or this attempt could never be closed at all.
      case 'conflict':
      case 'unknown':
        break
    }
  }
  const { changed } = await closeAttemptAfterManualReconciliation({ paymentId: row.id })
  if (!changed) return { kind: 'refused', reason: 'race' }
  await sendPendingExceptionAlerts({ paymentId: row.id })
  return { kind: 'closed', exceptionOpened: await hasOpenPaymentException(row.id) }
}
