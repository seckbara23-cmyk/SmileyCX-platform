import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { ownerEmails } from '@/lib/auth/owner-email'
import { sendPaymentExceptionAlert } from '@/lib/email'
import { isEntitlementAccessible } from '@/lib/entitlements'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { reasonFromError } from '@/lib/payments/payment-completion'

const log = createLogger('payments/exceptions')

/**
 * Payment exceptions — XP-PAYTECH-05, on migration 064.
 *
 * A report the payment state machine cannot act on is recorded here, beside the
 * payment, without moving it: paid after closure, paid but refused by
 * `complete_payment()`, or in conflict with the record.
 *
 * ── WHAT THIS MODULE WILL NOT DO ──────────────────────────────────────────
 *
 *   * complete a payment. It never calls `complete_payment()`;
 *   * grant access. It never writes `entitlements` or `enrollments`;
 *   * refund anything. It records a refund already confirmed OUTSIDE this
 *     system, and assumes nothing about what PayTech offers.
 *
 * A notification is not proof. The IPN signature covers the amount and the
 * reference, never the outcome, so a notification can only make a payment
 * `reported`. The settlement contract, or an administrator's check of the
 * PayTech dashboard, establishes that money moved.
 *
 * Every write first asks `paymentDatabaseAuthority()`. Migration 064 holds the
 * rules for every role, and audits each decision in the same transaction.
 */

export type ExceptionSignal =
  | 'paid_hint'
  | 'unverified_report'
  | 'provider_paid'
  | 'completion_refused'
  | 'provider_pending'
  | 'provider_not_paid'
  | 'cancel_hint'
  | 'amount_mismatch'
  | 'currency_mismatch'

export type ExceptionSource = 'ipn' | 'sweep' | 'admin' | 'checkout'

export type ReportOutcome =
  | { readonly recorded: true }
  /** This deployment may not act on this database. Nothing was attempted. */
  | { readonly recorded: false; readonly reason: 'environment_refused' }
  /** The record could not be written. The caller must not acknowledge the report. */
  | { readonly recorded: false; readonly reason: 'write_failed' }

/**
 * Record a signal. Idempotent per payment: a replay only counts.
 *
 * Never throws. `write_failed` must reach the provider as a retry, because an
 * acknowledged report that was never recorded is the loss this exists to stop.
 */
export async function reportPaymentException(opts: {
  paymentId: string
  signal: ExceptionSignal
  source: ExceptionSource
  detail?: string | null
}): Promise<ReportOutcome> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) {
      return { recorded: false, reason: 'environment_refused' }
    }
    const { data, error } = await createAdminClient().rpc('payment_exception_report', {
      p_payment_id: opts.paymentId,
      p_signal:     opts.signal,
      p_source:     opts.source,
      p_detail:     opts.detail ?? null,
    })
    if (error) {
      log.error({ paymentId: opts.paymentId, signal: opts.signal, reason: reasonFromError(error) },
        'could not record a payment exception')
      return { recorded: false, reason: 'write_failed' }
    }
    const result = (data ?? {}) as { outcome?: string; needsAlert?: boolean }
    if (result.outcome && result.outcome !== 'replayed' && result.outcome !== 'ignored') {
      log.warn({ paymentId: opts.paymentId, signal: opts.signal, source: opts.source, outcome: result.outcome },
        'payment exception recorded')
    }
    // A replay never sends: it could otherwise send once per notification while a
    // recipient keeps failing. An alert that is still due is the sweep's to retry.
    if (result.needsAlert === true && result.outcome !== 'replayed') {
      await sendPendingExceptionAlerts({ paymentId: opts.paymentId })
    }
    return { recorded: true }
  } catch {
    log.error({ paymentId: opts.paymentId, signal: opts.signal }, 'recording a payment exception threw')
    return { recorded: false, reason: 'write_failed' }
  }
}

