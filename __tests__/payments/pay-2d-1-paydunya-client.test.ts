// @vitest-environment node
/**
 * PAY-2D-1 — the PayDunya HTTP transport.
 *
 * NO LIVE CALLS. Every request is served by an injected `fetchImpl`, and the
 * suite asserts that the real global fetch is never touched. Credentials are
 * injected through `EnvLike`, so no real key is read and `process.env` is never
 * mutated.
 *
 * Two kinds of assertion live here, and the second kind matters more:
 *
 *   1. Does the client read the provider correctly — including the three
 *      behaviours that make a naive client unsafe (HTTP 200 on failure, HTML
 *      bodies, and "transaction found" not meaning "paid").
 *   2. Does the client remain INCAPABLE of granting anything — no Supabase
 *      import, no RPC, no completion authority, no credential in an error, and
 *      no way to point TEST credentials at the LIVE endpoint.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import {
  createCheckoutInvoice,
  confirmCheckoutInvoice,
  paydunyaBaseUrl,
  normalisePaydunyaStatus,
  isValidPaydunyaToken,
  isValidCheckoutUrl,
  PaydunyaApiError,
  PAYDUNYA_HOST,
  PAYDUNYA_TIMEOUT_MS,
  PAYDUNYA_STATUSES,
  PAYDUNYA_ERROR_REASONS,
  type PaydunyaErrorReason,
} from '@/lib/payments/paydunya-client'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const CLIENT = 'lib/payments/paydunya-client.ts'

/**
 * The client with comments blanked.
 *
 * Every "the client must not do X" assertion below reads THIS, not the raw
 * source. The client's header documents at length why it does not send the
 * public key, does not read process.env and does not authorise anything — so a
 * raw-text assertion would be tripped by the very prose that explains the rule.
 * Only executable code can satisfy or violate a behavioural invariant.
 */
const CODE = read(CLIENT)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))

/** Distinctive fake credentials — if any of these leaks, a test will see it. */
const TEST_MASTER  = 'MASTERKEY-TEST-aaaaaaaaaaaaaaaa'
const TEST_PRIVATE = 'test_private_bbbbbbbbbbbbbbbb'
const TEST_TOKEN   = 'TOKEN-TEST-cccccccccccccccc'
const LIVE_MASTER  = 'MASTERKEY-LIVE-dddddddddddddddd'
const LIVE_PRIVATE = 'live_private_eeeeeeeeeeeeeeee'
const LIVE_TOKEN   = 'TOKEN-LIVE-ffffffffffffffff'
const SECRETS = [TEST_MASTER, TEST_PRIVATE, TEST_TOKEN, LIVE_MASTER, LIVE_PRIVATE, LIVE_TOKEN]

const testEnv = {
  PAYDUNYA_MODE: 'test',
  PAYDUNYA_TEST_MASTER_KEY: TEST_MASTER,
  PAYDUNYA_TEST_PRIVATE_KEY: TEST_PRIVATE,
  PAYDUNYA_TEST_TOKEN: TEST_TOKEN,
}
const liveEnv = {
  PAYDUNYA_MODE: 'live',
  PAYDUNYA_LIVE_MASTER_KEY: LIVE_MASTER,
  PAYDUNYA_LIVE_PRIVATE_KEY: LIVE_PRIVATE,
  PAYDUNYA_LIVE_TOKEN: LIVE_TOKEN,
}

const VALID_TOKEN = 'test_RHICF0HboN'
const CHECKOUT_URL = `https://${PAYDUNYA_HOST}/sandbox-checkout/invoice/${VALID_TOKEN}`

