// @vitest-environment node
/**
 * ENR-01C-c (C3) — an enrollment row is not evidence of course access.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Checkout read `enrollments` and, on finding a row, redirected to /dashboard
 * as though the learner already held the course:
 *
 *   if (existing) redirect('/dashboard')
 *
 * Per Q-L and migration 037 an enrollment is an ACADEMIC TRANSCRIPT and
 * authorizes nothing — `has_course_access()` does not read the table at all.
 * So this answered a commercial question with an academic fact, and because it
 * ran BEFORE the entitlement check, it won.
 *
 * Two live production rows sat in exactly that state: one learner holds active
 * enrollments in C1-F4 (free) and C2-F5 (9 500 XOF) with NO entitlement row of
 * any kind, both with `payment_id` null — records left by the retired pilot
 * path. They were bounced to /dashboard, which shows them nothing, and could
 * not reach the price of the paid course. Those two cases are reproduced below
 * as `CASE_1_FREE` and `CASE_2_PAID`.
 *
 * ── HOW ENTITLEMENT STATE IS MODELLED ─────────────────────────────────────
 *
 * The gate reads `my_course_access`, the learner-safe VIEW, which collapses
 * every entitlement into two booleans (migration 037):
 *
 *   has_access   = bool_or(entitlement_accessible(status, starts, expires, revoked))
 *   access_ended = bool_or(not accessible and status <> 'PENDING')
 *
 * So REVOKED and EXPIRED are indistinguishable at this layer and both present
 * as `{ has_access: false, access_ended: true }` — which is precisely the
 * contract checkout must honour. An absent entitlement yields no row at all.
 * Modelling the view rather than inventing entitlement states keeps these tests
 * faithful to what the page can actually observe.
 *
 * Production currently contains only MANUAL_ADMIN/ACTIVE rows, with no
 * revoked_at, expires_at or starts_at set anywhere, so the revoked and expired
 * rows below are TEST-ONLY coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

class NotFound extends Error { constructor() { super('NEXT_NOT_FOUND') } }
class Redirect extends Error { constructor(public url: string) { super('NEXT_REDIRECT ' + url) } }

vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (url: string) => { throw new Redirect(url) },
}))

interface Fixture {
  course?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  enrollment?: unknown | null
  access?: Record<string, unknown> | null
}

let fixture: Fixture = {}
let touched: string[] = []
let mutations: string[] = []

function makeClient() {
  const build = (table: string) => {
    touched.push(table)
    const rowsFor = () => {
      if (table === 'courses')          return fixture.course ?? null
      if (table === 'profiles')         return fixture.profile ?? null
      if (table === 'enrollments')      return fixture.enrollment ?? null
      if (table === 'my_course_access') return fixture.access ?? null
      return null
    }
    const result = () => ({ data: rowsFor(), error: null })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'or', 'not', 'gt', 'gte']) {
      chain[m] = () => chain
    }
    for (const m of ['insert', 'upsert', 'update', 'delete']) {
      chain[m] = () => { mutations.push(`${table}.${m}`); throw new Error(`ENR-01C-c: unexpected ${table}.${m}()`) }
    }
    chain.maybeSingle = async () => result()
    chain.single      = async () => result()
    chain.then = (r: (v: unknown) => unknown) => Promise.resolve(result()).then(r)
    return chain
  }
  return {
    from: (t: string) => build(t),
    rpc: (n: string) => { mutations.push(`rpc.${n}`); throw new Error(`ENR-01C-c: unexpected rpc(${n})`) },
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

/** C2-F5 — the paid course in production case 2. */
const PAID = {
  id: 'd92ea494-36cf-4a19-8b01-db45666ac268',
  slug: 'developper-une-culture-client', title: 'C2-F5',
  price: 9500, currency: 'XOF', is_free: false, is_published: true,
}
/** C1-F4 — the free course in production case 1. */
const FREE = {
  id: '82392138-62d4-43bf-a890-fe27b58fccdd',
  slug: 'donnez-envie-a-vos-clients-de-revenir', title: 'C1-F4',
  price: 0, currency: 'XOF', is_free: true, is_published: true,
}

const VERIFIED   = { id: 'u1', email: 'a@b.c', email_confirmed_at: '2026-01-01T00:00:00Z' }
const UNVERIFIED = { id: 'u2', email: 'c@d.e', email_confirmed_at: null }
const ACTIVE     = { id: 'u1', platform_role: 'user', account_status: 'active' }
const SUSPENDED  = { id: 'u1', platform_role: 'user', account_status: 'suspended' }
const ENROLLED   = { id: 'e1' }