/**
 * Alert every allowlisted administrator about open exceptions not yet alerted.
 *
 * An exception is stamped only when every recipient accepted the message, so a
 * failed alert stays due and the sweep tries again. The queue in the admin page
 * shows the exception either way. The message names the order reference and
 * nothing else: no learner, no amount, no token. Delivery is at least once:
 * reports arriving together can each send it, which is better than losing it.
 *
 * Never throws, and returns how many exceptions were alerted.
 */
export async function sendPendingExceptionAlerts(opts: { paymentId?: string; limit?: number } = {}): Promise<number> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return 0
    const recipients = ownerEmails()
    if (recipients.length === 0) {
      log.error('payment exception alert not sent: no administrator address is configured')
      return 0
    }

    const admin = createAdminClient()
    const due = (filter: 'open' | 'flagged') => {
      let query = admin.from('payment_exceptions').select('id, payment_id, last_signal').is('alert_sent_at', null)
      query = filter === 'open' ? query.eq('state', 'open') : query.not('post_settlement_report_at', 'is', null)
      if (opts.paymentId) query = query.eq('payment_id', opts.paymentId)
      return query.limit(opts.limit ?? 25)
    }
    const [open, flagged] = await Promise.all([due('open'), due('flagged')])
    if (open.error || flagged.error) log.error('could not list payment exceptions awaiting an alert')
    const data = [...(open.data ?? []), ...(flagged.data ?? [])]
    if (data.length === 0) return 0

    const { data: payments } = await admin
      .from('payments')
      .select('id, reference')
      .in('id', data.map(e => String(e.payment_id)))
    const referenceOf = new Map((payments ?? []).map(p => [String(p.id), String(p.reference)]))

    let alerted = 0
    for (const exception of data) {
      const reference = referenceOf.get(String(exception.payment_id))
      if (!reference) continue

      let delivered = true
      for (const to of recipients) {
        const sent = await sendPaymentExceptionAlert(to, { reference })
        if (!sent.success || sent.dryRun) delivered = false
      }
      if (!delivered) {
        log.warn({ exceptionId: exception.id }, 'payment exception alert not delivered; it stays due')
        continue
      }

      const { error: stampError } = await admin.rpc('payment_exception_mark_alerted', {
        p_exception_id: String(exception.id),
      })
      if (stampError) log.error({ exceptionId: exception.id }, 'could not record that an alert was sent')
      else alerted += 1
    }
    return alerted
  } catch {
    log.error('sending payment exception alerts threw')
    return 0
  }
}

/**
 * Open reports that have sat on an in-flight payment for too long, so they reach
 * an administrator. Moves no payment. Never throws, and returns how many opened.
 */
export async function escalateStaleWatching(olderThanHours: number): Promise<number> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return 0
    const { data, error } = await createAdminClient().rpc('payment_exception_escalate_watching', {
      p_older_than_hours: olderThanHours,
    })
    if (error) {
      log.error('could not escalate unresolved payment reports')
      return 0
    }
    return typeof data === 'number' ? data : 0
  } catch {
    log.error('escalating unresolved payment reports threw')
    return 0
  }
}

/** Does this payment have an open exception now? False if it cannot be read. */
export async function hasOpenPaymentException(paymentId: string): Promise<boolean> {
  try {
    const { data } = await createAdminClient()
      .from('payment_exceptions')
      .select('id')
      .eq('payment_id', paymentId)
      .eq('state', 'open')
      .maybeSingle()
    return Boolean(data)
  } catch {
    return false
  }
}

/**
 * Must checkout refuse this learner a new attempt for this course?
 *
 * An open exception means an earlier attempt may have been paid, so another
 * chargeable attempt could take the money twice (safeguard 1). Fails closed: if
 * this cannot be answered, `unreadable` is true and checkout opens nothing.
 */
