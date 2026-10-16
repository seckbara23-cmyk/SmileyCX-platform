// @vitest-environment node
/**
 * ENR-01C-b (C2) — checkout stops sending learners into lessons they cannot open.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * A `PILOT_MODE` block sat ABOVE the auth check and above any access
 * resolution. It read the first module/lesson and redirected into
 * `/learn/<course>/<module>/<lesson>` — for anyone, with no entitlement check.
 * Production runs `PLATFORM_MODE=pilot`, so a signed-in learner following any
 * checkout link was bounced into a lesson the learn layout then refused:
 * CTA → checkout → lesson → denial.
 *
 * A deployment mode is not an access grant. `PILOT_MODE` appears in no policy,
 * no function and no grant; `resolveCourseAccess` is the authority and that
 * block never asked it. The lesson route always held, so this was never a
 * bypass — it was the page promising entry the gate denies, the same shape
 * CAT-02 removed from the price and ENR-01B from the lesson badge.
 *
 * ── THE CORRECTION ────────────────────────────────────────────────────────
 *
 * The block is gone. Control falls through to checks that already existed, in
 * this order: auth → profile → enrollment (C3, untouched) → ENTITLEMENT → the
 * priced panel. The entitlement step delegates to `resolveCourseAccessById` —
 * the same seam the learn layout, the media route and `ensureAcademicEnrollment`
 * use — and sends an already-entitled learner to the COURSE PAGE, which
 * resolves their access itself and renders the progress-aware CTA. Checkout
 * therefore computes no lesson route at all.
 *
 * ── WHAT THESE TESTS ASSERT ───────────────────────────────────────────────
 *
 * The full learner × course × mode matrix, by invoking the page as a real
 * server component. The Supabase mock THROWS on any mutating verb, so "no
 * entitlement is granted" is enforced rather than merely asserted.
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
  /** The `my_course_access` view row — the entitlement authority. */
  access?: Record<string, unknown> | null
  modules?: Record<string, unknown> | null
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
      if (table === 'modules')          return fixture.modules ?? null
      return null
    }
    const result = () => ({ data: rowsFor(), error: null })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'or', 'not', 'gt', 'gte']) {
      chain[m] = () => chain
    }
    for (const m of ['insert', 'upsert', 'update', 'delete']) {
      chain[m] = () => { mutations.push(`${table}.${m}`); throw new Error(`ENR-01C-b: unexpected ${table}.${m}()`) }
    }
    chain.maybeSingle = async () => result()
    chain.single      = async () => result()
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
    return chain
  }
  return {
    from: (t: string) => build(t),
    rpc: (n: string) => { mutations.push(`rpc.${n}`); throw new Error(`ENR-01C-b: unexpected rpc(${n})`) },
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

const PAID = {
  id: 'b0e3d6f3-af9e-4681-9865-751cff643fa3',
  slug: 'les-fondamentaux-du-service-client', title: 'C1-F2',
  price: 11000, currency: 'XOF', is_free: false, is_published: true,
}
const FREE = {
  id: '82392138-62d4-43bf-a890-fe27b58fccdd',
  slug: 'donnez-envie-a-vos-clients-de-revenir', title: 'C1-F4',
  price: 0, currency: 'XOF', is_free: true, is_published: true,
}
const SYLLABUS = { id: 'm1', slug: 'module-1', lessons: [{ id: 'l1', slug: 'lecon-1' }] }

const VERIFIED   = { id: 'u1', email: 'a@b.c', email_confirmed_at: '2026-01-01T00:00:00Z' }
const UNVERIFIED = { id: 'u2', email: 'c@d.e', email_confirmed_at: null }
const ACTIVE     = { id: 'u1', platform_role: 'user', account_status: 'active' }
const HAS_ACCESS = { has_access: true,  access_ended: false }
const NO_ACCESS  = { has_access: false, access_ended: false }
const ENROLLED   = { id: 'e1' }

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
  delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

const setMode = (m: 'pilot' | 'public') => { process.env.NEXT_PUBLIC_PLATFORM_MODE = m }

/** The five learner states Phase 5 requires. */
const LEARNERS = {
  anonymous:            { user: null },
  unentitled:           { user: VERIFIED,   profile: ACTIVE, access: NO_ACCESS,  enrollment: null },
  entitled:             { user: VERIFIED,   profile: ACTIVE, access: HAS_ACCESS, enrollment: null },
  enrolledUnentitled:   { user: VERIFIED,   profile: ACTIVE, access: NO_ACCESS,  enrollment: ENROLLED },
  unverified:           { user: UNVERIFIED, profile: ACTIVE, access: HAS_ACCESS, enrollment: null },
} as const

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-b · 1. NO unauthorized /learn redirect, in any state', () => {
  for (const mode of ['pilot', 'public'] as const) {
    for (const course of [PAID, FREE]) {
      for (const [name, who] of Object.entries(LEARNERS)) {
        it(`[${mode}] ${course.title} · ${name} is never sent into /learn`, async () => {
          setMode(mode)
          fixture = { course, modules: SYLLABUS, ...who }
          const r = await visit(course.id)

          if (r.kind === 'redirect') {
            expect(r.url, `redirected into a lesson: ${r.url}`).not.toMatch(/^\/learn\//)
          }
          if (r.kind === 'render') {
            expect(hrefsOf(r.tree).filter(h => h.includes('/learn/')),
              'a protected lesson link was exposed through checkout').toEqual([])
          }
        }, 20_000)
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-b · 2. the corrected routing matrix', () => {
  it('[pilot] unentitled learner, paid course → the priced panel, not a lesson', async () => {
    setMode('pilot')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(PAID.id)

    expect(r.kind, 'checkout still navigates away in pilot mode').toBe('render')
    if (r.kind !== 'render') return
    expect(flat(r.tree)).toMatch(/Inscription bient[oô]t disponible/)
    expect(flat(r.tree)).toContain('11 000')
  })

  it('[public] unentitled learner, paid course → the same priced panel', async () => {
    setMode('public')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(PAID.id)
    expect(r.kind).toBe('render')
    if (r.kind === 'render') expect(flat(r.tree)).toContain('11 000')
  })

  it('an ENTITLED learner keeps their learning journey, via the course page', async () => {
    // Not a lesson URL: the course page resolves their access itself and
    // renders the progress-aware CTA, so checkout promises nothing.
    for (const mode of ['pilot', 'public'] as const) {
      vi.resetModules()
      setMode(mode)
      fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.entitled }
      const r = await visit(PAID.id)
      expect(r, `[${mode}] an entitled learner was not routed to their course`)
        .toEqual({ kind: 'redirect', url: `/courses/${PAID.slug}` })
    }
  }, 20_000)

  it('entitlement is read from the ACCESS view, never inferred from enrollment', async () => {
    setMode('public')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.entitled }
    await visit(PAID.id)
    expect(touched, 'the access authority was not consulted').toContain('my_course_access')
  })

  it('an UNVERIFIED account is refused even holding an access row', async () => {
    setMode('public')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.unverified }
    const r = await visit(PAID.id)

    expect(r.kind, 'an unverified account was routed into the course').toBe('render')
    if (r.kind === 'render') expect(flat(r.tree)).toMatch(/Inscription bient[oô]t disponible/)
  })

  it('an INACTIVE account is refused even holding an access row', async () => {
    setMode('public')
    fixture = {
      course: PAID, modules: SYLLABUS, user: VERIFIED, access: HAS_ACCESS, enrollment: null,
      profile: { id: 'u1', platform_role: 'user', account_status: 'suspended' },
    }
    const r = await visit(PAID.id)
    expect(r.kind).toBe('render')
  })

  it('an anonymous visitor is sent to log in, carrying the return path', async () => {
    for (const mode of ['pilot', 'public'] as const) {
      vi.resetModules()
      setMode(mode)
      fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.anonymous }
      const r = await visit(PAID.id)
      expect(r.kind).toBe('redirect')
      if (r.kind === 'redirect') {
        expect(r.url).toContain('/login?next=')
        expect(r.url).not.toMatch(/^\/learn\//)
      }
    }
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-b · 3. free courses stay labelled free, and are still gated', () => {
  it('the free course shows "Formation gratuite" and grants nothing', async () => {
    setMode('pilot')
    fixture = { course: FREE, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(FREE.id)

    expect(r.kind).toBe('render')
    if (r.kind !== 'render') return
    expect(flat(r.tree)).toMatch(/Formation gratuite/)
    expect(flat(r.tree), 'a free course rendered a price amount').not.toContain('FCFA')
    expect(mutations, 'the free course path wrote something').toEqual([])
    expect(hrefsOf(r.tree).filter(h => h.includes('/learn/')), 'free != open').toEqual([])
  })

  it('an entitled learner on the FREE course also goes to the course page', async () => {
    setMode('pilot')
    fixture = { course: FREE, modules: SYLLABUS, ...LEARNERS.entitled }
    expect(await visit(FREE.id)).toEqual({ kind: 'redirect', url: `/courses/${FREE.slug}` })
  })

  it('no misleading GRATUIT claim appears anywhere in checkout', async () => {
    for (const course of [PAID, FREE]) {
      vi.resetModules()
      setMode('pilot')
      fixture = { course, modules: SYLLABUS, ...LEARNERS.unentitled }
      const r = await visit(course.id)
      if (r.kind === 'render') {
        expect(flat(r.tree), `${course.title}: a GRATUIT badge leaked into checkout`)
          .not.toMatch(/GRATUIT/)
        expect(flat(r.tree)).not.toMatch(/Acc[eè]s gratuit en cours|enti[eè]rement gratuit|phase pilote/i)
      }
    }
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-b · 4. prices stay database-derived', () => {
  it('the amount follows the row, not a constant', async () => {
    setMode('public')
    fixture = { course: { ...PAID, price: 9500 }, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).toContain('9 500')
    expect(flat(r.tree)).not.toContain('11 000')
  })

  it('payments ON still reaches the real payment UI', async () => {
    setMode('public')
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).toMatch(/Finaliser votre inscription/)
  })

  it('payments ON does not let an entitled learner pay twice', async () => {
    setMode('public')
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.entitled }
    expect(await visit(PAID.id)).toEqual({ kind: 'redirect', url: `/courses/${PAID.slug}` })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-b · 5. nothing is granted, and C1/C4/C5 remain fixed', () => {
  it('no write is attempted in ANY state, on either course', async () => {
    for (const mode of ['pilot', 'public'] as const) {
      for (const course of [PAID, FREE]) {
        for (const who of Object.values(LEARNERS)) {
          vi.resetModules()
          mutations = []
          setMode(mode)
          fixture = { course, modules: SYLLABUS, ...who }
          await visit(course.id)
          expect(mutations, 'checkout attempted a write').toEqual([])
        }
      }
    }
  }, 60_000)

  it('C1 still holds: phantom and unknown ids 404', async () => {
    setMode('pilot')
    for (const id of ['comprendre-client-qualite-experience', 'seed', '00000000-0000-0000-0000-000000000000']) {
      vi.resetModules()
      fixture = { course: null }
      expect((await visit(id)).kind, `?course=${id} did not 404`).toBe('notFound')
    }
  }, 20_000)

  it('C5 still holds: the panel offers contact and the course page, never /dashboard', async () => {
    setMode('public')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.unentitled }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    const hrefs = hrefsOf(r.tree)

    expect(hrefs).toContain(`/courses/${PAID.slug}`)
    expect(hrefs.some(h => h.startsWith('/contact?course='))).toBe(true)
    expect(hrefs, 'the panel offers /dashboard again').not.toContain('/dashboard')
  })

  it('C3 is FIXED: an enrollment row no longer routes anyone to /dashboard', async () => {
    // Was: the enrollment row redirected to /dashboard as if the learner had
    // the course. Two live production rows sat in exactly that state.
    setMode('public')
    fixture = { course: PAID, modules: SYLLABUS, ...LEARNERS.enrolledUnentitled }
    const r = await visit(PAID.id)

    expect(touched, 'checkout still reads enrollments').not.toContain('enrollments')
    expect(r.kind, 'an enrollment row still short-circuited checkout').toBe('render')
    if (r.kind !== 'render') return
    expect(flat(r.tree), 'the enrolled-but-unentitled learner was not shown the price')
      .toMatch(/Inscription bient[oô]t disponible/)
    expect(hrefsOf(r.tree).filter(h => h.includes('/learn/'))).toEqual([])
  })

  it('the ENTITLEMENT check is now the only access authority in checkout', async () => {
    // Was: 'the enrollment check still runs BEFORE the entitlement check'.
    // There is no enrollment check left to order against.
    setMode('public')
    fixture = {
      course: PAID, modules: SYLLABUS, user: VERIFIED, profile: ACTIVE,
      access: HAS_ACCESS, enrollment: ENROLLED,
    }
    const r = await visit(PAID.id)

    expect(touched).toContain('my_course_access')
    expect(touched).not.toContain('enrollments')
    expect(r, 'an entitled learner is no longer routed by their transcript')
      .toEqual({ kind: 'redirect', url: `/courses/${PAID.slug}` })
  })
})
