import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { paytechProcessingAvailability } from '@/lib/payments/providers'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { attemptsClosedByAPerson, closeUnopenedAttempt } from '@/lib/payments/payment-completion'
import { escalateStaleWatching, recordSweepFinished, sendPendingExceptionAlerts } from '@/lib/payments/payment-exceptions'
import { PAYTECH_SETTLEMENT_CONTRACT } from '@/lib/payments/paytech-settlement-contract'
import {
  PAYTECH_PAYMENT_COLUMNS,
  reconcilePaytechPayment,
  type PaytechPaymentRow,
} from '@/lib/payments/paytech-reconcile'
import { createLogger } from '@/lib/logger'

/**
 * PayTech reconciliation sweep — XP-PAYTECH-04 (XP-PAYTECH-READY-01 P2).
 *
 * `GET /api/payments/paytech/reconcile`, called by Vercel Cron (`vercel.json`).
 *
 * Before this existed, a payment whose notification was lost, refused or
 * acknowledged before it could be resolved stayed `processing` forever with the
 * money taken. The sweep asks PayTech about opened attempts that have been in
 * flight longer than `STALE_AFTER_MS`, a bounded number per run, through the same
 * procedure the IPN uses, and closes intents that were never opened.
 *
 * ── AUTHENTICATION ────────────────────────────────────────────────────────
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
 * Without CRON_SECRET this route refuses everything (503): an unauthenticated
 * sweep would let anyone make us call the provider. The comparison is constant
 * time over SHA-256 digests, so neither length nor prefix leaks.
 *
 * ── WHAT IT CAN AND CANNOT DO ─────────────────────────────────────────────
 *
 * It can complete a payment PayTech confirms as paid, close one PayTech
 * reliably reports failed or cancelled, and close an intent that was never
 * opened (no token, so no URL was ever handed out — nothing can have been
 * paid). It can NEVER close an opened attempt on a guess: `unknown` and
 * `pending` leave it exactly as it is, for the next run or for a human.
 *
 * Once a settlement contract is confirmed, it also asks about recently closed
 * attempts, so a payment made after closure can be found with no notification, and
 * about recently completed ones, so a provider going back on a payment reaches a person.
 * Both can only record an exception (XP-PAYTECH-05). It also escalates
 * reports that have sat unresolved, and retries any alert not delivered. Those run
 * first, once the caller is authenticated: they need no provider call, so neither a
 * slow provider nor missing PayTech credentials can starve them.
 *
 * A finished run leaves a dated row in the audit log, and the admin page warns when
 * the last one is too old, because a sweep that has stopped cannot report itself.
 *
 * It answers with COUNTS only — no reference, token, amount or identity.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = createLogger('api/payments/paytech/reconcile')

/** An opened attempt younger than this is left to its own notification. */
const STALE_AFTER_MS = 15 * 60 * 1000
/** A never-opened PayTech intent older than this cannot be mid-initialisation. */
const UNOPENED_AFTER_MS = 30 * 60 * 1000
/** How far back a closed attempt is still asked about. */
const LATE_PAID_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
/** Closed or completed attempts asked about per run, of each. The window moves at random within the candidates. */
const CLOSED_BATCH = 10
const CLOSED_CANDIDATES = 200
/** Stop asking the provider past this. The next run takes its own window. */
const SWEEP_BUDGET_MS = 45_000
/** The alerts' share of that, so that a backlog of them cannot cost the provider its turn. */
const ALERT_BUDGET_MS = 20_000
/** How long a report on an in-flight payment may sit before an administrator hears of it. */
const WATCHING_ESCALATES_AFTER_HOURS = 24
/** Bounded work per run. The window moves at random among the oldest and newest, as it does for closed attempts. */
const BATCH = 25
const STALE_CANDIDATES = 200

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest()
}