export async function paymentExceptionBlock(
  userId: string,
  courseId: string,
): Promise<{ readonly unreadable: boolean; readonly reference: string | null }> {
  try {
    const { data, error } = await createAdminClient().rpc('payment_exception_blocking_reference', {
      p_user_id:   userId,
      p_course_id: courseId,
    })
    if (error) {
      log.error({ courseId }, 'could not read whether an exception blocks checkout')
      return { unreadable: true, reference: null }
    }
    return { unreadable: false, reference: typeof data === 'string' && data.length > 0 ? data : null }
  } catch {
    log.error({ courseId }, 'reading whether an exception blocks checkout threw')
    return { unreadable: true, reference: null }
  }
}

// ── An administrator's decisions ────────────────────────────────────────────

export interface ExceptionActor {
  readonly id: string
  readonly email: string | null
  readonly ip: string | null
  readonly userAgent: string | null
}

export type ExceptionAction =
  | 'confirm_received'
  | 'withdraw_receipt'
  | 'dismiss'
  | 'require_refund'
  | 'withdraw_refund'
  | 'record_access'
  | 'acknowledge_report'

export type DecisionOutcome =
  | { readonly ok: true; readonly outcome: string; readonly accessStillLive: boolean; readonly paymentStatus: string | null }
  | { readonly ok: false; readonly reason: string }

function decisionResult(data: unknown, error: unknown): DecisionOutcome {
  if (error) return { ok: false, reason: reasonFromError(error) }
  const r = (data ?? {}) as { outcome?: string; accessStillLive?: boolean; paymentStatus?: string }
  return {
    ok: true,
    outcome: String(r.outcome ?? 'recorded'),
    accessStillLive: r.accessStillLive === true,
    paymentStatus: r.paymentStatus ?? null,
  }
}

export async function decidePaymentException(opts: {
  exceptionId: string
  action: ExceptionAction
  actor: ExceptionActor
  note: string
}): Promise<DecisionOutcome> {
  if (!(await paymentDatabaseAuthority()).allowed) return { ok: false, reason: 'environment_refused' }
  const { data, error } = await createAdminClient().rpc('payment_exception_decide', {
    p_exception_id: opts.exceptionId,
    p_action:       opts.action,
    p_actor_id:     opts.actor.id,
    p_actor_email:  opts.actor.email,
    p_note:         opts.note,
    p_ip:           opts.actor.ip,
    p_user_agent:   opts.actor.userAgent,
  })
  return decisionResult(data, error)
}

/** Record a full refund already confirmed outside this system. Issues nothing. */
export async function recordPaymentExceptionRefund(opts: {
  exceptionId: string
  actor: ExceptionActor
  externalReference: string
  amount: number
  currency: string
  refundedAt: string
  note: string
}): Promise<DecisionOutcome> {
  if (!(await paymentDatabaseAuthority()).allowed) return { ok: false, reason: 'environment_refused' }
  const { data, error } = await createAdminClient().rpc('payment_exception_record_refund', {
    p_exception_id:         opts.exceptionId,
    p_actor_id:             opts.actor.id,
    p_actor_email:          opts.actor.email,
    p_external_reference:   opts.externalReference,
    p_amount:               opts.amount,
    p_currency:             opts.currency,
    p_refunded_at:          opts.refundedAt,
    p_note:                 opts.note,
    p_ip:                   opts.actor.ip,
    p_user_agent:           opts.actor.userAgent,
  })
  return decisionResult(data, error)
}

// ── What the admin queue reads ──────────────────────────────────────────────

