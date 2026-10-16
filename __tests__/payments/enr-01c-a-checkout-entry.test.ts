// @vitest-environment node
/**
 * ENR-01C-a — the checkout page stops inventing courses, stops pretending to
 * enrol, and states the real price.
 *
 * ── THE THREE DEFECTS ─────────────────────────────────────────────────────
 *
 * C1  A phantom-course fallback. `?course=comprendre-client-qualite-experience`
 *     or `?course=seed` built a course object out of `data/seed.ts`, so a
 *     checkout existed for a course that is in no database row. The same
 *     escape hatch CAT-02 removed from the public detail page.
 *
 * C4  A dead free-enrollment branch. `if (FREE_ACCESS_MODE) { enrollForFree();
 *     redirect('/dashboard') }` could never run -- FREE_ACCESS_MODE and
 *     PILOT_MODE are the SAME predicate (`PLATFORM_MODE === 'pilot'`) and the
 *     PILOT_MODE branch above returns first. Had it run it called
 *     `enrollForFree` for paid courses too and discarded the result, so the
 *     learner was told they were enrolled either way.
 *
 * C5  "Accès gratuit en cours -- L'accès aux formations est entièrement gratuit
 *     et ne nécessite aucun paiement", offering "Accéder à ma formation" into
 *     /dashboard. Every clause false once CAT-02 published real prices.
 *
 * ── WHAT THESE TESTS ASSERT ───────────────────────────────────────────────
 *
 * Behaviour, by invoking the page as a real server component with Supabase
 * mocked: which navigation it performs, what it renders, and -- for C4 -- that
 * it performs no write at all. The Supabase mock THROWS on any mutating verb,
 * so a write cannot pass silently.
 *
 * C2 (the PILOT_MODE redirect into /learn) and C3 (the enrollments duplicate
 * check) are deliberately OUT of scope for this slice. The tests below pin
 * their current behaviour unchanged, so the next slice has to state its intent
 * rather than drift into it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

class NotFound extends Error { constructor() { super('NEXT_NOT_FOUND') } }
class Redirect extends Error {
  constructor(public url: string) { super('NEXT_REDIRECT: ' + url) }
}

vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (url: string) => { throw new Redirect(url) },
}))

/** Set by any test that wants to prove `enrollForFree` is never reached. */
const enrollForFree = vi.fn(async () => ({}))
vi.mock('@/app/actions/enrollment', () => ({
  enrollForFree,
  ensureAcademicEnrollment: vi.fn(async () => ({ ok: true })),
}))

interface Fixture {
  course?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  enrollment?: unknown | null
  modules?: Record<string, unknown> | null
}

let fixture: Fixture = {}
/** Every table the page touched, in order. */
let touched: string[] = []
/** Any mutating call the page attempted — must stay empty. */
let mutations: string[] = []

