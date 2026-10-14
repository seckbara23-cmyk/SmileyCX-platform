// @vitest-environment node
/**
 * CAT-02 — BEHAVIOURAL proof that the database price reaches the page, and
 * that the CTA follows the authoritative access result.
 *
 * ── WHY THIS FILE EXISTS ALONGSIDE THE PATTERN SUITE ──────────────────────
 *
 * `cat-02-database-backed-prices.test.ts` reads source text. This programme has
 * already demonstrated, with a neutralised `isCommercialHost` gate, that a
 * source-pattern suite can pass 34/34 while the behaviour is broken. So the
 * central claims of CAT-02 are asserted here by actually invoking the page and
 * reading the strings and hrefs it renders.
 *
 * ── WHAT THE ACCESS GATE ACTUALLY READS ───────────────────────────────────
 *
 * The first draft of this fixture stubbed `entitlements` and omitted
 * `email_confirmed_at`, so `resolveCourseAccess` denied every request and
 * `ctaAccess.allowed` was FALSE in every test -- the entitled path was never
 * exercised at all, and "entitled students can still continue" was asserted
 * nowhere. The contract reads three things and the fixture now models all
 * three:
 *
 *   · `email_confirmed_at` on the session user -- auth.users is the only
 *     authority for it, so it cannot be faked via a profiles column;
 *   · the `profiles` row (`platform_role`, `account_status`);
 *   · the learner-safe `my_course_access` VIEW -- never the `entitlements`
 *     base table, which is revoked from every app role by design.
 *
 * The syllabus likewise comes from the `public_course_*` views (migration 039),
 * not from `modules`. Serving those empty made `learnEntryHref` degrade to the
 * course page, which the self-link guard then rewrote to /contact -- an
 * artefact that looked exactly like an entitled learner being turned away.
 *
 * ── WHY PILOT MODE IN EVERY FIXTURE ───────────────────────────────────────
 *
 * `NEXT_PUBLIC_PLATFORM_MODE=pilot` is the CURRENT value, so PILOT_MODE and
 * FREE_ACCESS_MODE are both true. That is precisely the condition under which
 * the pre-CAT-02 page replaced every price with "Gratuit — phase pilote" and
 * every CTA with "Demander un accès". Each test therefore runs in the mode that
 * used to produce the defect.
 *
 * A React Server Component is an async function returning an element tree, so
 * it is invoked directly with Supabase mocked -- the harness shape is borrowed
 * from `__tests__/pages/course-detail.test.ts`, deliberately, so there is one
 * way of testing this page rather than two.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const notFoundError = new Error('NEXT_NOT_FOUND')

vi.mock('next/navigation', () => ({
  notFound: () => { throw notFoundError },
}))

interface Fixture {
  course?: Record<string, unknown> | null
  /** The session user. `email_confirmed_at` is what the gate checks. */
  user?: Record<string, unknown> | null
  enrollment?: unknown | null
  profile?: Record<string, unknown> | null
  /** The `my_course_access` view row — the entitlement authority. */
  access?: Record<string, unknown> | null
  /** false → the course publishes no syllabus (tests the degraded path). */
  syllabus?: boolean
}

let fixture: Fixture = {}

