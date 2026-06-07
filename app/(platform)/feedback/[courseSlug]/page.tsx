import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import FeedbackForm from './FeedbackForm'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Donner mon avis — XP Client Academy' }

interface Props { params: Promise<{ courseSlug: string }> }

export default async function FeedbackPage({ params }: Props) {
  const { courseSlug } = await params
  const supabase = await createClient()

  if (!PILOT_MODE) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect(`/login?next=/feedback/${courseSlug}`)
  }

  const { data: course } = await supabase
    .from('courses')
    .select('id, title')
    .eq('slug', courseSlug)
    .eq('is_published', true)
    .maybeSingle()

  if (!course) redirect('/dashboard')

  return (
    <div className="cx-section bg-light min-h-screen">
      <div className="cx-container max-w-2xl">

        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-bold text-secondary uppercase tracking-widest mb-2">
            Phase pilote
          </p>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-dark mb-2">
            Donnez votre avis sur la formation
          </h1>
          <p className="text-cx-gray text-sm leading-relaxed">
            <span className="font-semibold text-dark">{course.title}</span>
            {' '}— Votre retour nous aide directement à améliorer le contenu et l&apos;expérience pour les prochains apprenants.
          </p>
        </div>

        <FeedbackForm courseId={course.id} />

      </div>
    </div>
  )
}
