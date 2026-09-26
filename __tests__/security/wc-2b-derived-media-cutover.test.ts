// @vitest-environment node
/**
 * XPA-8 WC-2B — the application cutover to the derived media contract.
 *
 *   The browser learns WHAT KIND of asset a lesson has, never WHERE a
 *   protected one is stored. Browser-facing queries read the derived fields
 *   added by migration 054 (`*_source`, `*_external_url`) and never the three
 *   object-path or three legacy URL columns — so migration 055 can withdraw
 *   SELECT on those six from `anon` and `authenticated` without breaking
 *   playback. Upload, signing and administrative editing keep the raw columns
 *   through the service-role client.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * This suite pins the contract in the repository: which columns each caller
 * asks for, what the browser resolver does with them, and that no
 * browser-facing surface names a raw column. The behavioural half was proven
 * offline against real PostgreSQL 17 with the live corpus (127 lessons): the
 * new player query succeeds as anon, as a signed-in unentitled learner and as
 * an entitled learner both BEFORE and AFTER a simulated 055, the old query is
 * refused with 42501 after it, `select *` is refused rather than silently
 * narrowed, and the service-role media route and admin editor are unaffected.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { lessonAssetSrcFromSource, lessonAssetSrc, resolveAssetSource, lessonMediaHref } from '@/lib/media/paths'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const PLAYER_PATH = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const SIDEBAR_PATH = 'components/lms/LessonSidebar.tsx'
const PATHS_PATH = 'lib/media/paths.ts'
const ROUTE_PATH = 'app/api/media/lesson/[lessonId]/[kind]/route.ts'
const ADMIN_PAGE = 'app/(admin)/admin/modules/[id]/edit/page.tsx'
const ADMIN_ACTIONS = 'app/(admin)/admin/modules/[id]/edit/actions.ts'
const ADMIN_EDITOR = 'app/(admin)/admin/modules/[id]/edit/LessonEditor.tsx'

const KINDS = ['video', 'pdf', 'subtitle'] as const
const RAW = KINDS.flatMap(k => [`${k}_object_path`, `${k}_url`])
const DERIVED = KINDS.flatMap(k => [`${k}_source`, `${k}_external_url`])
/** Columns of `lessons` that survive migration 055 for anon / authenticated. */
const ALLOWED_AFTER_055 = [
  'id', 'module_id', 'slug', 'title', 'title_fr', 'content', 'duration_minutes',
  'order_index', 'is_preview', 'created_at', ...DERIVED,
]

const PLAYER = read(PLAYER_PATH)
/** The lesson columns of the player's two `modules → lessons(...)` selects. */
const playerSelects = [...PLAYER.matchAll(/lessons\(([^)]*)\)'\)/g)].map(m => m[1].split(',').map(s => s.trim()))

/** Every source file, with the Supabase client factory it uses. */
function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const p = `${dir}/${name}`
      if (statSync(join(ROOT, p)).isDirectory()) { walk(p); continue }
      if (/\.(ts|tsx)$/.test(name)) out.push({ path: p, text: read(p) })
    }
  }
  for (const d of ['app', 'components', 'lib', 'types', 'hooks']) {
    try { walk(d) } catch { /* optional directory */ }
  }
  return out
}
const FILES = sourceFiles()
/** Files that query Supabase as the CALLER (anon or authenticated), not as the service role. */
const userClientFiles = FILES.filter(f =>
  /from '@\/lib\/supabase\/(client|server)'/.test(f.text) && !/createAdminClient/.test(f.text))
const adminClientFiles = FILES.filter(f => /createAdminClient/.test(f.text))

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — the browser-facing lesson query', () => {
  it('both player queries are identical and select the derived fields', () => {
    expect(playerSelects).toHaveLength(2)
    expect(playerSelects[0].join(', '), 'the anonymous and entitled loaders must ask for the same columns')
      .toBe(playerSelects[1].join(', '))
    for (const c of DERIVED) expect(playerSelects[0], `player does not select ${c}`).toContain(c)
  })

  it('neither player query names an object path or a legacy URL', () => {
    for (const c of RAW) expect(playerSelects[0], `player still selects ${c}`).not.toContain(c)
  })

  it('the player still selects what the page renders besides media', () => {
    for (const c of ['id', 'slug', 'title', 'content', 'duration_minutes', 'order_index'])
      expect(playerSelects[0]).toContain(c)
  })

  it('every player column survives migration 055', () => {
    const forbidden = playerSelects[0].filter(c => !ALLOWED_AFTER_055.includes(c))
    expect(forbidden, `columns that 055 would withdraw: ${forbidden.join(', ')}`).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — no caller-role query anywhere reads a raw media column', () => {
  /**
   * The lesson columns a file asks Supabase for: `lessons(...)` embeds and
   * `.from('lessons')…select('…')`. Scoped to LESSON queries on purpose —
   * `certificates.pdf_url` is a different table and a different work item.
   */
  const lessonQueryColumns = (text: string): string[] => {
    const cols: string[] = []
    for (const m of text.matchAll(/lessons\s*\(([^()]*)\)/g)) cols.push(...m[1].split(',').map(s => s.trim()))
    for (const m of text.matchAll(/from\('lessons'\)[\s\S]{0,200}?\.select\(\s*'([^']*)'/g))
      cols.push(...m[1].replace(/\w+\([^)]*\)/g, '').split(',').map(s => s.trim()))
    return cols.filter(Boolean)
  }

  it('no anon/authenticated lesson query selects an object path or a legacy URL', () => {
    const offenders = userClientFiles
      .map(f => ({ path: f.path, bad: lessonQueryColumns(f.text).filter(c => RAW.includes(c)) }))
      .filter(f => f.bad.length)
    expect(offenders, 'these run as anon/authenticated and would get 42501 after 055').toEqual([])
  })

  it('every column any caller-role lesson query asks for survives migration 055', () => {
    const offenders = userClientFiles
      .map(f => ({ path: f.path, bad: lessonQueryColumns(f.text).filter(c => !ALLOWED_AFTER_055.includes(c)) }))
      .filter(f => f.bad.length)
    expect(offenders).toEqual([])
  })

  it('lesson queries that still read raw columns are all service-role ones', () => {
    const readers = FILES.filter(f => lessonQueryColumns(f.text).some(c => RAW.includes(c))).map(f => f.path)
    for (const p of readers)
      expect(adminClientFiles.some(f => f.path === p), `${p} reads raw lesson media but is not a service-role path`).toBe(true)
    for (const p of [ROUTE_PATH, ADMIN_PAGE]) expect(readers, `${p} must keep the raw columns`).toContain(p)
  })

  it('no browser-facing file resolves media from raw columns any more', () => {
    for (const f of [...userClientFiles, { path: SIDEBAR_PATH, text: read(SIDEBAR_PATH) }])
      expect(f.text, `${f.path} still calls lessonAssetSrc()`).not.toMatch(/\blessonAssetSrc\s*\(/)
  })

  it('no user-client query asks for every column of lessons', () => {
    for (const f of userClientFiles)
      expect(f.text, `${f.path} selects lessons(*)`).not.toMatch(/lessons\s*\(\s*\*\s*\)|from\('lessons'\)[\s\S]{0,80}?select\('\*'/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — the browser resolver', () => {
  const ID = '11111111-2222-4333-8444-555555555555'

  it('protected resolves to the delivery route for every kind, and never to a location', () => {
    for (const k of KINDS) {
      expect(lessonAssetSrcFromSource(ID, k, 'protected', null)).toBe(`/api/media/lesson/${ID}/${k}`)
      expect(lessonAssetSrcFromSource(ID, k, 'protected', null)).toBe(lessonMediaHref(ID, k))
      // even if an external URL were somehow present, protected wins and the URL is not used
      expect(lessonAssetSrcFromSource(ID, k, 'protected', 'https://cdn.example.com/x.mp4')).toBe(`/api/media/lesson/${ID}/${k}`)
    }
  })

  it('external resolves to the external URL', () => {
    expect(lessonAssetSrcFromSource(ID, 'video', 'external', 'https://www.youtube.com/embed/abc')).toBe('https://www.youtube.com/embed/abc')
    expect(lessonAssetSrcFromSource(ID, 'pdf', 'external', 'https://docs.example.org/a.pdf')).toBe('https://docs.example.org/a.pdf')
  })

  it('null, empty and unknown values produce no media', () => {
    for (const bad of [null, undefined, '', 'PROTECTED', 'internal', 'other'])
      expect(lessonAssetSrcFromSource(ID, 'video', bad as never, 'https://cdn.example.com/x.mp4')).toBeNull()
    expect(lessonAssetSrcFromSource(ID, 'video', 'external', null), 'external with no URL is no asset').toBeNull()
    expect(lessonAssetSrcFromSource(ID, 'video', 'external', ''), 'external with an empty URL is no asset').toBeNull()
  })

  it('it agrees with the raw-column resolver for every classification', () => {
    const cases: [string | null, string | null][] = [
      ['video/a.mp4', null],
      ['video/a.mp4', 'https://www.youtube.com/embed/abc'],
      [null, 'https://www.youtube.com/embed/abc'],
      [null, null],
    ]
    for (const [path, url] of cases) {
      const ref = resolveAssetSource(path, url)
      const source = ref?.kind ?? null
      const external = ref?.kind === 'external' ? ref.url : null
      expect(lessonAssetSrcFromSource(ID, 'video', source, external)).toBe(lessonAssetSrc(ID, 'video', path, url))
    }
  })

  it('is pure and browser-safe: no key, no signing, no server-only import', () => {
    const s = read(PATHS_PATH)
    expect(s, 'paths.ts must not become server-only').not.toMatch(/^import ['"]server-only['"]|from ['"]server-only['"]/m)
    expect(s).not.toMatch(/SUPABASE_SERVICE_ROLE|createSignedUrl\(|createAdminClient\(/)
    expect(s).toMatch(/export type LessonMediaSource/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — what the player does with the contract', () => {
  it('protected video is decided by video_source, not by a path', () => {
    expect(PLAYER).toMatch(/const isProtectedVideo = lesson\.video_source === 'protected'/)
    expect(PLAYER).not.toMatch(/Boolean\(lesson\.video_object_path\)/)
  })

  it('video, subtitle and PDF all resolve through the derived resolver', () => {
    for (const k of KINDS)
      expect(PLAYER).toMatch(new RegExp(`lessonAssetSrcFromSource\\(lesson\\.id, '${k}',\\s*lesson\\.${k}_source,\\s*lesson\\.${k}_external_url\\)`))
    expect(PLAYER).not.toMatch(/\blessonAssetSrc\(/)
  })

  it('an external embed still renders as an iframe, a protected asset as <video>', () => {
    expect(PLAYER).toMatch(/isProtectedVideo\s*\n\s*\|\|\s*\/\\\.\(mp4\|webm\|mov\|ogg\)/)
    expect(PLAYER).toMatch(/<iframe/)
    expect(PLAYER).toMatch(/src=\{videoSrc\}/)
  })

  it('the subtitle track and the PDF link use the resolved src, never a raw value', () => {
    expect(PLAYER).toMatch(/<track kind="subtitles" src=\{subtitleSrc\}/)
    expect(PLAYER).toMatch(/href=\{pdfSrc\}/)
    expect(PLAYER).not.toMatch(/pdf_object_path|pdf_url|video_object_path|video_url|subtitle_object_path|subtitle_url/)
  })

  it('anonymous preview playback is supported: the anon loader asks for the same contract', () => {
    expect(PLAYER).toMatch(/const loadCourseAnon = useCallback/)
    expect(playerSelects[0].join()).toBe(playerSelects[1].join())
  })

  it('entitled playback is still gated by the access seam, not by media columns', () => {
    // UAT-ADMIN-LESSON-VISIBILITY-01: the player asks the one authority instead
    // of reading the entitlement view itself, so the platform admin the server
    // admits is no longer redirected out by a projection that ignores admins.
    expect(PLAYER).toMatch(/const access = await canOpenCourse\(course\.id\)/)
    expect(PLAYER).toMatch(/if \(!access\.allowed\)/)
    expect(read('app/actions/course-access.ts')).toMatch(/resolveCourseAccessById/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — browser DTOs carry no storage location', () => {
  const sidebar = read(SIDEBAR_PATH)

  it('SidebarLessonRow exposes the derived contract only', () => {
    const iface = sidebar.slice(sidebar.indexOf('export interface SidebarLessonRow'), sidebar.indexOf('export interface SidebarModuleRow'))
    for (const c of RAW) expect(iface, `SidebarLessonRow still declares ${c}`).not.toContain(c)
    for (const c of DERIVED) expect(iface).toContain(c)
  })

  it('the player row type is that DTO', () => {
    expect(PLAYER).toMatch(/interface LessonRow extends SidebarLessonRow/)
  })

  it('the shared Lesson type marks the raw columns trusted-only', () => {
    const t = read('types/index.ts')
    for (const c of DERIVED) expect(t).toContain(c)
    expect(t).toMatch(/TRUSTED SERVER \/ ADMIN ONLY/)
    expect(t).toMatch(/Migration 055 withdraws SELECT on/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — trusted server and admin paths keep what they need', () => {
  it('the media route still resolves the object path itself, with the service role', () => {
    const r = read(ROUTE_PATH)
    expect(r).toMatch(/createAdminClient/)
    expect(r).toMatch(/select\('id, video_object_path, pdf_object_path, subtitle_object_path/)
    expect(r).toMatch(/resolveCourseAccessById/)
    expect(r).toMatch(/signObject\(/)
    expect(r).toMatch(/NextResponse\.redirect\(signed, 302\)/)
    for (const c of DERIVED) expect(r, `the delivery route must not depend on ${c}`).not.toContain(c)
  })

  it('the admin editor still reads and writes every raw column', () => {
    const page = read(ADMIN_PAGE), actions = read(ADMIN_ACTIONS), editor = read(ADMIN_EDITOR)
    for (const c of RAW) {
      expect(page, `admin page lost ${c}`).toContain(c)
      expect(actions, `admin save lost ${c}`).toContain(c)
    }
    expect(page).toMatch(/createAdminClient/)
    expect(actions).toMatch(/createAdminClient/)
    expect(editor).toMatch(/video_object_path \?\? lesson\?\.video_url/)
  })

  it('no code writes a derived field: they are generated by the database', () => {
    // The invariant is about WRITES, so it reads the write calls themselves.
    // A type annotation (`video_source: LessonMediaSource`) declares the shape
    // the database produces and is not a write — an earlier version of this
    // test pattern-matched `name:` and could be satisfied by backtracking.
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\.(insert|update|upsert)\(/g)) {
        const call = f.text.slice(m.index!, m.index! + 600)
        for (const c of DERIVED)
          expect(call, `${f.path} writes ${c} in a ${m[1]}()`).not.toContain(c)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WC-2B — the gate migration 055 depends on', () => {
  it('the application half shipped before 055 restricted anything', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations'))
    expect(files.filter(f => f.startsWith('054'))).toEqual(['054_lesson_media_derived_source.sql'])
    // WC-2C later authored 055. It carries no application change, and this
    // release carries no migration — the ordering the whole plan depends on.
    expect(files.filter(f => f.startsWith('055'))).toEqual(['055_restrict_lesson_media_columns.sql'])
    expect(read('supabase/migrations/055_restrict_lesson_media_columns.sql'))
      .toMatch(/ONLY while the WC-2B application release is live/)
  })

  it('no migration, grant or policy changed in this release', () => {
    const m = read('supabase/migrations/054_lesson_media_derived_source.sql')
    expect(m).toMatch(/ADDITIVE ONLY/)
    expect(m).toMatch(/055\s+\(later\)\s+restrict SELECT on the six raw columns/)
  })

  it('the set of lesson columns the browser needs is a subset of what survives 055', () => {
    const needed = new Set(playerSelects[0])
    for (const c of needed) expect(ALLOWED_AFTER_055, `${c} does not survive 055`).toContain(c)
    for (const c of RAW) expect(needed.has(c), `${c} is still needed by the browser`).toBe(false)
  })
})
