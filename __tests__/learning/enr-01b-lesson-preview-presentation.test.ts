// @vitest-environment node
/**
 * ENR-01B — the curriculum tells the truth about which lessons are open.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Both curriculum expressions read `lesson.is_preview || FREE_ACCESS_MODE`,
 * which conflated two unrelated things:
 *
 *   `is_preview`       an AUTHORIZATION fact. Migration 036's `lessons_visible`
 *                      policy admits a row on `lessons.is_preview = true`
 *                      alone, so a preview lesson really is readable with no
 *                      entitlement.
 *   FREE_ACCESS_MODE   a DEPLOYMENT mode. It grants nothing in SQL. Its only
 *                      effect was painting this icon.
 *
 * Production runs `PLATFORM_MODE=pilot`, and `is_preview` is false for all 128
 * lessons, so every protected lesson showed a Play icon and a GRATUIT badge —
 * 36 of them on a course priced 11 000 FCFA. Migration 043 measured the same
 * defect from the other side ("Measured: 0 lock icons anywhere") and ruled that
 * the badge "promises access the platform does not grant".
 *
 * ── WHAT THESE TESTS ASSERT ───────────────────────────────────────────────
 *
 * Rendered ELEMENTS, per lesson row — which icon component was chosen and
 * whether a badge element exists — not whether a string appears somewhere in
 * the page. The page is invoked as a real server component with Supabase
 * mocked, the same harness `cat-02-price-rendering.behaviour.test.ts` uses.
 *
 * Every fixture below runs in PILOT mode unless it says otherwise, because
 * pilot is the mode that produced the defect and the mode production is in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
}))

interface Fixture {
  course?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  access?: Record<string, unknown> | null
  lessons?: Record<string, unknown>[]
}

let fixture: Fixture = {}

function makeClient() {
  const build = (table: string) => {
    const rowsFor = () => {
      if (table === 'courses')               return fixture.course ?? null
      if (table === 'profiles')              return fixture.profile ?? null
      if (table === 'my_course_access')      return fixture.access ?? null
      if (table === 'enrollments')           return null
      if (table === 'public_course_modules') return MODULES
      if (table === 'public_course_lessons') return fixture.lessons ?? []
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

const PAID_COURSE = {
  id: 'course-paid', slug: 'les-fondamentaux-du-service-client',
  title: 'Les fondamentaux du service client', description: 'd',
  level: 'beginner', price: 11000, currency: 'XOF', is_free: false,
  duration_hours: 2, cover_url: null, intro_video_url: null,
}

const FREE_COURSE = {
  ...PAID_COURSE,
  id: 'course-free', slug: 'donnez-envie-a-vos-clients-de-revenir',
  title: 'Donnez envie a vos clients de revenir', price: 0, is_free: true,
}

const MODULES = [{ id: 'mod-1', slug: 'module-1', title: 'Module 1', order_index: 1 }]

/**
 * Lesson rows as the public view projects them, PLUS sentinel protected fields.
 *
 * `public_course_lessons` does not expose `content`, `title_fr` or any media
 * URL — verified against production. They are injected here anyway so the
 * assertions prove the PAGE never renders them, rather than relying on the view
 * to keep withholding them.
 */
const PROTECTED_LESSON = {
  id: 'l1', module_id: 'mod-1', slug: 'lecon-protegee',
  title: 'Lecon protegee', duration_minutes: 14, is_preview: false, order_index: 1,
  content: 'SENTINEL_LESSON_BODY', title_fr: 'SENTINEL_TITLE_FR',
  video_url: 'https://sentinel.invalid/v.mp4', pdf_url: 'https://sentinel.invalid/d.pdf',
  subtitle_url: 'https://sentinel.invalid/s.vtt',
}

const PREVIEW_LESSON = {
  ...PROTECTED_LESSON,
  id: 'l2', slug: 'lecon-preview', title: 'Lecon preview',
  duration_minutes: 7, is_preview: true, order_index: 2,
}

const SENTINELS = [
  'SENTINEL_LESSON_BODY', 'SENTINEL_TITLE_FR',
  'sentinel.invalid/v.mp4', 'sentinel.invalid/d.pdf', 'sentinel.invalid/s.vtt',
]

const VERIFIED   = { id: 'u1', email_confirmed_at: '2026-01-01T00:00:00Z' }
const ACTIVE     = { platform_role: 'user', account_status: 'active' }
const HAS_ACCESS = { has_access: true,  access_ended: false }
const NO_ACCESS  = { has_access: false, access_ended: false }

// ── element-level inspection ───────────────────────────────────────────────

const LESSON_ROW_CLASS =
  'flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-light/30 transition-colors'
const PLAY_CLASS = 'w-3.5 h-3.5 text-primary shrink-0'
const LOCK_CLASS = 'w-3.5 h-3.5 text-cx-gray/50 shrink-0'

type El = { type?: unknown; props?: Record<string, unknown> }

function walk(node: unknown, visit: (el: El) => void): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  const el = node as El
  visit(el)
  if (el.props && 'children' in el.props) walk(el.props.children, visit)
}

function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props && 'children' in el.props) textOf(el.props.children, out)
  return out
}
const flat = (n: unknown) => textOf(n).join(' ').replace(/\s+/g, ' ')

/** One record per rendered curriculum lesson row. */
interface Row {
  text: string
  icon: 'play' | 'lock' | 'none'
  badge: boolean
  hrefs: string[]
}

function lessonRows(tree: unknown): Row[] {
  const rows: Row[] = []
  walk(tree, el => {
    if (el.props?.className !== LESSON_ROW_CLASS) return
    let icon: Row['icon'] = 'none'
    const hrefs: string[] = []
    let badge = false
    walk(el.props.children, inner => {
      const cn = inner.props?.className
      if (cn === PLAY_CLASS) icon = 'play'
      if (cn === LOCK_CLASS) icon = 'lock'
      if (typeof inner.props?.href === 'string') hrefs.push(inner.props.href)
      if (typeof cn === 'string' && cn.includes('bg-green-50') && flat(inner).includes('GRATUIT')) {
        badge = true
      }
    })
    rows.push({ text: flat(el), icon, badge, hrefs })
  })
  return rows
}

async function render(slug: string) {
  const mod = await import('@/app/(public)/courses/[slug]/page')
  return (mod.default as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>)({
    params: Promise.resolve({ slug }),
  })
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  fixture = {}
  process.env.NEXT_PUBLIC_PLATFORM_MODE = 'pilot'   // the mode that caused it
  delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

// ═══════════════════════════════════════════════════════════════════════════
describe('ENR-01B · 1. paid course, protected lesson, PILOT mode', () => {
  it('renders a Lock and no GRATUIT badge — pilot mode no longer decides', async () => {
    fixture = {
      course: PAID_COURSE, lessons: [PROTECTED_LESSON],
      user: null, access: NO_ACCESS,
    }
    const rows = lessonRows(await render(PAID_COURSE.slug))

    expect(rows).toHaveLength(1)
    expect(rows[0].icon, 'a protected lesson still shows a Play icon in pilot mode').toBe('lock')
    expect(rows[0].badge, 'a protected lesson is still badged GRATUIT').toBe(false)
  })

  it('all 36-style rows lock together, not just the first', async () => {
    // The production symptom was 36 badges on one course. Prove it scales.
    const many = Array.from({ length: 36 }, (_, i) => ({
      ...PROTECTED_LESSON, id: `l${i}`, slug: `lecon-${i}`, title: `Lecon ${i}`, order_index: i,
    }))
    fixture = { course: PAID_COURSE, lessons: many, user: null, access: NO_ACCESS }
    const rows = lessonRows(await render(PAID_COURSE.slug))

    expect(rows).toHaveLength(36)
    expect(rows.filter(r => r.icon === 'lock')).toHaveLength(36)
    expect(rows.filter(r => r.badge), 'GRATUIT badges survived on a paid course').toHaveLength(0)
  })
})

describe('ENR-01B · 2. paid course, AUTHORIZED preview lesson, PILOT mode', () => {
  it('the preview lesson keeps Play + GRATUIT; its protected sibling does not', async () => {
    // is_preview is an authorization fact, so this badge is honest.
    fixture = {
      course: PAID_COURSE, lessons: [PROTECTED_LESSON, PREVIEW_LESSON],
      user: null, access: NO_ACCESS,
    }
    const rows = lessonRows(await render(PAID_COURSE.slug))

    expect(rows).toHaveLength(2)
    const protectedRow = rows.find(r => r.text.includes('Lecon protegee'))!
    const previewRow   = rows.find(r => r.text.includes('Lecon preview'))!

    expect(previewRow.icon).toBe('play')
    expect(previewRow.badge, 'an authorized preview lost its GRATUIT badge').toBe(true)
    expect(protectedRow.icon).toBe('lock')
    expect(protectedRow.badge).toBe(false)
  })
})

describe('ENR-01B · 3. FREE course, protected lesson, PILOT mode', () => {
  it('a free course does NOT make every lesson a public preview', async () => {
    // The course costs nothing; its lessons still need an entitlement. These
    // are different claims and the UI must not merge them.
    fixture = {
      course: FREE_COURSE, lessons: [PROTECTED_LESSON],
      user: null, access: NO_ACCESS,
    }
    const tree = await render(FREE_COURSE.slug)
    const rows = lessonRows(tree)

    expect(rows[0].icon).toBe('lock')
    expect(rows[0].badge, 'a free course auto-classified its lessons as previews').toBe(false)
    // …while the COURSE-level free statement is preserved.
    expect(flat(tree)).toMatch(/Formation gratuite|Gratuit/)
  })
})

describe('ENR-01B · 4. FREE course, authorized preview lesson', () => {
  it('an explicit preview on a free course still reads Play + GRATUIT', async () => {
    fixture = {
      course: FREE_COURSE, lessons: [PREVIEW_LESSON],
      user: null, access: NO_ACCESS,
    }
    const rows = lessonRows(await render(FREE_COURSE.slug))
    expect(rows[0].icon).toBe('play')
    expect(rows[0].badge).toBe(true)
  })
})

describe('ENR-01B · 5. the deployment mode has no influence at all', () => {
  it('pilot and non-pilot render byte-identical lesson rows', async () => {
    const snapshot = async (mode: string) => {
      process.env.NEXT_PUBLIC_PLATFORM_MODE = mode
      vi.resetModules()
      fixture = {
        course: PAID_COURSE, lessons: [PROTECTED_LESSON, PREVIEW_LESSON],
        user: null, access: NO_ACCESS,
      }
      return lessonRows(await render(PAID_COURSE.slug))
        .map(r => `${r.icon}|${r.badge}|${r.hrefs.length}`)
    }
    const pilot  = await snapshot('pilot')
    const open   = await snapshot('public')
    const closed = await snapshot('private')

    expect(pilot).toEqual(['lock|false|0', 'play|true|0'])
    expect(open,   'switching off pilot mode changed the curriculum').toEqual(pilot)
    expect(closed, 'private mode changed the curriculum').toEqual(pilot)
  })
})

describe('ENR-01B · 6. an ENTITLED learner is neither locked out nor told it is free', () => {
  it('shows Play on every lesson, but no GRATUIT — they hold an entitlement', async () => {
    fixture = {
      course: PAID_COURSE, lessons: [PROTECTED_LESSON],
      user: VERIFIED, profile: ACTIVE, access: HAS_ACCESS,
    }
    const rows = lessonRows(await render(PAID_COURSE.slug))

    expect(rows[0].icon, 'an entitled learner sees a lock on a lesson they can open').toBe('play')
    expect(rows[0].badge, 'a paid lesson was labelled GRATUIT to its owner').toBe(false)
  })

  it('an UNVERIFIED account is treated as locked, like the gate treats it', async () => {
    fixture = {
      course: PAID_COURSE, lessons: [PROTECTED_LESSON],
      user: { id: 'u2', email_confirmed_at: null }, profile: ACTIVE, access: HAS_ACCESS,
    }
    expect(lessonRows(await render(PAID_COURSE.slug))[0].icon).toBe('lock')
  })
})

describe('ENR-01B · 7. title and duration are untouched', () => {
  it('both render in every state, locked or open', async () => {
    for (const access of [NO_ACCESS, HAS_ACCESS]) {
      vi.resetModules()
      fixture = {
        course: PAID_COURSE, lessons: [PROTECTED_LESSON],
        user: VERIFIED, profile: ACTIVE, access,
      }
      const rows = lessonRows(await render(PAID_COURSE.slug))
      expect(rows[0].text, 'the lesson title vanished').toContain('Lecon protegee')
      expect(rows[0].text, 'the lesson duration vanished').toContain('14 min')
    }
  })
})

describe('ENR-01B · 8. SECURITY: no content, media URL or new link is exposed', () => {
  it('no protected field reaches the page, in ANY access state', async () => {
    for (const [label, f] of [
      ['guest, protected',        { user: null,     access: NO_ACCESS }],
      ['guest, preview',          { user: null,     access: NO_ACCESS }],
      ['entitled',                { user: VERIFIED, profile: ACTIVE, access: HAS_ACCESS }],
    ] as const) {
      vi.resetModules()
      fixture = { course: PAID_COURSE, lessons: [PROTECTED_LESSON, PREVIEW_LESSON], ...f }
      const text = flat(await render(PAID_COURSE.slug))
      for (const s of SENTINELS) {
        expect(text, `${label}: protected field ${s} was rendered`).not.toContain(s)
      }
    }
  })

  it('a curriculum row is never a link — preview included', async () => {
    fixture = {
      course: PAID_COURSE, lessons: [PROTECTED_LESSON, PREVIEW_LESSON],
      user: null, access: NO_ACCESS,
    }
    const rows = lessonRows(await render(PAID_COURSE.slug))
    for (const r of rows) {
      expect(r.hrefs, 'a curriculum row became a navigable link').toEqual([])
    }
  })

  it('marking a lesson preview adds no link anywhere on the page', async () => {
    // Flip ONLY `is_preview` — same lesson, same slug. The first draft of this
    // test also changed the slug, so `learnEntryHref` legitimately pointed at a
    // different first lesson and the comparison failed for the wrong reason.
    const hrefsFor = async (isPreview: boolean) => {
      vi.resetModules()
      fixture = {
        course: PAID_COURSE,
        lessons: [{ ...PROTECTED_LESSON, is_preview: isPreview }],
        user: null, access: NO_ACCESS,
      }
      const out: string[] = []
      walk(await render(PAID_COURSE.slug), el => {
        if (typeof el.props?.href === 'string') out.push(el.props.href)
      })
      return out.sort()
    }
    const locked  = await hrefsFor(false)
    const preview = await hrefsFor(true)

    expect(locked.length, 'the page rendered no links at all — assertion would be vacuous')
      .toBeGreaterThan(0)
    expect(preview, 'designating a preview introduced a new href').toEqual(locked)
  })

  it('the page still reads the public PROJECTION, not the base lessons table', async () => {
    const seen: string[] = []
    vi.resetModules()
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => {
        const c = makeClient()
        return { ...c, from: (t: string) => { seen.push(t); return c.from(t) } }
      },
    }))
    fixture = { course: PAID_COURSE, lessons: [PROTECTED_LESSON], user: null, access: NO_ACCESS }
    await render(PAID_COURSE.slug)

    expect(seen, 'the page queried the base lessons table').not.toContain('lessons')
    expect(seen).toContain('public_course_lessons')
    vi.doUnmock('@/lib/supabase/server')
  })
})