function makeClient() {
  const build = (table: string) => {
    touched.push(table)
    const rowsFor = () => {
      if (table === 'courses')     return fixture.course ?? null
      if (table === 'profiles')    return fixture.profile ?? null
      if (table === 'enrollments') return fixture.enrollment ?? null
      if (table === 'modules')     return fixture.modules ?? null
      return null
    }
    const result = () => ({ data: rowsFor(), error: null })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'or', 'not']) {
      chain[m] = () => chain
    }
    // A write must not merely be absent from an assertion — it must be loud.
    for (const m of ['insert', 'upsert', 'update', 'delete']) {
      chain[m] = () => { mutations.push(`${table}.${m}`); throw new Error(`ENR-01C-a: unexpected ${table}.${m}()`) }
    }
    chain.maybeSingle = async () => result()
    chain.single      = async () => result()
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
    return chain
  }
  return {
    from: (t: string) => build(t),
    rpc: (name: string) => { mutations.push(`rpc.${name}`); throw new Error(`ENR-01C-a: unexpected rpc(${name})`) },
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

const PAID = {
  id: 'b0e3d6f3-af9e-4681-9865-751cff643fa3',
  slug: 'les-fondamentaux-du-service-client',
  title: 'Les fondamentaux du service client',
  price: 11000, currency: 'XOF', is_free: false, is_published: true,
}
const FREE = {
  id: '82392138-62d4-43bf-a890-fe27b58fccdd',
  slug: 'donnez-envie-a-vos-clients-de-revenir',
  title: 'Donnez envie a vos clients de revenir',
  price: 0, currency: 'XOF', is_free: true, is_published: true,
}
const VERIFIED = { id: 'u1', email: 'l@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }
const PROFILE  = { id: 'u1', platform_role: 'user', account_status: 'active' }

/** The two ids the deleted fallback used to fabricate a course for. */
const PHANTOM_IDS = ['comprendre-client-qualite-experience', 'seed']

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

/** Render, or report the navigation the page performed instead. */
async function visit(courseId?: string): Promise<
  { kind: 'render'; tree: unknown } | { kind: 'notFound' } | { kind: 'redirect'; url: string }
> {
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
  enrollForFree.mockClear()
  delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

const pilot  = () => { process.env.NEXT_PUBLIC_PLATFORM_MODE = 'pilot' }
const public_ = () => { process.env.NEXT_PUBLIC_PLATFORM_MODE = 'public' }

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-a · C1 — no course is ever invented', () => {
  for (const mode of ['pilot', 'public'] as const) {
    it(`[${mode}] the two phantom ids now 404 instead of fabricating a course`, async () => {
      mode === 'pilot' ? pilot() : public_()
      for (const id of PHANTOM_IDS) {
        vi.resetModules()
        fixture = { course: null }
        const r = await visit(id)
        expect(r.kind, `?course=${id} did not 404 (got ${r.kind}${r.kind === 'redirect' ? ' ' + r.url : ''})`)
          .toBe('notFound')
      }
      // ENR-01C-b: checkout now imports the access seam, so each
      // resetModules() in this loop reloads a larger graph. Isolated this
      // runs in <1s; the default 5s cap is reached only by the repeated
      // re-import, not by the page.
    }, 20_000)

    it(`[${mode}] an arbitrary unknown id 404s`, async () => {
      mode === 'pilot' ? pilot() : public_()
      fixture = { course: null }
      expect((await visit('00000000-0000-0000-0000-000000000000')).kind).toBe('notFound')
    })
  }

  it('a VALID course id is still accepted (the 404 is not unconditional)', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    expect((await visit(PAID.id)).kind, 'a real course now 404s — the guard is too broad')
      .toBe('render')
  })

  it('no course id at all redirects to the catalogue', async () => {
    public_()
    const r = await visit(undefined)
    expect(r).toEqual({ kind: 'redirect', url: '/courses' })
  })

  it('the course is read from the database, never from the seed module', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(PAID.id)
    expect(touched[0], 'the first read was not the courses table').toBe('courses')
    expect(r.kind).toBe('render')
    if (r.kind === 'render') {
      // The seed course's title must never appear.
      expect(flat(r.tree)).not.toMatch(/Comprendre le Client pour D[eé]livrer/i)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-a · C4 — the page writes nothing, and does not pretend to enrol', () => {
  it('[pilot] no enrollment, entitlement or payment write is attempted', async () => {
    pilot()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, modules: null }
    await visit(PAID.id)
    expect(mutations, 'the page attempted a write').toEqual([])
    expect(enrollForFree, 'enrollForFree was called').not.toHaveBeenCalled()
  })

  it('[public] no write is attempted on the price path either', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    await visit(PAID.id)
    expect(mutations).toEqual([])
    expect(enrollForFree).not.toHaveBeenCalled()
  })

  it('[public] the FREE course is not auto-enrolled', async () => {
    // The deleted branch would have called enrollForFree for any course.
    public_()
    fixture = { course: FREE, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(FREE.id)
    expect(enrollForFree, 'the free course was auto-enrolled').not.toHaveBeenCalled()
    expect(mutations).toEqual([])
    expect(r.kind, 'the free course was redirected to /dashboard as if enrolled').toBe('render')
  })

  it('no code path reaches /dashboard by claiming an enrolment', async () => {
    for (const [mode, course] of [['public', PAID], ['public', FREE]] as const) {
      vi.resetModules()
      mode === 'public' ? public_() : pilot()
      fixture = { course, user: VERIFIED, profile: PROFILE, enrollment: null }
      const r = await visit(course.id)
      if (r.kind === 'redirect') {
        expect(r.url, 'redirected to /dashboard without an entitlement').not.toBe('/dashboard')
      }
      if (r.kind === 'render') {
        expect(hrefsOf(r.tree), 'the panel still offers /dashboard').not.toContain('/dashboard')
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-a · C5 — the unavailable-payment panel states the real price', () => {
  const FORBIDDEN = [
    /Acc[eè]s gratuit en cours/i,
    /enti[eè]rement\s+gratuit/i,
    /ne n[eé]cessite aucun paiement/i,
    /phase pilote/i,
    /Acc[eé]der [aà] ma formation/i,
  ]

  it('a PAID course shows its database price and none of the old claims', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(PAID.id)
    expect(r.kind).toBe('render')
    if (r.kind !== 'render') return
    const text = flat(r.tree)

    expect(text).toContain('11 000')
    expect(text).toContain('FCFA')
    for (const re of FORBIDDEN) {
      expect(text, `the old free-access copy survives: ${re}`).not.toMatch(re)
    }
    expect(text, 'a paid course is described as free').not.toMatch(/Formation gratuite/)
  })

  it('the price follows the ROW, not a constant', async () => {
    public_()
    fixture = { course: { ...PAID, price: 9500 }, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    expect(flat(r.tree)).toContain('9 500')
    expect(flat(r.tree)).not.toContain('11 000')
  })

  it('the FREE course says Formation gratuite and shows no amount', async () => {
    public_()
    fixture = { course: FREE, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(FREE.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    const text = flat(r.tree)

    expect(text).toMatch(/Formation gratuite/)
    expect(text, 'a free course rendered a price amount').not.toContain('FCFA')
    for (const re of FORBIDDEN) expect(text).not.toMatch(re)
  })

  it('it sends the learner somewhere that works, never to /dashboard', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    const hrefs = hrefsOf(r.tree)

    expect(hrefs, 'no link back to the course').toContain(`/courses/${PAID.slug}`)
    expect(hrefs.some(h => h.startsWith('/contact?course=')), 'no contact route offered').toBe(true)
    expect(hrefs, 'still offers /dashboard').not.toContain('/dashboard')
    expect(hrefs.some(h => h.includes('/learn/')), 'offers a lesson link with no entitlement').toBe(false)
  })

  it('the page title no longer claims the enrolment is free', async () => {
    public_()
    const mod = await import('@/app/(platform)/checkout/page')
    expect(String((mod.metadata as { title?: unknown }).title))
      .not.toMatch(/gratuit/i)
  })

  it('payments-enabled still reaches the real payment UI, not the panel', async () => {
    // Proves the panel is the PAYMENTS_ENABLED=false branch and nothing wider.
    public_()
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null }
    const r = await visit(PAID.id)
    if (r.kind !== 'render') throw new Error('expected a render')
    const text = flat(r.tree)

    expect(text).toMatch(/Finaliser votre inscription/)
    expect(text, 'the unavailable panel rendered while payments are ON')
      .not.toMatch(/Inscription bient[oô]t disponible/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01C-a · out of scope: C2 and C3 are unchanged', () => {
  it('C2 is FIXED by ENR-01C-b: pilot mode no longer redirects into /learn', async () => {
    // This pinned the defect while C2 was out of scope. ENR-01C-b removed the
    // redirect, so the pin is re-aimed at the corrected behaviour rather than
    // deleted: an unentitled learner in pilot mode now reaches the priced
    // panel, and no lesson URL is produced.
    pilot()
    fixture = {
      course: PAID, user: VERIFIED, profile: PROFILE, enrollment: null,
      modules: { id: 'm1', slug: 'module-1', lessons: [{ id: 'l1', slug: 'lecon-1' }] },
    }
    const r = await visit(PAID.id)
    expect(r.kind, 'checkout still navigates away in pilot mode').toBe('render')
    if (r.kind !== 'render') return
    expect(hrefsOf(r.tree).some(h => h.includes('/learn/')), 'a lesson URL was exposed')
      .toBe(false)
    expect(flat(r.tree)).toMatch(/Inscription bient[oô]t disponible/)
  })

  it('C3: the duplicate check STILL reads enrollments (not fixed by this slice)', async () => {
    public_()
    fixture = { course: PAID, user: VERIFIED, profile: PROFILE, enrollment: { id: 'e1' } }
    const r = await visit(PAID.id)
    expect(touched, 'C3 changed — that belongs to ENR-01C-c').toContain('enrollments')
    expect(r).toEqual({ kind: 'redirect', url: '/dashboard' })
  })

  it('an unauthenticated visitor is still sent to log in', async () => {
    public_()
    fixture = { course: PAID, user: null }
    const r = await visit(PAID.id)
    expect(r.kind).toBe('redirect')
    if (r.kind === 'redirect') expect(r.url).toContain('/login?next=')
  })
})
