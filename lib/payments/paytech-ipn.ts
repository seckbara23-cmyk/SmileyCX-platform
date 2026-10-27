import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PaytechConfig } from '@/lib/payments/paytech-config'

/**
 * PayTech IPN authenticity — XP-PAYTECH-01.
 *
 * Pure functions. No network, no database, no logging, no Supabase client. It
 * decides only whether a notification is authentic and what it says; acting on
 * that is `payment-completion.ts`'s business.
 *
 * ══ THE CENTRAL PROBLEM, STATED PLAINLY ═══════════════════════════════════
 *
 * PayDunya gives this codebase a server-to-server confirm endpoint, so
 * `paydunya-client.ts` can establish that money moved over a channel the
 * learner cannot touch, and the IPN is reduced to a hint. PayTech gives us
 * neither of those comforts:
 *
 *   * NO VERIFICATION ENDPOINT. Nothing in paytech.sn/doc, the official
 *     integration guide (doc.paytech.sn/PayTech.pdf) or the community PHP SDK
 *     documents any way to ask PayTech the status of an existing transaction.
 *     So the IPN is not a hint here — it is the only evidence that exists.
 *
 *   * THE OFFICIAL VERIFICATION METHOD IS NOT A SIGNATURE. The official guide
 *     says to verify a notification "en comparant le hash en sha256 de sa clé
 *     API et clé secrète avec les deux clés que nous lui avons envoyées" —
 *     i.e. compare `sha256(api_key)` and `sha256(api_secret)` against the
 *     `api_key_sha256` and `api_secret_sha256` fields in the payload.
 *
 *     Those two values are CONSTANTS. They are identical in every notification
 *     this merchant will ever receive, they cover none of the payload, and
 *     anyone who observes one notification can replay it forever or forge a
 *     new one with any amount they like. It is the same category of mistake as
 *     PayDunya's `hash`, which migration 062 documents at length.
 *
 * ══ WHAT WE DO ABOUT IT ═══════════════════════════════════════════════════
 *
 * PayTech's current documentation adds `hmac_compute`: HMAC-SHA256 over
 * `amount|ref_command|api_key`, keyed by `api_secret`. That IS a signature over
 * payload data, and it is the only mechanism here capable of integrity.
 *
 * Two deliberate choices make it safe to rely on:
 *
 *   1. THE SIGNED MESSAGE IS BUILT FROM OUR OWN STORED VALUES, never from the
 *      payload. We take the amount and reference from the payment row we
 *      already hold, construct the message, and compare. A notification that
 *      claims a different amount therefore cannot match — we never read its
 *      amount at all. This also disposes of a documented ambiguity (whether the
 *      provider signs `item_price` or `final_item_price`): if the signed amount
 *      is not ours, verification simply fails.
 *
 *   2. FAILURE IS CLOSED AND SAFE. If our message format is wrong, the HMAC
 *      does not match and nothing is fulfilled. The worst case is a missed
 *      fulfilment that surfaces as a reconciliation event — never a false one.
 *
 * ══ RESIDUAL RISK — READ BEFORE ENABLING LIVE PAYMENTS ════════════════════
 *
 *   * `hmac_compute` is documented by PayTech's current developer
 *     documentation but NOT by the official integration PDF, which predates
 *     it. The exact message format is therefore CONFIRMED BY ONE SOURCE ONLY
 *     and must be validated against a real sandbox notification before live
 *     payments are enabled. Until then `VERIFIED_STRENGTH` gates fulfilment.
 *
 *   * The signature carries NO nonce and NO timestamp, so it cannot establish
 *     freshness. A captured notification stays valid forever. Replay is
 *     therefore defeated downstream, not here: `provider_token` is UNIQUE
 *     (migration 060) and `complete_payment()` returns `already_completed`
 *     without writing, so a replayed notification cannot produce a second
 *     entitlement.
 *
 *   * The sha256-constant check is still performed, because the official guide
 *     requires it and it cheaply rejects obvious noise. It is treated as
 *     NECESSARY BUT NOT SUFFICIENT, and never as grounds for fulfilment.
 */

// ── Verification strength ───────────────────────────────────────────────────

/**
 * How much a notification actually proved, as an ordered scale.
 *
 * `signature` is the only value that may lead to fulfilment. The others exist
 * so a caller can record WHY it refused, and so an operator can see during
 * sandbox UAT whether the HMAC format is right.
 */
export const IPN_STRENGTHS = ['none', 'shared_secret', 'signature'] as const
export type IpnStrength = (typeof IPN_STRENGTHS)[number]

/** The strength required before anything is fulfilled. Deliberately a constant. */
export const VERIFIED_STRENGTH: IpnStrength = 'signature'

