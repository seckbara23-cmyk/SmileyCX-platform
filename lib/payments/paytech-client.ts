import 'server-only'
import { z } from 'zod'
import {
  resolvePaytechConfig,
  type PaytechConfig,
  type EnvLike,
} from '@/lib/payments/paytech-config'
import {
  PAYTECH_SETTLEMENT_CONTRACT,
  contractProblems,
  type PaytechSettlementContract,
} from '@/lib/payments/paytech-settlement-contract'

/**
 * PayTech HTTP transport — XP-PAYTECH-01.
 *
 * ── WHAT THIS MODULE IS ───────────────────────────────────────────────────
 *
 * One function that asks PayTech to open a hosted checkout, and returns a
 * validated token plus a redirect URL. That is all. Like its PayDunya
 * counterpart it is a TRANSPORT LAYER: it creates no payment row, updates no
 * status, grants no access right, calls no RPC and imports no Supabase client.
 * The completion authority (migration 062) is deliberately unreachable here.
 *
 * ── WHAT THE PROVIDER CONTRACT ACTUALLY IS ────────────────────────────────
 *
 * Established from PayTech's own documentation (paytech.sn/doc, base URL
 * `https://paytech.sn/api`) and the official integration guide
 * (doc.paytech.sn/PayTech.pdf):
 *
 *   POST https://paytech.sn/api/payment/request-payment
 *   headers: API_KEY, API_SECRET          (plain header values, not Bearer)
 *   body:    item_name, item_price, ref_command, command_name, currency,
 *            env, ipn_url, success_url, cancel_url, custom_field
 *   success: { success: 1, token, redirect_url, redirectUrl }
 *
 * Two provider behaviours shape the code below.
 *
 *   1. SUCCESS IS A FIELD, NOT A STATUS CODE. The documented success marker is
 *      `success: 1`; the refund example returns `success: -1` with a `message`.
 *      So `res.ok` is not the test — every response is judged by `success`.
 *      `success` is accepted as number or string because the documentation
 *      shows an integer while form-encoded transports stringify everything.
 *
 *   2. THE REDIRECT URL IS DUPLICATED. The response carries both
 *      `redirect_url` and `redirectUrl` with the same value. Either may be
 *      read; neither is trusted until it validates as HTTPS on the provider
 *      host, because its only use is to send a learner's browser somewhere.
 *
 * ── SETTLEMENT IS ASKED, NEVER GUESSED ────────────────────────────────────
 *
 * `confirmPaymentStatus()` asks PayTech, server to server, what happened to a
 * transaction. PayTech documents the endpoint but not its response, so the
 * reading of that response is DATA — `paytech-settlement-contract.ts` — and is
 * `null` until PayTech confirms it in writing. While it is `null` this module
 * makes no status request and answers `unknown`, which fulfils nothing and
 * frees no learner to pay twice (XP-PAYTECH-04 safeguards 1 and 3).
 *
 * ── SECRETS DO NOT LEAVE ──────────────────────────────────────────────────
 *
 * `import 'server-only'`. Credentials are read only through
 * `resolvePaytechConfig()`, never from `process.env` here. `PaytechApiError`
 * carries a machine-readable reason and an HTTP status — never a credential,
 * never a request header, never a raw response body. Nothing here logs.
 */

// ── Endpoints ───────────────────────────────────────────────────────────────

/** The provider host. The ONLY host this client will talk to or redirect to. */
export const PAYTECH_HOST = 'paytech.sn'

/** The documented base URL. PayTech uses ONE host for both modes, unlike PayDunya. */
export const PAYTECH_BASE_URL = `https://${PAYTECH_HOST}/api`

export const PAYTECH_REQUEST_PAYMENT_PATH = '/payment/request-payment'

/**
 * The documented server-to-server status endpoint. Which call is actually made
 * — this one, or the `POST /payment/status` PayTech's own documentation tester
 * uses — is decided by the confirmed settlement contract, not here.
 */
export const PAYTECH_GET_STATUS_PATH = '/payment/get-status'

/** Default request timeout. The provider documents none, so we impose one. */
export const PAYTECH_TIMEOUT_MS = 15_000

