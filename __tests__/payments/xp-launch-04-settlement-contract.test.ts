// @vitest-environment node
/**
 * XP-LAUNCH-04 — the settlement contract in force, proved on PayTech's own answers.
 *
 * The fixtures in `fixtures/paytech-get-status/` are sanitised copies of what
 * `GET /payment/get-status?token_payment=` answered in PayTech's test
 * environment on 2026-11-07: a paid Wave checkout (asked twice, identical),
 * unpaid and cancelled checkouts (both `running`), and an unknown token. Every
 * field name, type and status word is as observed; the personal fields carry
 * placeholders. PayTech sends these bodies with NO Content-Type header, and
 * the fixtures are served that way here.
 *
 * These tests use the LIVE constant (no injected contract): they are what
 * proves that the contract shipped is the one the answers satisfy.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { confirmPaymentStatus, PAYTECH_BASE_URL } from '@/lib/payments/paytech-client'
import { PAYTECH_SETTLEMENT_CONTRACT, contractProblems } from '@/lib/payments/paytech-settlement-contract'

const FIXTURES = join(process.cwd(), '__tests__/payments/fixtures/paytech-get-status')
type Answer = { success: number; payment: Record<string, unknown> | null }
const fixture = (name: string): Answer => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Answer
const withPayment = (a: Answer, patch: Record<string, unknown>): Answer => ({ ...a, payment: { ...(a.payment ?? {}), ...patch } })

const env = { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'pk_test_key_value', PAYTECH_TEST_API_SECRET: 'sk_test_secret_value' }
const PAID = { token: 'eeyFIXTUREPAID', refCommand: 'SCX-FIXTURE1-PAID000001' }
const OPEN = { token: 'eeyFIXTUREOPEN', refCommand: 'SCX-FIXTURE2-OPEN000002' }

/** PayTech's transport: HTTP 200, a JSON body as bytes, and no Content-Type header at all. */
function asPaytech(body: unknown): Response {
  const res = new Response(new TextEncoder().encode(JSON.stringify(body)), {
    status: 200, headers: { 'x-content-type-options': 'nosniff' },
  })
  res.headers.delete('content-type')
  return res
}

async function ask(body: unknown, target = PAID) {
  const spy = vi.fn(async () => asPaytech(body))
  const r = await confirmPaymentStatus(target, { env, fetchImpl: spy as unknown as typeof fetch })
  return { r, calls: spy.mock.calls as unknown as [string, RequestInit][] }
}

describe('XP-LAUNCH-04 · the settlement contract in force', () => {
  it('is filled, valid, and lists only the words PayTech was observed to answer', () => {
    expect(PAYTECH_SETTLEMENT_CONTRACT).not.toBeNull()
    const c = PAYTECH_SETTLEMENT_CONTRACT as NonNullable<typeof PAYTECH_SETTLEMENT_CONTRACT>
    expect(contractProblems(c)).toEqual([])
    expect(c.request).toEqual({ method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' })
    expect(c.successPath).toBe('success')
    expect(c.statusPath).toBe('payment.state')
    expect(c.paid).toEqual(['success'])
    expect(c.pending).toEqual(['running'])
    // Never observed, so never listed: an answer carrying such a word is unknown, not guessed.
    expect(c.failed).toEqual([])
    expect(c.cancelled).toEqual([])
    expect(c.amountPath).toBe('payment.item_price')
    expect(c.currencyPath).toBeNull()
    expect(c.referencePath).toBe('payment.ref_command')
    expect(c.confirmedBy).toMatch(/observed 2026-11-07/)
  })

  it('the fixtures are served the way PayTech sends them: no Content-Type header', () => {
    expect(asPaytech(fixture('paid')).headers.get('content-type')).toBeNull()
  })

  it('asks the documented endpoint with the token as token_payment and the key pair as headers', async () => {
    const { calls } = await ask(fixture('paid'))
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]
    expect(url).toBe(`${PAYTECH_BASE_URL}/payment/get-status?token_payment=${PAID.token}`)
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers.API_KEY).toBe(env.PAYTECH_TEST_API_KEY)
    expect(headers.API_SECRET).toBe(env.PAYTECH_TEST_API_SECRET)
  })

  it('the paid answer is PAID, with the item price as the amount and no currency', async () => {
    const { r } = await ask(fixture('paid'))
    expect(r).toEqual({ outcome: 'paid', reason: null, amount: 100, currency: null, shape: null })
  })

  it('an unpaid checkout — abandoned or cancelled, PayTech answers the same — is PENDING: still payable, nothing closes', async () => {
    const { r } = await ask(fixture('running'), OPEN)
    expect(r.outcome).toBe('pending')
    expect(r.reason).toBeNull()
  })

  it('an unknown token is refused by the provider, so it is unknown and completes nothing', async () => {
    const { r } = await ask(fixture('unknown-token'), OPEN)
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'provider_refused' })
  })

  it('a paid answer echoing another order is a reference mismatch, never paid', async () => {
    const { r } = await ask(fixture('paid'), { token: PAID.token, refCommand: 'SCX-FIXTURE9-OTHER00009' })
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'reference_mismatch' })
  })

  it('words PayTech has not been seen to use stay unknown: nothing is invented for failed or cancelled', async () => {
    for (const word of ['canceled', 'cancelled', 'failed', 'completed', 'paid', 'pending', 'expired', 'refunded']) {
      const { r } = await ask(withPayment(fixture('running'), { state: word }), OPEN)
      expect(r, word).toMatchObject({ outcome: 'unknown', reason: 'status_unrecognised' })
      expect(r.shape, word).toContain('payment.state')
    }
  })

  it('the status word is trimmed and lower-cased, nothing more', async () => {
    expect((await ask(withPayment(fixture('paid'), { state: ' SUCCESS ' }))).r.outcome).toBe('paid')
    expect((await ask(withPayment(fixture('paid'), { state: 'successful' }))).r.outcome).toBe('unknown')
  })

  it('a paid answer with no readable item price does not complete', async () => {
    const { payment, ...rest } = fixture('paid')
    const { item_price: _dropped, ...withoutPrice } = payment as Record<string, unknown> & { item_price: unknown }
    void _dropped
    const { r } = await ask({ ...rest, payment: withoutPrice })
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'amount_unreadable' })
  })

  it('the amount read is the item price PayTech reports, so a different price reaches the reconciler as a mismatch', async () => {
    const { r } = await ask(withPayment(fixture('paid'), { item_price: 150 }))
    expect(r).toMatchObject({ outcome: 'paid', amount: 150 })
  })

  it('a missing success flag, or success 0 with a payment attached, is refused before anything is read', async () => {
    const { success: _flag, ...noFlag } = fixture('paid')
    void _flag
    expect((await ask(noFlag)).r).toMatchObject({ outcome: 'unknown', reason: 'provider_refused' })
    expect((await ask({ ...fixture('paid'), success: 0 })).r).toMatchObject({ outcome: 'unknown', reason: 'provider_refused' })
  })

  it('the fixtures carry no personal data of a real payer', () => {
    for (const name of ['paid', 'running', 'unknown-token']) {
      const text = readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
      // The only digit runs are the placeholder phone number, prices and timestamps.
      expect(text.replace(/"000000000"|\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, ''), name).not.toMatch(/\d{7,}/)
      expect(text, name).not.toMatch(/@/)
    }
  })
})
