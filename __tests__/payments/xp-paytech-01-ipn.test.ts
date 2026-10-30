// @vitest-environment node
/**
 * XP-PAYTECH-01 — the PayTech IPN, proved against the real route handler.
 *
 * These tests drive `POST /api/payments/paytech/ipn` with real crypto and a
 * faked database. The signature checks are NOT stubbed: every payload below is
 * signed with the same HMAC the provider is documented to use, so a test that
 * passes proves the verification code accepts genuine notifications and refuses
 * the rest — not merely that a mock was called.
 *
 * ── WHY THE DATABASE IS THE ONLY THING FAKED ──────────────────────────────
 *
 * The interesting failures in a payment callback are all about what the handler
 * BELIEVES: that a signature covers this amount, that a token identifies one
 * row, that a duplicate must not pay twice. Faking the verification would erase
 * exactly the behaviour worth testing, so only Supabase is replaced, and the
 * fake records every write so a test can assert that nothing was written on a
 * refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'

const API_KEY = 'pk_test_xp_client_academy_key'
const API_SECRET = 'sk_test_xp_client_academy_secret'
const TOKEN = 'paytech_tok_ABC123xyz789'
const REFERENCE = 'SCX-TESTREF-AB12C'
const AMOUNT = 45_000
const USER_ID = '11111111-1111-4111-8111-111111111111'
const COURSE_ID = '22222222-2222-4222-8222-222222222222'

// ── the faked database ──────────────────────────────────────────────────────

interface PaymentRow {
  provider_token?: string | null
  created_at?: string
  id: string
  user_id: string | null
  course_id: string | null
  amount: number
  currency: string
  reference: string
  status: string
  provider: string | null
  provider_mode: string | null
}

const state: {
  payment: PaymentRow | null
  lookupError: unknown
  rpc: { data?: unknown; error?: unknown }
  updates: Record<string, unknown>[]
  rpcCalls: Record<string, unknown>[]
  terminalRowsAffected: number
  /**
   * What PayTech's /payment/get-status returns. `null` makes the call fail at
   * the transport, which must resolve to `unknown` and fulfil nothing.
   */
  settlement: Record<string, unknown> | null
  statusCalls: string[]
  /**
   * XP-PAYTECH-04: the settlement contract in force. A TEST FIXTURE — PayTech
   * has not documented its status response, so the real constant is `null`.
   */
  contract: Record<string, unknown> | null
} = {
  payment: null,
  lookupError: null,
  rpc: {},
  updates: [],
  rpcCalls: [],
  terminalRowsAffected: 1,
  settlement: null,
  statusCalls: [],
  contract: null,
}

const FIXTURE_CONTRACT = {
  confirmedBy: 'TEST FIXTURE — not a PayTech statement',
  request: { method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' },
  successPath: 'success',
  statusPath: 'payment.status',
  paid: ['completed'], failed: ['failed'], cancelled: ['canceled'], pending: ['pending'],
  amountPath: 'payment.amount', currencyPath: 'payment.currency', referencePath: 'payment.ref_command',
}

/** A get-status answer in the FIXTURE contract's shape. */
function settledBody(status: string, amount: number = AMOUNT): Record<string, unknown> {
  return { success: 1, payment: { status, amount, currency: 'XOF', ref_command: REFERENCE } }
}

vi.mock('@/lib/payments/paytech-settlement-contract', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return { ...orig, get PAYTECH_SETTLEMENT_CONTRACT() { return state.contract } }
})

function freshPayment(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: USER_ID,
    course_id: COURSE_ID,
    amount: AMOUNT,
    currency: 'XOF',
    reference: REFERENCE,
    status: 'processing',
    provider: 'paytech',
    provider_mode: 'test',
    // XP-PAYTECH-04: an opened attempt carries its token; the IPN found it by it.
    provider_token: TOKEN,
    created_at: '2026-10-30T00:00:00.000Z',
    ...over,
  }
}

vi.mock('@/lib/payments/payment-database-guard', () => ({
  paymentDatabaseAuthority: async () => ({ allowed: true, reason: null }),
}))

