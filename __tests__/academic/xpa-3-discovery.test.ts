// @vitest-environment node
/**
 * XPA-3 — public discovery experience.
 *
 * The highest-value assertions here are the DISCLOSURE ones. XPA-2 closed an
 * accidental public-read policy that had exposed the whole roadmap; XPA-3
 * deliberately re-opens a narrow projection, so the tests must prove the
 * projection is actually narrow — not merely that the pages render.
 *
 * Migrations are operator-applied, so the migration file is the artefact under
 * review, alongside the reader and page source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
}

/**
 * Strip TS/TSX comments before asserting on code.
 *
 * These files DOCUMENT the disclosure rules ("no unavailable counts", "never
 * copies pedagogical content"), so scanning raw text flags the explanation as
 * if it were the violation. Assertions must run against executable code.
 * `://` is preserved so URLs are not mangled.
 */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const PROJECTION_RAW = read('supabase/migrations/031_public_discovery_projection.sql')
const PROJECTION     = stripSqlComments(PROJECTION_RAW)
const READER_RAW     = read('lib/queries/catalogue.ts')
const READER         = stripTsComments(READER_RAW)

/** Roadmap codes with no produced course — must never appear publicly. */
const UNPRODUCED = ['C2-F3', 'C2-F5', 'C2-F6', 'C3-F1', 'C3-F2', 'C3-F3', 'C3-F4', 'C3-F5', 'C3-F6', 'C3-F7', 'C3-F8']

// ── The security boundary ───────────────────────────────────────────────────

