// @vitest-environment node
/**
 * UAT-ROUTE-01 — malformed learning routes.
 *
 * Production generated:
 *
 *   /learn/les-fondamentaux-de-l-experience-client/undefined/undefined
 *
 * `app/(public)/courses/[slug]/page.tsx` built its CTA from
 * `modules[0]?.slug` and `modules[0]?.lessons?.[0]?.slug`. `modules` is read
 * with the LEARNER'S session, so RLS empties it for anyone without an
 * entitlement; optional chaining then yields `undefined`, and a template
 * literal stringifies that to the seven characters "undefined".
 *
 * The route was malformed for precisely the users about to be denied — which is
 * why the denial screen and the broken URL appeared together.
 *
 * The invariant: no application-generated learning URL may contain `undefined`,
 * `null`, or an empty segment. Where a concrete lesson is required, resolve one;
 * otherwise fail safely to a course-level destination.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isRouteSegment,
  lessonHref,
  moduleQuizHref,
  finalExamHref,
  firstLessonHref,
  learnEntryHref,
  coursePageHref,
} from '@/lib/learn/routes'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const COURSE = 'les-fondamentaux-de-l-experience-client'

/** The exact production shape: a course whose modules were emptied by RLS. */
const RLS_EMPTIED: never[] = []

const REAL_MODULES = [
  { id: 'm1', slug: 'comprendre-cx', lessons: [{ id: 'l1', slug: 'introduction' }] },
]

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION — must never be deleted or renamed
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-01 — /learn/<course>/undefined/undefined must never be generated', () => {
  it('UAT-ROUTE-01: an RLS-emptied module list yields the course page, not a malformed route', () => {
    const href = learnEntryHref(COURSE, RLS_EMPTIED)
    expect(href).not.toContain('undefined')
    expect(href).toBe(`/courses/${COURSE}`)
  })

  it('UAT-ROUTE-01: reproduces the old expression and proves the new one differs', () => {
    const modules: { slug?: string; lessons?: { slug?: string }[] }[] = RLS_EMPTIED
    // Exactly what the page used to do:
    const old = `/learn/${COURSE}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
    expect(old).toBe(`/learn/${COURSE}/undefined/undefined`) // the production defect
    expect(learnEntryHref(COURSE, modules)).not.toBe(old)
  })

  it('UAT-ROUTE-01: no source file interpolates an optional-chained segment into a /learn/ URL', () => {
    const files = [
      'app/(public)/courses/[slug]/page.tsx',
      'app/(platform)/dashboard/page.tsx',
      'app/(platform)/checkout/page.tsx',
      'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx',
      'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx',
      'app/(learn)/learn/[courseSlug]/final-exam/page.tsx',
      'app/(learn)/learn/[courseSlug]/layout.tsx',
      'components/lms/LessonNavigation.tsx',
      'components/lms/LessonSidebar.tsx',
    ]
    const offenders: string[] = []
    for (const file of files) {
      const src = stripTs(read(file))
      // Every `/learn/...` template literal in the file.
      for (const m of src.matchAll(/`\/learn\/[^`]*`/g)) {
        // An interpolation containing `?.` can evaluate to undefined.
        for (const interp of m[0].matchAll(/\$\{([^}]*)\}/g)) {
          if (interp[1].includes('?.')) offenders.push(`${file}: ${m[0].trim()}`)
        }
      }
    }
    expect(offenders, `optional-chained /learn/ segments:\n${offenders.join('\n')}`).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SEGMENT INVARIANT
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-01 segment validation', () => {
  it('rejects the values that produced the defect', () => {
    for (const bad of [undefined, null, '', '   ', 'undefined', 'null', 42, {}, []]) {
      expect(isRouteSegment(bad), String(bad)).toBe(false)
    }
  })

  it('accepts real ids and slugs', () => {
    for (const good of ['comprendre-cx', 'introduction', 'debc2117-dc55-4b6f-98d7-280da12c2505']) {
      expect(isRouteSegment(good), good).toBe(true)
    }
  })

  it('lessonHref returns null rather than a best-effort string', () => {
    expect(lessonHref(COURSE, null, null)).toBeNull()
    expect(lessonHref(COURSE, { id: 'm1' }, null)).toBeNull()
    expect(lessonHref(COURSE, null, { id: 'l1' })).toBeNull()
    expect(lessonHref('', { id: 'm1' }, { id: 'l1' })).toBeNull()
    // Already-stringified undefined must not slip through.
    expect(lessonHref(COURSE, 'undefined', 'undefined')).toBeNull()
    expect(lessonHref(COURSE, { id: null, slug: null }, { id: 'l1' })).toBeNull()
  })

  it('lessonHref builds a valid URL from ids or slugs, preferring slugs', () => {
    expect(lessonHref(COURSE, { id: 'm1', slug: 'mod' }, { id: 'l1', slug: 'les' }))
      .toBe(`/learn/${COURSE}/mod/les`)
    expect(lessonHref(COURSE, { id: 'm1' }, { id: 'l1' }))
      .toBe(`/learn/${COURSE}/m1/l1`)
  })

  it('moduleQuizHref and finalExamHref hold the same invariant', () => {
    expect(moduleQuizHref(COURSE, null)).toBeNull()
    expect(moduleQuizHref(COURSE, 'undefined')).toBeNull()
    expect(moduleQuizHref(COURSE, { id: 'm1' })).toBe(`/learn/${COURSE}/m1/quiz`)
    expect(finalExamHref('')).toBeNull()
    expect(finalExamHref(COURSE)).toBe(`/learn/${COURSE}/final-exam`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION AND SAFE FALLBACK
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-01 lesson resolution', () => {
  it('course navigation resolves a valid module and lesson', () => {
    expect(firstLessonHref(COURSE, REAL_MODULES)).toBe(`/learn/${COURSE}/comprendre-cx/introduction`)
    expect(learnEntryHref(COURSE, REAL_MODULES)).toBe(`/learn/${COURSE}/comprendre-cx/introduction`)
  })

  it('skips an empty leading module instead of assuming modules[0] has lessons', () => {
    const modules = [
      { id: 'm0', slug: 'empty', lessons: [] },
      { id: 'm1', slug: 'second', lessons: [{ id: 'l9', slug: 'first-real' }] },
    ]
    expect(firstLessonHref(COURSE, modules)).toBe(`/learn/${COURSE}/second/first-real`)
  })

  it('fails safely to a course-level destination when nothing resolves', () => {
    expect(firstLessonHref(COURSE, [])).toBeNull()
    expect(firstLessonHref(COURSE, [{ id: 'm0', lessons: [] }])).toBeNull()
    expect(learnEntryHref(COURSE, [])).toBe(coursePageHref(COURSE))
    expect(learnEntryHref(COURSE, null)).toBe(coursePageHref(COURSE))
  })

  it('resume/continue: a valid preferred URL wins, a malformed one is discarded', () => {
    const resume = `/learn/${COURSE}/m2/l7`
    expect(learnEntryHref(COURSE, REAL_MODULES, resume)).toBe(resume)
    // A caller that already built a broken continue-URL must not have it honoured.
    expect(learnEntryHref(COURSE, REAL_MODULES, `/learn/${COURSE}/undefined/undefined`))
      .toBe(`/learn/${COURSE}/comprendre-cx/introduction`)
    expect(learnEntryHref(COURSE, [], `/learn/${COURSE}/undefined/undefined`))
      .toBe(coursePageHref(COURSE))
  })

  it('never emits a URL containing undefined or null, across a matrix of broken inputs', () => {
    const refs = [null, undefined, {}, { id: null }, { slug: '' }, { id: 'undefined' }, { slug: 'null' }]
    for (const m of refs) {
      for (const l of refs) {
        const href = lessonHref(COURSE, m as never, l as never)
        expect(href).toBeNull()
      }
      expect(learnEntryHref(COURSE, [{ ...(m as object), lessons: [] }])).not.toMatch(/undefined|null/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ENTITLEMENT GATE AND THE DENIED-STATE CTA
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ROUTE-01 denied state', () => {
  const LAYOUT = 'app/(learn)/learn/[courseSlug]/layout.tsx'

  it('access-denied users are sent to a valid non-protected destination', () => {
    const src = stripTs(read(LAYOUT))
    expect(src).toContain('coursePageHref')
    // No CTA on the denial screen may point into the gated area.
    for (const m of src.matchAll(/href=\{?['"`]([^'"`}]+)/g)) {
      expect(m[1].startsWith('/learn/'), `denial CTA points at ${m[1]}`).toBe(false)
    }
  })

  it('the CTA no longer repeats the label that led the learner here', () => {
    const src = read(LAYOUT)
    expect(src).not.toContain('Voir la formation <ArrowRight')
    expect(src).toContain('Retour à la fiche de formation')
  })

  it('the gate still renders children only when access is allowed', () => {
    const src = stripTs(read(LAYOUT))
    expect(src).toMatch(/if\s*\(\s*access\.allowed\s*\)\s*return\s*<>\{children\}<\/>/)
    // Unauthenticated callers are redirected, never rendered through.
    expect(src).toContain("access.reason === 'not_authenticated'")
    expect(src).toContain('redirect(')
  })

  it('the gate is not weakened — access still comes from resolveCourseAccess', () => {
    const src = stripTs(read(LAYOUT))
    expect(src).toContain('resolveCourseAccess')
    expect(src).not.toMatch(/allowed\s*=\s*true/)
    expect(src).not.toContain('PILOT_MODE')
    expect(src).not.toContain('FREE_ACCESS_MODE')
  })
})

describe('UAT-ROUTE-01 malformed URL entered manually', () => {
  const PLAYER = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'

  it('the player degrades to a real lesson instead of throwing', () => {
    const src = stripTs(read(PLAYER))
    // resolveLesson falls through to the first available lesson when neither
    // the module nor the lesson segment matches anything.
    expect(src).toMatch(/if\s*\(sorted\[0\]\?\.lessons\[0\]\)/)
  })

  it('an unresolvable course redirects rather than rendering an error', () => {
    const src = stripTs(read(PLAYER))
    expect(src).toContain("router.push('/courses')")
  })

  it('the entitlement gate runs above the player, so a malformed URL is gated first', () => {
    // The layout sits at [courseSlug], above [moduleId]/[lessonId]. A malformed
    // segment cannot skip it — Next.js resolves layouts before pages.
    const src = stripTs(read('app/(learn)/learn/[courseSlug]/layout.tsx'))
    expect(src).toContain('resolveCourseAccess(params.courseSlug)')
  })
})
