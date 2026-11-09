// @vitest-environment node
/**
 * XP-LAUNCH-04 — a cancelled PayTech checkout is RESUMED, never replaced.
 *
 * PayTech's « Annuler » button only redirects the browser. The hosted page it leaves
 * stays payable, `get-status` keeps answering `running` with no expiry announced, and
 * no notification is sent; the provider documents no call to cancel or invalidate a
 * token. The platform therefore never opens a second chargeable checkout beside a
 * pending one (safeguard 1). What this slice adds is that the learner is TOLD: the
 * cancel page offers « Reprendre le paiement » for an attempt in flight, the checkout
 * action flags the re-offered page as `resumed`, and the checkout page and its button
 * say so before the click.
 *
 * Everything here is mocked except the real helper, action, pages and button. The
 * settlement contract is the LIVE constant; the provider's answers are the sanitised
 * fixtures of `fixtures/paytech-get-status/`, served without a Content-Type header
 * as PayTech sends them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** Source with comments stripped — a guard must not match its own prose. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '99999999-9999-4999-8999-999999999999'
const COURSE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_COURSE = '33333333-3333-4333-8333-333333333333'
const TOKEN = 'eeyTESTRESUME001'
const STORED_URL = `https://paytech.sn/payment/checkout/${TOKEN}`
const REFERENCE = 'SCX-RESUME-REF01'
const PRICE = 45_000
const API_KEY = 'pk_test_key_value'
const API_SECRET = 'sk_test_secret_value'

// ── the database stand-in ───────────────────────────────────────────────────

interface Filter { m: string; args: unknown[] }
interface Query { table: string; select: string; filters: Filter[]; writes: string[] }

const db = {
  user: { id: USER_ID } as { id: string } | null,
  access: { allowed: false, reason: 'not_entitled' } as { allowed: boolean; reason?: string },
  course: null as Record<string, unknown> | null,
  profile: { id: USER_ID, full_name: 'Learner' } as Record<string, unknown> | null,
  /** Payment rows as the resume helper's query sees them; its filters are applied here. */
  inflight: [] as Record<string, unknown>[],
  /** The in-flight row checkout's step 6 finds for the caller and course. */
  pendingRow: null as Record<string, unknown> | null,
  /** The learner's latest payment, as the cancel page's fallback reads it. */
  latest: [] as Record<string, unknown>[],
  readFails: false,
  reads: [] as Query[],
  writes: [] as { table: string; op: string; patch: unknown }[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
}

function applyFilters(rows: Record<string, unknown>[], filters: Filter[]) {
  return rows.filter(r => filters.every(({ m, args }) => {
    const col = String(args[0])
    if (m === 'eq') return r[col] === args[1]
    if (m === 'in') return (args[1] as unknown[]).includes(r[col])
    if (m === 'not' && args[1] === 'is' && args[2] === null) return r[col] !== null && r[col] !== undefined
    return true
  }))
}

function resolveQuery(q: Query, shape: 'single' | 'many') {
  db.reads.push(q)
  if (q.writes.length > 0) {
    const row = { id: 'pay-new' }
    return { data: shape === 'single' ? row : [row], error: null }
  }
  if (q.table === 'courses') return { data: db.course, error: null }
  if (q.table !== 'payments') return { data: shape === 'single' ? null : [], error: null }
  if (db.readFails) return { data: null, error: { message: 'read failed' } }
  if (q.select === 'metadata') return { data: { metadata: db.pendingRow?.metadata ?? null }, error: null }
  if (q.select.includes('courses(slug, title)')) return { data: applyFilters(db.inflight, q.filters), error: null }
  if (q.filters.some(f => f.m === 'in' && f.args[0] === 'status')) return { data: db.pendingRow, error: null }
  if (q.select.includes('courses(slug)')) return { data: db.latest, error: null }
  return { data: shape === 'single' ? null : [], error: null }
}