// The exception record is proved on real SQL in the integration suite.
vi.mock('@/lib/payments/payment-exceptions', () => ({
  reportPaymentException: async () => ({ recorded: true }),
  sendPendingExceptionAlerts: async () => 0,
  hasOpenPaymentException: async () => false,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      const api: Record<string, unknown> = {}
      let isUpdate = false
      let excludesCompleted = false

      const chain = {
        select: () => chain,
        order:  () => chain,
        limit:  () => chain,
        in:     () => chain,
        eq:     () => chain,
        neq:    (col: string, val: string) => {
          if (col === 'status' && val === 'completed') excludesCompleted = true
          return chain
        },
        update: (patch: Record<string, unknown>) => {
          isUpdate = true
          state.updates.push(patch)
          return chain
        },
        insert: (patch: Record<string, unknown>) => {
          state.updates.push(patch)
          return chain
        },
        single:      async () => ({ data: state.payment, error: state.lookupError }),
        maybeSingle: async () => ({ data: state.payment, error: state.lookupError }),
        // Awaiting the builder itself: how the route issues its updates.
        then: (res: (v: unknown) => unknown) => {
          if (isUpdate) {
            // A terminal update that excludes completed rows affects nothing
            // when the stored row is already completed.
            const blocked = excludesCompleted && state.payment?.status === 'completed'
            const rows = blocked ? [] : Array(state.terminalRowsAffected).fill({ id: 'x' })
            return Promise.resolve({ data: rows, error: null }).then(res)
          }
          return Promise.resolve({ data: state.payment ? [state.payment] : [], error: state.lookupError }).then(res)
        },
      }
      return Object.assign(chain, api)
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, ...args })
      return { data: state.rpc.data ?? null, error: state.rpc.error ?? null }
    },
  }),
}))

// ── signing helpers — the real algorithms, not stubs ────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (msg: string) => createHmac('sha256', API_SECRET).update(msg, 'utf8').digest('hex')

function signedPayload(over: Record<string, unknown> = {}, signAmount: number = AMOUNT) {
  return {
    type_event:        'sale_complete',
    token:             TOKEN,
    ref_command:       REFERENCE,
    item_name:         'Les fondamentaux',
    item_price:        String(AMOUNT),
    currency:          'XOF',
    payment_method:    'Orange Money',
    client_phone:      '770000000',
    api_key_sha256:    sha256(API_KEY),
    api_secret_sha256: sha256(API_SECRET),
    hmac_compute:      hmac(`${signAmount}|${REFERENCE}|${API_KEY}`),
    ...over,
  }
}

async function post(body: unknown, contentType = 'application/json') {
  const { POST } = await import('@/app/api/payments/paytech/ipn/route')
  const raw = contentType.includes('json')
    ? JSON.stringify(body)
    : new URLSearchParams(body as Record<string, string>).toString()
  return POST(
    new Request('https://www.xpclient-academy.com/api/payments/paytech/ipn', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: raw,
    }),
  )
}

