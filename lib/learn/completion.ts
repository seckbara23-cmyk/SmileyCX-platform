import 'server-only'
/**
 * XPA-8 B-2.6 — the single lesson-completion authority.
 *
 * ── WHAT B-2.6 WAS, AND WHAT THE AUDIT FOUND UNDERNEATH IT ────────────────
 *
 * B-2.6 was raised as "completion is tied to a mechanism disabled by operating
 * mode": `LessonNavigation` hid the "Marquer comme complétée" control whenever
 * `PLATFORM_MODE=pilot`. That was real, but presentational — `PLATFORM_MODE`
 * has never had academic authority. It rendered a button or it did not.
 *
 * The audit (docs/xpa-8-b26-completion-architecture-audit.md) found the larger
 * defect underneath: completion had no ACCESS control at all. The browser wrote
 * to `lesson_progress` directly with the learner's own JWT, and the only rule
 * enforced was `user_id = auth.uid()`. Four of six production fixtures wrote
 * successfully with `has_course_access() = false` — enrollment-only, expired,
 * revoked, and no entitlement whatsoever. Since no published course has an
 * assessment, self-asserted progress WAS the entire certificate requirement.
 *
 * ── THE SEPARATION THIS MODULE PRESERVES ──────────────────────────────────
 *
 *   ENTITLEMENT   may this learner open the course?   Commercial. Authority.
 *   ENROLLMENT    what did this learner actually do?  Academic. Never authority.
 *   COMPLETION    this lesson is done.                Academic record.
 *   ASSESSMENT    did they demonstrate it?            B-2.3. Does not exist yet.
 *   CERTIFICATE   eligibility.                        Separate. Not redesigned here.
 *
 * So the gate below is `resolveCourseAccessById` — the same seam the learn
 * layout enforces and the same one `has_course_access()` mirrors in SQL. It is
 * NOT `enrollments` (Q-L: an enrollment is a transcript, never a key), and it
 * is NOT `PLATFORM_MODE`, which is consulted nowhere in this file.
 *
 * ── WHY THIS IS REUSE RATHER THAN INVENTION ───────────────────────────────
 *
 * `markVoiceLessonComplete` was already server-authoritative and idempotent,
 * and resolved the lesson from the scenario rather than trusting client input.
 * That protection existed for voice and not for video. This generalises the
 * pattern the repository already built; both writers now come through here, so
 * the two cannot drift into enforcing different rules.
 *
 * ── WHY IT IS A LIBRARY AND NOT A SECOND SERVER ACTION ────────────────────
 *
 * Every export of a `'use server'` module is a callable HTTP endpoint. A
 * variant that skipped the expected-course check would therefore BE a weaker
 * public endpoint, which is the opposite of the point. `import 'server-only'`
 * keeps this reachable from server code and from nowhere else.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE ─────────────────────────
 *
 * No watch-time threshold, no anti-cheating heuristic, no DRM, no new
 * pedagogical rule. Whether ending a video is sufficient evidence of learning
 * is a product decision and B-2.6 is not the phase that makes it. Completion
 * remains honour-based; what changes is that only a learner who may actually
 * open the course can assert it.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCourseAccessById, type CourseAccessDenial } from '@/lib/auth/course-access'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'

const log = createLogger('learn/completion')

/** Why a completion was refused. `CourseAccessDenial` covers the access seam. */
export type CompletionDenial =
  | 'invalid_input'
  | 'lesson_not_found'
  | 'course_mismatch'
  | 'write_failed'
  | CourseAccessDenial

export interface CompletionResult {
  ok:       boolean
  reason?:  CompletionDenial
  /** True when the lesson was already complete — the caller's optimism was right. */
  already?: boolean
  /** The course the lesson actually belongs to, once resolved. */
  courseId?: string
}

/**
 * Record that the CURRENT caller completed a lesson.
 *
 * There is no `userId` parameter and there never may be: the subject is taken
 * from the verified session inside `resolveCourseAccessById`, and the write
 * below uses the same id. This function therefore cannot be asked to complete a
 * lesson on somebody else's behalf. (RLS refused impersonation already — `403
 * 42501` — but a service-role write taking a caller-supplied `userId` would
 * have handed that capability straight back.)
 *
 * `expectedCourseId` is the caller's CLAIM about which course it is in. The
 * owning course is resolved from the lesson and is what gets authorized, so
 * this is not what keeps a learner out of another course's lessons — the access
 * check is. It catches the disagreement itself: a player that believes it is in
 * course A while completing a lesson of course B is confused or forged, and
 * either way its write should not land. Pass `null` when the caller reached the
 * lesson through a server-resolved path with no independent claim to check
 * (the voice scenario route).
 *
 * Idempotent: an already-complete lesson returns `{ ok: true, already: true }`
 * without writing, so `completed_at` keeps its original value and re-watching
 * cannot silently move the date a certificate was earned. Concurrent first
 * writes collapse on the existing `UNIQUE(user_id, lesson_id)` constraint.
 */
