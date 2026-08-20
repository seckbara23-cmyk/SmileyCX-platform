import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import { resolveCourseAccess } from '@/lib/auth/course-access'
import { resolveCertificateEligibility } from '@/lib/learn/assessment'
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

  // ── UAT-ACCESS-01: two separate questions, two separate answers ───────────
  //
  // 1. ACCESS AUTHORITY — may this learner have this course at all?
  //    Decided by the entitlement seam. This page used `enrollments` for it,
  //    which meant a genuinely entitled, genuinely finished learner could be
  //    turned away because an academic row was missing.
  //
  // 2. COMPLETION ELIGIBILITY — did they actually earn it?
  //    Decided by lesson_progress and quiz_attempts, below. An entitlement is
  //    permission to study, never evidence of having studied, so holding one
  //    must not by itself produce a certificate.
  //
  // Collapsing the two is what made the gate wrong in both directions.
  const access = await resolveCourseAccess(courseSlug)
  if (!access.allowed) redirect(`/courses/${courseSlug}`)

  // ── XPA-8 B-2.3A: eligibility is ACADEMIC, and PLATFORM_MODE has no say ──
  //
  // This block used to inline three checks - lessons, module quizzes, final
  // exam - and wrap the last two in `if (!PILOT_MODE)`. Two things were wrong
  // with that, and B-2.3A fixes both.
  //
  // 1. An operating mode was an academic authority. Flipping PLATFORM_MODE
  //    changed whether a certificate required an assessment, which is exactly
  //    the coupling B-2.6 removed from completion. The mode is consulted
  //    NOWHERE in eligibility now.
  //
  // 2. The gate demanded module quizzes and a final exam whenever any existed,
  //    with no way to say "this course does not assess". Ratified contract:
  //
  //      required lessons complete
  //      + if courses.requires_final_exam -> an attached exam, passed
  //
  //    Module quizzes gate nothing. The infrastructure survives for optional
  //    enrichment, but certification does not depend on it - and neither does
  //    a lesson-scoped formative quiz such as C1-F1's "Echauffement", which
  //    was silently able to gate progression before B-2.3A.
  //
  // A course flagged as requiring an exam that has none FAILS CLOSED. A
  // misconfiguration must withhold a certificate, never mint one.
  const eligibility = await resolveCertificateEligibility(user.id, course.id)

  if (!eligibility.eligible) {
    if (eligibility.reason === 'final_exam_not_passed') {
      redirect(`/learn/${courseSlug}/final-exam`)
    }
    // lessons_incomplete, final_exam_missing and lookup_failed all send the
    // learner back to the course. `final_exam_missing` is an OPERATOR error,
    // not a learner one, and it is logged as such by the resolver.
    redirect(`/courses/${courseSlug}`)
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
  const certNum = `XPC-${year}-${String(Math.floor(100000 + Math.random() * 900000))}`
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