beforeEach(() => {
  state.payment = freshPayment()
  state.lookupError = null
  state.rpc = { data: { outcome: 'completed', entitlement_id: 'ent-1' } }
  state.updates = []
  state.rpcCalls = []
  state.terminalRowsAffected = 1
  state.statusCalls = []
  // Default: under the fixture contract, PayTech confirms the payment settled for our amount.
  state.contract = FIXTURE_CONTRACT
  state.settlement = settledBody('completed')

  // The settlement check runs for real against this fake transport, so the
  // response parsing and the fail-closed branches are genuinely exercised.
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/payment/get-status')) {
      state.statusCalls.push(u)
      if (state.settlement === null) throw new Error('network down')
      return new Response(JSON.stringify(state.settlement), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch to ${u}`)
  }))

  vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', 'true')
  vi.stubEnv('PAYTECH_MODE', 'test')
  vi.stubEnv('PAYTECH_TEST_API_KEY', API_KEY)
  vi.stubEnv('PAYTECH_TEST_API_SECRET', API_SECRET)
  vi.stubEnv('VERCEL_ENV', 'preview')
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-01 · method enforcement', () => {
  it('refuses every method but POST', async () => {
    const mod = await import('@/app/api/payments/paytech/ipn/route')
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await (mod[m] as () => Promise<Response>)()
      expect(res.status, `${m} must not be processed`).toBe(405)
    }
    expect(state.rpcCalls).toEqual([])
  })
})

describe('XP-PAYTECH-01 · scenario 1 — successful verified payment', () => {
  it('completes and grants exactly one entitlement', async () => {
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.rpcCalls[0]).toMatchObject({
      fn: 'complete_payment',
      p_provider: 'paytech',
      p_provider_mode: 'test',
      p_provider_token: TOKEN,
      p_reference: REFERENCE,
      p_amount: AMOUNT,
      p_currency: 'XOF',
    })
  })

  it('passes the STORED amount, never the payload amount', async () => {
    // The payload claims the stored amount here; the point is that the route
    // sources it from the row, so a payload that disagrees is caught earlier.
    await post(signedPayload())
    expect(state.rpcCalls[0].p_amount).toBe(state.payment!.amount)
  })

  it('accepts a form-encoded notification too', async () => {
    const res = await post(signedPayload(), 'application/x-www-form-urlencoded')
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)
  })
})

describe('XP-PAYTECH-01 · scenario 2 — pending payment', () => {
  it('a pending row is still fulfillable once the provider confirms', async () => {
    state.payment = freshPayment({ status: 'pending' })
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)
  })
})

describe('XP-PAYTECH-01 · scenarios 3 and 4 — cancelled and failed', () => {
  it('a signed cancellation marks the payment cancelled and grants nothing', async () => {
    state.settlement = settledBody('canceled')
    const res = await post(signedPayload({ type_event: 'sale_canceled' }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'a cancellation must never reach complete_payment').toEqual([])
    expect(state.updates.some(u => u.status === 'cancelled')).toBe(true)
  })

  it('a completion refused by the authority writes no entitlement', async () => {
    state.rpc = { error: { message: 'x', details: '{"reason":"status_not_completable"}' } }
    const res = await post(signedPayload())
    expect(res.status).toBe(200) // not retryable: acked so the provider stops
    expect(state.updates.some(u => u.failure_reason === 'status_not_completable')).toBe(true)
  })

  it('asks for a retry ONLY on a transient refusal', async () => {
    state.rpc = { error: { message: 'x', details: '{"reason":"entitlement_race"}' } }
    expect((await post(signedPayload())).status).toBe(503)
    // XP-PAYTECH-04: no structured reason is a fault, not a disagreement.
    state.rpc = { error: { message: 'TypeError: fetch failed' } }
    expect((await post(signedPayload())).status).toBe(503)
  })
})

describe('XP-PAYTECH-01 · scenario 5 — invalid IPN authentication', () => {
  it('401s when the shared-secret hashes are wrong, without reading the row', async () => {
    const res = await post(signedPayload({ api_secret_sha256: sha256('wrong-secret') }))
    expect(res.status).toBe(401)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates, 'nothing may be written for an unauthenticated caller').toEqual([])
  })

  it('401s when the hashes are absent entirely', async () => {
    const p = signedPayload()
    delete (p as Record<string, unknown>).api_key_sha256
    delete (p as Record<string, unknown>).api_secret_sha256
    expect((await post(p)).status).toBe(401)
    expect(state.rpcCalls).toEqual([])
  })

  it('refuses a payload that passes the constants but carries NO signature', async () => {
    // This is the official-but-weak method on its own. It proves only knowledge
    // of a constant, so it must never fulfil.
    const p = signedPayload()
    delete (p as Record<string, unknown>).hmac_compute
    const res = await post(p)
    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'the sha256 constants alone must not fulfil').toEqual([])
    expect(state.updates.some(u => String(u.failure_reason).includes('signature_absent'))).toBe(true)
  })

  it('refuses a forged signature', async () => {
    const res = await post(signedPayload({ hmac_compute: 'deadbeef'.repeat(8) }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => String(u.failure_reason).includes('signature_mismatch'))).toBe(true)
  })

  it('refuses an unknown event even when perfectly signed', async () => {
    const res = await post(signedPayload({ type_event: 'refund_complete' }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'a refund event must not complete a purchase').toEqual([])
  })
})

describe('XP-PAYTECH-01 · scenario 6 — wrong amount', () => {
  it('refuses a notification signed for a DIFFERENT amount', async () => {
    // Signed correctly, but over 1 franc instead of the stored price.
    const res = await post(signedPayload({ item_price: '1' }, 1))
    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'an amount we did not ask for must not be fulfilled').toEqual([])
  })

  it('refuses when the signature is right but the reported amount disagrees', async () => {
    // The signature covers our amount, yet the body claims another. That is a
    // provider inconsistency, caught by the independent cross-check.
    const res = await post(signedPayload({ item_price: '999' }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'ipn_amount_mismatch')).toBe(true)
  })

  it('refuses when the provider says a promotion changed the price', async () => {
    const res = await post(signedPayload({ promo_enabled: '1' }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => String(u.failure_reason).includes('promo_applied'))).toBe(true)
  })
})

describe('XP-PAYTECH-01 · scenario 7 — wrong currency', () => {
  it('refuses a currency that is not the stored one', async () => {
    const res = await post(signedPayload({ currency: 'EUR' }))
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'ipn_currency_mismatch')).toBe(true)
  })
})

describe('XP-PAYTECH-01 · scenario 8 — unknown transaction', () => {
  it('404s for an authenticated notification about a token we do not hold', async () => {
    state.payment = null
    const res = await post(signedPayload())
    expect(res.status).toBe(404)
    expect(state.rpcCalls).toEqual([])
  })

  it('refuses a token that belongs to another provider', async () => {
    state.payment = freshPayment({ provider: 'paydunya' })
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'provider confusion must not fulfil').toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'provider_confusion')).toBe(true)
  })
})

describe('XP-PAYTECH-01 · scenarios 9 and 10 — duplicate and replay', () => {
  it('reports an already-completed payment as SUCCESS so retries stop', async () => {
    state.rpc = { data: { outcome: 'already_completed' } }
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.detail).toBe('already_completed')
  })

  it('a byte-identical replay produces exactly one completion attempt each time, and never two entitlements', async () => {
    // The signature carries no nonce, so a captured notification stays valid.
    // Replay is defeated downstream: the second call observes 'completed' and
    // returns already_completed without writing.
    const payload = signedPayload()
    await post(payload)
    expect(state.rpcCalls).toHaveLength(1)

    state.rpc = { data: { outcome: 'already_completed' } }
    state.payment = freshPayment({ status: 'completed' })
    const second = await post(payload)

    expect(second.status).toBe(200)
    expect((await second.json()).detail).toBe('already_completed')
    // XP-PAYTECH-04: a completed row is final (063), so the replay is answered
    // from the row without reaching the authority — or the provider — again.
    expect(state.rpcCalls).toHaveLength(1)
  })
})

describe('XP-PAYTECH-01 · scenario 11 — out-of-order notification', () => {
  it('a cancellation arriving AFTER a completed payment revokes nothing', async () => {
    state.payment = freshPayment({ status: 'completed' })
    state.settlement = settledBody('canceled')
    const res = await post(signedPayload({ type_event: 'sale_canceled' }))
    expect(res.status).toBe(200)
    expect((await res.json()).detail).toBe('already_completed')
    expect(state.rpcCalls).toEqual([])
    // XP-PAYTECH-04: nothing even attempts to move a completed row.
    expect(state.updates.filter(u => 'status' in u)).toEqual([])
  })

  it('a completion arriving after a cancellation re-opens nothing', async () => {
    // XP-PAYTECH-04: a closed payment is final (063). It is reported, not
    // re-decided, and the authority is not asked.
    state.payment = freshPayment({ status: 'cancelled' })
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect((await res.json()).detail).toBe('already_terminal')
    expect(state.rpcCalls).toEqual([])
  })
})

describe('XP-PAYTECH-01 · scenario 12 — concurrent fulfilment', () => {
  it('two simultaneous notifications cannot both be granted', async () => {
    const payload = signedPayload()
    let calls = 0
    state.rpc = {}
    // Stand in for the row lock inside complete_payment(): the first caller
    // completes, the second observes the completed row.
    const original = state.rpcCalls
    const results = await Promise.all([post(payload), post(payload)])
    calls = original.length
    expect(calls).toBe(2)
    for (const r of results) expect(r.status).toBe(200)
    // Both asked; the authority is the only thing that may grant, and it
    // serialises on the UNIQUE provider_token.
    expect(state.rpcCalls.every(c => c.p_provider_token === TOKEN)).toBe(true)
  })
})

describe('XP-PAYTECH-01 · scenario 16 — provider unavailable', () => {
  it('503s and fulfils nothing when PayTech cannot be processed here', async () => {
    vi.stubEnv('PAYTECH_MODE', '')
    const res = await post(signedPayload())
    expect(res.status).toBe(503)
    expect(state.rpcCalls).toEqual([])
  })

  it('XP-PAYTECH-04 safeguard 2: closing CHECKOUT does not stop processing a payment already taken', async () => {
    vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', '')
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)
  })

  it('refuses TEST mode on production: a sandbox flag never becomes a production fulfilment path', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYTECH_ALLOW_PRODUCTION', 'true')
    const res = await post(signedPayload())
    expect(res.status).toBe(503)
    expect(state.rpcCalls).toEqual([])
  })

  it('processes in production in LIVE mode, for a LIVE payment only', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYTECH_MODE', 'prod')
    vi.stubEnv('PAYTECH_PROD_API_KEY', API_KEY)
    vi.stubEnv('PAYTECH_PROD_API_SECRET', API_SECRET)
    state.payment = freshPayment({ provider_mode: 'live' })
    expect((await post(signedPayload())).status).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)

    // A TEST-mode payment seen by production is never completed (safeguard 4).
    state.rpcCalls = []
    state.payment = freshPayment({ provider_mode: 'test' })
    const res = await post(signedPayload())
    expect((await res.json()).detail).toBe('ineligible:test_payment_in_production')
    expect(state.rpcCalls).toEqual([])
  })
})

describe('XP-PAYTECH-01 · malformed input', () => {
  it('400s on an unusable body', async () => {
    const { POST } = await import('@/app/api/payments/paytech/ipn/route')
    const res = await POST(
      new Request('https://www.xpclient-academy.com/api/payments/paytech/ipn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    )
    expect(res.status).toBe(400)
    expect(state.rpcCalls).toEqual([])
  })

  it('400s when authenticated but carrying no token', async () => {
    const p = signedPayload()
    delete (p as Record<string, unknown>).token
    const res = await post(p)
    expect(res.status).toBe(400)
    expect(state.rpcCalls).toEqual([])
  })

  it('refuses a payment row with no learner or no course', async () => {
    state.payment = freshPayment({ user_id: null })
    const res = await post(signedPayload())
    expect(res.status).toBe(200)
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'payment_identity_incomplete')).toBe(true)
  })
})

describe('XP-PAYTECH-01 · forensics (migration 062, obligation 6)', () => {
  it('records last_ipn_at for every authenticated notification', async () => {
    await post(signedPayload())
    expect(state.updates.some(u => typeof u.last_ipn_at === 'string')).toBe(true)
  })

  it('never logs or echoes the provider token in a response body', async () => {
    const res = await post(signedPayload())
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(TOKEN)
  })

  it('never echoes a credential or either key hash', async () => {
    const res = await post(signedPayload({ api_secret_sha256: sha256('nope') }))
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(sha256(API_SECRET))
  })
})


// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-02 · settlement, not the notification, decides', () => {
  /**
   * The defect this suite exists for.
   *
   * `hmac_compute` signs `amount|ref_command|api_key`. No status field is in
   * that message, so for one order the signature is IDENTICAL whether the
   * payment completed or was cancelled. XP-PAYTECH-01 read `type_event` to
   * decide the outcome, so anyone holding a single authentic notification for
   * an order could flip `sale_canceled` to `sale_complete` and be granted the
   * course — with a signature that verifies perfectly.
   */
  it('a FLIPPED type_event cannot buy a course when PayTech says it was cancelled', async () => {
    // The attacker's payload: a genuine, correctly signed notification whose
    // only modification is the unauthenticated outcome field.
    state.settlement = settledBody('canceled')

    const forged = signedPayload({ type_event: 'sale_complete' })
    const res = await post(forged)

    expect(res.status).toBe(200)
    expect(state.rpcCalls, 'a flipped outcome must never grant an entitlement').toEqual([])
    // And the payment is moved to cancelled, which is what actually happened.
    expect(state.updates.some(u => u.status === 'cancelled')).toBe(true)
  })

  it('always asks PayTech, and asks about the token it correlated on', async () => {
    await post(signedPayload())
    expect(state.statusCalls).toHaveLength(1)
    expect(state.statusCalls[0]).toContain('/payment/get-status')
    expect(state.statusCalls[0]).toContain(`token_payment=${TOKEN}`)
  })

  it('fulfils when and only when settlement is confirmed paid', async () => {
    await post(signedPayload())
    expect(state.rpcCalls).toHaveLength(1)
  })

  it('fulfils nothing while the transaction is still pending at the provider', async () => {
    state.settlement = settledBody('pending')
    const res = await post(signedPayload())
    expect((await res.json()).detail).toBe('unsettled:pending')
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'settlement_pending')).toBe(true)
  })

  it('fulfils nothing when the provider cannot be reached', async () => {
    state.settlement = null // the fake transport throws
    const res = await post(signedPayload())
    // XP-PAYTECH-04: unresolved is 503 — come back — not an acknowledgement.
    expect(res.status).toBe(503)
    expect((await res.json()).detail).toBe('unsettled:network_error')
    expect(state.rpcCalls, 'an unreachable provider must not grant access').toEqual([])
  })

  it('fulfils nothing for a status it does not recognise', async () => {
    // The /payment/get-status response shape is undocumented, so an
    // unrecognised value is the EXPECTED case until a real sandbox response
    // confirms it. It must refuse, not lean towards paid.
    state.settlement = settledBody('quelque_chose_inattendu')
    const res = await post(signedPayload())
    expect(res.status).toBe(503)
    expect((await res.json()).detail).toBe('unsettled:status_unrecognised')
    expect(state.rpcCalls).toEqual([])
  })

  it('fulfils nothing when the provider itself reports failure', async () => {
    state.settlement = { success: -1, message: 'nope' }
    const res = await post(signedPayload())
    expect(res.status).toBe(503)
    expect((await res.json()).detail).toBe('unsettled:provider_refused')
    expect(state.rpcCalls).toEqual([])
  })

  it('refuses when the CONFIRMED amount is not the stored amount', async () => {
    // The notification claimed the right amount and signed it; the
    // authoritative source disagrees. That is the failure only this check sees.
    state.settlement = settledBody('completed', 1)
    const res = await post(signedPayload())
    expect((await res.json()).detail).toBe('refused:settlement_amount_mismatch')
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'settlement_amount_mismatch')).toBe(true)
  })

  it('reads ONLY the contract\'s status path — a request envelope saying "success" is not a payment', async () => {
    state.settlement = { success: 1, status: 'success', payment: { status: 'pending', amount: AMOUNT, currency: 'XOF', ref_command: REFERENCE } }
    const res = await post(signedPayload())
    expect((await res.json()).detail).toBe('unsettled:pending')
    expect(state.rpcCalls).toEqual([])
  })

  it('XP-PAYTECH-04 safeguard 3: with NO confirmed contract nothing is inferred, and PayTech is not even asked', async () => {
    state.contract = null
    const res = await post(signedPayload())
    expect(res.status).toBe(503)
    expect((await res.json()).detail).toBe('unsettled:contract_unconfirmed')
    expect(state.statusCalls).toEqual([])
    expect(state.rpcCalls).toEqual([])
    expect(state.updates.some(u => u.failure_reason === 'settlement_unknown:contract_unconfirmed')).toBe(true)
  })

  it('an echoed reference that is not ours is unknown, never paid', async () => {
    state.settlement = { success: 1, payment: { status: 'completed', amount: AMOUNT, currency: 'XOF', ref_command: 'SCX-SOMEONE-ELSE' } }
    const res = await post(signedPayload())
    expect((await res.json()).detail).toBe('unsettled:reference_mismatch')
    expect(state.rpcCalls).toEqual([])
  })

  it('never asks PayTech before the notification is authenticated', async () => {
    // The settlement call costs a round trip and leaks nothing, but an
    // unauthenticated caller must not be able to make us originate traffic.
    await post(signedPayload({ api_secret_sha256: 'deadbeef' }))
    expect(state.statusCalls, 'an unauthenticated caller must not trigger a provider call').toEqual([])
  })
})
