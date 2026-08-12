// @vitest-environment node
/**
 * UAT-ROUTE-02 — "Commencer gratuitement" did nothing.
 *
 * The live page rendered:
 *
 *   <a href="/courses/les-fondamentaux-de-l-experience-client">Commencer gratuitement</a>
 *
 * a link to the page it was already on. Clicking navigated to the current URL,
 * so nothing appeared to happen.
 *
 * ── HOW IT GOT THERE ──────────────────────────────────────────────────────
 *
 * The page loaded `modules` / `lessons` with the LEARNER'S session client.
 * XPA-6A/6B/6D correctly hide those from anyone without an entitlement, so an
 * anonymous visitor got zero rows: "0 modules · 0 leçons", no resolvable first
 * lesson, and `learnEntryHref` degraded — correctly — to the course page.
 *
 * UAT-ROUTE-01 changed the SYMPTOM (a malformed `/undefined/undefined` link
 * became a safe self-link) but did not cause the defect. The page was reading
 * PROTECTED learner content to render PUBLIC catalogue metadata, and that was
 * true before either fix.
 *
 * Two invariants come out of it:
 *
 *   1. A rendered primary CTA always has a destination that is not the current
 *      page. "Fail safe" must not mean "fail inert".
 *   2. Public catalogue metadata comes from a public projection, never from a
 *      protected table the visitor cannot read.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { learnEntryHref, coursePageHref } from '@/lib/learn/routes'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)

const PAGE = 'app/(public)/courses/[slug]/page.tsx'
const MIGRATION = 'supabase/migrations/039_public_course_structure.sql'

const COURSE = 'les-fondamentaux-de-l-experience-client'
const FORBIDDEN_LESSON_COLUMNS = ['content', 'video_url', 'subtitle_url', 'pdf_url']

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-02 — the primary CTA must never render inert', () => {
  it('UAT-ROUTE-02: a self-link is the failure mode, and the page guards against it', () => {
    const src = stripTs(read(PAGE))
    // The belt-and-braces guard: whatever the branches produced, a destination
    // equal to the current course page is replaced by the access flow.
    expect(src).toMatch(/===\s*coursePageHref\(slug\)\s*\?\s*accessRequestHref/)
  })

  it('UAT-ROUTE-02: the degraded route IS the current page — which is why the guard exists', () => {
    // This is the mechanism, asserted directly rather than described.
    expect(learnEntryHref(COURSE, [])).toBe(coursePageHref(COURSE))
    // ...so a CTA that used the degraded route unguarded would link to itself.
  })

  it('UAT-ROUTE-02: the access-request destination is never the course page', () => {
    // /login, /signup and /checkout are all off-page by construction.
    for (const href of ['/login?next=%2Fx', '/signup', '/checkout?course=abc']) {
      expect(href).not.toBe(coursePageHref(COURSE))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE DATA BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-02 public catalogue metadata', () => {
  it('the page reads course structure from the public projection', () => {
    const src = stripTs(read(PAGE))
    expect(src).toContain('public_course_modules')
    expect(src).toContain('public_course_lessons')
  })

  it('the page no longer reads the protected modules/lessons tables for structure', () => {
    const src = stripTs(read(PAGE))
    // The exact protected read that produced 0 modules / 0 leçons.
    expect(src).not.toMatch(/\.from\(['"`]modules['"`]\)/)
    expect(src).not.toMatch(/lessons\s*\(\s*\*\s*\)/)
  })

  it('migration 039 defines both projections', () => {
    const sql = stripSql(read(MIGRATION))
    expect(sql).toMatch(/create or replace view public\.public_course_modules/i)
    expect(sql).toMatch(/create or replace view public\.public_course_lessons/i)
  })

  it('the lesson projection cannot return a body, video, subtitle or pdf', () => {
    const sql = stripSql(read(MIGRATION))
    const view = sql.split(/create or replace view public\.public_course_lessons/i)[1] ?? ''
    const selectList = view.split(/\bfrom\b/i)[0] ?? ''
    for (const col of FORBIDDEN_LESSON_COLUMNS) {
      expect(selectList, `public_course_lessons selects ${col}`).not.toContain(col)
    }
  })

  it('039 revokes before granting, and grants SELECT only (D-GRANT)', () => {
    const sql = stripSql(read(MIGRATION))
    const revokeAt = sql.search(/revoke all on public\.public_course_modules/i)
    const grantAt  = sql.search(/grant select on public\.public_course_modules/i)
    expect(revokeAt, 'no revoke on the new view').toBeGreaterThan(-1)
    expect(grantAt, 'no grant on the new view').toBeGreaterThan(-1)
    expect(revokeAt, 'grant precedes revoke — the view keeps its default ALL').toBeLessThan(grantAt)
    // A view is born holding GRANT ALL; migration 034 shipped a writable one.
    expect(sql).not.toMatch(/grant all on public\.public_course_/i)
  })

  it('039 asserts the base tables were not widened', () => {
    const sql = stripSql(read(MIGRATION))
    expect(sql).toMatch(/READ lesson bodies directly/i)
    expect(sql).toMatch(/XPA-6D regression/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE PROBE MUST TELL A LEAK FROM AN EMPTY RESULT
//
// The first 039 asserted that anon reading `lessons.content` must not be
// "ALLOWED", where ALLOWED meant only "the statement did not error". A SELECT
// returning zero rows does not error, so a correctly-configured database failed
// the migration — DENIED_EMPTY scored as ALLOWED. Measured against production:
// anon and authenticated-unentitled both get 200 / 0 rows on content,
// video_url, subtitle_url and pdf_url; service_role gets 82.
//
// `lessons` is protected by ROW-level security; `quiz_questions.correct_answer`
// by COLUMN PRIVILEGE. The two have different correct answers and a probe that
// cannot distinguish them is not a security check.
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-02 probe classification', () => {
  const sql = () => stripSql(read(MIGRATION))

  it('the read probe counts rows rather than merely running the statement', () => {
    expect(sql()).toMatch(/select count\(\*\) from \(/i)
    expect(sql()).toMatch(/ALLOWED_WITH_ROWS/)
    expect(sql()).toMatch(/DENIED_EMPTY/)
  })

  it('only rows coming back counts as a lesson-body leak', () => {
    const s = sql()
    expect(s).toMatch(/if v = 'ALLOWED_WITH_ROWS' then[\s\S]{0,160}READ lesson bodies/i)
    // DENIED_EMPTY is the ratified posture for `lessons` and must pass.
    expect(s).toMatch(/not in \('DENIED_EMPTY', 'REFUSED_BY_PRIVILEGE'\)/)
  })

  it('the answer-key check still demands a hard privilege refusal, not emptiness', () => {
    const s = sql()
    expect(s).toMatch(/correct_answer[\s\S]{0,240}<>\s*'REFUSED_BY_PRIVILEGE'/)
  })

  it('write probes keep error-shaped semantics — for a write, running IS the failure', () => {
    const s = sql()
    expect(s).toMatch(/uat2_write_probe/)
    expect(s).toMatch(/uat2_write_probe\(r, col\)[\s\S]{0,120}if v = 'ALLOWED'/)
  })

  it('both probe helpers are dropped at the end', () => {
    const s = sql()
    expect(s).toMatch(/drop function if exists public\.uat2_probe/)
    expect(s).toMatch(/drop function if exists public\.uat2_write_probe/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// COPY MUST MATCH THE ACCESS MODEL
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-02 access copy', () => {
  it('the page no longer claims that no account is required', () => {
    // Comments may discuss the old string; rendered copy may not contain it.
    const rendered = stripTs(read(PAGE))
    expect(rendered).not.toContain('Aucun compte requis')
  })

  it('the CTA label is derived from actual access, not from PLATFORM_MODE alone', () => {
    const src = stripTs(read(PAGE))
    expect(src).toContain('ctaAccess.allowed')
    // "Commencer gratuitement" must not be reachable while access is refused.
    expect(src).not.toContain('Commencer gratuitement')
  })

  it('CTA membership is decided by the ratified seam, not by enrollments', () => {
    const src = stripTs(read(PAGE))
    expect(src).toContain('resolveCourseAccess')
    // The CTA branch must key off ctaAccess, not the stale isEnrolled boolean.
    expect(src).toMatch(/ctaAccess\.allowed\s*\n?\s*\?/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UAT-ROUTE-01 MUST SURVIVE
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-02 preserves UAT-ROUTE-01', () => {
  it('the canonical route helper is still used and not bypassed', () => {
    const src = stripTs(read(PAGE))
    expect(src).toContain('learnEntryHref')
    for (const m of src.matchAll(/`\/learn\/[^`]*`/g)) {
      for (const interp of m[0].matchAll(/\$\{([^}]*)\}/g)) {
        expect(interp[1], `optional-chained /learn/ segment: ${m[0]}`).not.toContain('?.')
      }
    }
  })

  it('lessonHref fail-safe behaviour is unchanged', () => {
    expect(learnEntryHref(COURSE, [])).toBe(coursePageHref(COURSE))
    expect(learnEntryHref(COURSE, [{ id: 'm', slug: 'm', lessons: [{ id: 'l', slug: 'l' }] }]))
      .toBe(`/learn/${COURSE}/m/l`)
    expect(learnEntryHref(COURSE, null)).not.toContain('undefined')
  })
})
