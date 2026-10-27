import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePaytechConfig, PaytechConfigError } from '@/lib/payments/paytech-config'
import { paytechAvailability } from '@/lib/payments/providers'
import { confirmPaymentStatus } from '@/lib/payments/paytech-client'
import {
  verifyPaytechIpn,
  verifySharedSecretOnly,
  VERIFIED_STRENGTH,
} from '@/lib/payments/paytech-ipn'
import {
  completeVerifiedPayment,
  recordTerminalFailure,
  touchIpnReceipt,
} from '@/lib/payments/payment-completion'
import { createLogger } from '@/lib/logger'

/**
 * PayTech IPN — XP-PAYTECH-01 Phase D.
 *
 * `POST /api/payments/paytech/ipn`, the URL already registered in the PayTech
 * merchant dashboard. This is the ONLY path in the application that can cause a
 * course entitlement to be granted by a payment, and it reaches that outcome
 * through exactly one module: `lib/payments/payment-completion.ts`.
 *
 * ── A BROWSER CAN NEVER REACH THIS OUTCOME ────────────────────────────────
 *
 * `/payment/success` reads the database and renders whatever it finds. It calls
 * nothing here, completes nothing, and cannot. A learner who crafts a success
 * redirect, or replays one, changes no row. That separation is the point of
 * Phase E and it is asserted by test.
 *
 * ── THE ORDER OF CHECKS IS LOAD-BEARING ───────────────────────────────────
 *
 *   1. METHOD. Only POST exists; everything else is 405.
 *   2. PROVIDER ENABLED. A deployment where PayTech is not offered does not
 *      process PayTech notifications either, or a preview flag would become a
 *      production fulfilment path.
 *   3. SHARED SECRET, BEFORE ANY LOOKUP. The official sha256-constant check
 *      needs only our credentials. Running it first means an unauthenticated
 *      caller cannot probe which provider tokens exist.
 *   4. CORRELATE on `provider_token`, the UNIQUE replay key (migration 060).
 *   5. SIGNATURE, against the stored row. The HMAC message is built from the
 *      row's own amount and reference, so a notification claiming a different
 *      amount cannot verify.
 *   6. INDEPENDENT CROSS-CHECK. The payload's own claimed amount is compared
 *      against the row too. The signature already covers our amount, so this
 *      catches the different failure of a provider that signs one value and
 *      reports another.
 *   7. ONLY THEN fulfil, and only for `sale_complete`.
 *
 * ── WHAT THE STATUS CODES MEAN TO THE PROVIDER ────────────────────────────
 *
 * PayTech retries, so the response is a control signal rather than decoration:
 *
 *   200  handled — including an idempotent repeat, and including a refusal that
 *        retrying cannot fix. Acking a mismatch is deliberate: a retry loop
 *        would add noise without changing the outcome, and the refusal is
 *        recorded in `failure_reason` for reconciliation instead.
 *   401  not authentic. Nothing was read, nothing written.
 *   404  no payment carries this token.
 *   503  transient — the one retryable refusal (`entitlement_race`), or our own
 *        unavailability. Retrying this one genuinely can succeed.
 *
 * ── LOGS CARRY NO SECRETS AND NO PERSONAL DATA ────────────────────────────
 *
 * Never the provider token (it is the replay key), never `client_phone`, never
 * an email, never a credential or a hash of one, and never the raw payload. The
 * payment id and a machine-readable reason are enough to find the row.
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

/**
 * Parse a notification body.
 *
 * PayTech's documentation shows JSON while its PHP example posts
 * `application/x-www-form-urlencoded`, so both are accepted. Form values are
 * all strings, which is why every reader in `paytech-ipn.ts` tolerates string
 * forms of numbers and booleans.
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

  // No usable content type: try JSON, then form. A provider that omits the
  // header should not cost us the notification.
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

export async function POST(req: Request) {
  // ── 2. is PayTech processed on this deployment at all? ──
  const availability = paytechAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'PayTech IPN received but provider is not enabled')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  let config
  try {
    config = resolvePaytechConfig()
  } catch (err) {
    // Availability already proved the credentials resolve, so this is defensive.
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

  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (token.length === 0) {
    log.warn('PayTech IPN carried no token')
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // ── 4. correlate on the UNIQUE replay key ──
  const admin = createAdminClient()
  const { data: payment, error: lookupError } = await admin
    .from('payments')
    .select('id, user_id, course_id, amount, currency, reference, status, provider, provider_mode')
    .eq('provider_token', token)
    .maybeSingle()

  if (lookupError) {
    log.error('PayTech IPN could not read the payment row')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (!payment) {
    // Authenticated but unknown. Not retryable: no payment will appear later.
    log.warn('PayTech IPN referenced a token no payment carries')
    return NextResponse.json({ error: 'unknown_transaction' }, { status: 404 })
  }

  // Every notification is recorded, successful or not (obligation 6).
  await touchIpnReceipt({ providerToken: token })

  // The row must actually be a PayTech row. A token collision across providers
  // is implausible, but fulfilling a PayDunya payment on a PayTech signature
  // would be a provider-confusion bug, so it is refused explicitly.
  if (payment.provider !== null && payment.provider !== 'paytech') {
    log.error({ paymentId: payment.id }, 'PayTech IPN matched a payment from another provider')
    await touchIpnReceipt({ providerToken: token, failureReason: 'provider_confusion' })
    return ack('provider_mismatch')
  }

  // ── 5. the signature, against OUR stored values ──
  const verification = verifyPaytechIpn({
    payload,
    config,
    expected: {
      amount:     Number(payment.amount),
      refCommand: String(payment.reference),
    },
  })

  // AUTHENTICITY ONLY. This establishes that the sender knows our API secret
  // and that the notification concerns this amount and this reference. It does
  // NOT establish that money moved: the signed message is
  // `amount|ref_command|api_key`, which contains no status field, so
  // `hmac_compute` is identical for a completion and a cancellation of the
  // same order. Settlement is decided further down, by asking PayTech.
  if (!verification.authenticated || verification.strength !== VERIFIED_STRENGTH) {
    log.error(
      { paymentId: payment.id, strength: verification.strength, reason: verification.reason },
      'PayTech IPN is not authentic for this payment',
    )
    await touchIpnReceipt({
      providerToken: token,
      failureReason: `ipn_${verification.reason ?? 'unverified'}`,
    })
    return ack('unverified')
  }

  // ── 6. the independent cross-check ──
  // The signature already proves the provider signed OUR amount. This catches
  // the different failure of a provider that signs one value and reports
  // another, which no amount of signing would reveal on its own.
  const claimed = claimedAmount(payload)
  if (claimed !== null && claimed !== Number(payment.amount)) {
    log.error({ paymentId: payment.id }, 'PayTech IPN reported an amount that is not the stored one')
    await touchIpnReceipt({ providerToken: token, failureReason: 'ipn_amount_mismatch' })
    return ack('amount_mismatch')
  }

  const claimedCurrency = typeof payload.currency === 'string' ? payload.currency.trim() : null
  if (claimedCurrency !== null && claimedCurrency !== payment.currency) {
    log.error({ paymentId: payment.id }, 'PayTech IPN reported a currency that is not the stored one')
    await touchIpnReceipt({ providerToken: token, failureReason: 'ipn_currency_mismatch' })
    return ack('currency_mismatch')
  }

  if (verification.refCommand !== String(payment.reference)) {
    // The signature covers our reference, so this should be unreachable; it is
    // asserted anyway because correlation errors are the expensive kind.
    log.error({ paymentId: payment.id }, 'PayTech IPN reference did not match the stored reference')
    await touchIpnReceipt({ providerToken: token, failureReason: 'ipn_reference_mismatch' })
    return ack('reference_mismatch')
  }

  // A payment with no learner or no course cannot be fulfilled coherently.
  if (!payment.user_id || !payment.course_id) {
    log.error({ paymentId: payment.id }, 'PayTech IPN matched an incomplete payment row')
    await touchIpnReceipt({ providerToken: token, failureReason: 'payment_identity_incomplete' })
    return ack('incomplete_payment')
  }

  // ── 7. SETTLEMENT: ask PayTech, over a channel the payer cannot influence ──
  //
  // This is the fix for the XP-PAYTECH-01 defect. `type_event` is NOT part of
  // the signed message, so the notification's own claim about the outcome is
  // unauthenticated: a party holding one authentic notification for this order
  // could flip `sale_canceled` to `sale_complete` and the signature would
  // still verify. The event is therefore demoted to a HINT — it tells us a
  // check is worth making, and nothing more.
  //
  // `confirmPaymentStatus()` never throws and never guesses: a transport
  // failure, a refusal, an unparseable body and an unrecognised status all
  // resolve to `unknown`, which fulfils nothing.
  const settlement = await confirmPaymentStatus(token)

  log.info(
    { paymentId: payment.id, hint: verification.event, settlement: settlement.outcome },
    'PayTech settlement confirmed server-to-server',
  )

  // The confirmed amount, where PayTech reports one, must be ours. The IPN's
  // claimed amount was already checked; this checks the authoritative source.
  if (settlement.amount !== null && settlement.amount !== Number(payment.amount)) {
    log.error({ paymentId: payment.id }, 'PayTech confirmed an amount that is not the stored one')
    await touchIpnReceipt({ providerToken: token, failureReason: 'settlement_amount_mismatch' })
    return ack('amount_mismatch')
  }

  if (settlement.outcome === 'cancelled') {
    // Out-of-order safety: `recordTerminalFailure` refuses to touch a payment
    // that is already `completed`, so a late cancellation cannot revoke a
    // verified purchase.
    const { changed } = await recordTerminalFailure({
      providerToken: token,
      status:        'cancelled',
      failureReason: 'settlement_cancelled',
    })
    return ack(changed ? 'cancelled' : 'already_terminal')
  }

  if (settlement.outcome !== 'paid') {
    // 'pending' and 'unknown' both land here. Nothing is written beyond
    // forensics, and the provider is told we received it: a retry would ask
    // the same question and get the same answer, and a pending transaction
    // will produce its own notification when it settles.
    await touchIpnReceipt({
      providerToken: token,
      failureReason: `settlement_${settlement.outcome}`,
    })
    log.error(
      { paymentId: payment.id, settlement: settlement.outcome },
      'PayTech did not confirm settlement; fulfilling nothing',
    )
    return ack(`unsettled:${settlement.outcome}`)
  }

  // `complete_payment()` serialises on the locked payment row, so two
  // concurrent notifications for the same token cannot both fulfil: the second
  // observes 'completed' and returns `already_completed`.
  const outcome = await completeVerifiedPayment({
    provider:          'paytech',
    providerMode:      config.providerMode,
    providerToken:     token,
    providerReference: String(payment.reference),
    reference:         String(payment.reference),
    amount:            Number(payment.amount),
    currency:          String(payment.currency),
  })

  if (outcome.kind === 'already_completed') {
    // A SUCCESS. Acking it is what stops the provider redelivering (obligation 8).
    log.info({ paymentId: payment.id }, 'PayTech IPN was a duplicate of a completed payment')
    return ack('already_completed')
  }

  if (outcome.kind === 'refused') {
    await touchIpnReceipt({ providerToken: token, failureReason: outcome.reason })
    log.error(
      { paymentId: payment.id, reason: outcome.reason, retryable: outcome.retryable },
      'payment completion refused',
    )
    // Only the retryable one asks the provider to come back.
    return outcome.retryable
      ? NextResponse.json({ error: 'retry' }, { status: 503 })
      : ack(`refused:${outcome.reason}`)
  }

  log.info({ paymentId: payment.id }, 'payment completed and entitlement granted')
  return ack('completed')
}

/**
 * Everything that is not POST.
 *
 * Next.js already answers an undeclared method with 405, but declaring these
 * makes the refusal explicit and testable rather than incidental — and makes it
 * obvious that a GET to this path can never fulfil anything.
 */
export async function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 })
}
export const HEAD = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET
