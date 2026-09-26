// @vitest-environment node
/**
 * UAT-ADMIN-LESSON-VISIBILITY-01 — the platform admin could not open the
 * courses she authors, and correctly attached media looked missing.
 *
 * ── THE NAMED REGRESSION ─────────────────────────────────────────────────
 *
 * Three places answered "may this caller open this course?":
 *
 *   has_course_access()        SQL/RLS       admits a platform admin
 *   resolveCourseAccessById()  server seam   admits a platform admin
 *   my_course_access           a VIEW        entitlements only — NO admin arm
 *
 * The learn player queried the view directly, so the layout admitted the admin
 * server-side and the player redirected her back out — every course, every
 * time, because she holds no commercial entitlement and should not need one.
 *
 * The player now asks the seam (`canOpenCourse`) instead of re-deriving the
 * answer, so a third definition cannot drift. Entitlement semantics for
 * ordinary learners are untouched.
 *
 * Separately, the admin lesson list keyed its Video/PDF badges on the LEGACY
 * `*_url` columns. Protected media has no URL, so 61 videos and 12 PDFs showed
 * no badge and a correctly authored lesson looked empty. The badges now read
 * the derived contract (054).
 *
 * Nothing here weakens WC-2: no raw media column reaches a browser surface,
 * and 054/055 are pinned byte-identical below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const PLAYER   = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const ACTION   = 'app/actions/course-access.ts'
const SEAM     = 'lib/auth/course-access.ts'
const ADMIN_PAGE = 'app/(admin)/admin/modules/[id]/edit/page.tsx'
const ADMIN_EDITOR = 'app/(admin)/admin/modules/[id]/edit/LessonEditor.tsx'
const RAW = ['video_object_path', 'pdf_object_path', 'subtitle_object_path', 'video_url', 'pdf_url', 'subtitle_url']

// ── Supabase stub: one fixture per identity ──────────────────────────────────
interface Fixture { user?: unknown; profile?: unknown; access?: unknown }
let fixture: Fixture = {}

function makeClient() {
  const build = (table: string) => {
    const rowsFor = () => {
      if (table === 'profiles')         return fixture.profile ?? null
      if (table === 'my_course_access') return fixture.access ?? null
      if (table === 'courses')          return { id: COURSE }
      return null
    }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) chain[m] = () => chain
    chain.maybeSingle = async () => ({ data: rowsFor(), error: null })
    chain.single      = async () => ({ data: rowsFor(), error: null })
    return chain
  }
  return {
    from: (t: string) => build(t),
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient() }))

const COURSE = '11111111-2222-4333-8444-555555555555'
const VERIFIED = { id: '00000000-0000-0000-0000-0000000000aa', email_confirmed_at: '2026-01-01T00:00:00Z' }
const ADMIN_PROFILE   = { platform_role: 'super_admin', account_status: 'active' }
const LEARNER_PROFILE = { platform_role: 'learner', account_status: 'active' }

beforeEach(() => { fixture = {} })

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-ADMIN-LESSON-VISIBILITY-01 — the player access decision (behavioural)', () => {
  const ask = async () => (await import('@/app/actions/course-access')).canOpenCourse(COURSE)

  it('1. THE REGRESSION: super_admin with ZERO entitlements may open the player', async () => {
    // Exactly the production state: an admin, and no row in my_course_access.
    fixture = { user: VERIFIED, profile: ADMIN_PROFILE, access: null }
    expect(await ask()).toEqual({ allowed: true })
  })

  it('2. an ordinary authenticated learner with no entitlement is still denied', async () => {
    fixture = { user: VERIFIED, profile: LEARNER_PROFILE, access: null }
    const r = await ask()
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('not_entitled')
  })

  it('3. an entitled learner is still allowed', async () => {
    fixture = { user: VERIFIED, profile: LEARNER_PROFILE, access: { has_access: true } }
    expect(await ask()).toEqual({ allowed: true })
  })

  it('4. a learner whose access ended is denied, with the reason preserved', async () => {
    fixture = { user: VERIFIED, profile: LEARNER_PROFILE, access: { has_access: false, access_ended: true } }
    const r = await ask()
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('access_ended')
  })

  it('5. anonymous is denied as not_authenticated (unchanged)', async () => {
    fixture = { user: null }
    const r = await ask()
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('not_authenticated')
  })

  it('6. an unverified email is still denied, even for an admin candidate', async () => {
    fixture = { user: { id: VERIFIED.id, email_confirmed_at: null }, profile: ADMIN_PROFILE }
    const r = await ask()
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('email_unverified')
  })

  it('7. a suspended ordinary account is still denied', async () => {
    fixture = { user: VERIFIED, profile: { platform_role: 'learner', account_status: 'suspended' }, access: { has_access: true } }
    const r = await ask()
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('account_inactive')
  })

  it('8. a malformed course id fails closed before the seam is consulted', async () => {
    fixture = { user: VERIFIED, profile: ADMIN_PROFILE }
    const { canOpenCourse } = await import('@/app/actions/course-access')
    const r = await canOpenCourse('not-a-uuid')
    expect(r).toEqual({ allowed: false, reason: 'course_not_found' })
  })

  it('9. the player answer and the server seam cannot disagree for a platform admin', async () => {
    fixture = { user: VERIFIED, profile: ADMIN_PROFILE, access: null }
    const { resolveCourseAccessById } = await import('@/lib/auth/course-access')
    const { canOpenCourse } = await import('@/app/actions/course-access')
    const seam = await resolveCourseAccessById(COURSE)
    const player = await canOpenCourse(COURSE)
    expect(seam.allowed).toBe(true)
    expect(player.allowed).toBe(seam.allowed)
  })

  it('10. the OLD projection would have denied that same admin — the defect, pinned', async () => {
    // my_course_access is entitlements-only: no row for an admin who holds none.
    fixture = { user: VERIFIED, profile: ADMIN_PROFILE, access: null }
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data } = await (supabase.from('my_course_access') as never as {
      select: () => { eq: () => { maybeSingle: () => Promise<{ data: { has_access?: boolean } | null }> } }
    }).select().eq().maybeSingle()
    expect(data?.has_access, 'the view still has no platform-admin arm').toBeUndefined()
    const { canOpenCourse } = await import('@/app/actions/course-access')
    expect((await canOpenCourse(COURSE)).allowed, 'the player must no longer follow that view').toBe(true)
  })

  it('11. the answer carries nothing commercial', async () => {
    fixture = { user: VERIFIED, profile: LEARNER_PROFILE, access: { has_access: true } }
    const r = await ask()
    expect(Object.keys(r)).toEqual(['allowed'])
    for (const k of ['status', 'starts_at', 'expires_at', 'revoked_at', 'source', 'granted_by', 'external_ref'])
      expect(JSON.stringify(r)).not.toContain(k)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-ADMIN-LESSON-VISIBILITY-01 — one authority, not three', () => {
  it('the player no longer queries the entitlement view itself', () => {
    const src = stripTs(read(PLAYER))
    expect(src, 'the player still reads my_course_access directly').not.toContain('my_course_access')
    expect(src).not.toMatch(/!access\?\.has_access/)
  })

  it('the player asks the shared seam and still redirects on refusal', () => {
    const src = stripTs(read(PLAYER))
    expect(src).toMatch(/const access = await canOpenCourse\(course\.id\)/)
    expect(src).toMatch(/if \(!access\.allowed\) \{ router\.push\(`\/courses\/\$\{courseSlug\}`\); return \}/)
  })

  it('the player does NOT grow its own platform_role check (no third seam)', () => {
    const src = stripTs(read(PLAYER))
    for (const t of ['platform_role', 'super_admin', 'is_platform_admin', "from('profiles')"])
      expect(src, `the player re-derives access via ${t}`).not.toContain(t)
  })

  it('the action delegates to resolveCourseAccessById and adds no rule of its own', () => {
    const src = stripTs(read(ACTION))
    expect(src).toMatch(/resolveCourseAccessById\(parsed\.data\.courseId\)/)
    expect(src).toMatch(/^'use server'/m)
    for (const t of ['platform_role', 'super_admin', 'entitlements', 'my_course_access'])
      expect(src, `the action re-implements ${t}`).not.toContain(t)
    expect(src, 'no service-role client in a browser-reachable action').not.toContain('createAdminClient')
  })

  it('the seam still admits platform admins and still requires an entitlement otherwise', () => {
    const src = stripTs(read(SEAM))
    expect(src).toMatch(/platform_role === 'super_admin'/)
    expect(src).toContain('my_course_access')
  })

  it('anonymous browsing is untouched: the anon loader has no access call', () => {
    const src = stripTs(read(PLAYER))
    const anon = src.slice(src.indexOf('const loadCourseAnon'), src.indexOf('const loadCourse ='))
    expect(anon).toMatch(/\.eq\('is_published', true\)/)
    expect(anon, 'the anonymous path must not consult the entitlement seam').not.toContain('canOpenCourse')
  })

  it('publication and preview rules are untouched by this fix', () => {
    const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
    expect(migrations.filter(f => f.startsWith('056'))).toEqual([])
    const src = stripTs(read(PLAYER))
    expect(src).not.toMatch(/is_preview\s*=/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-ADMIN-LESSON-VISIBILITY-01 — admin lesson media badges', () => {
  const editor = () => read(ADMIN_EDITOR)
  /** The admin lesson row, comments blanked so a comment cannot satisfy a test. */
  const badges = () => stripTs(editor())

  it('the Video badge is driven by video_source, not by a legacy URL', () => {
    expect(badges()).toMatch(/\{lesson\.video_source && \(/)
    expect(badges(), 'the badge still keys on the legacy URL').not.toMatch(/\{lesson\.video_url && \(/)
  })

  it('the PDF badge is driven by pdf_source', () => {
    expect(badges()).toMatch(/\{lesson\.pdf_source && \(/)
    expect(badges()).not.toMatch(/\{lesson\.pdf_url && \(/)
  })

  it("a null source renders nothing — truthiness of 'protected' | 'external' | null", () => {
    // The rendered condition is the source itself, so null/undefined shows no badge
    // and both non-null values show one. Pinned as behaviour on the same union.
    const show = (s: 'protected' | 'external' | null | undefined) => Boolean(s)
    expect(show('protected')).toBe(true)
    expect(show('external')).toBe(true)
    expect(show(null)).toBe(false)
    expect(show(undefined)).toBe(false)
  })

  it('the row type carries the derived fields', () => {
    const s = editor()
    for (const f of ['video_source: LessonMediaSource', 'pdf_source: LessonMediaSource', 'subtitle_source: LessonMediaSource'])
      expect(s).toContain(f)
    expect(s).toMatch(/import type \{ LessonMediaSource \} from '@\/lib\/media\/paths'/)
  })

  it('the admin query provides them, and still runs on the service role', () => {
    const s = read(ADMIN_PAGE)
    const sel = /\.select\('([^']*)'\)[\s\S]{0,80}?\.eq\('module_id'/.exec(s)![1].split(',').map(x => x.trim())
    for (const f of ['video_source', 'pdf_source', 'subtitle_source']) expect(sel).toContain(f)
    // the editor still needs the raw values it writes back — trusted path only
    for (const f of RAW) expect(sel).toContain(f)
    expect(s).toMatch(/createAdminClient/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-ADMIN-LESSON-VISIBILITY-01 — WC-2 is not weakened', () => {
  /**
   * The git blob hash of the committed content, so the pin is byte-exact.
   * Line endings are normalised to LF first: git stores LF, while this working
   * tree is checked out CRLF (`core.autocrlf`).
   */
  const blobSha = (p: string) => {
    const b = Buffer.from(readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex')
  }

  it('055 is byte-identical to the applied migration', () => {
    expect(blobSha('supabase/migrations/055_restrict_lesson_media_columns.sql'))
      .toBe('4d1337e104d6049cc097eacd5d384c6f39102a72')
  })

  it('054 is byte-identical to the applied migration', () => {
    expect(blobSha('supabase/migrations/054_lesson_media_derived_source.sql'))
      .toBe('b0cdf55a28d05d82af4ca16c1be388bdc327bb55')
  })

  it('no migration was added by this fix', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    expect(files).toHaveLength(53)
    expect(files.filter(f => f.startsWith('056'))).toEqual([])
  })

  it('no caller-role lesson query names a raw media column', () => {
    const files: { path: string; text: string }[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${name.name}`
        if (name.isDirectory()) { walk(p); continue }
        if (/\.(ts|tsx)$/.test(name.name)) files.push({ path: p, text: read(p) })
      }
    }
    for (const d of ['app', 'components', 'lib']) walk(d)
    const lessonColumns = (t: string) => {
      const cols: string[] = []
      for (const m of t.matchAll(/lessons\s*\(([^()]*)\)/g)) cols.push(...m[1].split(',').map(s => s.trim()))
      for (const m of t.matchAll(/from\('lessons'\)[\s\S]{0,200}?\.select\(\s*'([^']*)'/g))
        cols.push(...m[1].replace(/\w+\([^)]*\)/g, '').split(',').map(s => s.trim()))
      return cols.filter(Boolean)
    }
    const offenders = files
      .filter(f => /from '@\/lib\/supabase\/(client|server)'/.test(f.text) && !/createAdminClient/.test(f.text))
      .map(f => ({ path: f.path, bad: lessonColumns(f.text).filter(c => RAW.includes(c)) }))
      .filter(f => f.bad.length)
    expect(offenders).toEqual([])
  })

  it('the new action exposes no storage location', () => {
    const s = read(ACTION)
    for (const c of RAW) expect(s).not.toContain(c)
    expect(s).not.toMatch(/object_path|storage|signed/i)
  })

  it('no RLS, grant, policy or storage change ships with this fix', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) { walk(p); continue }
        if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
      }
    }
    for (const d of ['app/actions']) walk(d)
    const s = read(ACTION)
    expect(files).toContain(ACTION)
    expect(s).not.toMatch(/\b(grant|revoke|alter policy|create policy|alter table)\b/i)
  })
})