function chain(table: string) {
  const q: Query = { table, select: '', filters: [], writes: [] }
  const c: Record<string, unknown> = {}
  for (const m of ['eq', 'neq', 'is', 'not', 'in', 'lt', 'gt', 'order', 'limit']) {
    c[m] = (...args: unknown[]) => { q.filters.push({ m, args }); return c }
  }
  c.select = (cols?: string) => { q.select = cols ?? ''; return c }
  for (const op of ['insert', 'update', 'upsert', 'delete']) {
    c[op] = (patch?: unknown) => { q.writes.push(op); db.writes.push({ table, op, patch }); return c }
  }
  c.maybeSingle = async () => resolveQuery(q, 'single')
  c.single = async () => resolveQuery(q, 'single')
  c.then = (res: (_v: unknown) => unknown, rej?: (_e: unknown) => unknown) =>
    Promise.resolve(resolveQuery(q, 'many')).then(res, rej)
  return c
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: unknown) => {
      db.rpcCalls.push({ fn, args })
      return db.rpc[fn] ?? { data: null, error: null }
    },
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) c[m] = () => c
      c.single = async () => ({ data: table === 'courses' ? db.course : table === 'profiles' ? db.profile : null, error: null })
      c.maybeSingle = c.single
      c.then = (res: (_v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return c
    },
  }),
}))

vi.mock('@/lib/auth/course-access', () => ({ resolveCourseAccessById: async () => db.access }))
vi.mock('@/lib/payments/payment-database-guard', () => ({ paymentDatabaseAuthority: async () => ({ allowed: true, reason: null }) }))
vi.mock('@/lib/payments/purchase-eligibility', () => ({ purchaseBlocker: async () => null }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) },
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode; className?: string }) =>
    <a href={href} {...rest}>{children}</a>,
}))

// ── the provider ────────────────────────────────────────────────────────────

const FIXTURES = join(ROOT, '__tests__/payments/fixtures/paytech-get-status')
type Answer = { success: number; payment: Record<string, unknown> | null }
const fixture = (name: string): Answer => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Answer

/** PayTech's transport: HTTP 200, a JSON body as bytes, and no Content-Type header at all. */
function asPaytech(body: unknown): Response {
  const res = new Response(new TextEncoder().encode(JSON.stringify(body)), {
    status: 200, headers: { 'x-content-type-options': 'nosniff' },
  })
  res.headers.delete('content-type')
  return res
}

/** The sanitised fixture about OUR attempt: it echoes our reference and our price. */
function providerSays(name: 'running' | 'paid', patch: Record<string, unknown> = {}) {
  const base = fixture(name)
  return asPaytech({
    ...base,
    payment: { ...(base.payment ?? {}), ref_command: REFERENCE, item_price: PRICE, item_price_xof: PRICE, token: TOKEN, ...patch },
  })
}

/** An attempt OPENED 14 hours ago: a token stored, a hosted page handed out, nothing heard since. */
const openedAttempt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pay-open', user_id: USER_ID, course_id: COURSE_ID, amount: PRICE, currency: 'XOF', reference: REFERENCE,
  status: 'processing', provider: 'paytech', provider_mode: 'test', provider_token: TOKEN,
  created_at: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString(),
  metadata: { provider: 'paytech', checkoutUrl: STORED_URL },
  courses: { slug: 'formation-test', title: 'Formation test PayTech' },
  ...over,
})

const inserts = () => db.writes.filter(w => w.op === 'insert')
const tokenWrites = () => db.writes.filter(w => w.op === 'update' && typeof w.patch === 'object' && w.patch !== null && 'provider_token' in (w.patch as object))
const statusWrites = () => db.writes.filter(w => typeof w.patch === 'object' && w.patch !== null && 'status' in (w.patch as object))

