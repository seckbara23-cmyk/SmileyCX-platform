import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Certificat de réussite' }

interface Props { params: Promise<{ courseSlug: string }> }

export default async function CertificatePage({ params }: Props) {
  const { courseSlug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(PILOT_MODE ? '/courses' : '/login')

  // Resolve course
  const { data: course } = await supabase
    .from('courses')
    .select('id, title, slug')
    .eq('slug', courseSlug)
    .single()

  if (!course) redirect('/dashboard')

  // Verify the user is enrolled
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id')
    .eq('user_id', user.id)
    .eq('course_id', course.id)
    .eq('status', 'active')
    .single()

  if (!enrollment) redirect(`/courses/${courseSlug}`)

  // Verify actual completion — all lessons must be completed
  const { data: modules } = await supabase
    .from('modules')
    .select('id, lessons(id)')
    .eq('course_id', course.id)

  const allLessonIds: string[] = (modules ?? []).flatMap(
    m => (m.lessons as { id: string }[]).map(l => l.id)
  )

  const totalLessons = allLessonIds.length

  if (totalLessons === 0) {
    // Course has no lessons yet — cannot issue certificate
    redirect('/dashboard')
  }

  const { count: completedCount } = await supabase
    .from('lesson_progress')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_completed', true)
    .in('lesson_id', allLessonIds)

  if ((completedCount ?? 0) < totalLessons) {
    redirect(`/courses/${courseSlug}`)
  }

  // Verify all module quizzes passed — uses quiz_attempts (server-side records only).
  // Skipped in PILOT_MODE since quiz attempts are not persisted for anonymous users.
  if (!PILOT_MODE) {
    const moduleIds = (modules ?? []).map(m => (m as { id: string }).id).filter(Boolean)

    if (moduleIds.length > 0) {
      const { data: quizModulesData } = await supabase
        .from('quizzes')
        .select('module_id')
        .in('module_id', moduleIds)
        .not('module_id', 'is', null)

      const quizModuleIds = Array.from(new Set(
        (quizModulesData ?? []).map(q => q.module_id as string).filter(Boolean)
      ))

      if (quizModuleIds.length > 0) {
        const { data: passedAttempts } = await supabase
          .from('quiz_attempts')
          .select('module_id')
          .eq('user_id', user.id)
          .eq('passed', true)
          .in('module_id', quizModuleIds)

        const passedIds = new Set(
          (passedAttempts ?? []).map(a => a.module_id as string).filter(Boolean)
        )

        if (!quizModuleIds.every(id => passedIds.has(id))) {
          redirect(`/courses/${courseSlug}`)
        }
      }
    }
  }

  // Look up or create certificate (only after verifying completion)
  const { data: existingCert } = await supabase
    .from('certificates')
    .select('id')
    .eq('user_id', user.id)
    .eq('course_id', course.id)
    .single()

  if (existingCert) {
    redirect(`/certificates/${existingCert.id}`)
  }

  const year   = new Date().getFullYear()
  const certNum = `SCX-${year}-${String(Math.floor(100000 + Math.random() * 900000))}`
  const { data: newCert } = await supabase
    .from('certificates')
    .insert({
      user_id:            user.id,
      course_id:          course.id,
      certificate_number: certNum,
    })
    .select('id')
    .single()

  if (!newCert) redirect('/dashboard')
  redirect(`/certificates/${newCert.id}`)
}