/** `my_course_access` as the view computes it, per migration 037. */
const ACCESS_ACTIVE  = { has_access: true,  access_ended: false }
/** REVOKED and EXPIRED are indistinguishable through the view. */
const ACCESS_ENDED   = { has_access: false, access_ended: true }
/** No entitlement row at all — the view returns nothing. */
const ACCESS_ABSENT  = null

function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props && 'children' in el.props) textOf(el.props.children, out)
  return out
}
const flat = (n: unknown) =>
  textOf(n).join(' ').replace(/[   ]/g, ' ').replace(/\s+/g, ' ')

function hrefsOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) hrefsOf(n, out); return out }
  const el = node as { props?: Record<string, unknown> }
  if (el.props) {
    if (typeof el.props.href === 'string') out.push(el.props.href)
    if ('children' in el.props) hrefsOf(el.props.children, out)
  }
  return out
}

type Outcome =
  | { kind: 'render'; tree: unknown }
  | { kind: 'notFound' }
  | { kind: 'redirect'; url: string }

async function visit(courseId?: string): Promise<Outcome> {
  const mod = await import('@/app/(platform)/checkout/page')
  const page = mod.default as (p: { searchParams: Promise<{ course?: string }> }) => Promise<unknown>
  try {
    return { kind: 'render', tree: await page({ searchParams: Promise.resolve({ course: courseId }) }) }
  } catch (e) {
    if (e instanceof NotFound) return { kind: 'notFound' }
    if (e instanceof Redirect) return { kind: 'redirect', url: e.url }
    throw e
  }
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  fixture = {}
  touched = []
  mutations = []
  for (const k of ['PAYTECH_CHECKOUT_ENABLED', 'PAYTECH_MODE', 'PAYTECH_TEST_API_KEY', 'PAYTECH_TEST_API_SECRET', 'VERCEL_ENV']) delete process.env[k]
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

const setMode = (m: 'pilot' | 'public') => { process.env.NEXT_PUBLIC_PLATFORM_MODE = m }

/** The nine learner states Phase 5 requires. */
const STATES = {
  entitledWithEnrollment:    { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ACTIVE, enrollment: ENROLLED },
  entitledNoEnrollment:      { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ACTIVE, enrollment: null },
  enrolledUnentitled:        { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ABSENT, enrollment: ENROLLED },
  revokedEntitlement:        { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ENDED,  enrollment: ENROLLED },
  expiredEntitlement:        { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ENDED,  enrollment: null },
  unverified:                { user: UNVERIFIED, profile: ACTIVE,    access: ACCESS_ACTIVE, enrollment: ENROLLED },
  inactive:                  { user: VERIFIED,   profile: SUSPENDED, access: ACCESS_ACTIVE, enrollment: ENROLLED },
  anonymous:                 { user: null },
  neither:                   { user: VERIFIED,   profile: ACTIVE,    access: ACCESS_ABSENT, enrollment: null },
} as const

/** States that must NOT reach the course. */
const DENIED = [
  'enrolledUnentitled', 'revokedEntitlement', 'expiredEntitlement',
  'unverified', 'inactive', 'neither',
] as const

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-c · 1. enrollment alone NEVER grants access', () => {
  it('checkout does not read the enrollments table at all', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.enrolledUnentitled }
    await visit(PAID.id)
    expect(touched, 'the enrollment read is back').not.toContain('enrollments')
    expect(touched, 'the access authority was not consulted').toContain('my_course_access')
  })

  for (const course of [PAID, FREE]) {
    for (const mode of ['pilot', 'public'] as const) {
      it(`[${mode}] ${course.title} · enrolled + unentitled is shown checkout, not the course`, async () => {
        setMode(mode)
        fixture = { course, ...STATES.enrolledUnentitled }
        const r = await visit(course.id)

        expect(r.kind, 'an enrollment row still short-circuited checkout').toBe('render')
        if (r.kind !== 'render') return
        expect(hrefsOf(r.tree).filter(h => h.includes('/learn/')),
          'a protected lesson link was exposed').toEqual([])
        expect(hrefsOf(r.tree), 'still bounced toward /dashboard').not.toContain('/dashboard')
      }, 20_000)
    }
  }

  it('the two REAL production cases now reach checkout information', async () => {
    // CASE 1: active enrollment in C1-F4, zero entitlement rows.
    // CASE 2: active enrollment in C2-F5 (9 500 XOF), zero entitlement rows.
    // Both had payment_id null; both were bounced to /dashboard.
    setMode('pilot')
    for (const [label, course, expect_] of [
      ['CASE_1_FREE', FREE, /Formation gratuite/],
      ['CASE_2_PAID', PAID, /9 500/],
    ] as const) {
      vi.resetModules()
      fixture = { course, ...STATES.enrolledUnentitled }
      const r = await visit(course.id)
      expect(r.kind, `${label} did not reach checkout`).toBe('render')
      if (r.kind === 'render') {
        expect(flat(r.tree), `${label} was not shown its commercial state`).toMatch(expect_)
      }
    }
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-c · 2. an entitled learner is never asked to pay again', () => {
  for (const course of [PAID, FREE]) {
    for (const mode of ['pilot', 'public'] as const) {
      for (const state of ['entitledWithEnrollment', 'entitledNoEnrollment'] as const) {
        it(`[${mode}] ${course.title} · ${state} goes to the course page`, async () => {
          setMode(mode)
          fixture = { course, ...STATES[state] }
          expect(await visit(course.id))
            .toEqual({ kind: 'redirect', url: `/courses/${course.slug}` })
        }, 20_000)
      }
    }
  }

  it('an entitled learner is routed identically whether or not an enrollment exists', async () => {
    // The whole point of C3: the transcript must not change the decision.
    setMode('public')
    const outcomes: unknown[] = []
    for (const state of ['entitledWithEnrollment', 'entitledNoEnrollment'] as const) {
      vi.resetModules()
      fixture = { course: PAID, ...STATES[state] }
      outcomes.push(await visit(PAID.id))
    }
    expect(outcomes[0]).toEqual(outcomes[1])
  }, 20_000)

  it('even with payments ENABLED, an entitled learner cannot be charged again', async () => {
    setMode('public')
    Object.assign(process.env, { PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'k_test', PAYTECH_TEST_API_SECRET: 's_test', VERCEL_ENV: 'preview' })  // XP-PAYTECH-04: the server-side PayTech checkout switch replaces NEXT_PUBLIC_PAYMENTS_ENABLED
    fixture = { course: PAID, ...STATES.entitledWithEnrollment }
    const r = await visit(PAID.id)
    expect(r).toEqual({ kind: 'redirect', url: `/courses/${PAID.slug}` })
    if (r.kind === 'render') expect(flat(r.tree)).not.toMatch(/Finaliser votre inscription/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-c · 3. revoked, expired and inactive states all deny', () => {
  it('a REVOKED entitlement does not grant access, even with an enrollment', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.revokedEntitlement }
    const r = await visit(PAID.id)
    expect(r.kind, 'a revoked entitlement opened the course').toBe('render')
    if (r.kind === 'render') {
      expect(hrefsOf(r.tree).filter(h => h.includes('/learn/'))).toEqual([])
    }
  })

  it('an EXPIRED entitlement does not grant access', async () => {
    // Supported by the contract: `expires_at <= now` denies, exclusively.
    setMode('public')
    fixture = { course: PAID, ...STATES.expiredEntitlement }
    const r = await visit(PAID.id)
    expect(r.kind).toBe('render')
    if (r.kind === 'render') {
      expect(hrefsOf(r.tree).filter(h => h.includes('/learn/'))).toEqual([])
    }
  })

  it('an UNVERIFIED account is denied even holding an active access row', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.unverified }
    const r = await visit(PAID.id)
    expect(r.kind, 'an unverified account was routed into the course').toBe('render')
  })

  it('an INACTIVE account is denied even holding an active access row', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.inactive }
    const r = await visit(PAID.id)
    expect(r.kind, 'a suspended account was routed into the course').toBe('render')
  })

  it('NO denied state is ever sent to a protected lesson, in either mode', async () => {
    for (const mode of ['pilot', 'public'] as const) {
      for (const state of DENIED) {
        for (const course of [PAID, FREE]) {
          vi.resetModules()
          setMode(mode)
          fixture = { course, ...STATES[state] }
          const r = await visit(course.id)
          if (r.kind === 'redirect') {
            expect(r.url, `[${mode}] ${state} redirected into a lesson`).not.toMatch(/^\/learn\//)
          }
          if (r.kind === 'render') {
            expect(hrefsOf(r.tree).filter(h => h.includes('/learn/')),
              `[${mode}] ${state} exposed a lesson link`).toEqual([])
          }
        }
      }
    }
  }, 60_000)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-c · 4. the rest of the contract is unchanged', () => {
  it('anonymous visitors still go to log in', async () => {
    for (const mode of ['pilot', 'public'] as const) {
      vi.resetModules()
      setMode(mode)
      fixture = { course: PAID, ...STATES.anonymous }
      const r = await visit(PAID.id)
      expect(r.kind).toBe('redirect')
      if (r.kind === 'redirect') {
        expect(r.url).toContain('/login?next=')
        expect(r.url).not.toMatch(/^\/learn\//)
      }
    }
  }, 20_000)

  it('C1 still holds: unknown and phantom course ids 404', async () => {
    setMode('public')
    for (const id of ['comprendre-client-qualite-experience', 'seed', '00000000-0000-0000-0000-000000000000']) {
      vi.resetModules()
      fixture = { course: null }
      expect((await visit(id)).kind, `?course=${id} did not 404`).toBe('notFound')
    }
  }, 20_000)

  it('C2 still holds: no /learn redirect is produced for anyone', async () => {
    setMode('pilot')
    for (const state of Object.keys(STATES) as (keyof typeof STATES)[]) {
      vi.resetModules()
      fixture = { course: PAID, ...STATES[state] }
      const r = await visit(PAID.id)
      if (r.kind === 'redirect') expect(r.url, state).not.toMatch(/^\/learn\//)
    }
  }, 60_000)

  it('C4 still holds: no write of any kind, in any state', async () => {
    for (const mode of ['pilot', 'public'] as const) {
      for (const state of Object.keys(STATES) as (keyof typeof STATES)[]) {
        for (const course of [PAID, FREE]) {
          vi.resetModules()
          mutations = []
          setMode(mode)
          fixture = { course, ...STATES[state] }
          await visit(course.id)
          expect(mutations, `[${mode}] ${state} attempted a write`).toEqual([])
        }
      }
    }
  }, 60_000)

  it('C5 still holds: the panel is row-priced and offers safe destinations', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.neither }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    const hrefs = hrefsOf(r.tree)

    expect(flat(r.tree)).toContain('9 500')
    expect(flat(r.tree)).toMatch(/Inscription bient[oô]t disponible/)
    expect(hrefs).toContain(`/courses/${PAID.slug}`)
    expect(hrefs.some(h => h.startsWith('/contact?course='))).toBe(true)
    expect(hrefs).not.toContain('/dashboard')
  })

  it('pricing stays database-derived', async () => {
    setMode('public')
    fixture = { course: { ...PAID, price: 11000 }, ...STATES.neither }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).toContain('11 000')
    expect(flat(r.tree)).not.toContain('9 500')
  })

  it('payments disabled never initiates a payment', async () => {
    setMode('public')
    fixture = { course: PAID, ...STATES.neither }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).not.toMatch(/Finaliser votre inscription/)
    expect(mutations).toEqual([])
  })

  it('payments enabled still reaches the gated payment UI for an unentitled learner', async () => {
    setMode('public')
    Object.assign(process.env, { PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'k_test', PAYTECH_TEST_API_SECRET: 's_test', VERCEL_ENV: 'preview' })  // XP-PAYTECH-04: the server-side PayTech checkout switch replaces NEXT_PUBLIC_PAYMENTS_ENABLED
    fixture = { course: PAID, ...STATES.neither }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).toMatch(/Finaliser votre inscription/)
    expect(mutations, 'reaching the payment UI wrote something').toEqual([])
  })

  it('checkout agrees with the course page: one authority, one answer', async () => {
    // Both consult resolveCourseAccess*; neither consults enrollments.
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const checkout = readFileSync(join(process.cwd(), 'app/(platform)/checkout/page.tsx'), 'utf8')
    const detail   = readFileSync(join(process.cwd(), 'app/(public)/courses/[slug]/page.tsx'), 'utf8')

    expect(checkout).toMatch(/resolveCourseAccessById\(/)
    expect(detail).toMatch(/resolveCourseAccess\(/)
    expect(checkout, 'checkout decides access from enrollments again')
      .not.toMatch(/from\('enrollments'\)/)
  })
})
