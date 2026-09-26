'use server'
/**
 * UAT-ADMIN-LESSON-VISIBILITY-01 — the browser's window onto the ONE access
 * authority.
 *
 * ── THE DEFECT THIS EXISTS TO END ─────────────────────────────────────────
 *
 * Three places answered "may this caller open this course?", and one of them
 * answered differently:
 *
 *   has_course_access()        SQL/RLS        admits a platform admin
 *   resolveCourseAccessById()  server seam    admits a platform admin
 *   my_course_access           a VIEW         entitlements only — no admin arm
 *
 * The learn player is a client component, so it could not call the server seam
 * and queried the view directly instead. The result: the layout admitted the
 * platform admin server-side, then the player read the view, found no
 * entitlement row and redirected her straight back out of the course she had
 * just been let into. Every course, every time — the admin holds no commercial
 * entitlement, and should not need one to review the material she authors.
 *
 * ── WHY AN ACTION RATHER THAN A SECOND CLIENT CHECK ───────────────────────
 *
 * Adding a `platform_role` lookup to the player would have made a THIRD
 * definition of access and guaranteed a future disagreement. This adds none:
 * it delegates to `resolveCourseAccessById`, the same function the learn
 * layout, the media delivery route and `ensureAcademicEnrollment` already use,
 * and which `has_course_access()` mirrors in SQL. The player stops deciding
 * and starts asking.
 *
 * ── WHAT IT DISCLOSES ─────────────────────────────────────────────────────
 *
 * A boolean and the coarse reason the layout already renders to the same
 * caller for the same course. No entitlement row, no provenance, no dates, no
 * revocation detail — `my_course_access` was itself the learner-safe
 * projection, and this returns strictly less than it did. It reads the
 * caller's own session server-side: no service-role key is involved, and
 * nothing here grants access.
 */

import { resolveCourseAccessById, type CourseAccessDenial } from '@/lib/auth/course-access'
import { EnrollSchema } from '@/lib/validation/schemas'

export interface CourseAccessAnswer {
  allowed: boolean
  reason?: CourseAccessDenial
}

/**
 * May the CURRENT caller open this course?
 *
 * Fail-closed: an id that is not a uuid is refused before the seam is asked,
 * and any denial reason the seam returns is passed through unchanged.
 */
export async function canOpenCourse(courseId: string): Promise<CourseAccessAnswer> {
  const parsed = EnrollSchema.safeParse({ courseId })
  if (!parsed.success) return { allowed: false, reason: 'course_not_found' }

  const access = await resolveCourseAccessById(parsed.data.courseId)
  return access.allowed ? { allowed: true } : { allowed: false, reason: access.reason }
}