/**
 * The only currency this integration accepts.
 *
 * PayTech also lists EUR, USD, CAD, GBP and MAD, but `complete_payment()`
 * refuses anything but XOF (`currency_unsupported`), and every course price in
 * this product is XOF. Offering a currency the completion authority will reject
 * would only create a way to take money we cannot fulfil.
 */
export const PAYTECH_CURRENCY = 'XOF'

// ── Errors ──────────────────────────────────────────────────────────────────

export const PAYTECH_ERROR_REASONS = [
  'config_invalid',        // credentials missing or mode unset — fail closed
  'network_error',         // DNS, TLS, connection reset
  'timeout',               // our own deadline elapsed
  'http_error',            // a non-2xx status
  'non_json_response',     // HTML, text, or a missing content type
  'malformed_json',        // 2xx, JSON content type, unparseable body
  'provider_error',        // `success` present and not 1
  'schema_invalid',        // shape we cannot safely interpret
  'invalid_token',         // missing or implausible payment token
  'invalid_redirect_url',  // wrong host, wrong protocol, or unparseable
  'invalid_argument',      // our caller passed something unusable
] as const
export type PaytechErrorReason = (typeof PAYTECH_ERROR_REASONS)[number]

export class PaytechApiError extends Error {
  readonly reason: PaytechErrorReason
  readonly httpStatus?: number

  constructor(reason: PaytechErrorReason, message: string, opts: { httpStatus?: number } = {}) {
    super(message)
    this.name = 'PaytechApiError'
    this.reason = reason
    this.httpStatus = opts.httpStatus
  }
}

// ── Response schema ─────────────────────────────────────────────────────────

/** `success: 1` is documented as an integer; a stringified '1' is tolerated. */
const SuccessSchema = z.union([z.number(), z.string()]).transform(v =>
  typeof v === 'number' ? v : Number(v.trim()),
)

const RequestPaymentResponseSchema = z.object({
  success:      SuccessSchema,
  token:        z.string().optional(),
  redirect_url: z.string().optional(),
  redirectUrl:  z.string().optional(),
  message:      z.unknown().optional(),
})

// ── Token and URL validation ────────────────────────────────────────────────

/**
 * A payment token must be plausible before we store it or put it in a URL.
 *
 * The format is not documented, so this validates a SHAPE rather than a
 * pattern: non-empty, bounded, and free of anything that could change the
 * meaning of a URL path. The token becomes `payments.provider_token`, which is
 * the UNIQUE replay key (migration 060), so a hostile value must not reach it.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/

export function isValidPaytechToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

/**
 * The redirect URL must be an HTTPS URL on the provider host, or we refuse it.
 *
 * This is an OPEN-REDIRECT control, not a formality: the value's only use is to
 * send a learner's browser to pay. Subdomains are NOT accepted — the host must
 * equal paytech.sn exactly — because a wildcard would defeat the point.
 */
export function isValidPaytechRedirectUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  return u.protocol === 'https:' && u.hostname === PAYTECH_HOST
}

/**
 * Every callback URL we hand the provider must be HTTPS.
 *
 * PayTech documents that `ipn_url` must be HTTPS, and an IPN delivered over
 * plaintext would expose the notification — including the key hashes it carries
 * — to anyone on the path. We apply the same rule to success and cancel.
 */
export function isValidCallbackUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  return u.protocol === 'https:'
}

// ── Public types ────────────────────────────────────────────────────────────

export interface PaytechCheckout {
  /** The provider's payment token. Persist this BEFORE redirecting anywhere. */
  readonly token: string
  /** Validated HTTPS URL on the provider host. Safe to redirect to. */
  readonly redirectUrl: string
  /** The provider env this checkout was opened in, from our config. */
  readonly env: PaytechConfig['env']
  /** What `payments.provider_mode` should record. */
  readonly providerMode: PaytechConfig['providerMode']
}

export interface RequestPaymentInput {
  /** Whole XOF francs. The caller computes this; the provider bills exactly it. */
  readonly itemPrice: number
  readonly itemName: string
  readonly commandName: string
  /** Our own order reference. Becomes `payments.reference` and is signed by the IPN. */
  readonly refCommand: string
  readonly ipnUrl: string
  readonly successUrl: string
  readonly cancelUrl: string
  /** Server-only data echoed back on the IPN. Never shown to the payer. */
  readonly customField?: Record<string, string>
}