// The first import of the server action pulls in the Supabase SSR client.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  db.user = { id: USER_ID }
  db.access = { allowed: false, reason: 'not_entitled' }
  db.course = { id: COURSE_ID, slug: 'formation-test', title: 'Formation test PayTech', price: PRICE, currency: 'XOF', is_published: true, is_free: false }
  db.profile = { id: USER_ID, full_name: 'Learner' }
  db.inflight = []
  db.pendingRow = null
  db.latest = []
  db.readFails = false
  db.reads = []
  db.writes = []
  db.rpcCalls = []
  db.rpc = {}

  vi.unstubAllEnvs()
  vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', 'true')
  vi.stubEnv('PAYTECH_MODE', 'test')
  vi.stubEnv('PAYTECH_TEST_API_KEY', API_KEY)
  vi.stubEnv('PAYTECH_TEST_API_SECRET', API_SECRET)
  vi.stubEnv('VERCEL_ENV', 'preview')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected provider call') }))
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-LAUNCH-04 · B1 — the read-only resume lookup', () => {
  it("lists the signed-in learner's OPENED attempts in flight, and nobody else's", async () => {
    db.inflight = [
      openedAttempt(),
      openedAttempt({ id: 'pay-other-user', user_id: OTHER_USER }),
      openedAttempt({ id: 'pay-unopened', provider_token: null }),   // never opened: no page exists
      openedAttempt({ id: 'pay-closed', status: 'cancelled' }),
      openedAttempt({ id: 'pay-done', status: 'completed' }),
      openedAttempt({ id: 'pay-paydunya', provider: 'paydunya' }),
    ]
    const { inflightPaytechAttempts } = await import('@/lib/payments/paytech-resume')
    const list = await inflightPaytechAttempts(USER_ID)
    expect(list?.map(a => a.paymentId)).toEqual(['pay-open'])
    expect(list?.[0]).toMatchObject({
      courseId: COURSE_ID, courseSlug: 'formation-test', courseTitle: 'Formation test PayTech',
      reference: REFERENCE, resumable: true,
    })
    // The scope is in the statement itself, not applied afterwards.
    const q = db.reads.find(r => r.table === 'payments')!
    expect(q.filters).toContainEqual({ m: 'eq', args: ['user_id', USER_ID] })
    expect(q.filters).toContainEqual({ m: 'eq', args: ['provider', 'paytech'] })
    expect(q.filters).toContainEqual({ m: 'in', args: ['status', ['pending', 'processing']] })
    expect(q.filters).toContainEqual({ m: 'not', args: ['provider_token', 'is', null] })
  })

  it('says only WHETHER a hosted page is stored — never the URL, never the token', async () => {
    db.inflight = [openedAttempt()]
    const { inflightPaytechAttempts } = await import('@/lib/payments/paytech-resume')
    const json = JSON.stringify(await inflightPaytechAttempts(USER_ID))
    expect(json).toContain('"resumable":true')
    expect(json).not.toContain(TOKEN)
    expect(json).not.toContain('paytech.sn')
    expect(json).not.toContain('checkoutUrl')
  })

  it('a missing or foreign stored URL is not resumable', async () => {
    const { inflightPaytechAttempts } = await import('@/lib/payments/paytech-resume')
    for (const metadata of [
      null,
      { provider: 'paytech' },
      { provider: 'paytech', checkoutUrl: 'https://evil.test/x' },
      { provider: 'paytech', checkoutUrl: 'https://paytech.sn.evil.test/x' },
      { provider: 'paytech', checkoutUrl: 'http://paytech.sn/x' },
    ]) {
      db.inflight = [openedAttempt({ metadata })]
      const list = await inflightPaytechAttempts(USER_ID)
      expect(list, JSON.stringify(metadata)).toHaveLength(1)
      expect(list?.[0].resumable, JSON.stringify(metadata)).toBe(false)
    }
  })

  it('scopes to one course on request, and answers null — not "none" — when the read fails', async () => {
    db.inflight = [openedAttempt(), openedAttempt({ id: 'pay-c2', course_id: OTHER_COURSE })]
    const { inflightPaytechAttempt, inflightPaytechAttempts } = await import('@/lib/payments/paytech-resume')
    expect((await inflightPaytechAttempt(USER_ID, OTHER_COURSE))?.paymentId).toBe('pay-c2')
    expect(await inflightPaytechAttempt(USER_ID, '44444444-4444-4444-8444-444444444444')).toBeNull()
    expect(await inflightPaytechAttempts('')).toEqual([])
    db.readFails = true
    expect(await inflightPaytechAttempts(USER_ID)).toBeNull()
  })

  it('has no write path, calls no provider, and is server-only', () => {
    expect(read('lib/payments/paytech-resume.ts')).toMatch(/^import 'server-only'/m)
    const c = code('lib/payments/paytech-resume.ts')
    expect(c).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/)
    expect(c).not.toMatch(/startPaytechCheckout|requestPayment|confirmPaymentStatus|complete_payment|fetch\(/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-LAUNCH-04 · B1 — the checkout action resumes a pending attempt, and says so', () => {
  async function start() {
    const { startPaytechCheckout } = await import('@/app/actions/paytech-checkout')
    return startPaytechCheckout({ courseId: COURSE_ID })
  }

  it('RESUMED: the provider says running → the SAME stored page, flagged resumed, with the reference', async () => {
    db.pendingRow = openedAttempt()
    const fetchSpy = vi.fn(async () => providerSays('running'))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await start()
    expect(r).toEqual({ redirectUrl: STORED_URL, resumed: true, reference: REFERENCE })
    // Nothing new: no row, no token, no second checkout requested.
    expect(inserts()).toEqual([])
    expect(tokenWrites()).toEqual([])
    expect(statusWrites()).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://paytech.sn/api/payment/get-status?token_payment=${TOKEN}`)
    expect(init.method).toBe('GET')
  })

  it('NEW: nothing in flight → a checkout is requested and the result is NOT flagged', async () => {
    const fetchSpy = vi.fn(async () => asPaytech({
      success: 1, token: 'eeyNEWTOKEN00001', redirect_url: 'https://paytech.sn/payment/checkout/eeyNEWTOKEN00001',
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await start()
    expect(r.redirectUrl).toBe('https://paytech.sn/payment/checkout/eeyNEWTOKEN00001')
    expect(r.resumed).toBeUndefined()
    expect(inserts()).toHaveLength(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/payment/request-payment')
  })

  it('MISSING REDIRECT: pending with no stored page → the verification message with the reference; nothing opened', async () => {
    db.pendingRow = openedAttempt({ metadata: { provider: 'paytech' } })
    vi.stubGlobal('fetch', vi.fn(async () => providerSays('running')))
    const r = await start()
    expect(r.redirectUrl).toBeUndefined()
    expect(r.resumed).toBeUndefined()
    expect(r.error).toMatch(/vérification/i)
    expect(r.reference).toBe(REFERENCE)
    expect(inserts()).toEqual([])
    expect(statusWrites()).toEqual([])
  })

  it("a stored URL that is not the provider's is treated as missing — never followed", async () => {
    db.pendingRow = openedAttempt({ metadata: { provider: 'paytech', checkoutUrl: 'https://paytech.sn.evil.test/x' } })
    vi.stubGlobal('fetch', vi.fn(async () => providerSays('running')))
    const r = await start()
    expect(r.redirectUrl).toBeUndefined()
    expect(r.resumed).toBeUndefined()
    expect(r.error).toMatch(/vérification/i)
  })

  it('COMPLETED meanwhile: the provider says paid → the learner goes in; nothing resumed, nothing re-offered', async () => {
    db.pendingRow = openedAttempt()
    db.rpc.complete_payment = { data: { outcome: 'completed', entitlementId: 'ent-1', preExistingEntitlement: false }, error: null }
    vi.stubGlobal('fetch', vi.fn(async () => providerSays('paid')))
    const r = await start()
    expect(r).toEqual({ accessUrl: '/courses/formation-test' })
    expect(db.rpcCalls.filter(c => c.fn === 'complete_payment')).toHaveLength(1)
    expect(inserts()).toEqual([])
    expect(tokenWrites()).toEqual([])
  })

  it('PROVIDER ERROR or an unlisted word: fail closed — nothing re-offered, nothing opened, the contract untouched', async () => {
    for (const [label, answer] of [
      ['a word PayTech never stated', () => providerSays('running', { state: 'canceled' })],
      ['an unknown token', () => asPaytech({ success: 0, payment: null })],
      ['the provider down', () => new Response('maintenance', { status: 503 })],
      ['the network failing', () => { throw new Error('ECONNRESET') }],
    ] as const) {
      db.pendingRow = openedAttempt()
      db.writes = []
      vi.stubGlobal('fetch', vi.fn(async () => answer()))
      const r = await start()
      expect(r.redirectUrl, `${label}: a page was offered on an unverified answer`).toBeUndefined()
      expect(r.resumed, label).toBeUndefined()
      expect(r.error, label).toMatch(/vérification/i)
      expect(r.reference, label).toBe(REFERENCE)
      expect(inserts(), label).toEqual([])
      expect(statusWrites(), `${label}: the attempt was closed on a guess`).toEqual([])
    }
  })

  it('UNAUTHORIZED: no session → refused before any attempt is read; the provider is never asked', async () => {
    db.user = null
    db.pendingRow = openedAttempt()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await start()
    expect(r.error).toMatch(/connecté/i)
    expect(r.redirectUrl).toBeUndefined()
    expect(r.resumed).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.reads.filter(q => q.table === 'payments')).toEqual([])
  })

  it('the attempt is read for the CALLER only: the session decides, never the request', async () => {
    db.pendingRow = openedAttempt()
    vi.stubGlobal('fetch', vi.fn(async () => providerSays('running')))
    await start()
    const q = db.reads.find(r => r.table === 'payments' && r.filters.some(f => f.m === 'in'))!
    expect(q.filters).toContainEqual({ m: 'eq', args: ['user_id', USER_ID] })
    expect(q.filters).toContainEqual({ m: 'eq', args: ['course_id', COURSE_ID] })
    const c = code('app/actions/paytech-checkout.ts')
    expect(c).toMatch(/startPaytechCheckout\(input: \{\s*courseId: string\s*\}\)/)
    expect(c).not.toMatch(/input\.(paymentId|reference|token|resume|redirect)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-LAUNCH-04 · B1 — the cancel page offers to resume, and still writes nothing', () => {
  async function renderCancelPage() {
    const { default: PaymentCancelPage } = await import('@/app/payment/cancel/page')
    return renderToStaticMarkup(await PaymentCancelPage())
  }

  it("CANCELLED PAGE: an attempt in flight → « Reprendre le paiement » to that course's checkout, with the reference", async () => {
    db.inflight = [openedAttempt()]
    const html = await renderCancelPage()
    expect(html).toContain('Reprendre le paiement')
    expect(html).toContain(`href="/checkout?course=${COURSE_ID}"`)
    expect(html).toContain('Formation test PayTech')
    expect(html).toContain(REFERENCE)
    expect(html).toMatch(/Aucun paiement n(&#x27;|’|')a été confirmé/)
    // The hosted page and the token stay on the server.
    expect(html).not.toContain('paytech.sn')
    expect(html).not.toContain(TOKEN)
    // Arriving here changes nothing: no write, no RPC, no provider call.
    expect(db.writes).toEqual([])
    expect(db.rpcCalls).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('every attempt in flight is listed, each to its own course', async () => {
    db.inflight = [openedAttempt(), openedAttempt({ id: 'pay-c2', course_id: OTHER_COURSE, reference: 'SCX-RESUME-REF02', courses: { slug: 'c2', title: 'Deuxième formation' } })]
    const html = await renderCancelPage()
    expect(html).toContain(`href="/checkout?course=${COURSE_ID}"`)
    expect(html).toContain(`href="/checkout?course=${OTHER_COURSE}"`)
    expect(html).toContain('Deuxième formation')
    expect(html).toContain('SCX-RESUME-REF02')
  })

  it('an attempt without a stored page gets the verification message, not a resume link', async () => {
    db.inflight = [openedAttempt({ metadata: { provider: 'paytech' } })]
    const html = await renderCancelPage()
    expect(html).not.toContain('Reprendre le paiement')
    expect(html).toContain('en cours de vérification')
    expect(html).toContain(REFERENCE)
    expect(html).toContain('href="/contact"')
  })

  it('no resume link where this deployment takes no payments — the action would refuse it', async () => {
    vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', '')
    db.inflight = [openedAttempt()]
    const html = await renderCancelPage()
    expect(html).not.toContain('Reprendre le paiement')
    expect(html).toContain(REFERENCE)
  })

  it('COMPLETED: nothing in flight and the latest payment completed → the purchase is confirmed, nothing to resume', async () => {
    db.latest = [{ status: 'completed', courses: { slug: 'formation-test' } }]
    const html = await renderCancelPage()
    expect(html).toContain('Votre dernier paiement est confirmé')
    expect(html).toContain('href="/courses/formation-test"')
    expect(html).not.toContain('Reprendre le paiement')
    expect(db.writes).toEqual([])
  })

  it('nothing in flight, nothing completed → the plain cancellation page', async () => {
    db.latest = [{ status: 'cancelled', courses: null }]
    const html = await renderCancelPage()
    expect(html).toContain('Paiement annulé')
    expect(html).toContain('href="/courses"')
    expect(html).not.toContain('Reprendre le paiement')
    expect(html).not.toContain('/login?next=')
  })

  it('UNAUTHORIZED: signed out → the plain page with a sign-in link, and no payment is read at all', async () => {
    db.user = null
    db.inflight = [openedAttempt()]
    const html = await renderCancelPage()
    expect(html).not.toContain('Reprendre le paiement')
    expect(html).not.toContain(REFERENCE)
    expect(html).toContain('href="/login?next=/payment/cancel"')
    expect(db.reads.filter(q => q.table === 'payments')).toEqual([])
  })

  it('a failed read falls back to the plain page rather than claiming there is nothing to resume', async () => {
    db.readFails = true
    db.inflight = [openedAttempt()]
    const html = await renderCancelPage()
    expect(html).toContain('Paiement annulé')
    expect(html).not.toContain('Reprendre le paiement')
    expect(db.writes).toEqual([])
  })

  it("writes nothing, reads only the session's learner, and takes no attempt from the request", () => {
    const c = code('app/payment/cancel/page.tsx')
    expect(c).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/)
    expect(c).not.toMatch(/searchParams|startPaytechCheckout|requestPayment|confirmPaymentStatus/)
    expect(c).toMatch(/inflightPaytechAttempts\(user\.id\)/)
    expect(c).toMatch(/\/checkout\?course=\$\{encodeURIComponent\(attempt\.courseId\)\}/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-LAUNCH-04 · B1 — the checkout page tells a resume from a new purchase', () => {
  async function renderCheckoutPage() {
    const { default: CheckoutPage } = await import('@/app/(platform)/checkout/page')
    return renderToStaticMarkup(await CheckoutPage({ searchParams: Promise.resolve({ course: COURSE_ID }) }))
  }

  it('RESUMED: an attempt in flight → « Reprise de votre paiement en cours », the reference, a resume button', async () => {
    db.inflight = [openedAttempt()]
    const html = await renderCheckoutPage()
    expect(html).toContain('Reprendre votre paiement')
    expect(html).toContain('Reprise de votre paiement en cours')
    expect(html).toMatch(/aucune nouvelle commande/i)
    expect(html).toContain(REFERENCE)
    expect(html).toContain('Reprendre le paiement')
    expect(html).not.toContain('Payer avec PayTech')
    expect(html).not.toContain('paytech.sn')
    expect(html).not.toContain(TOKEN)
    expect(db.writes).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('NEW: nothing in flight → « Finaliser votre inscription » and « Payer avec PayTech », no resume notice', async () => {
    const html = await renderCheckoutPage()
    expect(html).toContain('Finaliser votre inscription')
    expect(html).toContain('Payer avec PayTech')
    expect(html).not.toContain('Reprise de votre paiement')
    expect(html).not.toContain('Reprendre le paiement')
  })

  it('PENDING WITHOUT A PAGE: the notice says a payment is being verified; the button offers to check it', async () => {
    db.inflight = [openedAttempt({ metadata: { provider: 'paytech' } })]
    const html = await renderCheckoutPage()
    expect(html).toContain('en cours de vérification')
    expect(html).toContain('Vérifier l’état de mon paiement')
    expect(html).not.toContain('Reprendre le paiement')
    expect(html).toContain(REFERENCE)
  })

  it('an attempt on ANOTHER course is not this checkout’s resume', async () => {
    db.inflight = [openedAttempt({ course_id: OTHER_COURSE })]
    const html = await renderCheckoutPage()
    expect(html).toContain('Payer avec PayTech')
    expect(html).not.toContain('Reprise de votre paiement')
  })

  it('an entitled learner is still sent to the course, and a signed-out one to login, before any attempt is read', async () => {
    db.access = { allowed: true }
    await expect(renderCheckoutPage()).rejects.toThrow('NEXT_REDIRECT:/courses/formation-test')
    db.access = { allowed: false, reason: 'not_entitled' }
    db.user = null
    await expect(renderCheckoutPage()).rejects.toThrow(`NEXT_REDIRECT:/login?next=/checkout?course=${COURSE_ID}`)
    expect(db.reads.filter(q => q.table === 'payments')).toEqual([])
  })

  it('the page reads the attempt for the signed-in learner and this course; the action keeps its one caller', () => {
    const page = code('app/(platform)/checkout/page.tsx')
    expect(page).toMatch(/inflightPaytechAttempt\(user\.id, String\(course\.id\)\)/)
    expect(page).toMatch(/<PaytechCheckoutButton courseId=\{String\(course\.id\)\} resume=/)
    expect(page).not.toMatch(/startPaytechCheckout/)
    const button = code('components/payment/PaytechCheckoutButton.tsx')
    expect(button).toMatch(/startPaytechCheckout\(\{ courseId \}\)/)
    expect(button).toMatch(/result\.resumed === true/)
    expect(button).toMatch(/window\.location\.assign\(destination\)/)
    // The button renders no link and no field of its own: the server decides where to go.
    expect(button).not.toMatch(/<input|<Input|href=/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-LAUNCH-04 · B1 — the button names what the server decided', () => {
  it('reads « Payer avec PayTech » for a new purchase and « Reprendre le paiement » for a resume', async () => {
    const { default: Button } = await import('@/components/payment/PaytechCheckoutButton')
    const plain = renderToStaticMarkup(<Button courseId={COURSE_ID} />)
    expect(plain).toContain('Payer avec PayTech')
    expect(plain).toContain('redirigé vers')
    expect(plain).not.toContain('Reprendre le paiement')

    const resume = renderToStaticMarkup(<Button courseId={COURSE_ID} resume={{ resumable: true }} />)
    expect(resume).toContain('Reprendre le paiement')
    expect(resume).toContain('session de paiement PayTech en cours')
    expect(resume).toMatch(/Aucune nouvelle commande/)
    expect(resume).not.toContain('Payer avec PayTech')

    const checking = renderToStaticMarkup(<Button courseId={COURSE_ID} resume={{ resumable: false }} />)
    expect(checking).toContain('Vérifier l’état de mon paiement')
    expect(checking).toContain('en cours de vérification')
    expect(checking).not.toContain('Reprendre le paiement')
  })
})
