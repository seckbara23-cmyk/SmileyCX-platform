// @vitest-environment node
/**
 * XPA-8 B-2B — publication safety.
 *
 * ── WHAT UNPUBLISHING IS FOR ──────────────────────────────────────────────
 *
 * `courses.is_published = false` is the platform's only withdrawal mechanism.
 * C2-F2 was withdrawn because 10 of its 20 lessons are placeholders and cannot
 * be completed, so it advertised a journey it could not deliver.
 *
 * ── THE DEFECT B-2B FOUND ─────────────────────────────────────────────────
 *
 * Unpublishing worked everywhere the data is read live, and NOT on the one page
 * that matters most. Measured in production immediately after the flip:
 *
 *   /courses/mesurer-l-experience-client   404   ← dynamic route, correct
 *   /courses                               200   ← still shipped the course in
 *                                                  its payload as available:true
 *
 * `/courses` had no revalidation, so Next prerendered it at build time and kept
 * serving that HTML. The catalogue was advertising a course that 404s on click,
 * and would have kept doing so until somebody happened to redeploy.
 *
 * A withdrawal that depends on remembering to redeploy is not a withdrawal.
 *
 * ── THE RATIFIED CONTRACT THIS MUST NOT BREAK ─────────────────────────────
 *
 * Migrations 035 and 037 state it in as many words:
 *
 *     publication controls DISCOVERY, never ACCESS
 *
 * `has_course_access()` has no `is_published` arm and must never grow one.
 * Unpublishing removes a course from the shop window; it does not confiscate
 * what an entitled learner already holds.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel: string) => existsSync(join(ROOT, rel))
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)

const CATALOGUE = 'app/(public)/courses/page.tsx'

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION — WITHDRAWAL MUST TAKE EFFECT
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2B — unpublishing actually withdraws a course', () => {
  it('B-2B: the catalogue is not frozen at build time', () => {
    const raw = read(CATALOGUE)
    expect(raw, 'the catalogue has no revalidation and will serve stale HTML')
      .toMatch(/export const revalidate\s*=\s*\d+/)
    const secs = Number(/export const revalidate\s*=\s*(\d+)/.exec(raw)?.[1])
    expect(secs, 'revalidate must be finite and bounded').toBeGreaterThan(0)
    expect(secs, 'a withdrawal should not take more than five minutes to show')
      .toBeLessThanOrEqual(300)
  })

  it('B-2B: the reason is recorded next to the number', () => {
    expect(read(CATALOGUE)).toMatch(/PUBLICATION MUST ACTUALLY TAKE EFFECT/)
  })

  it('the catalogue reads published courses from the database, not a hardcoded list', () => {
    const s = stripTs(read(CATALOGUE))
    expect(s).toContain('getPublishedCoursesByCatalogue')
    // `available: true` is only safe because unpublished rows never arrive.
    expect(s).toMatch(/available:\s*true/)
  })

  it('the query filters on is_published', () => {
    expect(stripTs(read('lib/queries/catalogue.ts'))).toMatch(/\.eq\('is_published',\s*true\)/)
  })

  it('the course detail route refuses an unpublished course', () => {
    expect(stripTs(read('app/(public)/courses/[slug]/page.tsx')))
      .toMatch(/\.eq\('is_published',\s*true\)/)
  })

  it('the sitemap does not enumerate individual courses', () => {
    // A stale sitemap would keep pointing crawlers at a 404.
    const s = stripTs(read('app/sitemap.ts'))
    expect(s).not.toMatch(/from\('courses'\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PUBLICATION ≠ ACCESS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2B keeps discovery and access separate', () => {
  it('has_course_access() has no is_published arm', () => {
    // Stated in 035 and 037 and asserted here so it cannot drift.
    const m037 = read('supabase/migrations/037_entitlements.sql')
    const fn = m037.slice(m037.indexOf('function public.has_course_access'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    expect(body, 'publication leaked into the access seam').not.toContain('is_published')
  })

  it('the contract is written down in the migrations', () => {
    for (const f of ['035_learner_identity_and_access.sql', '037_entitlements.sql']) {
      expect(read(`supabase/migrations/${f}`)).toMatch(/publication controls DISCOVERY, never ACCESS/)
    }
  })

  it('the entitlement seam in TypeScript never consults publication', () => {
    const seam = stripTs(read('lib/auth/course-access.ts'))
    expect(seam, 'resolveCourseAccessById consults is_published').not.toContain('is_published')
  })

  it('the protected media route never consults publication', () => {
    const route = stripTs(read('app/api/media/lesson/[lessonId]/[kind]/route.ts'))
    expect(route).not.toContain('is_published')
  })

  it('unpublishing does not revoke entitlements or enrollments', () => {
    // Nothing anywhere may cascade a publication change into access records.
    for (const f of ['app/(admin)/admin/courses/[id]/edit/actions.ts',
                     'app/(admin)/admin/courses/new/actions.ts']) {
      const s = stripTs(read(f))
      expect(s, `${f} touches entitlements when publishing`).not.toContain('entitlements')
      expect(s, `${f} touches enrollments when publishing`).not.toContain('enrollments')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// WHAT AN UNPUBLISHED COURSE STILL OWES ITS ADMINISTRATORS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2B admin surfaces', () => {
  it('an unpublished course stays visible and editable in admin', () => {
    // courses_public_select is `is_published = true OR is_platform_admin()`,
    // so the portal keeps the row.
    const m001 = read('supabase/migrations/001_phase_a_rls_fix.sql')
    expect(m001).toMatch(/USING \(is_published = true OR is_platform_admin\(\)\)/)
    const list = stripTs(read('app/(admin)/admin/courses/page.tsx'))
    expect(list).toMatch(/is_published \? 'Publié' : 'Brouillon'/)
  })

  it('an unpublished course cannot be granted as a NEW entitlement', () => {
    // The grant form only offers published courses, so withdrawal also stops
    // new sales without touching anyone who already holds access.
    expect(stripTs(read('app/(admin)/admin/entitlements/page.tsx')))
      .toMatch(/\.eq\('is_published',\s*true\)/)
  })

  it('publication remains a single boolean an administrator can reverse', () => {
    const edit = stripTs(read('app/(admin)/admin/courses/[id]/edit/actions.ts'))
    expect(edit).toMatch(/is_published = formData\.get\('is_published'\) === 'on'/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING ELSE MOVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2B stayed in its lane', () => {
  it('no migration was added', () => {
    // B-2B is a data change plus one revalidate line. If it ever needs a
    // migration, that is a different decision.
    expect(has('supabase/migrations/044_unpublish_c2f2.sql')).toBe(false)
  })

  it('no lesson, assessment, completion or voice logic was touched', () => {
    const player = stripTs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))
    expect(player).toContain('markComplete')
    expect(player).toContain('my_course_access')
    const m043 = has('supabase/migrations/043_clear_unintended_preview_flags.sql')
      ? read('supabase/migrations/043_clear_unintended_preview_flags.sql') : ''
    expect(stripSql(m043)).not.toMatch(/is_published/)
  })

  it('F-1 and F-2 remain intact', () => {
    expect(stripTs(read('lib/media/storage.ts'))).toContain('SIGNED_URL_TTL_SECONDS')
    expect(read('scripts/security/verify-xpa-6a.mjs')).toContain('no course is flagged preview WHOLESALE')
  })
})