export interface PaytechRequestOptions {
  readonly timeoutMs?: number
  /** Injected for tests only. Defaults to the real global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Injected for tests only. Defaults to process.env via the config module. */
  readonly env?: EnvLike
}

// ── Transport ───────────────────────────────────────────────────────────────

function headersFor(config: PaytechConfig): Record<string, string> {
  // Exactly what the provider documents: the key and secret as plain headers.
  return {
    'Content-Type': 'application/json',
    Accept:         'application/json',
    API_KEY:        config.apiKey,
    API_SECRET:     config.apiSecret,
  }
}

function resolveConfigOrThrow(env?: EnvLike): PaytechConfig {
  try {
    return env ? resolvePaytechConfig(env) : resolvePaytechConfig()
  } catch {
    // The config module's message names variables, never values — but it is not
    // this module's to forward. Fail closed with our own reason.
    throw new PaytechApiError(
      'config_invalid',
      'PayTech is not configured. Refusing to make a provider request.',
    )
  }
}

/**
 * Open a hosted checkout and return its token and redirect URL.
 *
 * NOT IDEMPOTENT. PayTech offers no idempotency key, so calling this twice
 * opens two checkouts. The caller must persist the returned token BEFORE
 * redirecting and reuse the stored token on a retry rather than calling again.
 * A timeout is INDETERMINATE: the checkout may exist.
 *
 * `ref_command` must be unique per order on the provider's side, and it is the
 * value the IPN signature covers, so the caller owns its uniqueness.
 */
export async function requestPayment(
  input: RequestPaymentInput,
  opts: PaytechRequestOptions = {},
): Promise<PaytechCheckout> {
  if (!Number.isInteger(input.itemPrice) || input.itemPrice <= 0) {
    throw new PaytechApiError(
      'invalid_argument',
      'itemPrice must be a positive whole number of XOF francs.',
    )
  }
  if (typeof input.refCommand !== 'string' || input.refCommand.trim().length === 0) {
    throw new PaytechApiError('invalid_argument', 'refCommand is required and must be unique.')
  }
  for (const [name, url] of [
    ['ipnUrl', input.ipnUrl],
    ['successUrl', input.successUrl],
    ['cancelUrl', input.cancelUrl],
  ] as const) {
    if (!isValidCallbackUrl(url)) {
      throw new PaytechApiError('invalid_argument', `${name} must be an absolute HTTPS URL.`)
    }
  }

  const config = resolveConfigOrThrow(opts.env)

  const body: Record<string, unknown> = {
    item_name:    input.itemName,
    item_price:   input.itemPrice,
    currency:     PAYTECH_CURRENCY,
    ref_command:  input.refCommand,
    command_name: input.commandName,
    env:          config.env,
    ipn_url:      input.ipnUrl,
    success_url:  input.successUrl,
    cancel_url:   input.cancelUrl,
    // Documented as a JSON-encoded STRING, not an object.
    ...(input.customField ? { custom_field: JSON.stringify(input.customField) } : {}),
  }

  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? PAYTECH_TIMEOUT_MS

  let res: Response
  try {
    res = await doFetch(`${PAYTECH_BASE_URL}${PAYTECH_REQUEST_PAYMENT_PATH}`, {
      method:  'POST',
      headers: headersFor(config),
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(timeoutMs),
      cache:   'no-store',
    })
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PaytechApiError('timeout', `PayTech did not respond within ${timeoutMs}ms.`)
    }
    // The underlying error is NOT attached: it can carry the request URL and,
    // in some runtimes, the request headers.
    throw new PaytechApiError('network_error', 'PayTech could not be reached.')
  }

  // Checked BEFORE the body is read: a non-2xx HTML error page must not be
  // reported as malformed JSON.
  if (!res.ok) {
    throw new PaytechApiError('http_error', `PayTech returned HTTP ${res.status}.`, {
      httpStatus: res.status,
    })
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!/\bapplication\/json\b|\b\+json\b/i.test(contentType)) {
    throw new PaytechApiError('non_json_response', 'PayTech returned a non-JSON response.', {
      httpStatus: res.status,
    })
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new PaytechApiError(
      'malformed_json',
      'PayTech returned a JSON content type with an unparseable body.',
      { httpStatus: res.status },
    )
  }

  const parsed = RequestPaymentResponseSchema.safeParse(raw)
  if (!parsed.success) {
    // Zod issues name PATHS, not values, so the body itself is never included.
    throw new PaytechApiError(
      'schema_invalid',
      'PayTech returned a response this client cannot safely interpret.',
      { httpStatus: res.status },
    )
  }

  if (parsed.data.success !== 1) {
    // The provider's own `message` is NOT forwarded: it is attacker-influenced
    // text that would end up in a log or, worse, on a page.
    throw new PaytechApiError(
      'provider_error',
      `PayTech refused the request (success=${parsed.data.success}).`,
      { httpStatus: res.status },
    )
  }

  if (!isValidPaytechToken(parsed.data.token)) {
    throw new PaytechApiError(
      'invalid_token',
      'PayTech reported success without a usable payment token.',
    )
  }

  // Both fields carry the same value; prefer the snake_case one the docs lead with.
  const redirect = parsed.data.redirect_url ?? parsed.data.redirectUrl
  if (!isValidPaytechRedirectUrl(redirect)) {
    throw new PaytechApiError(
      'invalid_redirect_url',
      `PayTech returned a redirect URL that is not HTTPS on ${PAYTECH_HOST}.`,
    )
  }

  return {
    token:        parsed.data.token,
    redirectUrl:  redirect,
    env:          config.env,
    providerMode: config.providerMode,
  }
}