export async function recordLessonCompletion(
  lessonId:         string,
  expectedCourseId: string | null,
): Promise<CompletionResult> {
  if (!lessonId) return { ok: false, reason: 'invalid_input' }

  // ── 1. Resolve the owning course from the LESSON, server-side ───────────
  //
  // The service-role client is used for the lookup and only for the lookup. A
  // learner whose entitlement has lapsed can no longer read `lessons` through
  // RLS, and we need to identify the course in order to refuse them for the
  // right reason rather than reporting "lesson not found" for an access
  // failure. The decision itself is made in step 3, through the normal seam.
  const admin = createAdminClient()

  const { data: lesson, error: lessonErr } = await admin
    .from('lessons')
    .select('id, module_id')
    .eq('id', lessonId)
    .maybeSingle()

  if (lessonErr) {
    log.error({ err: lessonErr.message, lessonId }, 'lesson lookup failed')
    return { ok: false, reason: 'write_failed' }
  }
  if (!lesson?.module_id) return { ok: false, reason: 'lesson_not_found' }

  const { data: mod, error: modErr } = await admin
    .from('modules')
    .select('id, course_id')
    .eq('id', lesson.module_id as string)
    .maybeSingle()

  if (modErr) {
    log.error({ err: modErr.message, moduleId: lesson.module_id }, 'module lookup failed')
    return { ok: false, reason: 'write_failed' }
  }
  const courseId = mod?.course_id as string | undefined
  if (!courseId) return { ok: false, reason: 'lesson_not_found' }

  // ── 2. The caller's claim must match the lesson's actual course ─────────
  if (expectedCourseId !== null && expectedCourseId !== courseId) {
    await auditDenial(lessonId, courseId, 'course_mismatch')
    return { ok: false, reason: 'course_mismatch', courseId }
  }

  // ── 3. THE authority check. Entitlement, and nothing else ───────────────
  //
  // Keyed on the course resolved above, never on anything the client sent.
  // `resolveCourseAccessById` refuses an expired entitlement, a revoked one, an
  // enrollment with no entitlement behind it, an unverified email and a
  // suspended account — and it has no `is_published` arm, because publication
  // controls DISCOVERY, never ACCESS (migrations 035, 037). A learner holding a
  // valid entitlement to a withdrawn course therefore keeps finishing it, which
  // is the ratified behaviour and not an oversight.
  const access = await resolveCourseAccessById(courseId)
  if (!access.allowed || !access.userId) {
    const reason = access.reason ?? 'not_entitled'
    await auditDenial(lessonId, courseId, reason)
    return { ok: false, reason, courseId }
  }

  // ── 4. Idempotent write ─────────────────────────────────────────────────
  //
  // Nothing here can reset or downgrade an existing row: an already-complete
  // lesson short-circuits, and the upsert only ever sets `is_completed` true.
  const { data: existing } = await admin
    .from('lesson_progress')
    .select('id, is_completed')
    .eq('user_id', access.userId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  if (existing?.is_completed) return { ok: true, already: true, courseId }

  const { error } = await admin
    .from('lesson_progress')
    .upsert(
      {
        user_id:      access.userId,
        lesson_id:    lessonId,
        is_completed: true,
        completed_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,lesson_id' },
    )

  if (error) {
    log.error({ err: error.message, userId: access.userId, lessonId },
      'lesson_progress upsert failed')
    return { ok: false, reason: 'write_failed', courseId }
  }

  return { ok: true, already: Boolean(existing), courseId }
}

/**
 * Record a refused completion.
 *
 * Successes are NOT audited: a learner finishing a course would write ~17 rows
 * of noise for an event `lesson_progress` already holds. A refusal is the
 * interesting one — it is either a learner whose access lapsed mid-course, or
 * an account asserting progress in a course it does not hold.
 *
 * The actor is resolved inside `logAuditEvent`'s caller context rather than
 * passed in, so this cannot attribute a denial to the wrong account.
 */
async function auditDenial(
  lessonId: string,
  courseId: string,
  reason:   CompletionDenial,
): Promise<void> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  await logAuditEvent({
    eventType:     'progress.completion_denied',
    actorType:     user ? 'self' : 'anonymous',
    actorId:       user?.id ?? null,
    actorEmail:    user?.email ?? null,
    subjectUserId: user?.id ?? null,
    method:        'lesson_completion',
    outcome:       'failure',
    reason,
    metadata:      { lessonId, courseId },
  })
}
