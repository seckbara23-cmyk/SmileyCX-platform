import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { paytechProcessingAvailability } from '@/lib/payments/providers'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { closeUnopenedAttempt } from '@/lib/payments/payment-completion'
import { escalateStaleWatching, sendPendingExceptionAlerts } from '@/lib/payments/payment-exceptions'
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
 * money taken. The sweep asks PayTech about every opened attempt that has been
 * in flight longer than `STALE_AFTER_MS`, through the same procedure the IPN
 * uses, and closes intents that were never opened.
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
 * attempts, so a payment made after closure is found even if no notification
 * arrives. That can only record an exception (XP-PAYTECH-05). It also escalates
 * reports that have sat unresolved, and retries any alert not delivered. Those run
 * first: they need no provider call, so a slow provider cannot starve them.
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
/** Closed attempts asked about per run. The window is random, so none is starved. */
const CLOSED_BATCH = 10
const CLOSED_CANDIDATES = 200
/** Stop asking the provider past this. The next run picks up what is left. */
const SWEEP_BUDGET_MS = 45_000
/** How long a report on an in-flight payment may sit before an administrator hears of it. */
const WATCHING_ESCALATES_AFTER_HOURS = 24
/** Bounded work per run; the oldest go first. */
const BATCH = 25

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
  const counts: Record<string, number> = { checked: 0, closedUnopened: 0 }

  // ── 0. what needs no provider call goes first ──
  counts.escalated = await escalateStaleWatching(WATCHING_ESCALATES_AFTER_HOURS)
  counts.alertsSent = await sendPendingExceptionAlerts()

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
    .limit(BATCH)

  if (staleError) {
    log.error('reconciliation sweep could not list stale attempts')
    return NextResponse.json({ error: 'retry' }, { status: 503 })
  }

  for (const row of (stale ?? []) as PaytechPaymentRow[]) {
    if (Date.now() - now > SWEEP_BUDGET_MS) {
      log.warn('reconciliation sweep stopped at its time budget; the next run continues')
      break
    }
    counts.checked += 1
    const result = await reconcilePaytechPayment(row, { source: 'sweep' })
    counts[result.kind] = (counts[result.kind] ?? 0) + 1
  }

  // ── 3. closed attempts that may have been paid afterwards ──
  // Skipped with no confirmed contract: the answer could only be `unknown`.
  if (PAYTECH_SETTLEMENT_CONTRACT !== null) {
    const { data: closed, error: closedError } = await admin
      .from('payments')
      .select(PAYTECH_PAYMENT_COLUMNS)
      .eq('provider', 'paytech')
      .in('status', ['failed', 'cancelled', 'expired'])
      .not('provider_token', 'is', null)
      .gt('created_at', new Date(now - LATE_PAID_LOOKBACK_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(CLOSED_CANDIDATES)

    if (closedError) {
      log.error('reconciliation sweep could not list closed attempts')
      return NextResponse.json({ error: 'retry' }, { status: 503 })
    }
    const rows = (closed ?? []) as PaytechPaymentRow[]
    if (rows.length === CLOSED_CANDIDATES) {
      log.warn({ candidates: CLOSED_CANDIDATES }, 'more closed attempts than one sweep considers; the oldest are not asked about')
    }
    const start = rows.length > CLOSED_BATCH ? Math.floor(Math.random() * rows.length) : 0
    const window = Array.from({ length: Math.min(CLOSED_BATCH, rows.length) }, (_, i) => rows[(start + i) % rows.length])
    counts.closedChecked = 0
    for (const row of window) {
      if (Date.now() - now > SWEEP_BUDGET_MS) {
        log.warn('reconciliation sweep stopped at its time budget; the next run continues')
        break
      }
      counts.closedChecked += 1
      const result = await reconcilePaytechPayment(row, { source: 'sweep' })
      if (result.kind === 'exception_unrecorded') {
        counts.exception_unrecorded = (counts.exception_unrecorded ?? 0) + 1
      }
    }
  }

  log.info(counts, 'PayTech reconciliation sweep finished')
  return NextResponse.json({ ok: true, ...counts })
}