function makeClient() {
  const build = (table: string) => {
    const rowsFor = () => {
      if (table === 'courses')               return fixture.course ?? null
      if (table === 'enrollments')           return fixture.enrollment ?? null
      if (table === 'profiles')              return fixture.profile ?? null
      if (table === 'my_course_access')      return fixture.access ?? null
      if (table === 'public_course_modules') return fixture.syllabus === false ? [] : PUB_MODULES
      if (table === 'public_course_lessons') return fixture.syllabus === false ? [] : PUB_LESSONS
      return []
    }
    const result = () => ({ data: rowsFor(), error: null })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'gt', 'gte', 'or', 'not']) {
      chain[m] = () => chain
    }
    chain.maybeSingle = async () => result()
    chain.single      = async () => result()
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
    return chain
  }
  return {
    from: (table: string) => build(table),
    rpc:  async () => ({ data: false, error: null }),
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

/** The real C1-F1 shape: paid, 9 500 XOF. */
const PAID_COURSE = {
  id: 'course-paid', slug: 'les-fondamentaux-de-l-experience-client',
  title: "Les fondamentaux de l'experience client", description: 'Une description',
  level: 'beginner', price: 9500, currency: 'XOF', is_free: false,
  duration_hours: 2, cover_url: null, intro_video_url: null,
}

/** The real C1-F4 shape: the one approved free course. */
const FREE_COURSE = {
  ...PAID_COURSE,
  id: 'course-free', slug: 'donnez-envie-a-vos-clients-de-revenir',
  title: 'Donnez envie a vos clients de revenir', price: 0, is_free: true,
}

/** The syllabus, as the public views project it. */
const PUB_MODULES = [{ id: 'mod-1', slug: 'module-1', title: 'Module 1', order_index: 1 }]
const PUB_LESSONS = [
  { id: 'l1', module_id: 'mod-1', slug: 'lecon-1', title: 'Lecon 1', duration_minutes: 10, is_preview: true,  order_index: 1 },
  { id: 'l2', module_id: 'mod-1', slug: 'lecon-2', title: 'Lecon 2', duration_minutes: 12, is_preview: false, order_index: 2 },
]

const VERIFIED   = { id: 'u1', email_confirmed_at: '2026-01-01T00:00:00Z' }
const UNVERIFIED = { id: 'u2', email_confirmed_at: null }
const ACTIVE     = { platform_role: 'user', account_status: 'active' }
const HAS_ACCESS = { has_access: true,  access_ended: false }
const NO_ACCESS  = { has_access: false, access_ended: false }
const ENROLLED   = { id: 'e1' }

/**
 * Every string in the rendered tree, with Unicode spaces normalised.
 *
 * `toLocaleString('fr-FR')` groups thousands with U+202F (narrow no-break
 * space), so a naive `toContain('9 500')` would fail against correct output.
 */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props && 'children' in el.props) textOf(el.props.children, out)
  return out
}

const renderedText = (el: unknown) =>
  textOf(el).join(' ').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ')

/** Every href in the rendered tree. */
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

/**
 * Every Link/anchor in the tree as {href, label}.
 *
 * `hrefsOf` and `renderedText` answer "is this string anywhere on the page",
 * which a mutation test showed is too weak: a duplicate caption elsewhere in
 * the page satisfied the assertion while the CTA itself said the opposite.
 * These assertions pin the CTA ELEMENT.
 */
function linksOf(node: unknown, out: { href: string; label: string }[] = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) linksOf(n, out); return out }
  const el = node as { props?: Record<string, unknown> }
  if (el.props) {
    if (typeof el.props.href === 'string') {
      out.push({ href: el.props.href, label: renderedText(el.props.children) })
    }
    if ('children' in el.props) linksOf(el.props.children, out)
  }
  return out
}

