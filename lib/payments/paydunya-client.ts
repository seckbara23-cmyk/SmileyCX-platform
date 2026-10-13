import 'server-only'
import { z } from 'zod'
import {
  resolvePaydunyaConfig,
  type PaydunyaConfig,
  type PaydunyaMode,
  type EnvLike,
} from '@/lib/payments/paydunya-config'

/**
 * PayDunya HTTP transport — PAY-2D-1.
 *
 * ── WHAT THIS MODULE IS ───────────────────────────────────────────────────
 *
 * Two functions that speak HTTP to PayDunya and return validated data. That is
 * all. It is a TRANSPORT LAYER: it creates no payment row, updates no status,
 * grants no access right, initialises no academic record, calls no RPC, and
 * imports no Supabase client. It cannot authorise anything, and the completion
 * authority (migration 062) is deliberately unreachable from here.
 *
 * A later trusted module will consume `confirmCheckoutInvoice()`'s result,
 * compare it against the stored payment row, and only then call the privileged
 * completion function. Separating transport from authority is the point: this
 * file can be read, reviewed and fuzzed without any possibility that a bug in
 * it grants a learner access.
 *
 * ── WHY IT IS HAND-WRITTEN ────────────────────────────────────────────────
 *
 * PayDunya publishes a Node SDK (`npm paydunya`). It is not used, for reasons
 * that are concrete rather than stylistic: it was last published in 2022, it
 * depends on `superagent@^0.18` and `bluebird@^2` (circa 2014), it is
 * CommonJS-only with no types, its `create()` silently performs a second
 * network round-trip, it emits `phone_number` where the API documents `phone`,
 * and — most importantly — it handles NONE of the three provider behaviours
 * below. The surface we need is two calls, three headers and one JSON body.
 *
 * ── THREE PROVIDER BEHAVIOURS THAT DICTATE THE DESIGN ─────────────────────
 *
 *   1. HTTP 200 DOES NOT MEAN SUCCESS. Established by probing the live
 *      sandbox: missing credentials return `200` with
 *      `{"response_code":"4000"}`, and a bad master key returns `200` with
 *      `{"response_code":"1001"}`. `res.ok` is therefore meaningless, and any
 *      client written as `if (!res.ok) throw` treats authentication failures
 *      as success-shaped. Every response here is judged by `response_code`.
 *
 *   2. THE API CAN RETURN HTML. A wrong-method request yields a redirect page,
 *      not JSON. A bare `await res.json()` throws a SyntaxError that looks like
 *      a bug in our code rather than a provider response, so the content type
 *      is checked first and a non-JSON body becomes its own error reason.
 *
 *   3. `response_code: "00"` ON CONFIRM MEANS ONLY "TRANSACTION FOUND".
 *      The payment outcome is the SEPARATE top-level `status` field. Treating
 *      the two as one is the single likeliest way to mark an unpaid invoice
 *      paid, so `confirmCheckoutInvoice()` requires both and returns the
 *      status as its own discriminated value.
 *
 * ── TEST AND LIVE CANNOT CROSS ────────────────────────────────────────────
 *
 * PayDunya has NO mode flag on the wire. Test and live differ only by URL
 * path, and the credentials differ by key set. So the base URL is derived from
 * the resolved config's `mode` and from nothing else — there is no base-URL
 * parameter, no override, and no environment read in this file. A caller
 * cannot point TEST credentials at the LIVE endpoint because there is no
 * argument through which to express it.
 *
 * ── SECRETS DO NOT LEAVE ──────────────────────────────────────────────────
 *
 * `import 'server-only'` makes a browser import a build error. Credentials are
 * read only through `resolvePaydunyaConfig()`, never from `process.env` here.
 * `PaydunyaApiError` carries a machine-readable reason, an HTTP status and a
 * provider `response_code` — never a credential, never a request header, and
 * never a raw response body. Nothing in this module logs.
 */

// ── Endpoints ───────────────────────────────────────────────────────────────

/** The provider host. The ONLY host this client will talk to or redirect to. */
export const PAYDUNYA_HOST = 'app.paydunya.com'

/**
 * Base URL per mode. Keyed by mode so the mapping is total: adding a mode to
 * the config without adding a URL here is a type error, not a runtime fallback.
 */