export const IPN_REJECTION_REASONS = [
  'malformed_payload',       // not a usable object
  'missing_token',           // no provider token to correlate on
  'missing_ref_command',     // no reference to correlate on
  'shared_secret_mismatch',  // api_key_sha256 / api_secret_sha256 wrong
  'signature_absent',        // no hmac_compute at all — cannot reach `signature`
  'signature_mismatch',      // hmac_compute present and wrong
  'unknown_event',           // type_event absent or outside the documented set
  'promo_applied',           // provider altered the amount; our signed amount cannot match
] as const
export type IpnRejectionReason = (typeof IPN_REJECTION_REASONS)[number]

// ── The documented event vocabulary ─────────────────────────────────────────

/**
 * PayTech's payment events. `sale_canceled` is single-L on the wire, as
 * documented; our `payments.status` vocabulary uses double-L `cancelled`
 * (migration 060), so the two are mapped rather than assumed equal.
 */
export const PAYTECH_EVENTS = ['sale_complete', 'sale_canceled'] as const
export type PaytechEvent = (typeof PAYTECH_EVENTS)[number]

/** Our own terminal outcome for an authenticated notification. */
export type IpnOutcome = 'completed' | 'cancelled'

export function outcomeForEvent(event: PaytechEvent): IpnOutcome {
  return event === 'sale_complete' ? 'completed' : 'cancelled'
}

/**
 * Normalise an event name, or null.
 *
 * An unrecognised event is REJECTED rather than guessed at. In particular it
 * must never drift towards `sale_complete`: transfers and refunds have their
 * own events (`transfer_success`, `refund_complete`) delivered to different
 * URLs, and none of them may complete a course purchase.
 */
export function normaliseEvent(raw: unknown): PaytechEvent | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s === 'sale_cancelled') return 'sale_canceled' // tolerate the double-L spelling
  return (PAYTECH_EVENTS as readonly string[]).includes(s) ? (s as PaytechEvent) : null
}

// ── Payload ─────────────────────────────────────────────────────────────────

/**
 * The fields we read. Everything else PayTech sends is ignored on purpose:
 * `client_phone` and `payment_method` are payer data we have no reason to
 * store, and `item_price` is never consumed because we use our own amount.
 */
export interface PaytechIpnPayload {
  readonly type_event?: unknown
  readonly token?: unknown
  readonly ref_command?: unknown
  readonly api_key_sha256?: unknown
  readonly api_secret_sha256?: unknown
  readonly hmac_compute?: unknown
  readonly promo_enabled?: unknown
  readonly custom_field?: unknown
  readonly env?: unknown
}

/** A trimmed string, or null. Blank is never a value. */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/**
 * True when the provider says a promotion changed the price.
 *
 * Form-encoded transports stringify booleans, so '1', 'true' and 'yes' all
 * count. Anything truthy means our stored amount is NOT what was signed, so
 * the only safe response is to refuse and reconcile.
 */
export function promoApplied(v: unknown): boolean {
  if (v === true) return true
  if (typeof v === 'number') return v !== 0
  const s = str(v)
  if (s === null) return false
  return !['0', 'false', 'no', 'off'].includes(s.toLowerCase())
}

// ── Constant-time comparison ────────────────────────────────────────────────

/**
 * Compare two hex digests without leaking how far they matched.
 *
 * Length is compared first and non-constant-time, which is fine: the length of
 * a digest is public. `timingSafeEqual` throws on a length mismatch, so the
 * guard is required rather than merely tidy.
 */
export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

// ── The signed message ──────────────────────────────────────────────────────

/**
 * Candidate signed messages for one payment, built ONLY from values we hold.
 *
 * The documented format is `amount|ref_command|api_key`, keyed by the API
 * secret. The amount's string FORM is not documented, so a small set of
 * formattings of OUR OWN amount is tried — an integer and a two-decimal form.
 * This varies the rendering, never the value: every candidate asserts the same
 * amount, so a notification for a different amount matches none of them.
 */
export function signedMessageCandidates(
  expected: { amount: number; refCommand: string },
  apiKey: string,
): string[] {
  const forms = new Set<string>()
  if (Number.isInteger(expected.amount)) forms.add(String(expected.amount))
  forms.add(String(expected.amount))
  forms.add(expected.amount.toFixed(2))
  return [...forms].map(a => `${a}|${expected.refCommand}|${apiKey}`)
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * The official shared-secret check ALONE, before any database lookup.
 *
 * This exists to solve an ordering problem. The HMAC can only be checked
 * against a message built from the stored payment row, so it needs a lookup
 * first — but performing a lookup for any unauthenticated caller would let an
 * attacker probe which provider tokens exist, by timing or by response code.
 *
 * The sha256-constant check needs only our own credentials, so it can run
 * first and gate the lookup. It is still NOT sufficient for fulfilment: a
 * caller that passes it has proved only that it knows a constant, which is why
 * `verifyPaytechIpn()` below must still be satisfied afterwards.
 */
export function verifySharedSecretOnly(
  payload: unknown,
  config: Pick<PaytechConfig, 'apiKey' | 'apiSecret'>,
): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const p = payload as PaytechIpnPayload
  const keyHash = str(p.api_key_sha256)
  const secretHash = str(p.api_secret_sha256)
  if (keyHash === null || secretHash === null) return false
  return (
    secureEquals(keyHash.toLowerCase(), sha256Hex(config.apiKey)) &&
    secureEquals(secretHash.toLowerCase(), sha256Hex(config.apiSecret))
  )
}

