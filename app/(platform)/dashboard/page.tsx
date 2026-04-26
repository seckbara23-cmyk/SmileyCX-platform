import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BookOpen, Award, Clock, ArrowRight, Play } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Mon Espace' }

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(PILOT_MODE ? '/courses' : '/login')

  // Load profile + enrollments + progress
  const [{ data: profile }, { data: enrollments }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase
      .from('enrollments')
      .select('*, courses(*, modules(id, lessons(id)))')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('enrolled_at', { ascending: false }),
  ])

  if (!profile) redirect('/login')

  // Compute progress for each enrollment + find first incomplete lesson
  const progressData = await Promise.all(
    (enrollments ?? []).map(async (e: {
      id: string
      course_id: string
      enrolled_at: string
      courses: { id: string; slug: string; title: string; modules: { id: string; lessons: { id: string }[] }[] } | null
    }) => {
      // Guard: skip gracefully if course data is missing
      if (!e.courses) {
        return { enrollment: e, total: 0, completed: 0, percentage: 0, continueUrl: '/courses' }
      }

      // All lesson IDs ordered by module/lesson index
      const lessonIds = (e.courses.modules ?? [])
        .flatMap((m: { id: string; lessons: { id: string }[] }) =>
          (m.lessons ?? []).map(l => ({ lessonId: l.id, moduleId: m.id }))
        )

      const lessonIdList = lessonIds.map(x => x.lessonId)

      const { data: completedRows } = await supabase
        .from('lesson_progress')
        .select('lesson_id')
        .eq('user_id', user.id)
        .eq('is_completed', true)
        .in('lesson_id', lessonIdList.length > 0 ? lessonIdList : ['__none__'])

      const completedSet = new Set((completedRows ?? []).map(r => r.lesson_id))
      const total     = lessonIdList.length
      const completed = completedSet.size

      // Find first uncompleted lesson for "Continue" button
      const firstIncomplete = lessonIds.find(x => !completedSet.has(x.lessonId))
      const firstLesson     = lessonIds[0]
      const targetLesson    = firstIncomplete ?? firstLesson

      const continueUrl = targetLesson
        ? `/learn/${e.courses.slug}/${targetLesson.moduleId}/${targetLesson.lessonId}`
        : `/courses/${e.courses.slug}`

      return {
        enrollment: e,
        total,
        completed,
        percentage:   total > 0 ? Math.round((completed / total) * 100) : 0,
        continueUrl,
      }
    })
  )

  // Load certificates
  const { data: certs } = await supabase
    .from('certificates')
    .select('*, courses(title, slug)')
    .eq('user_id', user.id)
    .order('issued_at', { ascending: false })

  const firstName = (profile.full_name || profile.email).split(' ')[0]

  return (
    <div className="cx-section bg-light min-h-screen">
      <div className="cx-container">

        {/* Welcome */}
        <div className="mb-10">
          <h1 className="text-2xl md:text-3xl font-extrabold text-dark">
            Bonjour, {firstName} 👋
          </h1>
          <p className="text-cx-gray mt-1">Votre espace d&apos;apprentissage SmileyCX Academy</p>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            {
              icon: BookOpen,
              value: enrollments?.length ?? 0,
              label: 'Formation(s) inscrit(e)',
              color: 'text-primary bg-primary/10',
            },
            {
              icon: Play,
              value: progressData.reduce((n, p) => n + p.completed, 0),
              label: 'Leçons complétées',
              color: 'text-secondary bg-secondary/10',
            },
            {
              icon: Award,
              value: certs?.length ?? 0,
              label: 'Certificat(s)',
              color: 'text-success bg-success/10',
            },
            {
              icon: Clock,
              value: (enrollments?.length ?? 0) > 0 ? '∞' : '0',
              label: "Accès à vie",
              color: 'text-cx-gray bg-cx-gray/10',
            },
          ].map(({ icon: Icon, value, label, color }) => (
            <div key={label} className="cx-card p-5">
              <div className={`w-10 h-10 rounded-cx flex items-center justify-center mb-3 ${color}`}>
                <Icon className="w-5 h-5" />
              </div>
              <p className="text-2xl font-extrabold text-dark">{value}</p>
              <p className="text-xs text-cx-gray mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* My Courses */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-extrabold text-dark">Mes formations</h2>
            <Link href="/courses" className="text-sm text-primary font-semibold hover:underline flex items-center gap-1">
              Explorer <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {progressData.length === 0 ? (
            <div className="cx-card p-10 text-center">
              <BookOpen className="w-12 h-12 text-primary/30 mx-auto mb-4" />
              <h3 className="font-bold text-dark mb-2">Vous n&apos;êtes inscrit à aucune formation</h3>
              <p className="text-sm text-cx-gray mb-5">
                Découvrez notre catalogue et commencez votre parcours CX dès aujourd&apos;hui.
              </p>
              <Link
                href="/courses"
                className="inline-flex items-center gap-2 px-6 py-3 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all"
              >
                Voir les formations <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-5">
              {progressData.map(({ enrollment, total, completed, percentage, continueUrl }) => {
                const c = enrollment.courses
                if (!c) return null   // course data missing — skip card

                return (
                  <div key={enrollment.id} className="cx-card p-5">
                    <div className="flex gap-3 mb-4">
                      <div className="w-12 h-12 rounded-cx bg-primary/10 flex items-center justify-center text-primary font-extrabold text-base shrink-0">
                        CX
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-dark text-sm leading-tight">{c.title}</p>
                        <p className="text-xs text-cx-gray mt-0.5">
                          {completed}/{total} leçons complétées
                        </p>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="mb-4">
                      <div className="flex justify-between text-xs text-cx-gray mb-1.5">
                        <span>Progression</span>
                        <span className="font-semibold text-primary">{percentage}%</span>
                      </div>
                      <div className="cx-progress-bar">
                        <div className="cx-progress-bar-fill" style={{ width: `${percentage}%` }} />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Link
                        href={continueUrl}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm"
                      >
                        <Play className="w-4 h-4" />
                        {percentage === 0 ? 'Commencer' : percentage === 100 ? 'Revoir' : 'Continuer'}
                      </Link>
                      {percentage === 100 && (
                        <Link
                          href={`/certificate/${c.slug}`}
                          className="flex items-center gap-1.5 px-4 py-2.5 bg-success/10 text-success font-semibold rounded-cx hover:bg-success/20 transition-colors text-sm"
                        >
                          <Award className="w-4 h-4" /> Certificat
                        </Link>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Certificates */}
        {(certs ?? []).length > 0 && (
          <section>
            <h2 className="text-lg font-extrabold text-dark mb-5">Mes certificats</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {(certs ?? []).map((cert: {
                id: string
                certificate_number: string
                issued_at: string
                courses: { title: string; slug: string }
              }) => (
                <div key={cert.id} className="cx-card p-5 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-cx bg-success/10 flex items-center justify-center shrink-0">
                    <Award className="w-6 h-6 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-dark text-sm">{cert.courses?.title}</p>
                    <p className="text-xs text-cx-gray">N° {cert.certificate_number}</p>
                  </div>
                  <Link
                    href={`/certificate/${cert.courses?.slug}`}
                    className="text-xs font-semibold text-primary hover:underline shrink-0"
                  >
                    Voir →
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
