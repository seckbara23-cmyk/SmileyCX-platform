import 'server-only'

/**
 * The PayTech settlement contract — XP-PAYTECH-04.
 *
 * ── WHY THIS IS A CONSTANT, AND WHY IT WAS `null` ────────────────────────
 *
 * Settlement — "did money move for this order?" — is the one fact the PayTech
 * integration may never guess. The IPN signature cannot carry it (its message
 * is `amount|ref_command|api_key`, with no outcome in it), so the only
 * authority is PayTech's own status endpoint, asked server to server.
 *
 * PayTech documents that endpoint (`GET /payment/get-status?token_payment=`)
 * but NOT its response, and a guess is not a verification.
 *
 * So the interpretation lives here, as data. It was `null` until PayTech's
 * own answers had been observed on a real payment (2026-11-07, below). While
 * it is `null`, `confirmPaymentStatus()` makes no request and answers
 * `unknown` — nothing is completed, nothing is cancelled, and no learner is
 * freed to open a second checkout (safeguard 1).
 *
 * ── HOW IT IS FILLED, AND HOW IT CHANGES ──────────────────────────────────
 *
 *   1. Only words PayTech has actually ANSWERED go into the lists, each one
 *      traceable to a captured response kept as a test fixture. A word nobody
 *      has seen stays out, so an answer carrying it is `unknown`, not guessed.
 *   2. `confirmedBy` names the source. A written statement from PayTech, when
 *      it comes, replaces the observation and may add the words still missing.
 *   3. `contractProblems()` must return [] — a test asserts it for the live
 *      constant — and the fixtures must still read as expected.
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
 * THE contract in force. `null` would mean unconfirmed: settlement never inferred.
 *
 * Filled on 2026-11-07 (XP-LAUNCH-04) from PayTech's OWN answers to
 * `GET /payment/get-status?token_payment=`, observed in its test environment
 * on real checkouts and verified against a real wallet debit:
 *
 *   * a PAID checkout (Wave), asked twice, half an hour after the debit:
 *     `{ success: 1, payment: { state: "success", item_price, item_price_xof,
 *     ref_command: <our reference>, token, token_expire_at: null, … } }`;
 *   * an UNPAID checkout, fresh and two hours old, and a checkout the payer
 *     CANCELLED with PayTech's own « Annuler » button: `payment.state = "running"`
 *     in every case — the cancellation changed nothing in the answer and sent
 *     no notification;
 *   * an UNKNOWN token: `{ success: 0, payment: null }`.
 *
 * Only observed words are listed. PayTech has not said which words mean
 * "failed" or "cancelled", nor how long a token stays payable (`token_expire_at`
 * was null throughout), so those lists stay empty and any other word answers
 * `unknown`: nothing completes, nothing closes. The sanitised answers are the
 * fixtures of `__tests__/payments/xp-launch-04-settlement-contract.test.ts`.
 *
 * The amount PayTech reports is the ITEM PRICE, not what the wallet debited (its
 * test mode debits a random 100 to 150 CFA and still reports the price), so the
 * amount cross-check compares the price we stored with the price it confirms.
 */
export const PAYTECH_SETTLEMENT_CONTRACT: PaytechSettlementContract | null = {
  confirmedBy:
    'PayTech test environment, observed 2026-11-07 (XP-LAUNCH-04): get-status answers for a paid Wave checkout '
    + '(asked twice), for unpaid and cancelled checkouts, and for an unknown token; sanitised copies are the '
    + 'fixtures in __tests__/payments/fixtures/paytech-get-status. No written statement from PayTech yet.',
  request: { method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' },
  successPath: 'success',
  statusPath: 'payment.state',
  paid: ['success'],
  failed: [],
  cancelled: [],
  pending: ['running'],
  amountPath: 'payment.item_price',
  currencyPath: null,
  referencePath: 'payment.ref_command',
}

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
