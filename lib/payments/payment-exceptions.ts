import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { ownerEmails } from '@/lib/auth/owner-email'
import { sendPaymentExceptionAlert } from '@/lib/email'
import { lastSuccessfulAuditEventAt, logAuditEvent } from '@/lib/audit/log'
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

/** Payment exceptions one alert run considers, per kind. */
const ALERT_CANDIDATES = 200
/** A record still waiting for a person is alerted on again after this long. */
const ALERT_REMINDER_MS = 7 * 24 * 60 * 60 * 1000
const ALERT_COLUMNS = 'id, payment_id, last_signal, evidence_version, repeat_alert_due_at'

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
  /** What a notification said, as a digest. Nothing else can be a repeat. */
  fingerprint?: string | null
  /** The amount the provider reported, where it was not ours. */
  providerAmount?: number | null
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
      p_fingerprint: opts.fingerprint ?? null,
      p_provider_amount: opts.providerAmount ?? null,
    })
    if (error) {
      log.error({ paymentId: opts.paymentId, signal: opts.signal, reason: reasonFromError(error) },
        'could not record a payment exception')
      return { recorded: false, reason: 'write_failed' }
    }
    const result = (data ?? {}) as { outcome?: string; needsAlert?: boolean }
    const quiet = result.outcome === 'replayed' || result.outcome === 'repeated' || result.outcome === 'completion_noted'
    if (result.outcome && !quiet && result.outcome !== 'ignored') {
      log.warn({ paymentId: opts.paymentId, signal: opts.signal, source: opts.source, outcome: result.outcome },
        'payment exception recorded')
    }
    // A replay never sends: it could otherwise send once per notification while a
    // recipient keeps failing. An alert that is still due is the sweep's to retry.
    if (result.needsAlert === true && !quiet) {
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
 * An alert every address refused stays due, and the sweep tries again. The queue in the admin page
 * shows the exception either way. The message names the order reference and
 * nothing else: no learner, no amount, no token. Delivery is at least once:
 * reports arriving together can each send it, which is better than losing it.
 *
 * Repeats of a notification already reviewed are the sweep's alone, at most once
 * per record per week, so they can never send anything on arrival. So is the reminder
 * about a record still waiting for a person a week after its last alert: open, flagged,
 * or holding a different report nobody has reviewed.
 *
 * A different report or a changed answer arriving while an alert goes out stays due,
 * because the stamp states the version and the due time the alert was listed with.
 *
 * A record is stamped once any address accepted, and a refusal is logged, so a failing
 * address cannot re-mail the others on every run. It next hears at the weekly reminder. With
 * every address failing the record stays due. Each run takes a window at a random place among
 * the oldest of each list, as the sweep does for closed attempts.
 *
 * Past `deadline` it starts no new alert, and what is left stays due for the next run. A send
 * already started is not cut short.
 *
 * Never throws, and returns how many exceptions were alerted.
 */
export async function sendPendingExceptionAlerts(opts: { paymentId?: string; limit?: number; deadline?: number } = {}): Promise<number> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return 0
    const recipients = ownerEmails()
    if (recipients.length === 0) {
      log.error('payment exception alert not sent: no administrator address is configured')
      return 0
    }

    const admin = createAdminClient()
    const size = opts.limit ?? 25
    const window = <T,>(rows: readonly T[] | null): T[] => {
      const all = rows ?? []
      if (all.length <= size) return [...all]
      const start = Math.floor(Math.random() * all.length)
      return Array.from({ length: size }, (_, i) => all[(start + i) % all.length])
    }
    const needingAPerson = (filter: 'open' | 'flagged') => {
      const query = admin.from('payment_exceptions').select(ALERT_COLUMNS)
      return filter === 'open' ? query.eq('state', 'open') : query.not('post_settlement_report_at', 'is', null)
    }
    const due = (filter: 'open' | 'flagged') => {
      let query = needingAPerson(filter).is('alert_sent_at', null)
      if (opts.paymentId) query = query.eq('payment_id', opts.paymentId)
      return query.order('first_reported_at', { ascending: true }).limit(ALERT_CANDIDATES)
    }
    const nothing = { data: [] as { id: unknown; payment_id: unknown; last_signal: unknown; evidence_version: unknown; repeat_alert_due_at: unknown }[], error: null }
    // The sweep's alone: these can never send anything because something arrived.
    const reminder = (filter: 'open' | 'flagged') => (opts.paymentId
      ? Promise.resolve(nothing)
      : needingAPerson(filter)
          .lt('alert_sent_at', new Date(Date.now() - ALERT_REMINDER_MS).toISOString())
          .order('first_reported_at', { ascending: true })
          .limit(ALERT_CANDIDATES))
    const repeats = opts.paymentId
      ? nothing
      : await admin
          .from('payment_exceptions')
          .select(ALERT_COLUMNS)
          .not('repeat_alert_due_at', 'is', null)
          .lt('repeat_alert_due_at', new Date().toISOString())
          .order('first_reported_at', { ascending: true })
          .limit(ALERT_CANDIDATES)
    const remindDifferent = opts.paymentId
      ? nothing
      : await admin
          .from('payment_exceptions')
          .select(ALERT_COLUMNS)
          .not('different_report_at', 'is', null)
          .lt('repeat_alerted_at', new Date(Date.now() - ALERT_REMINDER_MS).toISOString())
          .order('first_reported_at', { ascending: true })
          .limit(ALERT_CANDIDATES)
    const [open, flagged, remindOpen, remindFlagged] = await Promise.all([due('open'), due('flagged'), reminder('open'), reminder('flagged')])
    if (open.error || flagged.error || repeats.error || remindOpen.error || remindFlagged.error || remindDifferent.error) {
      log.error('could not list payment exceptions awaiting an alert')
    }
    const lists = [open.data, flagged.data, repeats.data, remindOpen.data, remindFlagged.data, remindDifferent.data]
    if (lists.some(l => (l?.length ?? 0) === ALERT_CANDIDATES)) {
      log.warn({ candidates: ALERT_CANDIDATES }, 'more payment exceptions await an alert than one run considers')
    }
    const byId = new Map(lists.flatMap(l => window(l)).map(e => [String(e.id), e]))
    const data = [...byId.values()]
    if (data.length === 0) return 0

    const { data: payments } = await admin
      .from('payments')
      .select('id, reference')
      .in('id', data.map(e => String(e.payment_id)))
    const referenceOf = new Map((payments ?? []).map(p => [String(p.id), String(p.reference)]))

    let alerted = 0
    for (const exception of data) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        log.warn('payment exception alerts stopped at their share of the sweep budget; the next run continues')
        break
      }
      const reference = referenceOf.get(String(exception.payment_id))
      if (!reference) continue

      let accepted = 0
      for (const to of recipients) {
        const sent = await sendPaymentExceptionAlert(to, { reference })
        if (sent.success && !sent.dryRun) accepted += 1
      }
      if (accepted === 0) {
        log.warn({ exceptionId: exception.id }, 'payment exception alert not delivered; it stays due')
        continue
      }
      if (accepted < recipients.length) {
        log.error({ exceptionId: exception.id }, 'payment exception alert refused for an administrator address; it next hears at the weekly reminder')
      }

      const { data: stamped, error: stampError } = await admin.rpc('payment_exception_mark_alerted', {
        p_exception_id: String(exception.id),
        p_seen_version: Number(exception.evidence_version),
        p_seen_due:     exception.repeat_alert_due_at ?? null,
      })
      if (stampError) log.error({ exceptionId: exception.id }, 'could not record that an alert was sent')
      else if (stamped === true) alerted += 1
    }
    return alerted
  } catch {
    log.error('sending payment exception alerts threw')
    return 0
  }
}