export interface PaymentExceptionView {
  readonly id: string
  readonly paymentId: string
  readonly state: string
  readonly firstSignal: string
  readonly lastSignal: string
  readonly detail: string | null
  readonly reportCount: number
  readonly firstReportedAt: string
  readonly lastReportedAt: string
  readonly paymentReceived: string
  readonly accessState: string
  readonly refundState: string
  readonly refundExternalReference: string | null
  readonly refundAmount: number | null
  readonly refundCurrency: string | null
  readonly refundConfirmedAt: string | null
  readonly resolution: string | null
  readonly resolvedAt: string | null
  readonly alertSentAt: string | null
  /** A paid report after this record was settled: possibly a second real payment. */
  readonly postSettlementReportAt: string | null
  readonly payment: {
    readonly reference: string
    readonly status: string
    readonly amount: number
    readonly currency: string
    readonly providerMode: string | null
  } | null
  readonly learner: { readonly name: string | null; readonly email: string | null } | null
  readonly courseTitle: string | null
  /** Does the learner hold access to this course right now, from any source? */
  readonly accessLive: boolean
  /** Another payment by this learner for this course that completed: a possible double payment. */
  readonly otherCompletedReference: string | null
}

const EXCEPTION_COLUMNS =
  'id, payment_id, state, first_signal, last_signal, detail, report_count, first_reported_at, last_reported_at, ' +
  'payment_received, access_state, refund_state, refund_external_reference, refund_amount, refund_currency, ' +
  'refund_confirmed_at, resolution, resolved_at, alert_sent_at, post_settlement_report_at'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/**
 * The exception queue, newest report first. `null` means it could not be read,
 * which is not the same as an empty queue, so the page must say so.
 */
export async function listPaymentExceptions(
  opts: { states?: readonly string[]; limit?: number; flaggedOnly?: boolean } = {},
): Promise<PaymentExceptionView[] | null> {
  const admin = createAdminClient()
  const base = admin.from('payment_exceptions').select(EXCEPTION_COLUMNS).in('state', [...(opts.states ?? ['open'])])
  const { data, error } = await (opts.flaggedOnly ? base.not('post_settlement_report_at', 'is', null) : base)
    .order('last_reported_at', { ascending: false })
    .limit(opts.limit ?? 100)
  if (error || !Array.isArray(data)) {
    log.error('could not read the payment exception queue')
    return null
  }
  const rows = data as unknown as Row[]
  if (rows.length === 0) return []

  const { data: paymentData, error: paymentError } = await admin
    .from('payments')
    .select('id, reference, status, amount, currency, provider_mode, user_id, course_id')
    .in('id', rows.map(r => String(r.payment_id)))
  if (paymentError) {
    log.error('could not read the payments behind the exception queue')
    return null
  }
  const payments = new Map(((paymentData ?? []) as Row[]).map(p => [String(p.id), p]))
  const userIds = [...new Set([...payments.values()].map(p => text(p.user_id)).filter((v): v is string => v !== null))]
  const courseIds = [...new Set([...payments.values()].map(p => text(p.course_id)).filter((v): v is string => v !== null))]

  // Read as evidence for a human. These decide nothing: the database re-checks
  // access itself when a decision is recorded. A failed read fails the whole list,
  // because "no access" and "could not tell" must never look the same.
  const empty = { data: [] as Row[], error: null }
  const reads = userIds.length === 0
    ? [empty, empty, empty, empty]
    : await Promise.all([
        admin.from('profiles').select('id, full_name, email').in('id', userIds),
        courseIds.length === 0 ? Promise.resolve(empty) : admin.from('courses').select('id, title').in('id', courseIds),
        admin.from('entitlements').select('user_id, course_id, status, starts_at, expires_at, revoked_at').in('user_id', userIds),
        admin.from('payments').select('id, reference, user_id, course_id').in('user_id', userIds).eq('status', 'completed'),
      ])
  if (reads.some(r => r.error)) {
    log.error('could not read the facts behind the exception queue')
    return null
  }
  const [profiles, courses, entitlements, completed] = reads.map(r => (r.data ?? []) as Row[])
  const profileOf = new Map(profiles.map(p => [String(p.id), p]))
  const titleOf = new Map(courses.map(c => [String(c.id), text(c.title)]))

  return rows.map(r => {
    const p = payments.get(String(r.payment_id)) ?? null
    const userId = p ? text(p.user_id) : null
    const courseId = p ? text(p.course_id) : null
    const profile = userId ? profileOf.get(userId) ?? null : null
    const sameCourse = (x: Row) => text(x.user_id) === userId && text(x.course_id) === courseId
    return {
      id: String(r.id),
      paymentId: String(r.payment_id),
      state: String(r.state),
      firstSignal: String(r.first_signal),
      lastSignal: String(r.last_signal),
      detail: text(r.detail),
      reportCount: Number(r.report_count),
      firstReportedAt: String(r.first_reported_at),
      lastReportedAt: String(r.last_reported_at),
      paymentReceived: String(r.payment_received),
      accessState: String(r.access_state),
      refundState: String(r.refund_state),
      refundExternalReference: text(r.refund_external_reference),
      refundAmount: r.refund_amount === null || r.refund_amount === undefined ? null : Number(r.refund_amount),
      refundCurrency: text(r.refund_currency),
      refundConfirmedAt: text(r.refund_confirmed_at),
      resolution: text(r.resolution),
      resolvedAt: text(r.resolved_at),
      alertSentAt: text(r.alert_sent_at),
      postSettlementReportAt: text(r.post_settlement_report_at),
      payment: p && {
        reference: String(p.reference),
        status: String(p.status),
        amount: Number(p.amount),
        currency: String(p.currency),
        providerMode: text(p.provider_mode),
      },
      learner: profile && { name: text(profile.full_name), email: text(profile.email) },
      courseTitle: courseId ? titleOf.get(courseId) ?? null : null,
      accessLive: Boolean(userId && courseId) && entitlements.some(e => sameCourse(e) && isEntitlementAccessible(e as never)),
      otherCompletedReference: !userId || !courseId
        ? null
        : text(completed.find(c => sameCourse(c) && String(c.id) !== String(r.payment_id))?.reference),
    }
  })
}

