import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEntitlementAccessible, LIVE_STATUSES, type EntitlementLike } from '@/lib/entitlements'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'

/**
 * XP-LAUNCH-FINAL-18 — self-service access to a FREE course (C1-F4).
 *
 * CGV art. 5: the free course is accessible for an indefinite period. Access is
 * still decided by an entitlement, never by an account or an enrollment
 * (decision 4: account != payment != enrollment != access). This grants one,
 * and only for a course that is published AND free:
 *
 *   * source PROMOTIONAL_GRANT, status ACTIVE, no end date, recorded and audited;
 *   * idempotent: a learner who already holds an accessible entitlement gets it
 *     back unchanged, and a concurrent second request finds the first one
 *     (one live entitlement per learner and course is a database rule);
 *   * a live entitlement that is NOT accessible (suspended, pending) is never
 *     overridden: an administrator's suspension stays a suspension;
 *   * a paid course is refused: this can never open what has a price.
 */
export type FreeCourseResult =
  | { ok: true; created: boolean; slug: string }
  | { ok: false; reason: 'not_found' | 'not_free' | 'not_accessible' | 'failed' }

type Db = ReturnType<typeof createAdminClient>

async function liveEntitlement(db: Db, userId: string, courseId: string): Promise<EntitlementLike | null> {
  const { data } = await db
    .from('entitlements')
    .select('status, starts_at, expires_at, revoked_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .in('status', LIVE_STATUSES as unknown as string[])
    .maybeSingle()
  return (data as EntitlementLike | null) ?? null
}

export async function grantFreeCourseAccess(input: {
  userId: string
  email: string | null
  courseId: string
}): Promise<FreeCourseResult> {
  const log = createLogger('learn/free-course')
  const db = createAdminClient()

  const { data: course } = await db
    .from('courses')
    .select('id, slug, is_free, is_published')
    .eq('id', input.courseId)
    .maybeSingle()
  if (!course || course.is_published !== true) return { ok: false, reason: 'not_found' }
  if (course.is_free !== true) return { ok: false, reason: 'not_free' }

  const live = await liveEntitlement(db, input.userId, course.id)
  if (live) {
    return isEntitlementAccessible(live)
      ? { ok: true, created: false, slug: course.slug }
      : { ok: false, reason: 'not_accessible' }
  }

  const { error } = await db.from('entitlements').insert({
    user_id:        input.userId,
    course_id:      course.id,
    source:         'PROMOTIONAL_GRANT',
    status:         'ACTIVE',
    granted_reason: 'free_course_self_service',
  })
  if (error) {
    const again = await liveEntitlement(db, input.userId, course.id)
    if (again && isEntitlementAccessible(again)) return { ok: true, created: false, slug: course.slug }
    log.error({ err: error.message, userId: input.userId, courseId: course.id }, 'free course entitlement not created')
    return { ok: false, reason: 'failed' }
  }

  // The academic record that carries progress. It authorizes nothing.
  const { error: enrollError } = await db.from('enrollments').upsert(
    { user_id: input.userId, course_id: course.id, payment_id: null, status: 'active' },
    { onConflict: 'user_id,course_id', ignoreDuplicates: true },
  )
  if (enrollError) {
    log.error({ err: enrollError.message, userId: input.userId, courseId: course.id }, 'free course enrollment not initialised')
  }

  await logAuditEvent({
    eventType:     'entitlement.granted',
    actorType:     'self',
    actorId:       input.userId,
    actorEmail:    input.email,
    subjectUserId: input.userId,
    method:        'free_course_self_service',
    outcome:       'success',
    metadata:      { courseId: course.id, source: 'PROMOTIONAL_GRANT', expiresAt: null },
  })

  return { ok: true, created: true, slug: course.slug }
}