// ── C. Confirm settlement, server to server ─────────────────────────────────

/**
 * What PayTech says happened to a transaction.
 *
 * `unknown` is a first-class outcome, not an error: it is what the caller gets
 * whenever the answer cannot be positively interpreted under the CONFIRMED
 * contract, and it must never lead to fulfilment, cancellation, or a second
 * checkout for the same order.
 */
export const PAYTECH_SETTLEMENTS = ['paid', 'failed', 'cancelled', 'pending', 'unknown'] as const
export type PaytechSettlementOutcome = (typeof PAYTECH_SETTLEMENTS)[number]

/** Why the answer was `unknown`. Machine-readable; safe to record and log. */
export const SETTLEMENT_UNKNOWN_REASONS = [
  'contract_unconfirmed',   // PayTech has not documented the response — nothing is inferred
  'contract_invalid',       // the configured contract fails contractProblems()
  'invalid_target',         // our own token or reference is unusable
  'config_invalid',         // credentials do not resolve
  'network_error',
  'timeout',
  'http_error',
  'non_json_response',
  'malformed_json',
  'provider_refused',       // the contract's success flag is present and not 1
  'status_missing',         // nothing at the contract's status path
  'status_unrecognised',    // a status word the contract does not list
  'reference_mismatch',     // the provider echoed another order's reference
  'amount_unreadable',      // a paid answer without the amount the contract promises
] as const
export type SettlementUnknownReason = (typeof SETTLEMENT_UNKNOWN_REASONS)[number]

export interface PaytechSettlement {
  readonly outcome: PaytechSettlementOutcome
  /** Set only when outcome is `unknown`. */
  readonly reason: SettlementUnknownReason | null
  /** The amount PayTech reports, when the contract names one. Cross-checked by the caller. */
  readonly amount: number | null
  /** The currency PayTech reports, upper-cased, when the contract names one. */
  readonly currency: string | null
  /**
   * For `status_missing` / `status_unrecognised`: the KEY PATHS of the response
   * (never values), so an operator can see what PayTech actually sent without
   * anything sensitive reaching a log.
   */
  readonly shape: readonly string[] | null
}

export interface ConfirmTarget {
  /** Our stored provider token. */
  readonly token: string
  /** Our stored order reference (`payments.reference`). */
  readonly refCommand: string
}

export interface ConfirmOptions extends PaytechRequestOptions {
  /**
   * Injected for tests only. Absent means "the contract in force"; `null`
   * means "unconfirmed" explicitly.
   */
  readonly contract?: PaytechSettlementContract | null
}

/** Read a dotted path through plain objects only. Arrays and prototypes are never walked. */
function readPath(body: unknown, path: string): unknown {
  let cur: unknown = body
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Key paths of a response, three levels deep. Names only — no value is ever copied. */
function shapeOf(body: unknown, prefix = '', depth = 0): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || depth > 2) return []
  const out: string[] = []
  for (const k of Object.keys(body as Record<string, unknown>).sort().slice(0, 40)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.push(p)
    out.push(...shapeOf((body as Record<string, unknown>)[k], p, depth + 1))
  }
  return out
}

