'use server'
/**
 * TEMP_FREE_ACCESS: Free pilot enrollment server action.
 *
 * Creates an active enrollment without any payment.
 * Uses the admin (service-role) Supabase client so RLS does not block
 * the INSERT — this is safe because the user identity is verified
 * server-side before the record is created.
 *
 * To remove when payments are re-enabled:
 *   - Delete this file entirely
 *   - Remove all imports of enrollForFree in the codebase
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { EnrollSchema } from '@/lib/validation/schemas'
import { sendEnrollmentEmail } from '@/lib/email'
import { createLogger } from '@/lib/logger'
import { FREE_ACCESS_MODE } from '@/lib/pilot'
import { PUBLIC_SITE_URL } from '@/lib/brand'

const log = createLogger('actions/enrollment')

/**
 * XPA-6A — free self-enrollment is CLOSED unless explicitly re-opened.
 *
 * This action let any authenticated user grant themselves an active enrollment
 * in any published course. Under the pilot that was the point. With public
 * registration open it becomes "registration grants course access", which
 * directly contradicts ratified decisions 3 and 5.
 *
 * Deliberately NOT gated on PLATFORM_MODE alone: that variable defaults to
 * 'pilot' when unset, so an environment that merely forgot to set it would have
 * self-enrollment switched ON. The flag below defaults to OFF and must be set to
 * the literal string 'true' to re-open it — a missing or misspelled value
 * denies. Fail closed, and fail closed on absence.
 */
const SELF_ENROLLMENT_OPEN =
  process.env.NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT === 'true'

export async function enrollForFree(
  courseId: string
): Promise<{ error?: string }> {
  // XPA-6A: deny by default, before anything else runs.
  if (!SELF_ENROLLMENT_OPEN) {
    return {
      error:
        "La création d'un compte ne donne pas accès aux formations. L'accès doit être activé pour votre compte.",
    }
  }

  // TEMP_FREE_ACCESS: Guard — only available in pilot mode
  if (!FREE_ACCESS_MODE) {
    return { error: 'Free enrollment is not available outside pilot mode.' }
  }

  // Validate courseId is a proper UUID
  const parsed = EnrollSchema.safeParse({ courseId })
  if (!parsed.success) {
    return { error: 'Invalid course ID.' }
  }

  // Verify the caller is authenticated using the user-scoped client
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  // Use admin client for reads/writes — bypasses RLS INSERT restriction.
  // The service-role key lives only in SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_
  // prefix) so it is never included in the client bundle.
  const admin = createAdminClient()

  // Verify the course exists and is published before enrolling.
  const { data: course } = await admin
    .from('courses')
    .select('id, title, slug')
    .eq('id', parsed.data.courseId)
    .eq('is_published', true)
    .maybeSingle()

  if (!course) {
    return { error: 'Course not found or not available.' }
  }

  // Check for an existing enrollment record
  const { data: existing } = await admin
    .from('enrollments')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('course_id', parsed.data.courseId)
    .maybeSingle()

  if (existing?.status === 'active') {
    return {} // already active — nothing to do
  }

  const fullName = (user.user_metadata?.full_name as string | undefined) ?? ''

  if (existing) {
    // Reactivate an expired or suspended enrollment
    const { error } = await admin
      .from('enrollments')
      .update({ status: 'active' })
      .eq('id', existing.id)
    if (error) return { error: error.message }
    fireEnrollmentEmail(user.email!, fullName, course.title, course.slug)
    return {}
  }

  // Create a new active enrollment with no payment attached.
  // TEMP_FREE_ACCESS: payment_id is intentionally null.
  // upsert + ignoreDuplicates guards against the rare race condition where
  // two concurrent requests both pass the maybeSingle() check above and
  // both reach this point — the second is silently discarded (DO NOTHING)
  // rather than returning a unique-constraint error.
  const { error } = await admin.from('enrollments').upsert(
    {
      user_id:    user.id,
      course_id:  parsed.data.courseId,
      payment_id: null,
      status:     'active',
    },
    { onConflict: 'user_id,course_id', ignoreDuplicates: true }
  )

  if (error) return { error: error.message }
  fireEnrollmentEmail(user.email!, fullName, course.title, course.slug)
  return {}
}

function fireEnrollmentEmail(to: string, fullName: string, courseTitle: string, courseSlug: string) {
  // XPA-1: canonical public academy domain (was a bare smileycx.com fallback).
  const baseUrl = PUBLIC_SITE_URL
  sendEnrollmentEmail(to, {
    fullName,
    courseTitle,
    courseUrl: `${baseUrl}/courses/${courseSlug}`,
  }).catch(err => log.error({ err }, 'Failed to send enrollment email'))
}