const BASE_URL: Record<PaydunyaMode, string> = {
  test: `https://${PAYDUNYA_HOST}/sandbox-api/v1`,
  live: `https://${PAYDUNYA_HOST}/api/v1`,
}

/** Derived from the resolved mode alone. Exported for assertions, not for input. */
export function paydunyaBaseUrl(mode: PaydunyaMode): string {
  return BASE_URL[mode]
}

/** Default request timeout. The provider documents none, so we impose one. */
export const PAYDUNYA_TIMEOUT_MS = 15_000

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Why a PayDunya call failed, as a closed set a caller can branch on.
 *
 * `provider_error` carries the provider's own `response_code`; every other
 * reason is ours. A reconciliation workflow reads these, so they are stable
 * identifiers rather than prose.
 */
export const PAYDUNYA_ERROR_REASONS = [
  'config_invalid',          // credentials missing or mode unset — fail closed
  'network_error',           // DNS, TLS, connection reset
  'timeout',                 // our own deadline elapsed
  'http_error',              // a non-2xx status (rarer than you would think)
  'non_json_response',       // HTML, text, or a missing content type
  'malformed_json',          // 2xx, JSON content type, unparseable body
  'provider_error',          // response_code present and not "00"
  'schema_invalid',          // shape we cannot safely interpret
  'invalid_token',           // missing or implausible invoice token
  'invalid_checkout_url',    // wrong host, wrong protocol, or unparseable
  'missing_status',          // confirm succeeded but carried no status
  'unknown_status',          // a status outside the documented four
  'invalid_amount',          // confirmed amount not a positive integer
  'invalid_argument',        // our caller passed something unusable
] as const
export type PaydunyaErrorReason = (typeof PAYDUNYA_ERROR_REASONS)[number]

/**
 * A PayDunya transport failure.
 *
 * Deliberately narrow: `reason`, and optionally the HTTP status and the
 * provider's `response_code`. It never carries a credential, a request header,
 * a URL with embedded secrets, or a raw response body — a provider body can
 * contain customer PII and, for PCI-certified merchants, a `pan`.
 */
export class PaydunyaApiError extends Error {
  readonly reason: PaydunyaErrorReason
  readonly httpStatus?: number
  readonly responseCode?: string

  constructor(
    reason: PaydunyaErrorReason,
    message: string,
    opts: { httpStatus?: number; responseCode?: string } = {},
  ) {
    super(message)
    this.name = 'PaydunyaApiError'
    this.reason = reason
    this.httpStatus = opts.httpStatus
    this.responseCode = opts.responseCode
  }
}

// ── Response schemas ────────────────────────────────────────────────────────

/**
 * `response_code` is documented as a string (`"00"`), and the live sandbox
 * returns strings. The PHP SDK compares it loosely, so a numeric form is
 * conceivable; coercing a number to a string here would turn `0` into `"0"`
 * rather than `"00"`, so numbers are accepted and normalised explicitly below
 * instead of being coerced blindly.
 */
const ResponseCodeSchema = z.union([z.string(), z.number()]).transform(v =>
  typeof v === 'number' ? String(v).padStart(2, '0') : v.trim(),
)

/** An amount as PayDunya expresses it: whole XOF francs, number or string. */
const AmountSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v.trim())
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount is not a number' })
    return z.NEVER
  }
  return n
})

const CreateResponseSchema = z.object({
  response_code: ResponseCodeSchema,
  response_text: z.string().optional(),
  description:   z.string().optional(),
  token:         z.string().optional(),
})

const ConfirmResponseSchema = z.object({
  response_code: ResponseCodeSchema,
  response_text: z.string().optional(),
  status:        z.string().optional(),
  fail_reason:   z.string().optional(),
  mode:          z.string().optional(),
  invoice: z
    .object({
      token:        z.string().optional(),
      total_amount: AmountSchema.optional(),
      description:  z.string().optional(),
    })
    .optional(),
  custom_data: z.record(z.unknown()).optional(),
  // Undocumented, read by the official SDK only when status is completed.
  // Optional by contract: we must never require a field the provider may omit.
  receipt_identifier: z.string().optional(),
  provider_reference: z.string().optional(),
  receipt_url:        z.string().optional(),
})

// ── Status normalisation ────────────────────────────────────────────────────