function numberAt(body: unknown, path: string | null): number | null {
  if (path === null) return null
  const v = readPath(body, path)
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Ask PayTech, over a channel the payer cannot influence, what happened.
 *
 * Returns FACTS under the confirmed contract; decides nothing. Comparing the
 * amount and currency with the stored row, and acting on the outcome, belong
 * to `paytech-reconcile.ts`.
 *
 * Never throws. Every failure — no contract, transport, refusal, an
 * unparseable body, a status word the contract does not list — is `unknown`
 * with a reason, so the caller has exactly one safe branch to write.
 */
export async function confirmPaymentStatus(
  target: ConfirmTarget,
  opts: ConfirmOptions = {},
): Promise<PaytechSettlement> {
  const unknown = (reason: SettlementUnknownReason, shape: readonly string[] | null = null): PaytechSettlement =>
    ({ outcome: 'unknown', reason, amount: null, currency: null, shape })

  const contract = 'contract' in opts ? opts.contract ?? null : PAYTECH_SETTLEMENT_CONTRACT
  if (contract === null) return unknown('contract_unconfirmed')
  if (contractProblems(contract).length > 0) return unknown('contract_invalid')

  if (!isValidPaytechToken(target.token)) return unknown('invalid_target')
  if (typeof target.refCommand !== 'string' || target.refCommand.trim().length === 0) {
    return unknown('invalid_target')
  }

  let config: PaytechConfig
  try {
    config = opts.env ? resolvePaytechConfig(opts.env) : resolvePaytechConfig()
  } catch {
    return unknown('config_invalid')
  }

  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? PAYTECH_TIMEOUT_MS
  const request = contract.request
  const url = request.method === 'GET'
    ? `${PAYTECH_BASE_URL}${request.path}?${request.tokenParam}=${encodeURIComponent(target.token)}`
    : `${PAYTECH_BASE_URL}${request.path}`

  let res: Response
  try {
    res = await doFetch(url, {
      method:  request.method,
      headers: headersFor(config),
      ...(request.method === 'POST'
        ? { body: JSON.stringify({ [request.refCommandField]: target.refCommand }) }
        : {}),
      signal:  AbortSignal.timeout(timeoutMs),
      cache:   'no-store',
    })
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? ''
    return unknown(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error')
  }

  if (!res.ok) return unknown('http_error')
  const contentType = res.headers.get('content-type') ?? ''
  if (!/\bapplication\/json\b|\b\+json\b/i.test(contentType)) return unknown('non_json_response')

  let body: unknown
  try { body = await res.json() } catch { return unknown('malformed_json') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return unknown('malformed_json')

  if (contract.successPath !== null && numberAt(body, contract.successPath) !== 1) {
    return unknown('provider_refused')
  }

  if (contract.referencePath !== null) {
    const echoed = readPath(body, contract.referencePath)
    if (typeof echoed !== 'string' || echoed.trim() !== target.refCommand.trim()) {
      return unknown('reference_mismatch')
    }
  }

  const raw = readPath(body, contract.statusPath)
  if (typeof raw !== 'string' || raw.trim().length === 0) return unknown('status_missing', shapeOf(body))
  const word = raw.trim().toLowerCase()

  const amount = numberAt(body, contract.amountPath)
  const currencyRaw = contract.currencyPath === null ? null : readPath(body, contract.currencyPath)
  const currency = typeof currencyRaw === 'string' && currencyRaw.trim() ? currencyRaw.trim().toUpperCase() : null
  const facts = { reason: null, amount, currency, shape: null }

  if (contract.paid.includes(word)) {
    // A contract that promises an amount must deliver it for a PAID answer:
    // the amount cross-check is part of what makes "paid" trustworthy.
    if (contract.amountPath !== null && amount === null) return unknown('amount_unreadable')
    return { outcome: 'paid', ...facts }
  }
  if (contract.failed.includes(word)) return { outcome: 'failed', ...facts }
  if (contract.cancelled.includes(word)) return { outcome: 'cancelled', ...facts }
  if (contract.pending.includes(word)) return { outcome: 'pending', ...facts }

  // A word the contract does not list. Fail closed rather than guess which way it leans.
  return unknown('status_unrecognised', shapeOf(body))
}
