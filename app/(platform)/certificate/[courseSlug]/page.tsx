import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import { formatDate } from '@/lib/utils/cn'
import PrintButton from './PrintButton'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Certificat de réussite' }

interface Props { params: Promise<{ courseSlug: string }> }

export default async function CertificatePage({ params }: Props) {
  const { courseSlug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(PILOT_MODE ? '/courses' : '/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single()

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
    .select('lessons(id)')
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

  const isComplete = (completedCount ?? 0) >= totalLessons

  if (!isComplete) {
    // Not all lessons completed — redirect to the course detail page
    redirect(`/courses/${courseSlug}`)
  }

  // Look up or create certificate (only after verifying completion)
  let cert = null
  const { data: existingCert } = await supabase
    .from('certificates')
    .select('*')
    .eq('user_id', user.id)
    .eq('course_id', course.id)
    .single()

  if (existingCert) {
    cert = existingCert
  } else {
    const certNum = `SCX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
    const { data: newCert } = await supabase
      .from('certificates')
      .insert({
        user_id:            user.id,
        course_id:          course.id,
        certificate_number: certNum,
      })
      .select()
      .single()
    cert = newCert
  }

  const certNumber = cert?.certificate_number ?? 'SCX-DEMO-2025'
  const issuedAt   = cert?.issued_at ?? new Date().toISOString()

  return (
    <div className="cx-section">
      <div className="cx-container max-w-3xl">

        {/* Action bar */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <Link href="/dashboard" className="text-sm text-cx-gray hover:text-dark">← Mon espace</Link>
          <PrintButton />
        </div>

        {/* Certificate */}
        <div className="certificate-frame print:shadow-none" id="certificate">
          {/* Corner decorations */}
          <div aria-hidden className="absolute top-5 left-5 w-12 h-12 border-t-2 border-l-2 border-primary/30 rounded-tl-lg" />
          <div aria-hidden className="absolute top-5 right-5 w-12 h-12 border-t-2 border-r-2 border-primary/30 rounded-tr-lg" />
          <div aria-hidden className="absolute bottom-5 left-5 w-12 h-12 border-b-2 border-l-2 border-primary/30 rounded-bl-lg" />
          <div aria-hidden className="absolute bottom-5 right-5 w-12 h-12 border-b-2 border-r-2 border-primary/30 rounded-br-lg" />

          <div className="relative z-10">
            {/* Logo */}
            <p className="text-2xl font-extrabold text-primary mb-1">
              Smiley<span className="text-secondary">CX</span>{' '}
              <span className="text-base font-semibold text-cx-gray">Academy</span>
            </p>
            <p className="text-xs text-cx-gray mb-8 tracking-widest uppercase">Certificat de réussite</p>

            {/* Badge */}
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary to-secondary mx-auto mb-6 flex items-center justify-center">
              <span className="text-3xl">🏆</span>
            </div>

            <p className="text-sm text-cx-gray mb-1">Ce certificat est décerné à</p>
            <h1 className="text-3xl md:text-4xl font-extrabold text-dark mb-6 tracking-tight">
              {profile?.full_name || profile?.email}
            </h1>

            <p className="text-sm text-cx-gray mb-2">pour avoir complété avec succès la formation</p>
            <h2 className="text-xl font-bold text-primary mb-8 max-w-md mx-auto leading-snug">
              {course.title}
            </h2>

            {/* Signature line */}
            <div className="flex justify-center gap-16 mt-6 pt-6 border-t border-primary/20">
              <div className="text-center">
                <div className="w-24 h-0.5 bg-dark/20 mx-auto mb-1" />
                <p className="text-xs text-cx-gray">SmileyCX Consulting</p>
              </div>
              <div className="text-center">
                <div className="w-24 h-0.5 bg-dark/20 mx-auto mb-1" />
                <p className="text-xs text-cx-gray">Directrice de Formation</p>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-8 pt-4 border-t border-black/[0.06] flex justify-between items-center text-xs text-cx-gray">
              <span>Délivré le {formatDate(issuedAt)}</span>
              <span className="font-mono text-[11px]">N° {certNumber}</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-cx-gray text-center mt-6">
          Ce certificat peut être partagé sur LinkedIn et autres plateformes professionnelles.
          <br />Vérification : <span className="font-mono text-primary">{certNumber}</span>
        </p>
      </div>
    </div>
  )
}
