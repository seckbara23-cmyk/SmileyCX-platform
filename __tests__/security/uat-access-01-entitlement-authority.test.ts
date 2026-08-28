// @vitest-environment node
/**
 * UAT-ACCESS-01 — entitlement is the access authority.
 *
 * Ratified invariant:
 *
 *   ENTITLEMENT  may this learner access this course?   Commercial. Authority.
 *   ENROLLMENT   what did this learner actually do?     Academic. Never authority.
 *
 * A valid entitlement must never be overridden by the absence of an enrollment.
 *
 * ── THE TWO GATES THAT DISAGREED ──────────────────────────────────────────
 *
 * `(learn)/[courseSlug]/layout.tsx` admitted a learner on `resolveCourseAccess`.
 * The player inside it then read `enrollments` and redirected when none existed,
 * falling back to `enrollForFree()` under FREE_ACCESS_MODE. So a learner holding
 * a valid entitlement was bounced out of a page they had just been let into,
 * and a mode flag decided access.
 *
 * The certificate page was worse: `enrollments` was its ONLY gate, so it could
 * turn away an entitled learner who had genuinely finished the course.
 *
 * Both now consult the entitlement seam. Enrollment survives as academic state.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const PLAYER      = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const CERTIFICATE = 'app/(platform)/certificate/[courseSlug]/page.tsx'
const LAYOUT      = 'app/(learn)/learn/[courseSlug]/layout.tsx'
const ACTIONS     = 'app/actions/enrollment.ts'
const DASHBOARD   = 'app/(platform)/dashboard/page.tsx'

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ACCESS-01 — a missing enrollment must not override a valid entitlement', () => {
  it('UAT-ACCESS-01: the player no longer gates entry on an enrollment row', () => {
    const src = stripTs(read(PLAYER))
    // The exact query that produced the defect.
    expect(src, 'the player still reads enrollments to decide entry')
      .not.toMatch(/\.from\(\s*['"`]enrollments['"`]\s*\)/)
  })

  it('UAT-ACCESS-01: the player decides entry on the entitlement seam', () => {
    const src = stripTs(read(PLAYER))
    expect(src).toContain('my_course_access')
    expect(src).toMatch(/has_access/)
    // The redirect must be driven by access, not by an enrollment lookup.
    expect(src).toMatch(/!access\?\.has_access/)
  })

  it('UAT-ACCESS-01: the player never calls enrollForFree', () => {
    const src = stripTs(read(PLAYER))
    expect(src).not.toContain('enrollForFree')
  })

  it('UAT-ACCESS-01: no mode flag is an access authority in the player', () => {
    const src = stripTs(read(PLAYER))
    expect(src, 'FREE_ACCESS_MODE is back in the player').not.toContain('FREE_ACCESS_MODE')
    expect(src).not.toContain('SELF_ENROLLMENT_OPEN')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ACADEMIC INITIALISATION — AFTER authorization, never as part of it
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ACCESS-01 academic enrollment initialisation', () => {
  const src = () => stripTs(read(ACTIONS))

  it('is authorized by the entitlement seam, not by a mode flag', () => {
    const s = src()
    expect(s).toContain('ensureAcademicEnrollment')
    expect(s).toMatch(/resolveCourseAccessById\(parsed\.data\.courseId\)/)
    // The guard must reject before any write.
    expect(s).toMatch(/if\s*\(!access\.allowed\)[\s\S]{0,120}return\s*\{\s*ok:\s*false/)
  })

  it('is idempotent and cannot duplicate', () => {
    const s = src()
    expect(s).toMatch(/onConflict:\s*'user_id,course_id'/)
    expect(s).toMatch(/ignoreDuplicates:\s*true/)
    // An existing row short-circuits without a second write.
    expect(s).toMatch(/if\s*\(existing\)\s*return\s*\{\s*ok:\s*true,\s*created:\s*false\s*\}/)
  })

  it('is auditable under the existing convention', () => {
    const s = src()
    expect(s).toContain('logAuditEvent')
    expect(s).toContain('enrollment.initialized')
    expect(read('lib/audit/log.ts')).toContain("'enrollment.initialized'")
  })

  it('is explicitly non-authorizing', () => {
    // The audit metadata records that this row grants nothing, so a future
    // reader of the log cannot mistake it for an access change.
    expect(src()).toMatch(/authorizing:\s*false/)
  })

  it('runs only after the access decision, and its failure cannot deny entry', () => {
    const player = stripTs(read(PLAYER))
    const accessAt = player.search(/!access\?\.has_access/)
    // The CALL SITE, not the import at the top of the file.
    const ensureAt = player.search(/void ensureAcademicEnrollment/)
    expect(accessAt).toBeGreaterThan(-1)
    expect(ensureAt).toBeGreaterThan(accessAt)
    // Fire-and-forget: no branch may redirect on its result.
    expect(player).toMatch(/void ensureAcademicEnrollment/)
  })

  it('enrollForFree remains closed and is still the self-service path', () => {
    const s = src()
    expect(s).toMatch(/SELF_ENROLLMENT_OPEN/)
    expect(s).toMatch(/if\s*\(!FREE_ACCESS_MODE\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CERTIFICATE — access authority vs completion eligibility
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ACCESS-01 certificate gate', () => {
  const src = () => stripTs(read(CERTIFICATE))

  it('uses the entitlement seam for ACCESS', () => {
    const s = src()
    expect(s).toContain('resolveCourseAccess')
    expect(s).toMatch(/if\s*\(!access\.allowed\)\s*redirect/)
  })

  it('no longer uses an enrollment row as the access gate', () => {
    const s = src()
    expect(s).not.toMatch(/\.from\(\s*['"`]enrollments['"`]\s*\)/)
  })

  // XPA-8 B-2.3A moved the completion arithmetic out of the page and into
  // `resolveCertificateEligibility`. UAT-ACCESS-01's claim is unchanged, and is
  // now asserted in both halves: the page refuses on the resolver's verdict,
  // and the resolver demands real evidence.
  it('still requires real COMPLETION evidence — an entitlement is not a certificate', () => {
    const page = src()
    expect(page).toContain('resolveCertificateEligibility')
    expect(page).toMatch(/if \(!eligibility\.eligible\)/)

    const assess = stripTs(read('lib/learn/assessment.ts'))
    expect(assess).toContain('lesson_progress')
    expect(assess).toContain('quiz_attempts')
    // Incomplete learner is refused.
    expect(assess).toMatch(/completedLessons < totalLessons/)
    expect(assess).toMatch(/lessons_incomplete/)
    // A course with no lessons cannot mint one.
    expect(assess).toMatch(/totalLessons === 0/)
  })

  it('creates the certificate only after every completion check', () => {
    const s = src()
    const verdictAt = s.search(/if \(!eligibility\.eligible\)/)
    const insertAt  = s.search(/\.from\(\s*['"`]certificates['"`]\s*\)[\s\S]{0,200}\.insert/)
    expect(verdictAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(verdictAt)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SEAM ITSELF, AND WHAT MUST NOT REGRESS
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ACCESS-01 the seam is unchanged', () => {
  it('has_course_access still reads entitlements and never enrollments', () => {
    const sql = read('supabase/migrations/037_entitlements.sql')
    const fn = sql.split('create or replace function public.has_course_access')[1]?.split('$$;')[0] ?? ''
    expect(fn).toContain('entitlements')
    expect(fn, 'the SQL seam reads enrollments again — Q-L violated').not.toContain('enrollments')
  })

  it('the TypeScript mirror also reads only the entitlement view', () => {
    const s = stripTs(read('lib/auth/course-access.ts'))
    expect(s).toContain('my_course_access')
    expect(s).not.toMatch(/\.from\(\s*['"`]enrollments['"`]\s*\)/)
  })

  it('the layout still gates every learning route on the seam', () => {
    const s = stripTs(read(LAYOUT))
    expect(s).toContain('resolveCourseAccess(params.courseSlug)')
    expect(s).toMatch(/if\s*\(\s*access\.allowed\s*\)\s*return/)
  })

  it('the dashboard reference pattern is intact: access from the view, progress from enrollments', () => {
    const s = stripTs(read(DASHBOARD))
    expect(s).toContain('my_course_access')
    expect(s).toMatch(/\.from\(\s*['"`]enrollments['"`]\s*\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPERATING-MODE INDEPENDENCE
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-ACCESS-01 operating-mode independence', () => {
  it('an authenticated learner takes the authorized path in EVERY mode', () => {
    const s = stripTs(read(PLAYER))
    // The old short-circuit returned before loadCourse ever ran.
    expect(s, 'PILOT_MODE still short-circuits an authenticated learner')
      .not.toMatch(/if\s*\(PILOT_MODE\)\s*\{\s*loadCourseAnon\(\)[\s\S]{0,60}return\s*\}\s*\n\s*supabase\.auth/)
    // PILOT_MODE may now only choose a path for an ANONYMOUS caller.
    expect(s).toMatch(/if\s*\(!user\)\s*\{[\s\S]{0,200}PILOT_MODE/)
  })

  it('the access decision itself consults no mode flag', () => {
    const s = stripTs(read(PLAYER))
    const decision = s.slice(s.search(/my_course_access/), s.search(/ensureAcademicEnrollment/))
    for (const flag of ['PILOT_MODE', 'FREE_ACCESS_MODE', 'SELF_ENROLLMENT_OPEN']) {
      expect(decision, `${flag} participates in the access decision`).not.toContain(flag)
    }
  })

  it('invite-only mode changes nothing about the decision path', () => {
    // Modelled rather than executed: the decision reads `my_course_access`,
    // whose value is computed by has_course_access() in Postgres from the
    // entitlement alone. No environment variable is an input to it, so the
    // same learner resolves identically under pilot, private and public.
    const seam = read('lib/auth/course-access.ts')
    for (const flag of ['PLATFORM_MODE', 'PILOT_MODE', 'FREE_ACCESS_MODE', 'SELF_ENROLLMENT_OPEN']) {
      expect(seam, `${flag} leaked into the access seam`).not.toContain(flag)
    }
  })
})
