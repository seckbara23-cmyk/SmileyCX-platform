import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePaytechConfig, PaytechConfigError } from '@/lib/payments/paytech-config'
import { paytechProcessingAvailability } from '@/lib/payments/providers'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import {
  verifyPaytechIpn,
  verifySharedSecretOnly,
  VERIFIED_STRENGTH,
} from '@/lib/payments/paytech-ipn'
import { touchIpnReceipt } from '@/lib/payments/payment-completion'
import {
  PAYTECH_PAYMENT_COLUMNS,
  reconcilePaytechPayment,
  type PaytechPaymentRow,
  type ReconcileResult,
} from '@/lib/payments/paytech-reconcile'
import { createLogger } from '@/lib/logger'

/**
 * PayTech IPN — XP-PAYTECH-01 Phase D, rebuilt on reconciliation by XP-PAYTECH-04.
 *
 * `POST /api/payments/paytech/ipn`. A notification is a HINT that something
 * happened to one payment. It is authenticated, correlated to a row we hold,
 * cross-checked against that row — and then handed to the same
 * reconciliation procedure the sweep and the admin use, which asks PayTech,
 * under the confirmed contract, what actually happened.
 *
 * ── A BROWSER CAN NEVER REACH THIS OUTCOME ────────────────────────────────
 *
 * `/payment/success` reads the database and renders what it finds. It calls
 * nothing here and completes nothing.
 *
 * ── THE ORDER OF CHECKS IS LOAD-BEARING ───────────────────────────────────
 *
 *   1. METHOD. Only POST exists; everything else is 405.
 *   2. PROCESSING AVAILABLE. Credentials resolve and the mode belongs to this
 *      environment. NOT the sales switch: closing checkout must never strand
 *      a payment already taken (XP-PAYTECH-04 safeguard 2).
 *   3. SHARED SECRET, BEFORE ANY LOOKUP, so an unauthenticated caller cannot
 *      probe which tokens exist.
 *   4. CORRELATE on `provider_token`, the UNIQUE replay key (060).
 *   5. SIGNATURE, built from the stored row's amount and reference.
 *   6. CROSS-CHECK the payload's own claims against the row.
 *   7. RECONCILE — the provider decides; the notification never does.
 *
 * ── WHAT THE STATUS CODES MEAN TO THE PROVIDER ────────────────────────────
 *
 * PayTech's retry policy is undocumented, so these are written to be correct
 * whether or not it retries — the sweep is the safety net either way:
 *
 *   200  handled: completed, already completed, reliably failed/cancelled,
 *        reliably pending, or a refusal no retry can fix (recorded in
 *        `failure_reason` for a human).
 *   401  not authentic. Nothing was read, nothing written.
 *   404  no payment carries this token.
 *   503  not resolved YET — settlement unknown (including "contract not
 *        confirmed"), a transient database fault, or processing unavailable
 *        here. Asking again is safe: every path is idempotent.
 *
 * ── LOGS CARRY NO SECRETS AND NO PERSONAL DATA ────────────────────────────
 *
 * Never the provider token, `client_phone`, an email, a credential or a hash
 * of one, and never the raw payload.
 */

// node:crypto is required for the signature check, so this cannot run on edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = createLogger('api/payments/paytech/ipn')

/** A notification body larger than this is not a notification. */
const MAX_BODY_BYTES = 64 * 1024

/** Acknowledge. The body is deliberately uninformative to the caller. */
function ack(detail: string) {
  return NextResponse.json({ received: true, detail }, { status: 200 })
}

/** Not resolved yet — please come back. */
function retry(detail: string) {
  return NextResponse.json(
    { error: 'retry', detail },
    { status: 503, headers: { 'Retry-After': '300' } },
  )
}

/**
 * Parse a notification body.
 *
 * PayTech's documentation shows JSON while its PHP example and plugins read
 * form fields, so both are accepted. Form values are all strings, which is why
 * every reader in `paytech-ipn.ts` tolerates string forms.
 */
async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null

  const raw = await req.text()
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null

  const contentType = (req.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }

  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through to form parsing */
  }
  const form = Object.fromEntries(new URLSearchParams(raw))
  return Object.keys(form).length > 0 ? form : null
}

/** The payload's own claimed amount, for the cross-check. Never used as truth. */
function claimedAmount(payload: Record<string, unknown>): number | null {
  for (const key of ['final_item_price', 'item_price_xof', 'item_price']) {
    const v = payload[key]
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
    if (Number.isFinite(n)) return n
  }
  return null
}