export interface IpnVerification {
  /** What the notification actually proved. Only 'signature' permits fulfilment. */
  readonly strength: IpnStrength
  /** True only when `strength === VERIFIED_STRENGTH` and the event is known. */
  readonly fulfillable: boolean
  readonly reason: IpnRejectionReason | null
  /** The provider token, when the payload carried a usable one. */
  readonly token: string | null
  /** The reference the payload claims. Used ONLY to correlate, never to trust. */
  readonly refCommand: string | null
  readonly event: PaytechEvent | null
  readonly outcome: IpnOutcome | null
  /** Whether the official sha256-constant check passed. Necessary, not sufficient. */
  readonly sharedSecretOk: boolean
}

/**
 * Decide what a notification proved about a payment we already hold.
 *
 * `expected` comes from our own payment row. Passing the payload's own amount
 * here would make the whole exercise vacuous, which is why the parameter is
 * named for where it must come from.
 *
 * Order matters: shape, then correlation fields, then the official shared-secret
 * check, then the signature. Each failure gets its own reason so a
 * reconciliation workflow can tell "not from PayTech" from "from PayTech, but
 * about an amount we did not ask for".
 */
export function verifyPaytechIpn(args: {
  payload: unknown
  config: Pick<PaytechConfig, 'apiKey' | 'apiSecret'>
  expected: { amount: number; refCommand: string }
}): IpnVerification {
  const { config, expected } = args

  const base = {
    strength: 'none' as IpnStrength,
    fulfillable: false,
    token: null,
    refCommand: null,
    event: null,
    outcome: null,
    sharedSecretOk: false,
  }

  if (typeof args.payload !== 'object' || args.payload === null || Array.isArray(args.payload)) {
    return { ...base, reason: 'malformed_payload' }
  }
  const p = args.payload as PaytechIpnPayload

  const token = str(p.token)
  const refCommand = str(p.ref_command)
  const event = normaliseEvent(p.type_event)

  if (token === null) return { ...base, reason: 'missing_token' }
  if (refCommand === null) return { ...base, token, reason: 'missing_ref_command' }

  // ── the official check: sha256 of each credential, compared constant-time ──
  const keyHash = str(p.api_key_sha256)
  const secretHash = str(p.api_secret_sha256)
  const sharedSecretOk =
    keyHash !== null &&
    secretHash !== null &&
    secureEquals(keyHash.toLowerCase(), sha256Hex(config.apiKey)) &&
    secureEquals(secretHash.toLowerCase(), sha256Hex(config.apiSecret))

  const partial = { ...base, token, refCommand, event, sharedSecretOk }

  if (!sharedSecretOk) {
    return { ...partial, reason: 'shared_secret_mismatch' }
  }

  // Past this point the sender knows our credentials — but that is a constant,
  // so it is NOT yet grounds for anything. Strength stays below `signature`.
  const sharedOnly = { ...partial, strength: 'shared_secret' as IpnStrength }

  // ── the signature: HMAC over a message built from OUR stored values ──
  const provided = str(p.hmac_compute)
  if (provided === null) {
    return { ...sharedOnly, reason: 'signature_absent' }
  }

  // A promotion means the provider signed an amount that is not ours, so none
  // of our candidates can match. Refusing explicitly gives a clearer reason
  // than letting it fall through as a signature mismatch.
  if (promoApplied(p.promo_enabled)) {
    return { ...sharedOnly, reason: 'promo_applied' }
  }

  const matched = signedMessageCandidates(expected, config.apiKey).some(msg =>
    secureEquals(provided.toLowerCase(), hmacSha256Hex(config.apiSecret, msg)),
  )
  if (!matched) {
    return { ...sharedOnly, reason: 'signature_mismatch' }
  }

  // Authentic AND about our amount and our reference. The event must still be
  // one we recognise before any outcome is derived from it.
  if (event === null) {
    return { ...sharedOnly, strength: 'signature', reason: 'unknown_event' }
  }

  return {
    strength: 'signature',
    fulfillable: true,
    reason: null,
    token,
    refCommand,
    event,
    outcome: outcomeForEvent(event),
    sharedSecretOk: true,
  }
}