function authorised(req: Request, secret: string): boolean {
  const given = req.headers.get('authorization') ?? ''
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`))
}

export async function GET(req: Request) {
  const secret = (process.env.CRON_SECRET ?? '').trim()
  if (secret.length < 16) {
    log.error('reconciliation sweep refused: CRON_SECRET is not configured')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (!authorised(req, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // The budget covers the whole run. A function cut off partway finishes no sweep, and the
  // admin page then warns of one overdue.
  const started = Date.now()

  // ── 0. what needs no provider call goes first ──
  // Each asks whether this deployment may act on this database, so neither writes
  // anything on one that may not.
  const escalated = await escalateStaleWatching(WATCHING_ESCALATES_AFTER_HOURS)
  const counts: Record<string, number> = {
    checked: 0,
    closedUnopened: 0,
    escalated: escalated ?? 0,
    alertsSent: await sendPendingExceptionAlerts({ deadline: started + ALERT_BUDGET_MS }),
  }
  if (escalated === null) counts.escalationFailed = 1
  if (Date.now() - started > ALERT_BUDGET_MS) counts.stoppedAtBudget = 1

  const availability = paytechProcessingAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'reconciliation sweep skipped: processing unavailable')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (!(await paymentDatabaseAuthority()).allowed) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  const admin = createAdminClient()
  const now = Date.now()

  // ── 1. intents that were never opened ──
  const { data: unopened, error: unopenedError } = await admin
    .from('payments')
    .select('id')
    .eq('provider', 'paytech')
    .eq('status', 'pending')
    .is('provider_token', null)
    .lt('created_at', new Date(now - UNOPENED_AFTER_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH)

  if (unopenedError) {
    log.error('reconciliation sweep could not list unopened intents')
    return NextResponse.json({ error: 'retry' }, { status: 503 })
  }
  for (const row of unopened ?? []) {
    const { changed } = await closeUnopenedAttempt({ paymentId: String(row.id), failureReason: 'abandoned_unopened' })
    if (changed) counts.closedUnopened += 1
  }

  // ── 2. opened attempts in flight for too long ──
  const { data: stale, error: staleError } = await admin
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('provider', 'paytech')
    .in('status', ['pending', 'processing'])
    .not('provider_token', 'is', null)
    .lt('created_at', new Date(now - STALE_AFTER_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(STALE_CANDIDATES)
  // Attempts that keep answering "pending" collect at the old end, so the new end is read
  // apart, or a recent payment could wait behind them for good.
  const { data: recentStale, error: recentStaleError } = await admin
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('provider', 'paytech')
    .in('status', ['pending', 'processing'])
    .not('provider_token', 'is', null)
    .lt('created_at', new Date(now - STALE_AFTER_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(STALE_CANDIDATES)

  if (staleError || recentStaleError) {
    log.error('reconciliation sweep could not list stale attempts')
    return NextResponse.json({ error: 'retry' }, { status: 503 })
  }
  // Both ends full: there may be attempts between them. One more read, from a random place
  // in that gap, so that none can wait behind both for good.
  let middleStale: unknown[] = []
  if (stale?.length === STALE_CANDIDATES && recentStale?.length === STALE_CANDIDATES) {
    log.warn({ candidates: STALE_CANDIDATES * 2 }, 'more stale attempts than one sweep considers')
    const from = new Date(String(stale[stale.length - 1].created_at)).getTime()
    const to = new Date(String(recentStale[recentStale.length - 1].created_at)).getTime()
    if (to > from) {
      const { data: middle, error: middleError } = await admin
        .from('payments')
        .select(PAYTECH_PAYMENT_COLUMNS)
        .eq('provider', 'paytech')
        .in('status', ['pending', 'processing'])
        .not('provider_token', 'is', null)
        .lt('created_at', new Date(from + Math.random() * (to - from)).toISOString())
        .order('created_at', { ascending: false })
        .limit(STALE_CANDIDATES)
      if (middleError) log.error('reconciliation sweep could not list the attempts in the middle')
      middleStale = middle ?? []
    }
  }
  const staleById = new Map(([...(stale ?? []), ...(recentStale ?? []), ...middleStale] as PaytechPaymentRow[]).map(r => [String(r.id), r]))
  const staleRows = [...staleById.values()]
  const staleStart = staleRows.length > BATCH ? Math.floor(Math.random() * staleRows.length) : 0
  const staleWindow = Array.from({ length: Math.min(BATCH, staleRows.length) }, (_, i) => staleRows[(staleStart + i) % staleRows.length])

  for (const row of staleWindow) {
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      log.warn('reconciliation sweep stopped at its time budget; the next run continues')
      counts.stoppedAtBudget = 1
      break
    }
    counts.checked += 1
    const result = await reconcilePaytechPayment(row, { source: 'sweep' })
    counts[result.kind] = (counts[result.kind] ?? 0) + 1
  }

  // ── 3. closed attempts that may have been paid afterwards, and completed ones the
  // provider may have gone back on ──
  // Skipped with no confirmed contract: the answer could only be `unknown`.
  if (PAYTECH_SETTLEMENT_CONTRACT !== null) {
    const sinceSettled = async (statuses: readonly string[], counter: 'closedByAPersonChecked' | 'closedChecked' | 'completedChecked', recheck: boolean) => {
      const { data, error } = counter === 'closedByAPersonChecked'
        ? await attemptsClosedByAPerson(PAYTECH_PAYMENT_COLUMNS, CLOSED_CANDIDATES)
        : await admin
          .from('payments')
          .select(PAYTECH_PAYMENT_COLUMNS)
          .eq('provider', 'paytech')
          .in('status', [...statuses])
          .not('provider_token', 'is', null)
          .gt('created_at', new Date(now - LATE_PAID_LOOKBACK_MS).toISOString())
          .order('created_at', { ascending: false })
          .limit(CLOSED_CANDIDATES)
      if (error) {
        log.error({ counter }, 'reconciliation sweep could not list settled attempts')
        return false
      }
      const rows = (data ?? []) as unknown as PaytechPaymentRow[]
      if (rows.length === CLOSED_CANDIDATES) {
        log.warn({ candidates: CLOSED_CANDIDATES, counter }, 'more settled attempts than one sweep considers')
      }
      const start = rows.length > CLOSED_BATCH ? Math.floor(Math.random() * rows.length) : 0
      const window = Array.from({ length: Math.min(CLOSED_BATCH, rows.length) }, (_, i) => rows[(start + i) % rows.length])
      counts[counter] = 0
      for (const row of window) {
        if (Date.now() - started > SWEEP_BUDGET_MS) {
          log.warn('reconciliation sweep stopped at its time budget; the next run continues')
          counts.stoppedAtBudget = 1
          break
        }
        counts[counter] += 1
        const result = await reconcilePaytechPayment(row, { source: 'sweep', recheck })
        if (result.kind === 'exception_unrecorded') {
          counts.exception_unrecorded = (counts.exception_unrecorded ?? 0) + 1
        }
      }
      return true
    }
    if (!(await sinceSettled([], 'closedByAPersonChecked', false))
     || !(await sinceSettled(['failed', 'cancelled', 'expired', 'refunded'], 'closedChecked', false))
     || !(await sinceSettled(['completed'], 'completedChecked', true))) {
      return NextResponse.json({ error: 'retry' }, { status: 503 })
    }
  }

  // A run that left work undone is not a finished sweep. If that keeps happening, the page warns.
  if (!counts.stoppedAtBudget && !counts.escalationFailed && !counts.exception_unrecorded) await recordSweepFinished(counts)
  log.info(counts, 'PayTech reconciliation sweep finished')
  return NextResponse.json({ ok: true, ...counts })
}