/**
 * A finished sweep, so the admin page can tell when they have stopped. Writes nothing on
 * a deployment that may not act on this database. Counts only, and never throws.
 */
export async function recordSweepFinished(counts: Readonly<Record<string, number>>): Promise<void> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return
    await logAuditEvent({
      eventType: 'payment.reconciliation_sweep_finished',
      actorType: 'system',
      method:    'cron',
      outcome:   'success',
      metadata:  counts,
    })
  } catch {
    log.error('could not record that the sweep finished')
  }
}

/** When a sweep last finished. `readable: false` means it could not be told, which is not "never". */
export function lastSweepFinishedAt(): Promise<{ readonly readable: boolean; readonly at: string | null }> {
  return lastSuccessfulAuditEventAt('payment.reconciliation_sweep_finished')
}

/**
 * Open reports that have sat on an in-flight payment for too long, so they reach
 * an administrator. Moves no payment. Never throws, and returns how many opened.
 */
export async function escalateStaleWatching(olderThanHours: number): Promise<number | null> {
  try {
    if (!(await paymentDatabaseAuthority()).allowed) return 0
    const { data, error } = await createAdminClient().rpc('payment_exception_escalate_watching', {
      p_older_than_hours: olderThanHours,
    })
    if (error) {
      log.error('could not escalate unresolved payment reports')
      return null
    }
    return typeof data === 'number' ? data : 0
  } catch {
    log.error('escalating unresolved payment reports threw')
    return null
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
  | 'reopen_after_review'

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
  /** The version of the record the form showed. Null is refused: nothing says what this covers. */
  seenVersion: number | null
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
    p_seen_version: opts.seenVersion,
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
  seenVersion: number | null
  attestCharged: boolean
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
    p_seen_version:         opts.seenVersion,
    p_attest_charged:       opts.attestCharged,
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
  /** An administrator raised that flag, on a record that stays settled. */
  readonly administratorFlaggedAt: string | null
  /** What a form sends back, so that one from before a change is refused. */
  readonly evidenceVersion: number
  /** What the last administrator wrote. */
  readonly lastDecisionNote: string | null
  readonly lastDecisionAt: string | null
  /**
   * Different reports on this record: notifications, plus one once any could not be
   * stored, plus each different answer from the provider. More than one may mean more
   * than one payment, so a decision on more than one needs its own attestation.
   */
  readonly evidenceCount: number
  /** Different notifications alone. More than one may mean more than one payment. */
  readonly notificationCount: number
  /** More notifications arrived than a record stores, so these counts are floors. */
  readonly evidenceOverflow: boolean
  /** The provider's last answer that questioned this record. A notification cannot write it. */
  readonly providerAnswer: string | null
  /** Every such answer it has given on this record. */
  readonly providerAnswers: readonly string[]
  /** The amount the provider reported, where it was not ours. */
  readonly providerAmount: number | null
  /** Every amount the provider has said was paid on this record. */
  readonly providerAmounts: readonly number[]
  /** Notifications counted since the last review, which reopened and flagged nothing. */
  readonly repeatCount: number
  readonly lastRepeatAt: string | null
  /** One of those had content no review covered, so it is not a plain repeat. */
  readonly differentReportAt: string | null
  readonly differentSignal: string | null
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
  'refund_confirmed_at, resolution, resolved_at, alert_sent_at, post_settlement_report_at, administrator_flagged_at, ' +
  'evidence_fingerprints, evidence_overflow_at, repeat_count, last_repeat_at, different_report_at, different_signal, ' +
  'provider_answer, provider_answers, provider_amount, provider_amounts, evidence_version, ' +
  'last_decision_note, last_decision_at'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/**
 * The exception queue, newest report first. `null` means it could not be read,
 * which is not the same as an empty queue, so the page must say so.
 */
export async function listPaymentExceptions(
  opts: { states?: readonly string[]; limit?: number; flaggedOnly?: boolean; repeatedOnly?: boolean } = {},
): Promise<PaymentExceptionView[] | null> {
  const admin = createAdminClient()
  const base = admin.from('payment_exceptions').select(EXCEPTION_COLUMNS).in('state', [...(opts.states ?? ['open'])])
  const narrowed = opts.flaggedOnly
    ? base.not('post_settlement_report_at', 'is', null)
    : opts.repeatedOnly ? base.gt('repeat_count', 0) : base
  const { data, error } = await narrowed
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
      administratorFlaggedAt: text(r.administrator_flagged_at),
      evidenceVersion: Number(r.evidence_version),
      lastDecisionNote: text(r.last_decision_note),
      lastDecisionAt: text(r.last_decision_at),
      evidenceCount: (Array.isArray(r.evidence_fingerprints) ? r.evidence_fingerprints.length : 0)
        + (Array.isArray(r.provider_answers) ? r.provider_answers.length : 0)
        + Math.max((Array.isArray(r.provider_amounts) ? r.provider_amounts.length : 0) - 1, 0)
        + (r.evidence_overflow_at ? 1 : 0),
      notificationCount: (Array.isArray(r.evidence_fingerprints) ? r.evidence_fingerprints.length : 0)
        + (r.evidence_overflow_at ? 1 : 0),
      evidenceOverflow: Boolean(r.evidence_overflow_at),
      providerAnswer: text(r.provider_answer),
      providerAnswers: Array.isArray(r.provider_answers) ? r.provider_answers.map(String) : [],
      providerAmount: r.provider_amount === null || r.provider_amount === undefined ? null : Number(r.provider_amount),
      providerAmounts: Array.isArray(r.provider_amounts) ? r.provider_amounts.map(Number) : [],
      repeatCount: Number(r.repeat_count ?? 0),
      lastRepeatAt: text(r.last_repeat_at),
      differentReportAt: text(r.different_report_at),
      differentSignal: text(r.different_signal),
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
 * report to review, then reviewed records whose notification has come again, then
 * the most recent resolved. Read apart, so a run of resolved records can never push
 * one that needs a human out of the list. `null` if any read failed.
 */
export async function paymentExceptionQueue(): Promise<PaymentExceptionView[] | null> {
  const [open, flagged, repeated, resolved] = await Promise.all([
    listPaymentExceptions({ states: ['open'], limit: 200 }),
    listPaymentExceptions({ states: ['resolved'], flaggedOnly: true, limit: 200 }),
    listPaymentExceptions({ states: ['resolved'], repeatedOnly: true, limit: 200 }),
    listPaymentExceptions({ states: ['resolved'], limit: 50 }),
  ])
  if (open === null || flagged === null || repeated === null || resolved === null) return null
  const seen = new Set<string>()
  return [...open, ...flagged, ...repeated, ...resolved].filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
}

/** How many exceptions need a human. `null` if it could not be read. */
export async function countOpenPaymentExceptions(): Promise<number | null> {
  const count = (filter: 'open' | 'flagged' | 'repeated') => {
    const query = createAdminClient().from('payment_exceptions').select('id', { count: 'exact', head: true })
    if (filter === 'open') return query.eq('state', 'open')
    if (filter === 'flagged') return query.eq('state', 'resolved').not('post_settlement_report_at', 'is', null)
    return query.eq('state', 'resolved').is('post_settlement_report_at', null).gt('repeat_count', 0)
  }
  const results = await Promise.all([count('open'), count('flagged'), count('repeated')])
  // A missing table can answer a HEAD request with no error and no count. That is
  // "could not tell", never zero.
  if (results.some(r => r.error || r.count === null || r.count === undefined)) return null
  return results.reduce((sum, r) => sum + (r.count as number), 0)
}

/**
 * Payments with a report on record that a manual close must not pass over: a paid one
 * being watched or escalated, or anything counted since a review. The page applies this
 * to in-flight rows only.
 */
export async function watchedPaymentIds(): Promise<Set<string>> {
  const table = () => createAdminClient().from('payment_exceptions').select('payment_id')
  const [watching, repeated] = await Promise.all([
    table().in('state', ['watching', 'open']).in('payment_received', ['reported', 'confirmed_by_operator', 'confirmed_by_provider']).limit(500),
    table().eq('state', 'resolved').gt('repeat_count', 0).limit(500),
  ])
  if (watching.error || repeated.error) log.error('could not read which payments have a notification on record')
  const rows = [watching, repeated].flatMap(r => (!r.error && Array.isArray(r.data) ? r.data : []))
  return new Set(rows.map(e => String(e.payment_id)))
}
