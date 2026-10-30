import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { paytechProcessingAvailability } from '@/lib/payments/providers'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { closeUnopenedAttempt } from '@/lib/payments/payment-completion'
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
 * It answers with COUNTS only — no reference, token, amount or identity.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = createLogger('api/payments/paytech/reconcile')

/** An opened attempt younger than this is left to its own notification. */
const STALE_AFTER_MS = 15 * 60 * 1000
/** A never-opened PayTech intent older than this cannot be mid-initialisation. */
const UNOPENED_AFTER_MS = 30 * 60 * 1000
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
    counts.checked += 1
    const result = await reconcilePaytechPayment(row, { source: 'sweep' })
    counts[result.kind] = (counts[result.kind] ?? 0) + 1
  }

  log.info(counts, 'PayTech reconciliation sweep finished')
  return NextResponse.json({ ok: true, ...counts })
}
