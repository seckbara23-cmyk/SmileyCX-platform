// @vitest-environment node
/**
 * XP-PAYTECH-01 — checkout initiation, the configuration boundary, provider
 * selection, and the one-chokepoint rule.
 *
 * The IPN is covered in `xp-paytech-01-ipn.test.ts`. This file covers
 * everything that happens BEFORE the learner reaches PayTech, plus the two
 * structural rules the integration rests on: that exactly one module may call
 * `complete_payment()`, and that nothing a browser touches can fulfil.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const API_KEY = 'pk_test_key_value'
const API_SECRET = 'sk_test_secret_value'
const COURSE_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'

// ── source helpers ──────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
/** Source with comments stripped — a guard must not match its own prose. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

// ── mocks ───────────────────────────────────────────────────────────────────

const state: {
  user: { id: string } | null
  access: { allowed: boolean; reason?: string }
  course: Record<string, unknown> | null
  pending: Record<string, unknown> | null
  inserted: Record<string, unknown>[]
  updates: Record<string, unknown>[]
  insertFails: boolean
  updateFails: boolean
  fetchResponse: () => Response
} = {
  user: { id: USER_ID },
  access: { allowed: false, reason: 'not_entitled' },
  course: null,
  pending: null,
  inserted: [],
  updates: [],
  insertFails: false,
  updateFails: false,
  fetchResponse: () => jsonResponse({ success: 1, token: 'paytech_tok_ABCDEFGH', redirect_url: 'https://paytech.sn/payment/checkout/abc' }),
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}))

vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => state.access,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      let isPendingLookup = false
      const chain: Record<string, unknown> = {
        select: () => chain,
        order:  () => chain,
        limit:  () => chain,
        in:     () => { isPendingLookup = true; return chain },
        eq:     () => chain,
        neq:    () => chain,
        update: (patch: Record<string, unknown>) => { state.updates.push(patch); return chain },
        insert: (patch: Record<string, unknown>) => { state.inserted.push(patch); return chain },
        maybeSingle: async () => {
          if (table === 'courses') return { data: state.course, error: null }
          return { data: isPendingLookup ? state.pending : null, error: null }
        },
        single: async () =>
          state.insertFails
            ? { data: null, error: { message: 'insert failed' } }
            : { data: { id: 'pay-1' }, error: null },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            state.updateFails ? { data: null, error: { message: 'update failed' } } : { data: [{ id: 'pay-1' }], error: null },
          ).then(res),
      }
      return chain
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

beforeEach(() => {
  state.user = { id: USER_ID }
  state.access = { allowed: false, reason: 'not_entitled' }
  state.course = { id: COURSE_ID, title: 'Les fondamentaux', price: 45_000, currency: 'XOF', is_published: true }
  state.pending = null
  state.inserted = []
  state.updates = []
  state.insertFails = false
  state.updateFails = false

  vi.stubEnv('PAYTECH_ENABLED', 'true')
  vi.stubEnv('PAYTECH_MODE', 'test')
  vi.stubEnv('PAYTECH_TEST_API_KEY', API_KEY)
  vi.stubEnv('PAYTECH_TEST_API_SECRET', API_SECRET)
  vi.stubEnv('VERCEL_ENV', 'preview')
  vi.stubGlobal('fetch', vi.fn(async () => state.fetchResponse()))
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-01 · configuration boundary', () => {
  it('fails closed with no PAYTECH_MODE, naming the variable', async () => {
    const { paytechConfigError } = await import('@/lib/payments/paytech-config')
    const err = paytechConfigError({})
    expect(err).toMatch(/PAYTECH_MODE/)
    expect(err).toMatch(/no default/i)
  })

  it("accepts only exactly 'test' or 'prod'", async () => {
    const { paytechConfigError } = await import('@/lib/payments/paytech-config')
    for (const bad of ['TEST', ' test ', 'live', 'production', 'Prod']) {
      expect(paytechConfigError({ PAYTECH_MODE: bad }), bad).toMatch(/must be exactly/)
    }
  })

  it('names which credential is missing, and never a value', async () => {
    const { paytechConfigError } = await import('@/lib/payments/paytech-config')
    const err = paytechConfigError({ PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY })
    expect(err).toMatch(/PAYTECH_TEST_API_SECRET/)
    expect(err).not.toContain(API_KEY)
  })

  it('cannot read the other mode’s credentials', async () => {
    const { paytechConfigError } = await import('@/lib/payments/paytech-config')
    // prod selected, only test credentials present -> unusable, not a fallback.
    const err = paytechConfigError({
      PAYTECH_MODE: 'prod',
      PAYTECH_TEST_API_KEY: API_KEY,
      PAYTECH_TEST_API_SECRET: API_SECRET,
    })
    expect(err).toMatch(/PAYTECH_PROD_API_KEY/)
  })

  it("maps PayTech's env onto the provider_mode the database accepts", async () => {
    const { resolvePaytechConfig } = await import('@/lib/payments/paytech-config')
    const test = resolvePaytechConfig({
      PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET,
    })
    expect(test.env).toBe('test')
    expect(test.providerMode).toBe('test')
    expect(test.isLive).toBe(false)

    const prod = resolvePaytechConfig({
      PAYTECH_MODE: 'prod', PAYTECH_PROD_API_KEY: 'k', PAYTECH_PROD_API_SECRET: 's',
    })
    // 'prod' is PayTech's word; migration 058 only admits 'test' | 'live'.
    expect(prod.env).toBe('prod')
    expect(prod.providerMode).toBe('live')
    expect(prod.isLive).toBe(true)
  })

  it('redacts itself when logged, interpolated or serialised', async () => {
    const { resolvePaytechConfig } = await import('@/lib/payments/paytech-config')
    const c = resolvePaytechConfig({
      PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET,
    })
    expect(JSON.stringify(c)).not.toContain(API_SECRET)
    expect(`${c}`).not.toContain(API_SECRET)
    expect(String(c)).toMatch(/redacted/)
  })

  it('is server-only, so a client import is a build error', () => {
    expect(read('lib/payments/paytech-config.ts')).toMatch(/^import 'server-only'/m)
  })
})

describe('XP-PAYTECH-01 · provider selection (Phase F)', () => {
  const full = {
    PAYTECH_ENABLED: 'true', PAYTECH_MODE: 'test',
    PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET,
  }

  it('is unavailable unless PAYTECH_ENABLED is exactly true', async () => {
    const { paytechAvailability } = await import('@/lib/payments/providers')
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const env = { ...full, PAYTECH_ENABLED: v } as Record<string, string | undefined>
      expect(paytechAvailability(env).available, String(v)).toBe(false)
    }
    expect(paytechAvailability(full).available).toBe(true)
  })

  it('is unavailable when credentials do not resolve, even if enabled', async () => {
    const { paytechAvailability } = await import('@/lib/payments/providers')
    const r = paytechAvailability({ PAYTECH_ENABLED: 'true' })
    expect(r.available).toBe(false)
    expect(r.blockedBy).toMatch(/credentials/)
  })

  it('needs a SECOND explicit approval in production', async () => {
    const { paytechAvailability } = await import('@/lib/payments/providers')
    const prod = { ...full, VERCEL_ENV: 'production' }
    expect(paytechAvailability(prod).available).toBe(false)
    expect(paytechAvailability({ ...prod, PAYTECH_ALLOW_PRODUCTION: 'true' }).available).toBe(true)
  })

  it('keys production on VERCEL_ENV, not NODE_ENV (a preview is also NODE_ENV=production)', async () => {
    const { isProductionDeployment } = await import('@/lib/payments/providers')
    expect(isProductionDeployment({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(false)
    expect(isProductionDeployment({ VERCEL_ENV: 'production' })).toBe(true)
  })

  it('exposes no PayTech flag or credential through a NEXT_PUBLIC_ variable', () => {
    const c = code('lib/payments/providers.ts') + code('lib/payments/paytech-config.ts')
    expect(c).not.toMatch(/NEXT_PUBLIC_PAYTECH/)
  })

  it('offers no provider that is not configured and operational', async () => {
    const { availableProviders } = await import('@/lib/payments/providers')
    expect(availableProviders({})).toEqual([])
  })
})

describe('XP-PAYTECH-01 · scenario 17 — PayDunya regression', () => {
  it('PayDunya availability does not depend on any PayTech flag', async () => {
    const { paydunyaAvailability } = await import('@/lib/payments/providers')
    const base = {
      PAYDUNYA_MODE: 'test',
      PAYDUNYA_TEST_MASTER_KEY: 'm', PAYDUNYA_TEST_PRIVATE_KEY: 'p', PAYDUNYA_TEST_TOKEN: 't',
    }
    expect(paydunyaAvailability(base).available).toBe(true)
    // Turning PayTech off, or on, changes nothing about PayDunya.
    expect(paydunyaAvailability({ ...base, PAYTECH_ENABLED: 'true' }).available).toBe(true)
    expect(paydunyaAvailability({ ...base, PAYTECH_ENABLED: '' }).available).toBe(true)
  })

  it('no PayDunya module imports anything from PayTech', () => {
    for (const f of ['lib/payments/paydunya-config.ts', 'lib/payments/paydunya-client.ts']) {
      expect(code(f), `${f} must not depend on the new provider`).not.toMatch(/paytech/i)
    }
  })

  it('PayDunya still requires all three of its credentials', async () => {
    const { paydunyaConfigError } = await import('@/lib/payments/paydunya-config')
    expect(paydunyaConfigError({ PAYDUNYA_MODE: 'test' })).toMatch(/3 credentials/)
  })

  it('the legacy payment action is untouched and still cannot complete', () => {
    const c = code('app/actions/payment.ts')
    expect(c).not.toMatch(/complete_payment/)
    expect(c).not.toMatch(/paytech/i)
  })
})

describe('XP-PAYTECH-01 · the transport layer', () => {
  it('posts to the documented endpoint with the documented headers', async () => {
    const { requestPayment } = await import('@/lib/payments/paytech-client')
    const calls: { url: string; init: RequestInit }[] = []
    await requestPayment(
      {
        itemPrice: 45_000, itemName: 'X', commandName: 'Y', refCommand: 'SCX-1',
        ipnUrl: 'https://a.test/ipn', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c',
      },
      {
        env: { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET },
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          return jsonResponse({ success: 1, token: 'paytech_tok_ABCDEFGH', redirect_url: 'https://paytech.sn/p/1' })
        }) as unknown as typeof fetch,
      },
    )
    expect(calls[0].url).toBe('https://paytech.sn/api/payment/request-payment')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.API_KEY).toBe(API_KEY)
    expect(headers.API_SECRET).toBe(API_SECRET)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body).toMatchObject({ item_price: 45_000, currency: 'XOF', ref_command: 'SCX-1', env: 'test' })
  })

  it('judges the response by `success`, not by the HTTP status', async () => {
    const { requestPayment, PaytechApiError } = await import('@/lib/payments/paytech-client')
    // HTTP 200 with success: -1 is the provider's normal way of saying no.
    await expect(
      requestPayment(
        { itemPrice: 1, itemName: 'X', commandName: 'Y', refCommand: 'R', ipnUrl: 'https://a.test/i', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c' },
        {
          env: { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET },
          fetchImpl: (async () => jsonResponse({ success: -1, message: 'nope' })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof PaytechApiError && e.reason === 'provider_error')
  })

  it('refuses a redirect URL that is not HTTPS on paytech.sn — an open-redirect control', async () => {
    const { isValidPaytechRedirectUrl } = await import('@/lib/payments/paytech-client')
    expect(isValidPaytechRedirectUrl('https://paytech.sn/payment/checkout/x')).toBe(true)
    for (const bad of [
      'http://paytech.sn/x',                 // not HTTPS
      'https://evil.test/x',                 // wrong host
      'https://paytech.sn.evil.test/x',      // suffix trick
      'https://sub.paytech.sn/x',            // subdomains are NOT accepted
      'javascript:alert(1)',
      '',
    ]) {
      expect(isValidPaytechRedirectUrl(bad), bad).toBe(false)
    }
  })

  it('requires HTTPS for every callback URL it hands the provider', async () => {
    const { requestPayment, PaytechApiError } = await import('@/lib/payments/paytech-client')
    await expect(
      requestPayment(
        { itemPrice: 1, itemName: 'X', commandName: 'Y', refCommand: 'R', ipnUrl: 'http://a.test/i', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c' },
        { env: { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: API_KEY, PAYTECH_TEST_API_SECRET: API_SECRET } },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof PaytechApiError && e.reason === 'invalid_argument')
  })

  it('has NO confirm/verify function, because the provider documents none', () => {
    const c = code('lib/payments/paytech-client.ts')
    expect(c).not.toMatch(/function\s+confirm/i)
    expect(c).not.toMatch(/verify-payment|check-payment|payment-status/)
  })

  it('never reaches the database or the completion authority', () => {
    const c = code('lib/payments/paytech-client.ts')
    expect(c).not.toMatch(/supabase|complete_payment|entitlement/i)
  })
})

describe('XP-PAYTECH-01 · checkout eligibility', () => {
  async function start() {
    const { startPaytechCheckout } = await import('@/app/actions/paytech-checkout')
    return startPaytechCheckout({ courseId: COURSE_ID })
  }

  it('scenario 14 — refuses an unauthenticated caller', async () => {
    state.user = null
    const r = await start()
    expect(r.error).toMatch(/connecté/i)
    expect(r.redirectUrl).toBeUndefined()
    expect(state.inserted).toEqual([])
  })

  it('scenario 13 — refuses a learner who already has access', async () => {
    state.access = { allowed: true }
    const r = await start()
    expect(r.error).toMatch(/déjà accès/i)
    expect(state.inserted, 'an entitled learner must not be charged again').toEqual([])
  })

  it('scenario 15 — refuses an unpublished course', async () => {
    state.course = { ...state.course, is_published: false }
    const r = await start()
    expect(r.error).toMatch(/introuvable/i)
    expect(state.inserted).toEqual([])
  })

  it('refuses a course that does not exist', async () => {
    state.course = null
    expect((await start()).error).toMatch(/introuvable/i)
  })

  it('scenario 16 — refuses when PayTech is not available here', async () => {
    vi.stubEnv('PAYTECH_ENABLED', '')
    const r = await start()
    expect(r.error).toMatch(/pas disponible/i)
    expect(state.inserted).toEqual([])
  })

  it('refuses a course not priced in XOF', async () => {
    state.course = { ...state.course, currency: 'EUR' }
    expect((await start()).error).toBeTruthy()
    expect(state.inserted).toEqual([])
  })

  it('refuses a non-positive or fractional price', async () => {
    for (const price of [0, -1, 1.5]) {
      state.inserted = []
      state.course = { ...state.course, price }
      expect((await start()).error, String(price)).toBeTruthy()
      expect(state.inserted).toEqual([])
    }
  })

  it('tells an unverified learner to confirm their email rather than charging them', async () => {
    state.access = { allowed: false, reason: 'email_unverified' }
    expect((await start()).error).toMatch(/email/i)
    expect(state.inserted).toEqual([])
  })
})

describe('XP-PAYTECH-01 · checkout writes', () => {
  async function start() {
    const { startPaytechCheckout } = await import('@/app/actions/paytech-checkout')
    return startPaytechCheckout({ courseId: COURSE_ID })
  }

  it('takes the price from the database, never from the caller', async () => {
    await start()
    expect(state.inserted[0]).toMatchObject({ amount: 45_000, currency: 'XOF', status: 'pending' })
    const c = code('app/actions/paytech-checkout.ts')
    // The action's input type carries a course id and nothing else.
    expect(c).toMatch(/startPaytechCheckout\(input: \{\s*courseId: string\s*\}\)/)
    expect(c).not.toMatch(/input\.(amount|price|currency|reference)/)
  })

  it('persists the provider token BEFORE handing back a redirect URL', async () => {
    const r = await start()
    expect(r.redirectUrl).toBe('https://paytech.sn/payment/checkout/abc')
    const tokenWrite = state.updates.find(u => 'provider_token' in u)
    expect(tokenWrite).toMatchObject({ provider: 'paytech', provider_mode: 'test', status: 'processing' })
  })

  it('refuses to redirect when the token could not be stored', async () => {
    state.updateFails = true
    const r = await start()
    // A checkout the learner can pay but we cannot correlate is worse than a
    // refused sale: the IPN would arrive for a payment we cannot find.
    expect(r.redirectUrl).toBeUndefined()
    expect(r.error).toBeTruthy()
  })

  it('reuses a live intent instead of creating a second one', async () => {
    state.pending = { id: 'pay-existing', reference: 'SCX-OLD-REF', amount: 45_000, status: 'pending' }
    const r = await start()
    expect(state.inserted, '058 allows one live intent per learner per course').toEqual([])
    expect(r.redirectUrl).toBeTruthy()
  })

  it('refuses to re-price a live intent whose course price has since changed', async () => {
    state.pending = { id: 'pay-existing', reference: 'SCX-OLD-REF', amount: 30_000, status: 'pending' }
    const r = await start()
    expect(r.error).toMatch(/tarif/i)
    expect(state.updates.find(u => 'provider_token' in u)).toBeUndefined()
  })

  it('never leaks a provider message to the learner', async () => {
    state.fetchResponse = () => jsonResponse({ success: -1, message: 'INTERNAL: key xyz invalid' })
    const r = await start()
    expect(r.error).toBeTruthy()
    expect(r.error).not.toMatch(/INTERNAL|xyz/)
  })

  it('derives the three callback URLs from our own site, all HTTPS', async () => {
    const { paytechCallbackUrls } = await import('@/app/actions/paytech-checkout')
    const u = paytechCallbackUrls('https://www.xpclient-academy.com/')
    expect(u.ipnUrl).toBe('https://www.xpclient-academy.com/api/payments/paytech/ipn')
    expect(u.successUrl).toBe('https://www.xpclient-academy.com/payment/success')
    expect(u.cancelUrl).toBe('https://www.xpclient-academy.com/payment/cancel')
    for (const v of Object.values(u)) expect(v.startsWith('https://')).toBe(true)
  })

  it('the dashboard-registered URLs exist as real routes', () => {
    // The merchant dashboard holds these three paths. A dashboard setting is
    // not proof that the route exists, so the route files are asserted.
    expect(existsSync(join(process.cwd(), 'app/api/payments/paytech/ipn/route.ts'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'app/payment/success/page.tsx'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'app/payment/cancel/page.tsx'))).toBe(true)
  })

  it('cannot complete a payment from the checkout action', () => {
    expect(code('app/actions/paytech-checkout.ts')).not.toMatch(/complete_payment/)
  })

  it('the IPN is reachable on a preview host, or no notification can ever arrive', async () => {
    // `isAdminHost()` treats EVERY *.vercel.app host as the admin host by
    // design, and that host bounces anything outside ADMIN_HOST_PUBLIC_PATHS
    // to /login. Verified against a live preview: the IPN path returned a
    // redirect to /login, so a provider notification would have arrived as an
    // HTML login page and nothing would ever have been fulfilled.
    //
    // This is what makes the preview-only rollout in Phase F actually runnable,
    // so it is pinned rather than left as a deployment quirk.
    const { isAdminHost, isAdminHostPublicPath } = await import('@/lib/hosts')
    expect(isAdminHost('smiley-cx-platform-abc123.vercel.app')).toBe(true)
    expect(isAdminHostPublicPath('/api/payments/paytech/ipn')).toBe(true)
  })

  it('the exemption covers that one route, not the payments namespace', async () => {
    // `isAdminHostPublicPath` is PREFIX-based for every entry — that is how
    // '/auth/' and '/api/auth/' work — so the entry covers the IPN path and
    // anything below it. Nothing is routed below it, so the reachable surface
    // is the one handler; what matters is that no SIBLING is exposed.
    const { isAdminHostPublicPath } = await import('@/lib/hosts')
    for (const p of [
      '/api/payments',
      '/api/payments/paytech',
      '/api/payments/paydunya/ipn',
      '/api/payments/paytech/refund',
      '/api/admin/upload-url',
      '/api/media/lesson/abc/video',
    ]) {
      expect(isAdminHostPublicPath(p), `${p} must NOT be exposed on the admin host`).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-01 · migration 062 obligation 5 — ONE chokepoint', () => {
  const CHOKEPOINT = 'lib/payments/payment-completion.ts'

  it('exactly one module in the repository calls complete_payment', () => {
    const callers: string[] = []
    for (const dir of ['app', 'lib', 'components', 'scripts']) {
      for (const f of walk(join(process.cwd(), dir))) {
        const rel = f.replace(process.cwd() + '\\', '').replace(/\\/g, '/').replace(process.cwd() + '/', '')
        if (/\.rpc\(\s*['"]complete_payment['"]/.test(code(rel))) callers.push(rel)
      }
    }
    expect(callers).toEqual([CHOKEPOINT])
  })

  it('the chokepoint reaches the authority through service_role only', () => {
    const c = code(CHOKEPOINT)
    expect(c).toMatch(/createAdminClient/)
    // A browser-scoped client would be refused by 062's EXECUTE list anyway,
    // but using one here would mean the refusal is the only thing stopping it.
    expect(c).not.toMatch(/from '@\/lib\/supabase\/server'/)
  })

  it('treats already_completed as a SUCCESS (obligation 8)', () => {
    expect(code(CHOKEPOINT)).toMatch(/already_completed/)
  })

  it('only entitlement_race is retryable (obligation 7)', async () => {
    const { isRetryable } = await import('@/lib/payments/payment-completion')
    expect(isRetryable('entitlement_race')).toBe(true)
    for (const r of [
      'amount_mismatch', 'currency_mismatch', 'reference_mismatch', 'provider_mismatch',
      'provider_mode_mismatch', 'entitlement_conflict', 'entitlement_revoked_requires_decision',
      'status_not_completable', 'payment_not_found',
    ]) {
      expect(isRetryable(r), r).toBe(false)
    }
  })

  it('reads the structured reason out of the exception DETAIL', async () => {
    const { reasonFromError } = await import('@/lib/payments/payment-completion')
    expect(reasonFromError({ details: '{"reason":"amount_mismatch"}' })).toBe('amount_mismatch')
    expect(reasonFromError({ message: 'boom {"reason":"entitlement_race"}' })).toBe('entitlement_race')
    expect(reasonFromError({})).toBe('unknown_error')
  })
})

describe('XP-PAYTECH-01 · scenario 18 — a browser can never fulfil', () => {
  for (const page of ['app/payment/success/page.tsx', 'app/payment/cancel/page.tsx']) {
    it(`${page} writes nothing at all`, () => {
      const c = code(page)
      expect(c).not.toMatch(/complete_payment/)
      expect(c).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
      expect(c).not.toMatch(/grantEntitlement|recordTerminalFailure|touchIpnReceipt/)
    })
  }

  it('the success page reports the stored status and never asserts success from a query parameter', () => {
    const c = code('app/payment/success/page.tsx')
    // The only success branch is gated on the stored status.
    expect(c).toMatch(/status === 'completed'/)
    // Pending and processing must NOT render as success.
    expect(c).toMatch(/Confirmation en cours/)
    expect(c).not.toMatch(/searchParams[\s\S]{0,200}status\s*=/)
  })

  it('the cancel page cannot revoke a completed purchase', () => {
    const c = code('app/payment/cancel/page.tsx')
    expect(c).not.toMatch(/\.update\(/)
    expect(c).toMatch(/completed/)
  })
})
