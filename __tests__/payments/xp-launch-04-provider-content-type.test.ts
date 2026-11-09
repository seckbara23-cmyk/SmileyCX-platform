// @vitest-environment node
/**
 * XP-LAUNCH-04 — the provider's real transport.
 *
 * PayTech returns its JSON bodies WITHOUT a Content-Type header (observed on
 * 2026-11-07 against its test environment, on `request-payment` and on
 * `get-status`). Requiring the header made the first real checkout fail as
 * `non_json_response`. The client must read a header-less body by parsing it,
 * and must still refuse a response that DECLARES a non-JSON type.
 */
import { describe, it, expect } from 'vitest'
import { requestPayment, confirmPaymentStatus, PaytechApiError } from '@/lib/payments/paytech-client'

const env = { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'pk_test_key_value', PAYTECH_TEST_API_SECRET: 'sk_test_secret_value' }
const input = {
  itemPrice: 100, itemName: 'X', commandName: 'Y', refCommand: 'SCX-REF-1',
  ipnUrl: 'https://a.test/i', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c',
}
const OK = {
  success: 1, token: 'eeyABCDEFGHIJK',
  redirect_url: 'https://paytech.sn/payment/checkout/eeyABCDEFGHIJK',
  redirectUrl: 'https://paytech.sn/payment/checkout/eeyABCDEFGHIJK',
}

/** A 2xx whose body is bytes and whose headers carry NO content type, as PayTech answers. */
function headerless(body: string, status = 200) {
  const res = new Response(new TextEncoder().encode(body), { status, headers: { 'x-content-type-options': 'nosniff' } })
  res.headers.delete('content-type')
  return res
}
const typed = (body: string, type: string, status = 200) => new Response(body, { status, headers: { 'content-type': type } })
const fetching = (res: Response) => (async () => res) as unknown as typeof fetch

const contract = {
  confirmedBy: 'TEST FIXTURE — not a PayTech statement', successPath: 'success',
  request: { method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' },
  statusPath: 'payment.status', paid: ['completed'], failed: ['failed'], cancelled: ['canceled'],
  pending: ['pending'], amountPath: null, currencyPath: null, referencePath: null,
} as const
const target = { token: 'eeyABCDEFGHIJK', refCommand: 'SCX-REF-1' }

describe('XP-LAUNCH-04 · PayTech answers JSON without a Content-Type header', () => {
  it('the fixture really carries no content type', () => {
    expect(headerless('{}').headers.get('content-type')).toBeNull()
  })

  it('request-payment: a header-less JSON body opens the checkout', async () => {
    const checkout = await requestPayment(input, { env, fetchImpl: fetching(headerless(JSON.stringify(OK))) })
    expect(checkout.token).toBe(OK.token)
    expect(checkout.redirectUrl).toBe(OK.redirect_url)
  })

  it('request-payment: a header-less NON-JSON body is malformed_json, never a checkout', async () => {
    await expect(requestPayment(input, { env, fetchImpl: fetching(headerless('<html>maintenance</html>')) }))
      .rejects.toSatisfy((e: unknown) => e instanceof PaytechApiError && e.reason === 'malformed_json')
  })

  it('request-payment: a DECLARED non-JSON type is still refused before the body is read', async () => {
    await expect(requestPayment(input, { env, fetchImpl: fetching(typed(JSON.stringify(OK), 'text/html; charset=utf-8')) }))
      .rejects.toSatisfy((e: unknown) => e instanceof PaytechApiError && e.reason === 'non_json_response')
  })

  it('request-payment: an explicit JSON type keeps working', async () => {
    const checkout = await requestPayment(input, { env, fetchImpl: fetching(typed(JSON.stringify(OK), 'application/json')) })
    expect(checkout.token).toBe(OK.token)
  })

  it('get-status: a header-less JSON body is read under the contract', async () => {
    const body = JSON.stringify({ success: 1, payment: { status: 'pending' } })
    const r = await confirmPaymentStatus(target, { env, contract, fetchImpl: fetching(headerless(body)) })
    expect(r.outcome).toBe('pending')
  })

  it('get-status: a DECLARED non-JSON type is unknown/non_json_response', async () => {
    const r = await confirmPaymentStatus(target, { env, contract, fetchImpl: fetching(typed('<html></html>', 'text/html')) })
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'non_json_response' })
  })

  it('get-status: a header-less NON-JSON body is unknown/malformed_json', async () => {
    const r = await confirmPaymentStatus(target, { env, contract, fetchImpl: fetching(headerless('<html></html>')) })
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'malformed_json' })
  })
})