/** How a reconciliation result is answered to the provider. */
function respond(result: ReconcileResult) {
  switch (result.kind) {
    case 'completed':        return ack('completed')
    case 'already_completed':return ack('already_completed')
    case 'failed':           return ack('failed')
    case 'cancelled':        return ack('cancelled')
    case 'already_terminal': return ack('already_terminal')
    case 'pending':          return ack('unsettled:pending')
    case 'unknown':          return retry(`unsettled:${result.reason}`)
    case 'refused':          return result.retryable ? retry(`refused:${result.reason}`) : ack(`refused:${result.reason}`)
    case 'ineligible':       return ack(`ineligible:${result.reason}`)
  }
}

export async function POST(req: Request) {
  // ── 2. may this deployment process PayTech payments? ──
  const availability = paytechProcessingAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'PayTech IPN received but processing is unavailable')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  let config
  try {
    config = resolvePaytechConfig()
  } catch (err) {
    const why = err instanceof PaytechConfigError ? 'config_invalid' : 'unexpected'
    log.error({ why }, 'PayTech IPN could not resolve configuration')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  const payload = await parseBody(req)
  if (payload === null) {
    log.warn('PayTech IPN body was unusable')
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // ── 3. the official check, BEFORE any database read ──
  if (!verifySharedSecretOnly(payload, config)) {
    log.warn('PayTech IPN failed the shared-secret check')
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // After the shared-secret check, so an unauthenticated request reads nothing.
  if (!(await paymentDatabaseAuthority()).allowed) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (token.length === 0) {
    log.warn('PayTech IPN carried no token')
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // ── 4. correlate on the UNIQUE replay key ──
  const { data, error: lookupError } = await createAdminClient()
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('provider_token', token)
    .maybeSingle()

  if (lookupError) {
    log.error('PayTech IPN could not read the payment row')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  const payment = data as PaytechPaymentRow | null
  if (!payment) {
    log.warn('PayTech IPN referenced a token no payment carries')
    return NextResponse.json({ error: 'unknown_transaction' }, { status: 404 })
  }

  // Every notification is recorded, successful or not (obligation 6).
  await touchIpnReceipt({ providerToken: token })

  if (payment.provider !== 'paytech') {
    log.error({ paymentId: payment.id }, 'PayTech IPN matched a payment from another provider')
    await touchIpnReceipt({ providerToken: token, failureReason: 'provider_confusion' })
    return ack('provider_mismatch')
  }

  // ── 5. the signature, against OUR stored values ──
  // AUTHENTICITY ONLY: the signed message is `amount|ref_command|api_key`,
  // which contains no outcome. It never proves that money moved.
  const verification = verifyPaytechIpn({
    payload,
    config,
    expected: { amount: Number(payment.amount), refCommand: String(payment.reference) },
  })

  // `authenticated` also requires a SALE event (sale_complete / sale_canceled).
  // Refunds and transfers are delivered to other URLs; a signed notification
  // of any other kind is not for this endpoint and is refused, even though the
  // provider — not the event — would decide the outcome.
  if (!verification.authenticated
      || verification.strength !== VERIFIED_STRENGTH
      || verification.refCommand !== String(payment.reference)) {
    log.error(
      { paymentId: payment.id, strength: verification.strength, reason: verification.reason },
      'PayTech IPN is not authentic for this payment',
    )
    await touchIpnReceipt({
      providerToken: token,
      failureReason: `ipn_${verification.reason ?? 'reference_mismatch'}`,
    })
    return ack('unverified')
  }

  // ── 6. the independent cross-checks ──
  const claimed = claimedAmount(payload)
  if (claimed !== null && claimed !== Number(payment.amount)) {
    log.error({ paymentId: payment.id }, 'PayTech IPN reported an amount that is not the stored one')
    await touchIpnReceipt({ providerToken: token, failureReason: 'ipn_amount_mismatch' })
    return ack('amount_mismatch')
  }
  const claimedCurrency = typeof payload.currency === 'string' ? payload.currency.trim().toUpperCase() : null
  if (claimedCurrency !== null && claimedCurrency !== payment.currency) {
    log.error({ paymentId: payment.id }, 'PayTech IPN reported a currency that is not the stored one')
    await touchIpnReceipt({ providerToken: token, failureReason: 'ipn_currency_mismatch' })
    return ack('currency_mismatch')
  }

  // ── 7. reconcile: the provider decides, not the notification ──
  // `type_event` (verification.event) is unauthenticated and is used for
  // nothing but this log line.
  const result = await reconcilePaytechPayment(payment, { source: 'ipn' })
  log.info({ paymentId: payment.id, hint: verification.event, result: result.kind }, 'PayTech IPN reconciled')
  return respond(result)
}

/**
 * Everything that is not POST. Declared so the refusal is explicit and
 * testable: a GET to this path can never fulfil anything.
 */
export async function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 })
}
export const HEAD = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET
