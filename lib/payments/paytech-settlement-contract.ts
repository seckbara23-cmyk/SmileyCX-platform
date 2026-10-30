import 'server-only'

/**
 * The PayTech settlement contract — XP-PAYTECH-04.
 *
 * ── WHY THIS IS A CONSTANT, AND WHY IT IS `null` ─────────────────────────
 *
 * Settlement — "did money move for this order?" — is the one fact the PayTech
 * integration may never guess. The IPN signature cannot carry it (its message
 * is `amount|ref_command|api_key`, with no outcome in it), so the only
 * authority is PayTech's own status endpoint, asked server to server.
 *
 * PayTech documents that endpoint (`GET /payment/get-status?token_payment=`)
 * but NOT its response, and a guess is not a verification.
 *
 * So the interpretation lives here, as data, and it is `null` until
 * PayTech states it in writing. While it is `null`, `confirmPaymentStatus()`
 * makes no request and answers `unknown` — nothing is completed, nothing is
 * cancelled, and no learner is freed to open a second checkout (safeguard 1).
 *
 * ── HOW IT GETS FILLED ────────────────────────────────────────────────────
 *
 *   1. PayTech answers, in writing, the questions in the XP-PAYTECH-04 PR
 *      (field path, status vocabulary, amount field, endpoint).
 *   2. An engineer fills ONE object below, citing that answer in `confirmedBy`,
 *      and adds the provider's literal example response as a test fixture.
 *   3. `contractProblems()` must return [] — a test asserts it for the live
 *      constant — and the sandbox UAT in the release checklist confirms it
 *      against real responses before production.
 *
 * Every field is EXACT: one path, no fallbacks, no case folding beyond trim and
 * lower-case of the status word. Anything that does not match is `unknown`.
 */

export type PaytechStatusRequest =
  /** As documented: GET /payment/get-status?token_payment={token} */
  | { readonly method: 'GET'; readonly path: '/payment/get-status'; readonly tokenParam: 'token_payment' }
  /** As PayTech's documentation tester calls it: POST /payment/status {ref_command} */
  | { readonly method: 'POST'; readonly path: '/payment/status'; readonly refCommandField: 'ref_command' }

export interface PaytechSettlementContract {
  /** Who stated this, and when. A contract with no provenance is not a contract. */
  readonly confirmedBy: string
  readonly request: PaytechStatusRequest
  /** Dotted path to a flag that must equal 1 before anything else is read, or null. */
  readonly successPath: string | null
  /** Dotted path to the PAYMENT status. Exactly one path. */
  readonly statusPath: string
  /** Money moved. The only words that may lead to fulfilment. */
  readonly paid: readonly string[]
  /** The payment failed and the checkout can no longer be paid. */
  readonly failed: readonly string[]
  /** The payer cancelled and the checkout can no longer be paid. */
  readonly cancelled: readonly string[]
  /** Not paid yet, still payable. */
  readonly pending: readonly string[]
  /** Dotted path to the settled amount, or null when PayTech returns none. */
  readonly amountPath: string | null
  /** Dotted path to the currency, or null. */
  readonly currencyPath: string | null
  /** Dotted path to the order reference PayTech echoes, or null. */
  readonly referencePath: string | null
}

/**
 * THE contract in force. `null` = unconfirmed: settlement is never inferred.
 *
 * Do not fill this from a sandbox observation, a community SDK or a guess.
 * Fill it from PayTech's written answer, then prove it in sandbox UAT.
 */
export const PAYTECH_SETTLEMENT_CONTRACT: PaytechSettlementContract | null = null

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/
const WORD_RE = /^[a-z][a-z0-9_ -]{0,39}$/

/**
 * Why a contract is unusable, or [] when it is usable.
 *
 * Run at call time by `confirmPaymentStatus()` — an invalid contract answers
 * `unknown` rather than throwing — and asserted in tests for the live constant.
 */
export function contractProblems(c: PaytechSettlementContract): string[] {
  const problems: string[] = []
  if (typeof c.confirmedBy !== 'string' || c.confirmedBy.trim().length < 10) {
    problems.push('confirmedBy must cite the written source')
  }
  for (const [name, path] of [
    ['successPath', c.successPath], ['statusPath', c.statusPath], ['amountPath', c.amountPath],
    ['currencyPath', c.currencyPath], ['referencePath', c.referencePath],
  ] as const) {
    if (path === null && name !== 'statusPath') continue
    if (typeof path !== 'string' || !PATH_RE.test(path)) problems.push(`${name} is not a dotted path`)
  }
  const lists = { paid: c.paid, failed: c.failed, cancelled: c.cancelled, pending: c.pending }
  if (!Array.isArray(c.paid) || c.paid.length === 0) problems.push('paid must name at least one status')
  const seen = new Map<string, string>()
  for (const [name, words] of Object.entries(lists)) {
    if (!Array.isArray(words)) { problems.push(`${name} must be a list`); continue }
    for (const w of words) {
      if (typeof w !== 'string' || !WORD_RE.test(w)) problems.push(`${name} contains a non-normalised word`)
      const other = seen.get(w)
      if (other && other !== name) problems.push(`"${w}" is listed as both ${other} and ${name}`)
      seen.set(w, name)
    }
  }
  const r = c.request as { method?: string; path?: string }
  const knownRequest =
    (r?.method === 'GET' && r.path === '/payment/get-status') ||
    (r?.method === 'POST' && r.path === '/payment/status')
  if (!knownRequest) problems.push('request must be one of the two documented status calls')
  return problems
}