/**
 * What the admin queue shows: everything open, then settled records with a paid
 * report to review, then the most recent resolved. Read apart, so a run of resolved
 * records can never push one that needs a human out of the list. `null` if any read
 * failed.
 */
export async function paymentExceptionQueue(): Promise<PaymentExceptionView[] | null> {
  const [open, flagged, resolved] = await Promise.all([
    listPaymentExceptions({ states: ['open'], limit: 200 }),
    listPaymentExceptions({ states: ['resolved'], flaggedOnly: true, limit: 200 }),
    listPaymentExceptions({ states: ['resolved'], limit: 50 }),
  ])
  if (open === null || flagged === null || resolved === null) return null
  const seen = new Set(flagged.map(e => e.id))
  return [...open, ...flagged, ...resolved.filter(e => !seen.has(e.id))]
}

/** How many exceptions need a human. `null` if it could not be read. */
export async function countOpenPaymentExceptions(): Promise<number | null> {
  const count = (filter: 'open' | 'flagged') => {
    const query = createAdminClient().from('payment_exceptions').select('id', { count: 'exact', head: true })
    return filter === 'open' ? query.eq('state', 'open') : query.eq('state', 'resolved').not('post_settlement_report_at', 'is', null)
  }
  const [open, flagged] = await Promise.all([count('open'), count('flagged')])
  // A missing table can answer a HEAD request with no error and no count. That is
  // "could not tell", never zero.
  if (open.error || flagged.error || open.count === null || open.count === undefined
      || flagged.count === null || flagged.count === undefined) return null
  return open.count + flagged.count
}

/**
 * In-flight payments with a paid notification on record, for the warning before a
 * manual close. A report that failed its signature check is not one.
 */
export async function watchedPaymentIds(): Promise<Set<string>> {
  const { data, error } = await createAdminClient()
    .from('payment_exceptions')
    .select('payment_id')
    .eq('state', 'watching')
    .eq('payment_received', 'reported')
    .limit(500)
  if (error || !Array.isArray(data)) return new Set()
  return new Set(data.map(e => String(e.payment_id)))
}