/** A fetch stub returning one canned response, recording what it was called with. */
function stub(
  body: unknown,
  o: { status?: number; contentType?: string | null; raw?: string } = {},
) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const headers = new Headers()
    if (o.contentType !== null) headers.set('content-type', o.contentType ?? 'application/json')
    const text = o.raw ?? JSON.stringify(body)
    return {
      ok: (o.status ?? 200) >= 200 && (o.status ?? 200) < 300,
      status: o.status ?? 200,
      headers,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const okCreate = { response_code: '00', response_text: CHECKOUT_URL, token: VALID_TOKEN }
const okConfirm = (over: Record<string, unknown> = {}) => ({
  response_code: '00',
  response_text: 'Transaction Found',
  status: 'completed',
  mode: 'test',
  invoice: { token: VALID_TOKEN, total_amount: 9500 },
  ...over,
})

const INVOICE = { totalAmount: 9500, description: 'Formation', storeName: 'XP Client Academy' }

/** Run a call and return the PaydunyaApiError it must throw. */
async function reasonOf(fn: () => Promise<unknown>): Promise<PaydunyaErrorReason> {
  try { await fn(); throw new Error('expected a PaydunyaApiError, got success') }
  catch (e) {
    expect(e, `threw ${(e as Error).name}: ${(e as Error).message}`)
      .toBeInstanceOf(PaydunyaApiError)
    return (e as PaydunyaApiError).reason
  }
}

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 1. TEST and LIVE cannot cross', () => {
  it('the base URL is derived from the mode, exhaustively', () => {
    expect(paydunyaBaseUrl('test')).toBe(`https://${PAYDUNYA_HOST}/sandbox-api/v1`)
    expect(paydunyaBaseUrl('live')).toBe(`https://${PAYDUNYA_HOST}/api/v1`)
  })

  it('TEST credentials never target a LIVE URL', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    const s2 = stub(okConfirm())
    await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s2.impl })
    for (const c of [...s.calls, ...s2.calls]) {
      expect(c.url).toContain('/sandbox-api/v1/')
      expect(c.url, 'a TEST call reached the LIVE path').not.toMatch(/\/api\/v1\//)
    }
  })

  it('LIVE credentials never target a TEST URL', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: liveEnv, fetchImpl: s.impl })
    const s2 = stub(okConfirm({ mode: 'live' }))
    await confirmCheckoutInvoice(VALID_TOKEN, { env: liveEnv, fetchImpl: s2.impl })
    for (const c of [...s.calls, ...s2.calls]) {
      expect(c.url).toContain('/api/v1/')
      expect(c.url, 'a LIVE call reached the SANDBOX path').not.toContain('sandbox')
    }
  })

  it('TEST mode sends only TEST credentials, LIVE only LIVE', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    const h = s.calls[0].init.headers as Record<string, string>
    expect(h['PAYDUNYA-MASTER-KEY']).toBe(TEST_MASTER)
    expect(JSON.stringify(h)).not.toContain(LIVE_MASTER)
    expect(JSON.stringify(h)).not.toContain(LIVE_PRIVATE)

    const s2 = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: liveEnv, fetchImpl: s2.impl })
    const h2 = s2.calls[0].init.headers as Record<string, string>
    expect(h2['PAYDUNYA-MASTER-KEY']).toBe(LIVE_MASTER)
    expect(JSON.stringify(h2)).not.toContain(TEST_MASTER)
    expect(JSON.stringify(h2)).not.toContain(TEST_PRIVATE)
  })

  it('there is no way to supply a base URL — the signature has no such argument', () => {
    const src = read(CLIENT)
    expect(src, 'a baseUrl/apiUrl/endpoint option would allow pointing TEST at LIVE')
      .not.toMatch(/\b(baseUrl|baseURL|apiUrl|apiBase|endpoint)\s*\??:/)
    // Both URLs appear exactly once each, inside the keyed map.
    expect((src.match(/sandbox-api\/v1/g) ?? []).length).toBe(1)
    expect((src.match(/\$\{PAYDUNYA_HOST\}\/api\/v1/g) ?? []).length).toBe(1)
  })

  it('every outbound URL is https on the provider host', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    const u = new URL(s.calls[0].url)
    expect(u.protocol).toBe('https:')
    expect(u.hostname).toBe(PAYDUNYA_HOST)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 2. headers are exactly the three documented', () => {
  it('sends master, private and token — and NOT the public key', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    const h = s.calls[0].init.headers as Record<string, string>
    expect(Object.keys(h).sort()).toEqual([
      'Content-Type', 'PAYDUNYA-MASTER-KEY', 'PAYDUNYA-PRIVATE-KEY', 'PAYDUNYA-TOKEN',
    ])
    expect(Object.keys(h).join(',')).not.toMatch(/PUBLIC/i)
    expect(CODE, 'the public key must never be sent').not.toMatch(/PAYDUNYA-PUBLIC-KEY/)
  })

  it('reads credentials only through the config module, never process.env', () => {
    expect(CODE).toMatch(/resolvePaydunyaConfig/)
    expect(CODE, 'the client reads the environment directly').not.toMatch(/process\.env/)
  })

  it('a missing or invalid configuration fails closed before any request', async () => {
    const s = stub(okCreate)
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: {}, fetchImpl: s.impl }))).toBe('config_invalid')
    expect(await reasonOf(() =>
      confirmCheckoutInvoice(VALID_TOKEN, { env: {}, fetchImpl: s.impl }))).toBe('config_invalid')
    // A partial credential set is never usable either.
    expect(await reasonOf(() => createCheckoutInvoice(INVOICE, {
      env: { PAYDUNYA_MODE: 'test', PAYDUNYA_TEST_MASTER_KEY: TEST_MASTER },
      fetchImpl: s.impl,
    }))).toBe('config_invalid')
    expect(s.calls, 'a request was made despite unusable configuration').toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 3. HTTP 200 does not mean success', () => {
  it('response_code 4000 (credentials absent) is a provider_error, not a success', async () => {
    const s = stub({ response_code: '4000', response_text: 'Your request was malformed.' })
    try {
      await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
      throw new Error('a 200 with code 4000 was treated as success')
    } catch (e) {
      const err = e as PaydunyaApiError
      expect(err.reason).toBe('provider_error')
      expect(err.responseCode).toBe('4000')
      expect(err.httpStatus).toBe(200)
    }
  })

  it('response_code 1001 (invalid master key) is a provider_error', async () => {
    const s = stub({ response_code: '1001', response_text: 'Invalid Masterkey Specified' })
    try {
      await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
      throw new Error('a 200 with code 1001 was treated as success')
    } catch (e) {
      expect((e as PaydunyaApiError).reason).toBe('provider_error')
      expect((e as PaydunyaApiError).responseCode).toBe('1001')
    }
  })

  it('an undocumented response_code is still refused', async () => {
    const s = stub({ response_code: '9999' })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('provider_error')
  })

  it("the provider's own response_text is NOT forwarded in the error message", async () => {
    const leak = 'SENSITIVE-PROVIDER-TEXT-DO-NOT-FORWARD'
    const s = stub({ response_code: '4000', response_text: leak })
    try { await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }) }
    catch (e) { expect((e as Error).message).not.toContain(leak) }
  })

  it('a numeric response_code is normalised rather than misread', async () => {
    // The PHP SDK compares loosely, so a numeric 0 is conceivable. It must mean
    // success, not be stringified to "0" and rejected.
    const s = stub({ response_code: 0, response_text: CHECKOUT_URL, token: VALID_TOKEN })
    const inv = await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    expect(inv.token).toBe(VALID_TOKEN)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 4. malformed and hostile responses', () => {
  it('a non-200 HTTP status is an http_error', async () => {
    const s = stub({}, { status: 502 })
    const r = await reasonOf(() => createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))
    expect(r).toBe('http_error')
  })

  it('an HTML body is rejected as non_json_response, never parsed', async () => {
    const s = stub(null, { contentType: 'text/html', raw: '<!doctype html><html>redirect</html>' })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('non_json_response')
  })

  it('a missing content-type is rejected too', async () => {
    const s = stub(null, { contentType: null, raw: '{"response_code":"00"}' })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('non_json_response')
  })

  it('malformed JSON under a JSON content type is malformed_json', async () => {
    const s = stub(null, { raw: '{"response_code": "00", oops' })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('malformed_json')
  })

  it('a response with no response_code at all is schema_invalid', async () => {
    const s = stub({ something: 'else' })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('schema_invalid')
  })

  it('a network failure is network_error and carries no request detail', async () => {
    const impl = (async () => { throw new TypeError('fetch failed to https://secret.internal') }) as unknown as typeof fetch
    try {
      await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: impl })
      throw new Error('expected failure')
    } catch (e) {
      expect((e as PaydunyaApiError).reason).toBe('network_error')
      expect((e as Error).message).not.toContain('secret.internal')
      expect((e as { cause?: unknown }).cause, 'the underlying error was attached').toBeUndefined()
    }
  })

  it('a timeout is reported as timeout, not as a network error', async () => {
    const impl = (async () => {
      const e = new Error('The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: impl }))).toBe('timeout')
  })

  it('an AbortError is also treated as a timeout', async () => {
    const impl = (async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }) as unknown as typeof fetch
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: impl }))).toBe('timeout')
  })

  it('every request carries an abort signal and no-store caching', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    expect(s.calls[0].init.signal, 'no timeout signal was attached').toBeDefined()
    expect(s.calls[0].init.cache).toBe('no-store')
    expect(PAYDUNYA_TIMEOUT_MS).toBeGreaterThan(0)
    expect(PAYDUNYA_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 5. create: token and redirect validation', () => {
  it('a successful create returns the token, URL and our own mode', async () => {
    const s = stub(okCreate)
    const inv = await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })
    expect(inv).toEqual({ token: VALID_TOKEN, checkoutUrl: CHECKOUT_URL, mode: 'test' })
    expect(s.calls[0].url).toBe(`https://${PAYDUNYA_HOST}/sandbox-api/v1/checkout-invoice/create`)
    expect(s.calls[0].init.method).toBe('POST')
  })

  it('the request body sends total_amount and store.name, and no item breakdown', async () => {
    const s = stub(okCreate)
    await createCheckoutInvoice(
      { ...INVOICE, customData: { paymentId: 'p1' }, channels: ['wave-senegal'] },
      { env: testEnv, fetchImpl: s.impl },
    )
    const body = JSON.parse(String(s.calls[0].init.body))
    expect(body.invoice.total_amount).toBe(9500)
    expect(body.store.name).toBe('XP Client Academy')
    expect(body.custom_data).toEqual({ paymentId: 'p1' })
    expect(body.invoice.channels).toEqual(['wave-senegal'])
    // The provider ignores item amounts when billing, so none is sent.
    expect(body.invoice.items, 'an item breakdown could disagree with the total').toBeUndefined()
    expect(body.invoice.taxes).toBeUndefined()
  })

  it('a success without a token is invalid_token', async () => {
    const s = stub({ response_code: '00', response_text: CHECKOUT_URL })
    expect(await reasonOf(() =>
      createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }))).toBe('invalid_token')
  })

  it('an implausible token shape is refused', async () => {
    for (const bad of ['', 'short', 'has/slash/token', 'has space tok', '../../etc/passwd', 'a'.repeat(200)]) {
      const s = stub({ response_code: '00', response_text: CHECKOUT_URL, token: bad })
      expect(await reasonOf(() =>
        createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })),
      ).toBe('invalid_token')
    }
  })

  it('a checkout URL on the wrong HOST is refused — no open redirect', async () => {
    for (const bad of [
      'https://evil.example.com/checkout/invoice/x',
      'https://app.paydunya.com.evil.example.com/x',
      'https://evil.com/?u=https://app.paydunya.com/',
      `https://sub.${PAYDUNYA_HOST}/x`,
    ]) {
      const s = stub({ response_code: '00', response_text: bad, token: VALID_TOKEN })
      expect(await reasonOf(() =>
        createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })),
      ).toBe('invalid_checkout_url')
    }
  })

  it('a checkout URL on the wrong PROTOCOL is refused', async () => {
    for (const bad of [
      `http://${PAYDUNYA_HOST}/checkout/invoice/x`,
      `javascript:alert(1)//${PAYDUNYA_HOST}`,
      `data:text/html,<script>1</script>`,
      'not a url at all',
    ]) {
      const s = stub({ response_code: '00', response_text: bad, token: VALID_TOKEN })
      expect(await reasonOf(() =>
        createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl })),
      ).toBe('invalid_checkout_url')
    }
  })

  it('a non-positive or fractional amount is refused before any request', async () => {
    const s = stub(okCreate)
    for (const amt of [0, -1, 9500.5, NaN, Infinity]) {
      expect(await reasonOf(() => createCheckoutInvoice(
        { ...INVOICE, totalAmount: amt }, { env: testEnv, fetchImpl: s.impl },
      ))).toBe('invalid_argument')
    }
    expect(await reasonOf(() => createCheckoutInvoice(
      { ...INVOICE, storeName: '  ' }, { env: testEnv, fetchImpl: s.impl },
    ))).toBe('invalid_argument')
    expect(s.calls, 'a bad argument still reached the network').toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 6. confirm: "found" is not "paid"', () => {
  it('a completed confirmation returns status and confirmed amount', async () => {
    const s = stub(okConfirm())
    const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
    expect(c.status).toBe('completed')
    expect(c.amount).toBe(9500)
    expect(c.token).toBe(VALID_TOKEN)
    expect(c.mode).toBe('test')
    expect(c.reportedMode).toBe('test')
    expect(s.calls[0].url)
      .toBe(`https://${PAYDUNYA_HOST}/sandbox-api/v1/checkout-invoice/confirm/${VALID_TOKEN}`)
    expect(s.calls[0].init.method).toBe('GET')
  })

  it('a PENDING confirmation is returned as pending, never as completed', async () => {
    const s = stub(okConfirm({ status: 'pending' }))
    const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
    expect(c.status).toBe('pending')
  })

  it('a FAILED confirmation is returned as failed, with fail_reason', async () => {
    const s = stub(okConfirm({ status: 'failed', fail_reason: 'card declined' }))
    const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
    expect(c.status).toBe('failed')
    expect(c.failReason).toBe('card declined')
  })

  it('both cancelled spellings normalise to cancelled', async () => {
    for (const raw of ['cancelled', 'canceled', 'CANCELLED', ' Canceled ']) {
      const s = stub(okConfirm({ status: raw }))
      const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
      expect(c.status, `status '${raw}' did not normalise`).toBe('cancelled')
    }
    expect(normalisePaydunyaStatus('canceled')).toBe('cancelled')
    expect(normalisePaydunyaStatus('COMPLETED')).toBe('completed')
  })

  it('a missing status is missing_status — found is not paid', async () => {
    const s = stub({ response_code: '00', response_text: 'Transaction Found',
                     invoice: { total_amount: 9500 } })
    expect(await reasonOf(() =>
      confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl }))).toBe('missing_status')
  })

  it('an unrecognised status FAILS CLOSED rather than drifting to completed', async () => {
    for (const bad of ['paid', 'success', 'COMPLETE', 'settled', '']) {
      const s = stub(okConfirm({ status: bad }))
      const r = await reasonOf(() =>
        confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl }))
      expect(['unknown_status', 'missing_status'], `status '${bad}'`).toContain(r)
    }
    expect(normalisePaydunyaStatus('paid')).toBeNull()
  })

  it('a non-positive, fractional or absent confirmed amount is refused', async () => {
    for (const amt of [0, -5, 95.5]) {
      const s = stub(okConfirm({ invoice: { total_amount: amt } }))
      expect(await reasonOf(() =>
        confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })),
      ).toBe('invalid_amount')
    }
    const s2 = stub(okConfirm({ invoice: {} }))
    expect(await reasonOf(() =>
      confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s2.impl })),
    ).toBe('invalid_amount')
    const s3 = stub({ response_code: '00', status: 'completed' })
    expect(await reasonOf(() =>
      confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s3.impl })),
    ).toBe('invalid_amount')
  })

  it('a string amount is accepted and returned as a number', async () => {
    // The IPN form-encodes everything; confirm may follow suit.
    const s = stub(okConfirm({ invoice: { total_amount: '9500' } }))
    const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
    expect(c.amount).toBe(9500)
    expect(typeof c.amount).toBe('number')
  })

  it('the undocumented provider identifiers are OPTIONAL', async () => {
    const without = stub(okConfirm())
    const a = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: without.impl })
    expect(a.receiptIdentifier).toBeUndefined()
    expect(a.providerReference).toBeUndefined()

    const with_ = stub(okConfirm({
      receipt_identifier: 'RCPT-1', provider_reference: 'PROV-1',
      receipt_url: `https://${PAYDUNYA_HOST}/r.pdf`,
    }))
    const b = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: with_.impl })
    expect(b.receiptIdentifier).toBe('RCPT-1')
    expect(b.providerReference).toBe('PROV-1')
    expect(b.receiptUrl).toBe(`https://${PAYDUNYA_HOST}/r.pdf`)
  })

  it('custom_data is returned untouched for the completion module to compare', async () => {
    const s = stub(okConfirm({ custom_data: { paymentId: 'p-1', courseId: 'c-1' } }))
    const c = await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl })
    expect(c.customData).toEqual({ paymentId: 'p-1', courseId: 'c-1' })
  })

  it('a malformed token is refused before it can reach the URL path', async () => {
    const s = stub(okConfirm())
    for (const bad of ['', '../../admin', 'tok en', 'a/b', 'x']) {
      expect(await reasonOf(() =>
        confirmCheckoutInvoice(bad, { env: testEnv, fetchImpl: s.impl }))).toBe('invalid_token')
    }
    expect(s.calls, 'a malformed token reached the network').toHaveLength(0)
    expect(isValidPaydunyaToken('../etc')).toBe(false)
    expect(isValidPaydunyaToken(VALID_TOKEN)).toBe(true)
  })

  it('the client does NOT decide anything about the amount', () => {
    // Amount comparison against the stored payment row belongs to the trusted
    // completion module. This layer validates the SHAPE and reports the value.
    expect(CODE).not.toMatch(/expectedAmount|amountMismatch|amount_mismatch/)
    expect(CODE, 'the transport layer must not authorise').not.toMatch(/\bauthoriz|\bauthoris/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 7. no credential and no provider body can leak', () => {
  it('no thrown error contains a credential, in any failure mode', async () => {
    const bodies: { body: unknown; o?: Parameters<typeof stub>[1] }[] = [
      { body: { response_code: '4000' } },
      { body: { response_code: '1001' } },
      { body: { response_code: '9999' } },
      { body: {}, o: { status: 500 } },
      { body: null, o: { contentType: 'text/html', raw: '<html>x</html>' } },
      { body: null, o: { raw: 'not json' } },
      { body: { nope: 1 } },
      { body: { response_code: '00' } },
      { body: { response_code: '00', token: VALID_TOKEN, response_text: 'http://evil.com' } },
    ]
    for (const env of [testEnv, liveEnv]) {
      for (const { body, o } of bodies) {
        const s = stub(body, o)
        for (const call of [
          () => createCheckoutInvoice(INVOICE, { env, fetchImpl: s.impl }),
          () => confirmCheckoutInvoice(VALID_TOKEN, { env, fetchImpl: s.impl }),
        ]) {
          try { await call() } catch (e) {
            const dump = `${(e as Error).name} ${(e as Error).message} ${(e as Error).stack ?? ''}` +
                         JSON.stringify(e, Object.getOwnPropertyNames(e as object))
            for (const secret of SECRETS) {
              expect(dump, `a credential leaked into an error (${(e as PaydunyaApiError).reason})`)
                .not.toContain(secret)
            }
          }
        }
      }
    }
  })

  it('a raw provider body never appears in an error', async () => {
    const marker = 'CUSTOMER-PHONE-770000000-AND-PAN'
    const s = stub({ response_code: '4000', response_text: marker, customer: { phone: marker } })
    try { await confirmCheckoutInvoice(VALID_TOKEN, { env: testEnv, fetchImpl: s.impl }) }
    catch (e) {
      const dump = `${(e as Error).message}` +
                   JSON.stringify(e, Object.getOwnPropertyNames(e as object))
      expect(dump).not.toContain(marker)
    }
  })

  it('the error class exposes only reason, httpStatus and responseCode', async () => {
    const s = stub({ response_code: '4000' })
    try { await createCheckoutInvoice(INVOICE, { env: testEnv, fetchImpl: s.impl }) }
    catch (e) {
      const own = Object.keys(e as object).sort()
      expect(own).toEqual(['httpStatus', 'name', 'reason', 'responseCode'])
    }
  })

  it('the module logs NOTHING at all', () => {
    const src = read(CLIENT)
    expect(src, 'the transport layer must not log').not.toMatch(/createLogger|console\.(log|error|warn|info|debug)/)
  })

  it('every declared error reason is reachable and distinct', () => {
    expect(new Set(PAYDUNYA_ERROR_REASONS).size).toBe(PAYDUNYA_ERROR_REASONS.length)
    const src = read(CLIENT)
    for (const r of PAYDUNYA_ERROR_REASONS) {
      expect(src, `reason '${r}' is declared but never raised`)
        .toMatch(new RegExp(`'${r}'`))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 8. the boundary: this module cannot grant anything', () => {
  const src = read(CLIENT)
  const code = CODE   // one comment-stripping mechanism for the whole suite

  it('is server-only by mechanism', () => {
    expect(src.split('\n')[0].trim()).toBe("import 'server-only'")
  })

  it('imports no Supabase client and performs no database access', () => {
    expect(code).not.toMatch(/@\/lib\/supabase|createAdminClient|createClient|supabase/i)
    expect(code).not.toMatch(/\.from\(/)
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })

  it('never calls an RPC, and never names the completion authority', () => {
    expect(code).not.toMatch(/\.rpc\(/)
    expect(code).not.toMatch(/complete_payment/)
  })

  it('touches no payment, entitlement, enrollment or audit table', () => {
    for (const t of ['payments', 'entitlements', 'enrollments', 'audit_log', 'certificates']) {
      expect(code, `the client references the ${t} table`)
        .not.toMatch(new RegExp(`['"\`]${t}['"\`]`))
    }
  })

  it('imports only zod and the credential config', () => {
    // Matches multi-line import blocks too — the config import spans lines.
    const imports = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['@/lib/payments/paydunya-config', 'zod'])
    // Plus the bare server-only marker.
    expect(src).toMatch(/^import 'server-only'$/m)
  })

  it('adds no dependency — zod and native fetch only', () => {
    const pkg = JSON.parse(read('package.json'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(deps.zod, 'zod must already be present').toBeTruthy()
    expect(deps.paydunya, 'the legacy PayDunya SDK must not be installed').toBeUndefined()
    for (const forbidden of ['superagent', 'bluebird', 'axios', 'node-fetch', 'msw', 'nock']) {
      expect(deps[forbidden], `${forbidden} was added`).toBeUndefined()
    }
  })

  it('no IPN, webhook or callback handler was introduced', () => {
    expect(existsSync(join(ROOT, 'app/api/webhooks'))).toBe(false)
    expect(existsSync(join(ROOT, 'app/api/payments'))).toBe(false)
    expect(existsSync(join(ROOT, 'lib/payments/completion.ts'))).toBe(false)
    expect(readdirSync(join(ROOT, 'lib/payments')).sort())
      .toEqual(['paydunya-client.ts', 'paydunya-config.ts'])
  })

  it('nothing imports the client yet — it has no callers', () => {
    const importers: string[] = []
    const walk = (d: string) => {
      let entries
      try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = `${d}/${e.name}`
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        if (/from\s+['"][^'"]*paydunya-client['"]/.test(read(p))) importers.push(p)
      }
    }
    ;['app', 'components', 'lib', 'types'].forEach(walk)
    expect(importers, `paydunya-client is imported by: ${importers.join(', ')}`).toEqual([])
  })

  it('checkout behaviour and the payment action are untouched', () => {
    const action = read('app/actions/payment.ts')
    expect(action).toMatch(/status:\s+'pending'/)
    expect(action, 'the action started using the provider client').not.toMatch(/paydunya-client/)
    const page = read('app/(platform)/checkout/page.tsx')
    // ENR-01C-b removed the pinned `if (PILOT_MODE)` branch (see the note in
    // pay-2d-0). Re-aimed at the invariant it was standing in for.
    expect(page, 'checkout redirects into /learn again').not.toContain('redirect(`/learn/')
    expect(page).toMatch(/if \(!PAYMENTS_ENABLED\)/)
  })

  it('no migration was added and 062 is untouched', () => {
    const migs = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    expect(migs).toHaveLength(60)
    const { createHash } = require('crypto') as typeof import('crypto')
    const raw = readFileSync(join(ROOT, 'supabase/migrations/062_atomic_payment_completion.sql'))
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('899cd3832573383b20df4dc09003f702a860c4ccb4651caead1a0bee817f31bb')
  })

  it('payment flags remain disabled', () => {
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      const env = read('.env.local')
      expect(env).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
      expect(env, 'a PayDunya credential appeared').not.toMatch(/^PAYDUNYA_/m)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-1 · 9. the tests themselves make no live call', () => {
  it('the suite injects fetch and never uses the global', () => {
    const self = read('__tests__/payments/pay-2d-1-paydunya-client.test.ts')
    expect(self).toMatch(/fetchImpl/)
    expect(self, 'the suite stubs the global fetch instead of injecting')
      .not.toMatch(/stubGlobal\(\s*['"]fetch/)
    // No real endpoint is ever contacted: the host appears only in assertions
    // and stub payloads, never as an un-injected call.
    expect(self).not.toMatch(/await fetch\(/)
  })

  it('the exported status vocabulary is exactly the four documented values', () => {
    expect([...PAYDUNYA_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed', 'pending'])
  })

  it('isValidCheckoutUrl accepts only https on the exact provider host', () => {
    expect(isValidCheckoutUrl(CHECKOUT_URL)).toBe(true)
    expect(isValidCheckoutUrl(`https://${PAYDUNYA_HOST}/checkout/invoice/x`)).toBe(true)
    expect(isValidCheckoutUrl(`http://${PAYDUNYA_HOST}/x`)).toBe(false)
    expect(isValidCheckoutUrl('https://app.paydunya.com.evil.com/x')).toBe(false)
    expect(isValidCheckoutUrl(undefined)).toBe(false)
    expect(isValidCheckoutUrl(`https://${PAYDUNYA_HOST}/` + 'a'.repeat(3000))).toBe(false)
  })
})