/** The four documented provider outcomes, lowercase as the wire carries them. */
export const PAYDUNYA_STATUSES = ['pending', 'completed', 'cancelled', 'failed'] as const
export type PaydunyaStatus = (typeof PAYDUNYA_STATUSES)[number]

/**
 * Normalise a provider status.
 *
 * The documentation contradicts itself: every JSON example and both SDKs use
 * double-L `cancelled`, while the English IPN prose says single-L `canceled`.
 * Prose also uppercases them in places. So: trim, lowercase, and fold the
 * single-L spelling onto the double-L one. Anything outside the four is
 * REJECTED rather than guessed at — an unrecognised status must never be
 * allowed to resolve towards "completed".
 */
export function normalisePaydunyaStatus(raw: string): PaydunyaStatus | null {
  const s = raw.trim().toLowerCase()
  if (s === 'canceled') return 'cancelled'
  return (PAYDUNYA_STATUSES as readonly string[]).includes(s) ? (s as PaydunyaStatus) : null
}

// ── Token and URL validation ────────────────────────────────────────────────

/**
 * An invoice token must be plausible before we store it or put it in a path.
 *
 * Sandbox tokens look like `test_RHICF0HboN`. The format is not documented, so
 * this validates a SHAPE rather than a pattern: non-empty, bounded, and free of
 * anything that could change the meaning of a URL path (slashes, dots, query
 * or fragment characters, whitespace, control bytes). That makes path injection
 * through a provider-supplied token structurally impossible.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/

export function isValidPaydunyaToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

/**
 * The checkout URL must be an HTTPS URL on the provider host, or we refuse it.
 *
 * This is an OPEN-REDIRECT control, not a formality. The value arrives in the
 * provider's `response_text` field and its only use is to redirect a learner's
 * browser. If the response were ever manipulated, an unchecked value would send
 * the learner to an attacker's page while our own UI said "proceed to payment".
 * Subdomains are NOT accepted: the host must equal app.paydunya.com exactly.
 */
export function isValidCheckoutUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  return u.protocol === 'https:' && u.hostname === PAYDUNYA_HOST
}

// ── Public result types ─────────────────────────────────────────────────────

export interface PaydunyaInvoice {
  /** The provider's invoice token. Persist this before redirecting anywhere. */
  readonly token: string
  /** Validated HTTPS checkout URL on the provider host. Safe to redirect to. */
  readonly checkoutUrl: string
  /** The mode this invoice was created in, from our config — never the wire. */
  readonly mode: PaydunyaMode
}

export interface PaydunyaConfirmation {
  readonly token: string
  readonly status: PaydunyaStatus
  /** Whole XOF francs as the provider confirmed them. Positive integer. */
  readonly amount: number
  /** The mode the PROVIDER reports, when it reports one. Defence in depth. */
  readonly reportedMode?: string
  /** The mode our configuration is in. Always present. */
  readonly mode: PaydunyaMode
  readonly failReason?: string
  readonly receiptUrl?: string
  /** Undocumented provider identifiers; present only sometimes. */
  readonly receiptIdentifier?: string
  readonly providerReference?: string
  readonly customData?: Record<string, unknown>
}

export interface CreateInvoiceInput {
  /** Whole XOF francs. The caller computes this; the provider bills exactly it. */
  readonly totalAmount: number
  readonly description: string
  readonly storeName: string
  readonly callbackUrl?: string
  readonly returnUrl?: string
  readonly cancelUrl?: string
  /** Server-only data echoed back on confirm. Never shown to the payer. */
  readonly customData?: Record<string, string>
  /** Restrict the instruments the provider offers, e.g. ['wave-senegal']. */
  readonly channels?: readonly string[]
}

export interface PaydunyaRequestOptions {
  readonly timeoutMs?: number
  /** Injected for tests only. Defaults to the real global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Injected for tests only. Defaults to process.env via the config module. */
  readonly env?: EnvLike
}

// ── Transport ───────────────────────────────────────────────────────────────

function headersFor(config: PaydunyaConfig): Record<string, string> {
  // Exactly the three the HTTP API documents. PAYDUNYA-PUBLIC-KEY is NOT sent:
  // it is unused by this API and commented out even in the provider's own SDK.
  return {
    'Content-Type':         'application/json',
    'PAYDUNYA-MASTER-KEY':  config.masterKey,
    'PAYDUNYA-PRIVATE-KEY': config.privateKey,
    'PAYDUNYA-TOKEN':       config.token,
  }
}

function resolveConfigOrThrow(env?: EnvLike): PaydunyaConfig {
  try {
    return env ? resolvePaydunyaConfig(env) : resolvePaydunyaConfig()
  } catch {
    // The config module's message names variables, never values — but it is not
    // this module's to forward. Fail closed with our own reason.
    throw new PaydunyaApiError(
      'config_invalid',
      'PayDunya is not configured. Refusing to make a provider request.',
    )
  }
}

/**
 * One request, one validated JSON object, or a PaydunyaApiError.
 *
 * The order of checks is deliberate: transport, then content type, then JSON,
 * then schema, then `response_code`. Each failure mode gets its own reason so a
 * caller can distinguish "the provider refused us" from "we could not read the
 * provider at all" — which matters, because only the first is actionable.
 */
async function request<T extends z.ZodTypeAny>(
  schema: T,
  url: string,
  init: RequestInit,
  opts: PaydunyaRequestOptions,
  config: PaydunyaConfig,
): Promise<z.infer<T>> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? PAYDUNYA_TIMEOUT_MS

  let res: Response
  try {
    res = await doFetch(url, {
      ...init,
      headers: headersFor(config),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
  } catch (err) {
    // A timeout surfaces as AbortError / TimeoutError depending on the runtime.
    const name = (err as { name?: string } | null)?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PaydunyaApiError('timeout', `PayDunya did not respond within ${timeoutMs}ms.`)
    }
    // The underlying error is NOT attached: it can carry the request URL and,
    // in some runtimes, request headers.
    throw new PaydunyaApiError('network_error', 'PayDunya could not be reached.')
  }

  // Checked BEFORE the body is read: a non-2xx HTML error page must not be
  // reported as malformed JSON.
  if (!res.ok) {
    throw new PaydunyaApiError(
      'http_error',
      `PayDunya returned HTTP ${res.status}.`,
      { httpStatus: res.status },
    )
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!/\bapplication\/json\b|\b\+json\b/i.test(contentType)) {
    throw new PaydunyaApiError(
      'non_json_response',
      'PayDunya returned a non-JSON response.',
      { httpStatus: res.status },
    )
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new PaydunyaApiError(
      'malformed_json',
      'PayDunya returned a JSON content type with an unparseable body.',
      { httpStatus: res.status },
    )
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    // Zod issues name PATHS, not values, so they are safe to summarise. The
    // body itself is never included.
    throw new PaydunyaApiError(
      'schema_invalid',
      'PayDunya returned a response this client cannot safely interpret.',
      { httpStatus: res.status },
    )
  }

  const data = parsed.data as { response_code: string }
  if (data.response_code !== '00') {
    // HTTP 200 with a non-"00" code is the provider's normal way of saying no:
    // "4000" = credential headers absent, "1001" = invalid master key. The code
    // is preserved; the provider's own text is NOT forwarded.
    throw new PaydunyaApiError(
      'provider_error',
      `PayDunya refused the request (response_code ${data.response_code}).`,
      { httpStatus: res.status, responseCode: data.response_code },
    )
  }

  return parsed.data
}

// ── A. Create a checkout invoice ────────────────────────────────────────────

/**
 * Create a checkout invoice and return its token and checkout URL.
 *
 * NOT IDEMPOTENT, and the provider offers no idempotency key — calling this
 * twice creates two invoices. The caller must therefore persist the returned
 * token BEFORE redirecting, and reuse the stored token on a retry rather than
 * calling this again. A timeout is INDETERMINATE: the invoice may exist.
 *
 * `items` and `taxes` are deliberately not sent. The provider documents that it
 * bills `invoice.total_amount` and ignores item amounts entirely, so sending a
 * breakdown that could disagree with the total would add a way to be wrong
 * without adding anything.
 */
export async function createCheckoutInvoice(
  input: CreateInvoiceInput,
  opts: PaydunyaRequestOptions = {},
): Promise<PaydunyaInvoice> {
  if (!Number.isInteger(input.totalAmount) || input.totalAmount <= 0) {
    throw new PaydunyaApiError(
      'invalid_argument',
      'totalAmount must be a positive whole number of XOF francs.',
    )
  }
  if (typeof input.storeName !== 'string' || input.storeName.trim().length === 0) {
    throw new PaydunyaApiError('invalid_argument', 'storeName is required by the provider.')
  }

  const config = resolveConfigOrThrow(opts.env)

  const body: Record<string, unknown> = {
    invoice: {
      total_amount: input.totalAmount,
      description:  input.description,
      ...(input.channels && input.channels.length > 0 ? { channels: [...input.channels] } : {}),
    },
    store: { name: input.storeName },
    ...(input.customData ? { custom_data: input.customData } : {}),
    actions: {
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
    },
  }

  const data = await request(
    CreateResponseSchema,
    `${paydunyaBaseUrl(config.mode)}/checkout-invoice/create`,
    { method: 'POST', body: JSON.stringify(body) },
    opts,
    config,
  )

  if (!isValidPaydunyaToken(data.token)) {
    throw new PaydunyaApiError(
      'invalid_token',
      'PayDunya reported success without a usable invoice token.',
    )
  }

  // The checkout URL lives in `response_text` — counter-intuitive, but confirmed
  // by the documented example and by both the PHP and Node SDKs. There is no
  // `invoice_url` field on the wire; that name exists only inside the SDKs.
  if (!isValidCheckoutUrl(data.response_text)) {
    throw new PaydunyaApiError(
      'invalid_checkout_url',
      `PayDunya returned a checkout URL that is not HTTPS on ${PAYDUNYA_HOST}.`,
    )
  }

  return { token: data.token, checkoutUrl: data.response_text, mode: config.mode }
}

// ── B. Confirm a checkout invoice ───────────────────────────────────────────

/**
 * Ask the provider, server to server, what actually happened to an invoice.
 *
 * This is the ONLY thing in the system that establishes that money moved, and
 * it is why an IPN is never trusted: the provider's notification `hash` is
 * SHA-512 of the master key — a per-merchant CONSTANT, not a signature over the
 * payload — so it provides no integrity and no replay protection whatsoever.
 * The correct use of an IPN is to take the token from it, discard everything
 * else, and call this function.
 *
 * `response_code: "00"` here means only "Transaction Found". The outcome is the
 * separate `status`, which is returned as its own value and never conflated.
 *
 * It returns confirmed FACTS. It does not decide anything: comparing the amount
 * against the stored payment row, checking the mode, and completing the payment
 * all belong to the trusted completion module, not here.
 */
export async function confirmCheckoutInvoice(
  token: string,
  opts: PaydunyaRequestOptions = {},
): Promise<PaydunyaConfirmation> {
  // Validated before it reaches a URL path, so a hostile token cannot traverse.
  if (!isValidPaydunyaToken(token)) {
    throw new PaydunyaApiError('invalid_token', 'The invoice token is missing or malformed.')
  }

  const config = resolveConfigOrThrow(opts.env)

  const data = await request(
    ConfirmResponseSchema,
    `${paydunyaBaseUrl(config.mode)}/checkout-invoice/confirm/${encodeURIComponent(token)}`,
    { method: 'GET' },
    opts,
    config,
  )

  if (typeof data.status !== 'string' || data.status.trim().length === 0) {
    throw new PaydunyaApiError(
      'missing_status',
      'PayDunya found the transaction but reported no status.',
    )
  }
  const status = normalisePaydunyaStatus(data.status)
  if (status === null) {
    // Fail closed: an unrecognised status must never drift towards completed.
    throw new PaydunyaApiError(
      'unknown_status',
      'PayDunya reported a status outside the four documented values.',
    )
  }

  const amount = data.invoice?.total_amount
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    // XOF has no minor unit, so a non-integer or non-positive confirmed amount
    // is not something to round — it is something to refuse.
    throw new PaydunyaApiError(
      'invalid_amount',
      'PayDunya confirmed an amount that is not a positive whole number.',
    )
  }

  return {
    token,
    status,
    amount,
    mode: config.mode,
    ...(typeof data.mode === 'string' ? { reportedMode: data.mode } : {}),
    ...(data.fail_reason ? { failReason: data.fail_reason } : {}),
    ...(data.receipt_url ? { receiptUrl: data.receipt_url } : {}),
    ...(data.receipt_identifier ? { receiptIdentifier: data.receipt_identifier } : {}),
    ...(data.provider_reference ? { providerReference: data.provider_reference } : {}),
    ...(data.custom_data ? { customData: data.custom_data } : {}),
  }
}