describe('XPA-3 — internal registry stays private', () => {
  it('adds NO public policy to the four registry tables', () => {
    expect(PROJECTION).not.toMatch(/using\s*\(\s*true\s*\)/i)
    for (const t of ['catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']) {
      expect(PROJECTION).not.toMatch(new RegExp(`create policy[\\s\\S]{0,120}on public\\.${t}\\b`, 'i'))
    }
  })

  it('explicitly revokes anon access to the base tables', () => {
    for (const t of ['catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']) {
      expect(PROJECTION).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from anon`, 'i'))
    }
  })

  it('grants read only on the three projection views', () => {
    const grants = [...PROJECTION.matchAll(/grant select on public\.(\w+)\s+to anon/gi)].map(m => m[1])
    expect(grants.sort()).toEqual(['public_catalogues', 'public_learning_paths', 'public_path_courses'])
    expect(PROJECTION).not.toMatch(/grant\s+(insert|update|delete|all)\s+on public\.public_/i)
  })

  it('alters no table, policy or trigger', () => {
    expect(PROJECTION).not.toMatch(/alter table/i)
    expect(PROJECTION).not.toMatch(/drop (table|policy|trigger|column)/i)
    expect(PROJECTION).not.toMatch(/create (trigger|policy)/i)
  })

  it('the public reader never uses the service-role client', () => {
    expect(READER).not.toMatch(/createAdminClient|SERVICE_ROLE/)
    // Cookie-less ANON client: works at build time (sitemap) and stays subject
    // to the anon grants, which exclude the registry tables entirely.
    expect(READER).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/)
    expect(READER).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('the public reader never queries the registry tables directly', () => {
    for (const t of ['catalogues', 'course_codes', 'learning_paths', 'learning_path_courses']) {
      // Only the public_* views may be named.
      expect(READER).not.toMatch(new RegExp(`from\\('${t}'\\)`))
    }
    const tables = [...READER.matchAll(/\.from\('(\w+)'\)/g)].map(m => m[1])
    for (const t of tables) {
      expect(['public_catalogues', 'public_learning_paths', 'public_path_courses', 'courses']).toContain(t)
    }
  })

  it('no public page queries the registry tables', () => {
    let hits = ''
    try {
      hits = execFileSync(
        'git',
        ['grep', '-n', '-e', "from('course_codes')", '-e', "from('learning_paths')",
         '-e', "from('learning_path_courses')", '-e', "from('catalogues')",
         '--', 'app/(public)', 'components'],
        { cwd: ROOT, encoding: 'utf8' }
      ).trim()
    } catch { hits = '' }
    expect(hits).toBe('')
  }, 15_000)
})

// ── Q-E disclosure rules ────────────────────────────────────────────────────

describe('XPA-3 — Q-E: no roadmap, status or unavailable counts', () => {
  it('the projection never selects status', () => {
    expect(PROJECTION).not.toMatch(/\bstatus\b/)
  })

  it('the projection never selects internal notes or canonical titles', () => {
    expect(PROJECTION).not.toMatch(/\bp\.note\b/)
    expect(PROJECTION).not.toMatch(/canonical_title/)
    expect(PROJECTION).not.toMatch(/\btargets\b/)
  })

  it('every projection view requires a PUBLISHED course', () => {
    // Each of the three views constrains on is_published = true.
    const publishedFilters = PROJECTION.match(/is_published\s*=\s*true/g) ?? []
    expect(publishedFilters.length).toBeGreaterThanOrEqual(3)
  })

  it('public ordering is re-ranked so gaps cannot reveal hidden courses', () => {
    expect(PROJECTION).toMatch(/row_number\(\)\s*over/i)
    expect(PROJECTION).toMatch(/partition by\s+lpc\.path_code/i)
  })

  it('paths and catalogues with zero published courses are excluded', () => {
    const views = PROJECTION.split('create or replace view').slice(1)
    expect(views).toHaveLength(3)
    // The catalogue and path views both gate on an EXISTS over published courses.
    expect(views[0]).toMatch(/where exists/i)
    expect(views[1]).toMatch(/where exists/i)
  })

  it('the reader exposes no planned total anywhere', () => {
    expect(READER).not.toMatch(/planned|totalCourses|plannedTotal|unavailable/i)
  })

  it('PathCard has no prop for a planned total, so "N of M" cannot be rendered', () => {
    const card = read('components/courses/PathCard.tsx')
    expect(card).toMatch(/availableCount/)
    expect(card).not.toMatch(/plannedCount|totalCount|of\s*\{/)
    expect(card).toMatch(/formation\{.*\} disponible/)
  })

  it('no public component renders an "N / M" availability fraction', () => {
    for (const f of ['components/courses/PathCard.tsx', 'components/courses/PathDetail.tsx', 'components/courses/PathIndex.tsx']) {
      const src = read(f)
      expect(src, `${f} renders a fraction`).not.toMatch(/\{\s*\w+\s*\}\s*\/\s*\{\s*\w+\s*\}/)
    }
  })

  it('no unproduced course code appears in any public source file', () => {
    const publicSources = [
      'lib/queries/catalogue.ts',
      'components/courses/PathCard.tsx',
      'components/courses/PathDetail.tsx',
      'components/courses/PathIndex.tsx',
      'app/(public)/courses/page.tsx',
      'app/(public)/parcours/page.tsx',
      'app/(public)/secteurs/page.tsx',
    ].map(read).join('\n')

    for (const code of UNPRODUCED) {
      expect(publicSources, `${code} hardcoded in public source`).not.toContain(code)
    }
  })

  it('the admin catalogue page still shows the COMPLETE internal matrix', () => {
    const admin = read('app/(admin)/admin/catalogue/page.tsx')
    expect(admin).toMatch(/requirePlatformAdmin/)
    expect(admin).toMatch(/from\('course_codes'\)/)
    expect(admin).toMatch(/Formations codifiées sans contenu/)
    expect(admin).toMatch(/status/)   // admin may show backlog/undecided
  })
})

// ── Routes and separation ───────────────────────────────────────────────────

describe('XPA-3 — route structure (Q-F)', () => {
  it('professional and sector axes are separate routes', () => {
    expect(() => read('app/(public)/parcours/page.tsx')).not.toThrow()
    expect(() => read('app/(public)/secteurs/page.tsx')).not.toThrow()
    expect(() => read('app/(public)/parcours/[code]/page.tsx')).not.toThrow()
    expect(() => read('app/(public)/secteurs/[code]/page.tsx')).not.toThrow()
  })

  it('each axis filters to its own kind', () => {
    expect(read('app/(public)/parcours/page.tsx')).toMatch(/kind="professional"/)
    expect(read('app/(public)/secteurs/page.tsx')).toMatch(/kind="sector"/)
  })

  it('a path requested under the wrong axis 404s rather than leaking existence', () => {
    const detail = read('components/courses/PathDetail.tsx')
    expect(detail).toMatch(/path\.kind !== kind/)
    expect(detail).toMatch(/notFound\(\)/)
  })

  it('a path with zero published courses 404s', () => {
    expect(read('components/courses/PathDetail.tsx')).toMatch(/courses\.length === 0\) notFound\(\)/)
  })

  it('course detail pages remain canonical — paths link out, never duplicate', () => {
    const detail = stripTsComments(read('components/courses/PathDetail.tsx'))
    expect(detail).toMatch(/href=\{`\/courses\/\$\{c\.slug\}`\}/)
    // No copied pedagogical body content: a path may show title, short
    // description, level and duration — never lesson or module material.
    expect(detail).not.toMatch(/\blessons\b|\bmodules\b|\.content\b/)
  })
})

// ── /courses ────────────────────────────────────────────────────────────────

describe('XPA-3 — /courses shows published courses only', () => {
  const page = read('app/(public)/courses/page.tsx')

  it('no longer pads with static placeholder cards', () => {
    expect(page).not.toMatch(/MIN_CARDS_PER_PARCOURS/)
    expect(page).not.toMatch(/STATIC_CATALOG/)
    expect(page).not.toMatch(/available:\s*false/)
  })

  it('groups by catalogue code, not by title heuristics', () => {
    expect(page).toMatch(/CATALOGUE_TO_PARCOURS/)
    expect(page).toMatch(/getPublishedCoursesByCatalogue/)
    expect(page).not.toMatch(/isSameCourse|tokens\(/)
  })

  it('marks every rendered course as available', () => {
    expect(page).toMatch(/available:\s*true/)
  })
})

// ── SEO ─────────────────────────────────────────────────────────────────────

describe('XPA-3 — SEO', () => {
  const sitemap = read('app/sitemap.ts')

  it('sitemap includes the two index routes', () => {
    expect(sitemap).toMatch(/'\/parcours'/)
    expect(sitemap).toMatch(/'\/secteurs'/)
  })

  it('sitemap lists only paths that actually render', () => {
    // Membership in public_learning_paths IS the guarantee: the view excludes
    // paths with no published course, so no per-path query is needed.
    expect(sitemap).toMatch(/getPublicPaths\('professional'\)/)
    expect(sitemap).toMatch(/getPublicPaths\('sector'\)/)
    expect(sitemap).not.toMatch(/getPublicPathCourses/)
  })

  it('sitemap never lists private routes', () => {
    for (const p of ['/admin', '/dashboard', '/login', '/learn']) {
      expect(sitemap).not.toContain(`'${p}'`)
    }
  })

  it('path detail marks non-renderable paths noindex', () => {
    for (const f of ['app/(public)/parcours/[code]/page.tsx', 'app/(public)/secteurs/[code]/page.tsx']) {
      expect(read(f)).toMatch(/robots: \{ index: false, follow: false \}/)
    }
  })

  it('index and detail routes declare canonical URLs', () => {
    expect(read('app/(public)/parcours/page.tsx')).toMatch(/alternates: \{ canonical: '\/parcours' \}/)
    expect(read('app/(public)/secteurs/page.tsx')).toMatch(/alternates: \{ canonical: '\/secteurs' \}/)
    expect(read('app/(public)/parcours/[code]/page.tsx')).toMatch(/alternates:/)
  })
})

// ── Navigation & accessibility ──────────────────────────────────────────────

describe('XPA-3 — navigation', () => {
  const header = read('components/layout/Header.tsx')

  it('exposes all three entry points', () => {
    expect(header).toMatch(/href: '\/courses',\s*label: 'Formations'/)
    expect(header).toMatch(/href: '\/parcours'/)
    expect(header).toMatch(/href: '\/secteurs'/)
  })

  it('renders them in BOTH desktop and mobile navigation', () => {
    const occurrences = (header.match(/ROUTE_LINKS\.map/g) ?? []).length
    expect(occurrences).toBe(2)
  })

  it('mobile menu closes on navigation', () => {
    expect(header).toMatch(/onClick=\{\(\) => setMenuOpen\(false\)\}/)
  })

  it('path pages use semantic ordered lists and hide decorative icons', () => {
    const detail = read('components/courses/PathDetail.tsx')
    expect(detail).toMatch(/<ol/)
    expect(detail).toMatch(/aria-hidden/)
  })
})

// ── C1-F1 ordering ──────────────────────────────────────────────────────────

describe('XPA-3 — C1-F1 ordering preserved', () => {
  it('public ordering derives from the stored position, not an ad-hoc sort', () => {
    // row_number() over (order by lpc.position) preserves C1-F1's first place
    // whenever it is published and linked.
    expect(PROJECTION).toMatch(/order by\s+lpc\.position/i)
    expect(READER).toMatch(/\.order\('position'\)/)
  })

  it('the reader preserves view ordering when joining course content', () => {
    // Behavioural: the reader maps over the ORDERED view rows and looks each
    // course up, rather than iterating the unordered courses result.
    expect(READER).toMatch(/rows\s*\n?\s*\.map\(r =>/)
    expect(READER).toMatch(/byCode\.get\(r\.course_code\)/)
  })
})
