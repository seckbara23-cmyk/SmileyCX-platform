import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BookOpen, Award, Clock, ArrowRight, Play, CheckCircle, TrendingUp, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Mon Espace' }

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(dateStr))
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(PILOT_MODE ? '/courses' : '/login')

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

  // Compute progress for each enrollment
  const progressData = await Promise.all(
    (enrollments ?? []).map(async (e: {
      id: string
      course_id: string
      enrolled_at: string
      courses: { id: string; slug: string; title: string; cover_url?: string; modules: { id: string; lessons: { id: string }[] }[] } | null
    }) => {
      if (!e.courses) {
        return { enrollment: e, total: 0, completed: 0, percentage: 0, continueUrl: '/courses' }
      }

      const lessonIds = (e.courses.modules ?? []).flatMap(m =>
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
      let total     = lessonIdList.length
      let completed = completedSet.size

      // In authenticated mode, include quiz + final exam in progress totals
      if (!PILOT_MODE && total > 0) {
        const modIds = (e.courses.modules ?? []).map((m: { id: string }) => m.id)
        const modQuizData = modIds.length > 0
          ? (await supabase.from('quizzes').select('id').in('module_id', modIds)).data
          : []
        const { data: finalExamData } = await supabase
          .from('quizzes').select('id').eq('course_id', e.courses.id).is('module_id', null).limit(1).maybeSingle()

        const allQuizIds = [
          ...((modQuizData ?? []).map((q: { id: string }) => q.id)),
          ...(finalExamData ? [finalExamData.id] : []),
        ]
        if (allQuizIds.length > 0) {
          const { data: passedAttempts } = await supabase
            .from('quiz_attempts').select('quiz_id').eq('user_id', user.id).eq('passed', true).in('quiz_id', allQuizIds)
          const passedIds = new Set((passedAttempts ?? []).map((a: { quiz_id: string }) => a.quiz_id))
          total     += allQuizIds.length
          completed += allQuizIds.filter(id => passedIds.has(id)).length
        }
      }

      const firstIncomplete = lessonIds.find(x => !completedSet.has(x.lessonId))
      const targetLesson    = firstIncomplete ?? lessonIds[0]
      const continueUrl = targetLesson
        ? `/learn/${e.courses.slug}/${targetLesson.moduleId}/${targetLesson.lessonId}`
        : `/courses/${e.courses.slug}`

      return { enrollment: e, total, completed, percentage: total > 0 ? Math.round((completed / total) * 100) : 0, continueUrl }
    })
  )

  // Load certificates
  const { data: certs } = await supabase
    .from('certificates')
    .select('id, certificate_number, issued_at, pdf_url, courses(title, slug)')
    .eq('user_id', user.id)
    .order('issued_at', { ascending: false })

  const firstName     = (profile.full_name || profile.email).split(' ')[0]
  const inProgress    = progressData.filter(p => p.percentage < 100)
  const completed     = progressData.filter(p => p.percentage === 100)
  const totalCompleted = completedRows(progressData)

  function completedRows(data: typeof progressData) {
    return data.reduce((n, p) => n + p.completed, 0)
  }

  return (
    <div className="cx-section bg-light min-h-screen">
      <div className="cx-container">

        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-extrabold text-dark">
            Bonjour, {firstName} 👋
          </h1>
          <p className="text-cx-gray mt-1">Votre espace d&apos;apprentissage XP Client Academy</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { icon: BookOpen,    value: enrollments?.length ?? 0,    label: 'Formation(s)', color: 'text-primary bg-primary/10' },
            { icon: Play,        value: totalCompleted,               label: 'Leçons complétées', color: 'text-secondary bg-secondary/10' },
            { icon: Award,       value: certs?.length ?? 0,          label: 'Certificat(s)', color: 'text-success bg-success/10' },
            { icon: TrendingUp,  value: completed.length > 0 ? `${completed.length}/${enrollments?.length ?? 0}` : (enrollments?.length ?? 0) > 0 ? 'En cours' : '—',
              label: 'Formations terminées', color: 'text-amber-600 bg-amber-100' },
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

        {/* ── In Progress ────────────────────────────────────────── */}
        {inProgress.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-extrabold text-dark flex items-center gap-2">
                <Play className="w-4 h-4 text-primary" /> En cours
              </h2>
              <Link href="/courses" className="text-sm text-primary font-semibold hover:underline flex items-center gap-1">
                Explorer <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
            <div className="grid md:grid-cols-2 gap-5">
              {inProgress.map(({ enrollment, total, completed: done, percentage, continueUrl }) => {
                const c = enrollment.courses
                if (!c) return null
                return (
                  <div key={enrollment.id} className="cx-card p-5">
                    <div className="flex gap-3 mb-4">
                      <div className="w-12 h-12 rounded-cx bg-primary/10 flex items-center justify-center text-primary font-extrabold text-sm shrink-0">
                        CX
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-dark text-sm leading-tight">{c.title}</p>
                        <p className="text-xs text-cx-gray mt-0.5">{done}/{total} leçons</p>
                      </div>
                    </div>
                    <div className="mb-4">
                      <div className="flex justify-between text-xs text-cx-gray mb-1.5">
                        <span>Progression</span>
                        <span className="font-semibold text-primary">{percentage}%</span>
                      </div>
                      <div className="cx-progress-bar">
                        <div className="cx-progress-bar-fill transition-all duration-500" style={{ width: `${percentage}%` }} />
                      </div>
                    </div>
                    <Link
                      href={continueUrl}
                      className="flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm w-full"
                    >
                      <Play className="w-4 h-4" />
                      {percentage === 0 ? 'Commencer' : 'Continuer'}
                    </Link>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── Completed ──────────────────────────────────────────── */}
        {completed.length > 0 && (
          <section className="mb-10">
            <h2 className="text-lg font-extrabold text-dark flex items-center gap-2 mb-5">
              <CheckCircle className="w-4 h-4 text-success" /> Formations terminées
            </h2>
            <div className="grid md:grid-cols-2 gap-5">
              {completed.map(({ enrollment, total, completed: done, continueUrl }) => {
                const c = enrollment.courses
                if (!c) return null
                const cert = (certs ?? []).find(ct => {
                  const ctCourses = ct.courses as unknown as { slug: string } | null
                  return ctCourses?.slug === c.slug
                })
                return (
                  <div key={enrollment.id} className="cx-card p-5 border-success/20">
                    <div className="flex gap-3 mb-4">
                      <div className="w-12 h-12 rounded-cx bg-success/10 flex items-center justify-center text-success font-extrabold text-sm shrink-0">
                        <CheckCircle className="w-6 h-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-dark text-sm leading-tight">{c.title}</p>
                        <p className="text-xs text-success font-semibold mt-0.5">✓ Terminée — {done}/{total} leçons</p>
                      </div>
                    </div>
                    <div className="cx-progress-bar mb-4">
                      <div className="cx-progress-bar-fill bg-success" style={{ width: '100%' }} />
                    </div>
                    <div className="flex gap-2">
                      <Link
                        href={continueUrl}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-light border border-black/[0.08] text-cx-gray font-semibold rounded-cx hover:bg-white transition-colors text-sm"
                      >
                        Revoir
                      </Link>
                      {cert ? (
                        <Link
                          href={`/certificates/${cert.id}`}
                          className="flex items-center gap-1.5 px-4 py-2.5 bg-success/10 text-success font-semibold rounded-cx hover:bg-success/20 transition-colors text-sm"
                        >
                          <Award className="w-4 h-4" /> Certificat
                        </Link>
                      ) : (
                        <Link
                          href={`/certificate/${c.slug}`}
                          className="flex items-center gap-1.5 px-4 py-2.5 bg-success text-white font-semibold rounded-cx hover:bg-success/90 transition-colors text-sm"
                        >
                          <Award className="w-4 h-4" /> Obtenir
                        </Link>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Empty state */}
        {progressData.length === 0 && (
          <div className="cx-card p-10 text-center mb-10">
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
        )}

        {/* ── Certificates ───────────────────────────────────────── */}
        {(certs ?? []).length > 0 && (
          <section>
            <h2 className="text-lg font-extrabold text-dark mb-5 flex items-center gap-2">
              <Award className="w-4 h-4 text-amber-500" /> Mes certificats
            </h2>
            <div className="grid md:grid-cols-2 gap-4">
              {(certs ?? []).map((certRaw) => {
                const cert = certRaw as unknown as {
                  id: string
                  certificate_number: string
                  issued_at: string
                  pdf_url?: string | null
                  courses: { title: string; slug: string }
                }
                return (
                <div key={cert.id} className="cx-card p-5">
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shrink-0 shadow-sm">
                      <Award className="w-6 h-6 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-dark text-sm leading-tight">{cert.courses?.title}</p>
                      <p className="text-xs text-cx-gray mt-0.5 font-mono">{cert.certificate_number}</p>
                      <p className="text-xs text-cx-gray mt-0.5">Délivré le {formatDateFR(cert.issued_at)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      href={`/certificates/${cert.id}`}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      <Award className="w-3.5 h-3.5" /> Voir le certificat
                    </Link>
                    <Link
                      href={`/verify-certificate/${cert.id}`}
                      target="_blank"
                      className="flex items-center gap-1.5 px-3 py-2 bg-light border border-black/[0.08] text-cx-gray text-xs font-semibold rounded-lg hover:bg-white transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Vérifier
                    </Link>
                    {cert.pdf_url && (
                      <a
                        href={cert.pdf_url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-2 bg-success/10 text-success text-xs font-semibold rounded-lg hover:bg-success/20 transition-colors"
                      >
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              )})}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
