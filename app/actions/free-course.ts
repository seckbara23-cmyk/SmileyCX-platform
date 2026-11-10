'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { rateLimitDb } from '@/lib/rate-limit'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import { grantFreeCourseAccess } from '@/lib/learn/free-course'

/**
 * XP-LAUNCH-FINAL-18 — « Commencer gratuitement » on a free course's page.
 *
 * A POST from a signed-in learner. It grants the free course's entitlement
 * (see `grantFreeCourseAccess`: free and published courses only, idempotent,
 * audited) and returns the learner to the course page, where the gate now
 * opens. If the gate still refuses (an unverified e-mail, an inactive account),
 * the dashboard is where the learner is told why.
 */
const Input = z.object({
  courseId: z.string().uuid(),
  slug:     z.string().min(1).max(200),
})

const FREE_COURSE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

export async function startFreeCourse(formData: FormData): Promise<void> {
  const parsed = Input.safeParse({ courseId: formData.get('courseId'), slug: formData.get('slug') })
  if (!parsed.success) redirect('/courses')
  const { courseId, slug } = parsed.data
  const coursePage = `/courses/${encodeURIComponent(slug)}`

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(coursePage)}`)

  const rl = await rateLimitDb(`free-course:${user.id}`, FREE_COURSE_LIMIT)
  if (!rl.success) redirect(coursePage)

  const result = await grantFreeCourseAccess({ userId: user.id, email: user.email ?? null, courseId })
  if (!result.ok) redirect(`/contact?course=${encodeURIComponent(slug)}`)

  const access = await resolveCourseAccessById(courseId)
  if (!access.allowed) redirect('/dashboard')

  redirect(`/courses/${encodeURIComponent(result.slug)}`)
}