async function renderPage(slug: string) {
  const mod = await import('@/app/(public)/courses/[slug]/page')
  return (mod.default as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>)({
    params: Promise.resolve({ slug }),
  })
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  fixture = {}
  // The mode that used to cause the defect. Asserted, not assumed.
  process.env.NEXT_PUBLIC_PLATFORM_MODE = 'pilot'
  delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 behaviour · the price on the page is the price in the database', () => {
  it('a PAID course shows its real price even though PILOT_MODE is on', async () => {
    fixture = { course: PAID_COURSE }
    const text = renderedText(await renderPage(PAID_COURSE.slug))

    expect(text).toContain('9 500')
    expect(text).toContain('FCFA')
    // The three strings the pre-CAT-02 page produced in this exact mode.
    expect(text, 'the pilot free-access caption is back').not.toMatch(/phase pilote/i)
    expect(text, 'a paid course is being advertised as free').not.toMatch(/\bGratuit\b/)
    expect(text, 'the manual access-request CTA is back').not.toMatch(/Demander un acc[eè]s/i)
  })

  it('the FREE course shows Gratuit and no amount — because the ROW says free', async () => {
    fixture = { course: FREE_COURSE }
    const text = renderedText(await renderPage(FREE_COURSE.slug))

    expect(text).toMatch(/\bGratuit\b/)
    expect(text, 'a free course rendered a price amount').not.toContain('FCFA')
    expect(text).not.toMatch(/phase pilote/i)
  })

  it('a price change in the DATABASE changes the page, with no code change', async () => {
    // The actual definition of "database-backed": vary only the row.
    fixture = { course: { ...PAID_COURSE, price: 11000 } }
    const text = renderedText(await renderPage(PAID_COURSE.slug))
    expect(text).toContain('11 000')
    expect(text).not.toContain('9 500')
  })

  it('the free label follows is_free, not a zero price alone', async () => {
    // Defensive: a paid row mistakenly left at 0 must not silently read Gratuit
    // merely because the amount is zero — is_free is the flag that decides.
    fixture = { course: { ...PAID_COURSE, price: 0, is_free: false } }
    expect(renderedText(await renderPage(PAID_COURSE.slug))).not.toMatch(/\bGratuit\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCESS MATRIX — the five cases that decide whether the CTA tells the
// truth. The question that matters is `entryLinks`: does a link into /learn
// actually render?
// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 behaviour · the CTA follows the access contract, not the transcript', () => {
  const entryLinks = (el: unknown) => linksOf(el).filter(l => l.href.startsWith('/learn/'))

  it('1. entitled + enrolled → may enter, with the progress-aware CTA', async () => {
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: HAS_ACCESS, enrollment: ENROLLED }
    const el = await renderPage(PAID_COURSE.slug)

    expect(entryLinks(el).length, 'an entitled, enrolled learner cannot enter').toBeGreaterThan(0)
    expect(renderedText(el)).toMatch(/Continuer la formation|Passer le quiz|Passer l.examen final|Obtenir le certificat/)
    const text = renderedText(el)
    expect(text, 'an entitled learner is told to wait')
      .not.toMatch(/Inscription bient[oô]t disponible/)
    // Nor is a learner who already holds access asked to acquire it, or
    // pitched the price of what they own.
    expect(text, 'a learner who already has access is told to acquire it')
      .not.toMatch(/Droit d.acc[eè]s requis/)
    expect(text).toMatch(/Acc[eè]s actif|Votre acc[eè]s est actif/)
  })

  it('2. entitled + NO enrollment → may STILL enter (enrollment authorizes nothing)', async () => {
    // The contract is explicit: "an enrollment is an academic transcript and
    // must not authorize access on its own"; the SQL seam dropped its
    // enrollments arm in migration 037. So this learner is allowed, and the
    // CTA must take them in rather than ask them to register interest.
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: HAS_ACCESS, enrollment: null }
    const el = await renderPage(PAID_COURSE.slug)

    const entries = entryLinks(el)
    expect(entries.length, 'an entitled learner without an enrollment row was turned away').toBeGreaterThan(0)
    expect(entries.every(l => /Commencer la formation|Reprendre la formation/.test(l.label)),
      `entry CTA mislabelled: ${JSON.stringify(entries.map(l => l.label))}`).toBe(true)
    expect(hrefsOf(el), 'an entitled learner was sent to /contact')
      .not.toContain(`/contact?course=${PAID_COURSE.slug}`)
  })

  it('3. enrolled + NO entitlement → refused, and told so honestly', async () => {
    // The transcript exists but authorizes nothing. Both CTA sites were once
    // gated on `isEnrolled` alone, which offered this learner a continue button
    // into a lesson resolveCourseAccess then refuses.
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: NO_ACCESS, enrollment: ENROLLED }
    const el = await renderPage(PAID_COURSE.slug)

    expect(entryLinks(el), 'an enrollment alone opened the course').toEqual([])
    expect(renderedText(el)).toMatch(/Inscription bient[oô]t disponible/)
    expect(renderedText(el), 'a refused learner is invited to continue')
      .not.toMatch(/Continuer la formation|Reprendre la formation/)
  })

  it('4. neither enrollment nor entitlement → refused', async () => {
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: NO_ACCESS, enrollment: null }
    const el = await renderPage(PAID_COURSE.slug)

    expect(entryLinks(el)).toEqual([])
    expect(renderedText(el)).toMatch(/Inscription bient[oô]t disponible/)
  })

  it('5. UNVERIFIED email → refused even holding both entitlement and enrollment', async () => {
    // email_confirmed_at is checked before the entitlement arm, and is read
    // from the session rather than from a column the application maintains.
    fixture = { course: PAID_COURSE, user: UNVERIFIED, profile: ACTIVE, access: HAS_ACCESS, enrollment: ENROLLED }
    const el = await renderPage(PAID_COURSE.slug)

    expect(entryLinks(el), 'an unverified account opened the course').toEqual([])
    expect(renderedText(el)).toMatch(/Inscription bient[oô]t disponible/)
  })

  it('an inactive account is refused even when entitled', async () => {
    fixture = {
      course: PAID_COURSE, user: VERIFIED, access: HAS_ACCESS, enrollment: ENROLLED,
      profile: { platform_role: 'user', account_status: 'suspended' },
    }
    expect(entryLinks(await renderPage(PAID_COURSE.slug))).toEqual([])
  })

  it('the progress-aware CTA is keyed on progress DATA, never on the transcript', async () => {
    // Entitled and enrolled, but the syllabus publishes nothing, so there is no
    // progress to resume. The page must degrade rather than render a self-link
    // dressed up as an entry CTA.
    fixture = {
      course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: HAS_ACCESS,
      enrollment: ENROLLED, syllabus: false,
    }
    const el = await renderPage(PAID_COURSE.slug)
    expect(hrefsOf(el), 'a self-link was rendered as the entry CTA')
      .not.toContain(`/courses/${PAID_COURSE.slug}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 behaviour · the CTA never promises what the gate refuses', () => {
  it('a GUEST is sent to register, returning to the lesson', async () => {
    fixture = { course: PAID_COURSE, user: null }
    const el = await renderPage(PAID_COURSE.slug)

    const ctas = linksOf(el).filter(l => /Créer mon compte/.test(l.label))
    expect(ctas.length, 'no CTA invites the guest to register').toBeGreaterThan(0)
    expect(ctas.every(l => l.href.startsWith('/login?next=') || l.href === '/signup'),
      `a register CTA points somewhere unexpected: ${JSON.stringify(ctas.map(l => l.href))}`).toBe(true)
    expect(hrefsOf(el).some(h => h.startsWith('/checkout')), 'a guest was sent to checkout').toBe(false)
  })

  it('the secondary guest note points at the SAME safe targets, never /checkout', async () => {
    // This note was gated on the deployment mode and sent both of its links
    // straight to /checkout -- dormant today, live the moment PLATFORM_MODE
    // moved to 'live' while payments stayed off.
    fixture = { course: PAID_COURSE, user: null }
    const links = linksOf(await renderPage(PAID_COURSE.slug))

    const login = links.filter(l => /Connectez-vous|Connexion/.test(l.label))
    expect(login.length).toBeGreaterThan(0)
    for (const l of login)
      expect(l.href, 'the guest login note still targets checkout').not.toMatch(/checkout/)

    for (const l of links.filter(l => /créez un compte/.test(l.label)))
      expect(l.href, 'the guest signup note still targets checkout').not.toMatch(/checkout/)
  })

  it('the page never mentions buying while nothing can be bought', async () => {
    // A mutation test caught this: the "Connexion requise avant l'achat" note
    // was gated on `paidPurchaseAvailable`, and loosening it to `!user` left
    // the page inviting a guest to log in and buy a course nothing can sell.
    fixture = { course: PAID_COURSE, user: null }
    expect(renderedText(await renderPage(PAID_COURSE.slug)),
      'the page promises a purchase while payments are off')
      .not.toMatch(/avant l.achat|Acc[eè]s imm[eé]diat apr[eè]s paiement/i)
  })

  it('...and DOES mention it once payments are on — so the check is not vacuous', async () => {
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: PAID_COURSE, user: null }
    expect(renderedText(await renderPage(PAID_COURSE.slug))).toMatch(/avant l.achat/i)
  })

  it('no link anywhere offers a purchase while payments are off', async () => {
    for (const user of [null, VERIFIED]) {
      fixture = { course: PAID_COURSE, user, profile: ACTIVE, access: NO_ACCESS }
      const hrefs = hrefsOf(await renderPage(PAID_COURSE.slug))
      expect(hrefs.filter(h => h.includes('checkout')),
        `a checkout link rendered for user=${JSON.stringify(user)}`).toEqual([])
      vi.resetModules()
    }
  })

  it('a LOGGED-IN learner with no entitlement is NOT sent to checkout while payments are off', async () => {
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: NO_ACCESS }
    const el = await renderPage(PAID_COURSE.slug)

    // The CTA ITSELF must carry the caption — not merely some other element.
    const ctas = linksOf(el).filter(l => l.href.startsWith('/contact?course='))
    expect(ctas.length, 'no CTA points at the safe contact target').toBeGreaterThan(0)
    expect(ctas.every(l => /Inscription bient[oô]t disponible/.test(l.label)),
      `a CTA says something else: ${JSON.stringify(ctas.map(l => l.label))}`).toBe(true)
    expect(hrefsOf(el).some(h => h.startsWith('/checkout')), 'routed into the /checkout dead end').toBe(false)
  })

  it('once payments ARE enabled, the same learner is sent to checkout', async () => {
    // Proves the state machine both ways — otherwise "never checkout" would
    // pass trivially against a page that had simply lost the ability.
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: PAID_COURSE, user: VERIFIED, profile: ACTIVE, access: NO_ACCESS }
    const el = await renderPage(PAID_COURSE.slug)

    expect(hrefsOf(el).some(h => h === `/checkout?course=${PAID_COURSE.id}`)).toBe(true)
    expect(renderedText(el)).not.toMatch(/Inscription bient[oô]t disponible/)
  })

  it('the FREE course never offers checkout, even with payments enabled', async () => {
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'true'
    fixture = { course: FREE_COURSE, user: VERIFIED, profile: ACTIVE, access: NO_ACCESS }
    expect(hrefsOf(await renderPage(FREE_COURSE.slug)).some(h => h.startsWith('/checkout')),
      'a free course was sent to payment').toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 behaviour · the phantom seed course page is gone', () => {
  it('the old seed slug now 404s instead of advertising a nonexistent course', async () => {
    // Before CAT-02 this returned 200 in production and read "GRATUIT", via the
    // `slug !== FLAGSHIP_COURSE.slug` escape hatch in the notFound() guard. The
    // slug is in none of the eight published rows.
    fixture = { course: null }
    await expect(renderPage('comprendre-client-qualite-experience')).rejects.toThrow(notFoundError)
  })

  it('any slug the database does not publish 404s', async () => {
    fixture = { course: null }
    await expect(renderPage('n-importe-quoi')).rejects.toThrow(notFoundError)
  })

  it('the 404 carries NO phantom metadata either', async () => {
    // The body 404'd, but generateMetadata still reached into data/seed.ts for
    // the old flagship slug -- so the 404 response advertised the title and
    // description of a course that does not exist, in the <head> where
    // crawlers and link previews read it.
    fixture = { course: null }
    const mod = await import('@/app/(public)/courses/[slug]/page')
    const meta = await (mod as unknown as {
      generateMetadata: (p: { params: Promise<{ slug: string }> }) => Promise<Record<string, unknown>>
    }).generateMetadata({ params: Promise.resolve({ slug: 'comprendre-client-qualite-experience' }) })

    expect(String(meta.title), 'the seed course title is still advertised')
      .not.toMatch(/Comprendre le Client pour D[eé]livrer/i)
    expect(meta.description, 'the seed course description is still advertised').toBeUndefined()
  })
})
