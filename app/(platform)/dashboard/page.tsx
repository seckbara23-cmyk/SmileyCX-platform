import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BookOpen, Award, ArrowRight, Play, CheckCircle, ClipboardList, Star, ExternalLink, Mail, AlertTriangle, Compass } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import ResendVerificationButton from './ResendVerificationButton'
import type { Metadata } from 'next'

/** One row of the learner-safe `my_course_access` view (migration 037). */
interface CourseAccessRow {
  course_id:    string
  has_access:   boolean
  access_ended: boolean
}

export const metadata: Metadata = { title: 'Mon Espace' }

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(dateStr))
}

type NextStep = 'lesson' | 'quiz' | 'final-exam' | 'certificate' | 'done'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // XPA-6A: the dashboard is a learner's own space and always requires a
  // session. It previously sent anonymous visitors to /courses in pilot mode,
  // which quietly turned "you are not signed in" into "here is the catalogue".
  if (!user) redirect('/login?next=/dashboard')

  // ── XPA-6B: "Mes formations" is driven by ENTITLEMENTS ─────────────────
  // Q-L: an enrollment is an academic transcript, not a key. Listing
  // enrollments here would show a learner courses they can no longer open —
  // which is precisely the confusion the separation exists to prevent. The
  // enrollment is still what carries their progress; it is simply not what
  // decides whether the course appears.
  const [{ data: profile }, { data: accessRows }, { data: enrollments }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    // The learner-safe view, NOT the entitlements table — that one is revoked
    // from every app role and would return 42501. The view carries no
    // provenance, no dates and no revocation reasons; it answers "may I open
    // this course, and did an access of mine end?" and nothing more.
    supabase.from('my_course_access').select('course_id, has_access, access_ended'),
    supabase
      .from('enrollments')
      .select('*, courses(*, modules(id, lessons(id)))')
      .eq('user_id', user.id)
      .order('enrolled_at', { ascending: false }),
  ])

  if (!profile) redirect('/login')

  const access = (accessRows ?? []) as CourseAccessRow[]
  const accessibleCourseIds = new Set(access.filter(a => a.has_access).map(a => a.course_id))
  // Surfaced separately rather than silently vanishing: access disappearing
  // with no explanation reads as a bug.
  const lapsed = access.filter(a => !a.has_access && a.access_ended)

  // Progress is computed only for courses the learner may currently open.
  const activeEnrollments = (enrollments ?? []).filter(
    (e: { course_id: string }) => accessibleCourseIds.has(e.course_id),
  )

  const progressData = await Promise.all(
    activeEnrollments.map(async (e: {
      id: string
      course_id: string
      enrolled_at: string
      courses: { id: string; slug: string; title: string; cover_url?: string; modules: { id: string; lessons: { id: string }[] }[] } | null
    }) => {
      if (!e.courses) {
        return { enrollment: e, total: 0, completed: 0, percentage: 0, continueUrl: '/courses', nextStep: 'lesson' as NextStep }
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
      let smartContinueUrl: string | null = null
      let nextStep: NextStep = 'lesson'

      if (!PILOT_MODE && total > 0) {
        const modIds = (e.courses.modules ?? []).map((m: { id: string }) => m.id)
        const modQuizData = modIds.length > 0
          ? (await supabase.from('quizzes').select('id, module_id').in('module_id', modIds)).data
          : []
        const { data: finalExamData } = await supabase
          .from('quizzes').select('id').eq('course_id', e.courses.id).is('module_id', null).limit(1).maybeSingle()

        const modQuizzes = (modQuizData ?? []) as { id: string; module_id: string }[]
        const allQuizIds = [
          ...modQuizzes.map(q => q.id),
          ...(finalExamData ? [finalExamData.id] : []),
        ]

        if (allQuizIds.length > 0) {
          const { data: passedAttempts } = await supabase
            .from('quiz_attempts').select('quiz_id').eq('user_id', user.id).eq('passed', true).in('quiz_id', allQuizIds)
          const passedIds = new Set((passedAttempts ?? []).map((a: { quiz_id: string }) => a.quiz_id))
          total     += allQuizIds.length
          completed += allQuizIds.filter(id => passedIds.has(id)).length

          if (lessonIdList.every(id => completedSet.has(id))) {
            const pendingModQuiz = modQuizzes.find(q => !passedIds.has(q.id))
            if (pendingModQuiz) {
              smartContinueUrl = `/learn/${e.courses.slug}/${pendingModQuiz.module_id}/quiz`
              nextStep = 'quiz'
            } else if (finalExamData && !passedIds.has(finalExamData.id)) {
              smartContinueUrl = `/learn/${e.courses.slug}/final-exam`
              nextStep = 'final-exam'
            } else {
              smartContinueUrl = `/certificate/${e.courses.slug}`
              nextStep = 'certificate'
            }
          }
        }
      }

      const firstIncomplete = lessonIds.find(x => !completedSet.has(x.lessonId))
      const targetLesson    = firstIncomplete ?? lessonIds[0]
      const continueUrl = smartContinueUrl ?? (targetLesson
        ? `/learn/${e.courses.slug}/${targetLesson.moduleId}/${targetLesson.lessonId}`
        : `/courses/${e.courses.slug}`)

      return {
        enrollment: e,
        total,
        completed,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        continueUrl,
        nextStep,
      }
    })
  )

  const { data: certs } = await supabase
    .from('certificates')
    .select('id, certificate_number, issued_at, pdf_url, courses(title, slug)')
    .eq('user_id', user.id)
    .order('issued_at', { ascending: false })

  const courseTitleById = new Map(
    (enrollments ?? [])
      .filter((e: { courses: { title: string } | null }) => e.courses)
      .map((e: { course_id: string; courses: { title: string } }) => [e.course_id, e.courses.title]),
  )

  const firstName         = (profile.first_name || profile.full_name || profile.email).split(' ')[0]
  const emailVerified     = Boolean(user.email_confirmed_at)
  const accountStatus     = (profile.account_status as string | undefined) ?? 'active'
  const inProgress        = progressData.filter(p => p.percentage < 100)
  const completedCourses  = progressData.filter(p => p.percentage === 100)
  const totalStepsDone    = progressData.reduce((n, p) => n + p.completed, 0)

  return (
    <div className="bg-light min-h-screen py-8 md:py-10">
      <div className="cx-container max-w-5xl">

        {/* Welcome */}
        <div className="mb-6">
          <h1 className="text-xl md:text-2xl font-extrabold text-dark">Bonjour, {firstName} 👋</h1>
          <p className="text-sm text-cx-gray mt-0.5">Votre espace d&apos;apprentissage XP Client Academy</p>
        </div>

        {/* ── Account status (XPA-6A) ───────────────────────────────────────
            Stated plainly rather than inferred from an empty screen. A learner
            whose email is unverified or whose account is suspended should be
            told so, not left wondering why nothing works. */}
        {!emailVerified && (
          <div className="cx-card p-4 mb-4 border-amber-300 bg-amber-50/60">
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-dark text-sm mb-1">Confirmez votre adresse email</p>
                <p className="text-xs text-cx-gray leading-relaxed mb-2">
                  Votre adresse <strong className="text-dark">{profile.email}</strong> n&apos;a pas
                  encore été confirmée. La confirmation est nécessaire pour accéder au contenu des
                  formations.
                </p>
                <ResendVerificationButton email={profile.email} />
              </div>
            </div>
          </div>
        )}

        {accountStatus !== 'active' && (
          <div className="cx-card p-4 mb-4 border-red-300 bg-red-50/60">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-dark text-sm mb-1">Compte {accountStatus === 'suspended' ? 'suspendu' : 'désactivé'}</p>
                <p className="text-xs text-cx-gray leading-relaxed">
                  Votre compte n&apos;est pas actif. Contactez-nous pour rétablir votre accès.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Stats strip */}
        <div className="cx-card flex divide-x divide-black/[0.06] mb-7 overflow-hidden">
          {([
            { Icon: BookOpen,    value: enrollments?.length ?? 0, label: 'Formation(s)',      color: 'text-primary' },
            { Icon: Play,        value: totalStepsDone,            label: 'Étapes complétées', color: 'text-secondary' },
            { Icon: Award,       value: certs?.length ?? 0,        label: 'Certificat(s)',     color: 'text-amber-500' },
            { Icon: CheckCircle, value: completedCourses.length,   label: 'Terminée(s)',       color: 'text-success' },
          ] as const).map(({ Icon, value, label, color }) => (
            <div key={label} className="flex-1 flex items-center gap-2.5 px-3 sm:px-5 py-4 min-w-0">
              <Icon className={`w-4 h-4 shrink-0 ${color}`} />
              <div className="min-w-0">
                <p className="text-base font-extrabold text-dark leading-none">{value}</p>
                <p className="text-[11px] text-cx-gray mt-0.5 truncate">{label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── In Progress ────────────────────────────────────────── */}
        {inProgress.length > 0 && (
          <section className="mb-7">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-extrabold text-dark flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-primary" /> En cours
              </h2>
              <Link href="/courses" className="text-xs text-primary font-semibold hover:underline flex items-center gap-1">
                Voir les formations <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {inProgress.map(({ enrollment, total, completed: done, percentage, continueUrl, nextStep }) => {
                const c = enrollment.courses
                if (!c) return null

                const CtaIcon = nextStep === 'quiz'          ? ClipboardList
                              : nextStep === 'final-exam'    ? Star
                              : nextStep === 'certificate'   ? Award
                              : Play
                const ctaLabel = percentage === 0              ? 'Commencer'
                               : nextStep === 'quiz'           ? 'Passer le quiz'
                               : nextStep === 'final-exam'     ? 'Passer l\'examen final'
                               : nextStep === 'certificate'    ? 'Obtenir le certificat'
                               : 'Continuer'
                const ctaClass = nextStep === 'quiz'        ? 'bg-secondary'
                               : nextStep === 'final-exam'  ? 'bg-gradient-to-r from-amber-600 to-amber-400'
                               : nextStep === 'certificate' ? 'bg-success'
                               : 'bg-primary'
                const stepChip = nextStep === 'quiz'        ? { label: 'Quiz requis',          cls: 'text-secondary bg-secondary/10' }
                               : nextStep === 'final-exam'  ? { label: 'Examen final',          cls: 'text-amber-600 bg-amber-100' }
                               : nextStep === 'certificate' ? { label: 'Certificat prêt',       cls: 'text-success bg-green-50' }
                               : percentage === 0           ? { label: 'Non commencée',         cls: 'text-cx-gray bg-light border border-black/[0.08]' }
                               :                              { label: 'En cours',               cls: 'text-primary bg-primary/10' }

                return (
                  <div key={enrollment.id} className="cx-card p-4">
                    <div className="flex items-start gap-2 mb-2.5">
                      <p className="font-bold text-dark text-sm leading-snug flex-1 min-w-0">{c.title}</p>
                      <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${stepChip.cls}`}>
                        {stepChip.label}
                      </span>
                    </div>
                    <div className="mb-3">
                      <div className="flex justify-between text-xs text-cx-gray mb-1">
                        <span>{done} / {total} étapes</span>
                        <span className="font-semibold text-primary">{percentage}%</span>
                      </div>
                      <div className="cx-progress-bar">
                        <div className="cx-progress-bar-fill" style={{ width: `${percentage}%` }} />
                      </div>
                    </div>
                    <Link
                      href={continueUrl}
                      className={`flex items-center justify-center gap-2 px-4 py-2 text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm w-full ${ctaClass}`}
                    >
                      <CtaIcon className="w-3.5 h-3.5" />
                      {ctaLabel}
                    </Link>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── Completed ──────────────────────────────────────────── */}
        {completedCourses.length > 0 && (
          <section className="mb-7">
            <h2 className="text-sm font-extrabold text-dark flex items-center gap-1.5 mb-3">
              <CheckCircle className="w-3.5 h-3.5 text-success" /> Formations terminées
            </h2>
            <div className="grid md:grid-cols-2 gap-3">
              {completedCourses.map(({ enrollment, total, completed: done, continueUrl }) => {
                const c = enrollment.courses
                if (!c) return null
                const cert = (certs ?? []).find(ct => {
                  const ctCourses = ct.courses as unknown as { slug: string } | null
                  return ctCourses?.slug === c.slug
                })
                return (
                  <div key={enrollment.id} className="cx-card p-4 border-success/25">
                    <div className="flex items-start gap-2 mb-2.5">
                      <p className="font-bold text-dark text-sm leading-snug flex-1">{c.title}</p>
                      <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full text-success bg-green-50">
                        Terminée
                      </span>
                    </div>
                    <p className="text-xs text-success font-medium mb-3">{done} / {total} étapes complétées</p>
                    <div className="flex gap-2">
                      <Link
                        href={continueUrl}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-light border border-black/[0.08] text-cx-gray font-semibold rounded-cx hover:bg-white transition-colors text-sm"
                      >
                        Revoir
                      </Link>
                      {cert ? (
                        <Link
                          href={`/certificates/${cert.id}`}
                          className="flex items-center gap-1.5 px-3 py-2 bg-success/10 text-success font-semibold rounded-cx hover:bg-success/20 transition-colors text-sm"
                        >
                          <Award className="w-3.5 h-3.5" /> Certificat
                        </Link>
                      ) : (
                        <Link
                          href={`/certificate/${c.slug}`}
                          className="flex items-center gap-1.5 px-3 py-2 bg-success text-white font-semibold rounded-cx hover:bg-success/90 transition-colors text-sm"
                        >
                          <Award className="w-3.5 h-3.5" /> Obtenir
                        </Link>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── Empty state (XPA-6A) ───────────────────────────────────────────
            Honest and commercial. It says "you are not enrolled", not "browse
            the catalogue", because a published course is NOT an accessible one:
            having an account and having access are separate facts, and a
            dashboard that blurs them sets up a support ticket. */}
        {progressData.length === 0 && (
          <div className="cx-card p-8 text-center mb-7">
            <BookOpen className="w-10 h-10 text-primary/30 mx-auto mb-3" />
            <h3 className="font-bold text-dark mb-1.5">
              Vous n&apos;êtes inscrit à aucune formation
            </h3>
            <p className="text-sm text-cx-gray mb-1.5 max-w-md mx-auto leading-relaxed">
              Votre compte est créé, mais l&apos;accès à une formation est activé séparément.
            </p>
            <p className="text-xs text-cx-gray/80 mb-5 max-w-md mx-auto leading-relaxed">
              Parcourez le catalogue pour choisir une formation, puis contactez-nous pour
              activer votre accès.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              <Link
                href="/courses"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all text-sm"
              >
                Voir les formations <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/parcours"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-light border border-black/[0.08] text-cx-gray font-semibold rounded-cx hover:bg-white transition-colors text-sm"
              >
                <Compass className="w-4 h-4" /> Les parcours
              </Link>
            </div>
          </div>
        )}

        {/* ── Lapsed access (XPA-6B) ──────────────────────────────────────
            An expired or revoked access disappearing without explanation reads
            as a bug. Naming it — and saying the progress is kept — is the whole
            point of separating the two lifecycles (Q-L). */}
        {lapsed.length > 0 && (
          <section className="mb-7">
            <h2 className="text-sm font-extrabold text-dark mb-3">Accès terminés</h2>
            <div className="grid md:grid-cols-2 gap-3">
              {lapsed.map(a => (
                <div key={a.course_id} className="cx-card p-4 border-black/[0.08]">
                  <p className="font-bold text-dark text-sm leading-snug mb-1">
                    {courseTitleById.get(a.course_id) ?? 'Formation'}
                  </p>
                  <p className="text-xs text-cx-gray leading-relaxed mb-2">
                    Votre accès à cette formation n&apos;est plus actif.
                  </p>
                  <p className="text-[11px] text-cx-gray/80 leading-relaxed">
                    Votre progression, vos résultats et vos certificats sont conservés.
                    Contactez-nous pour rétablir votre accès.
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Certificates empty state — shown only once there is nothing else to
            report, so the page never looks empty AND silent at the same time. */}
        {progressData.length === 0 && (certs ?? []).length === 0 && (
          <div className="cx-card p-5 text-center">
            <Award className="w-7 h-7 text-amber-500/30 mx-auto mb-2" />
            <p className="text-sm font-bold text-dark mb-0.5">Aucun certificat</p>
            <p className="text-xs text-cx-gray">
              Vos certificats apparaîtront ici une fois une formation terminée.
            </p>
          </div>
        )}

        {/* ── Certificates ───────────────────────────────────────── */}
        {(certs ?? []).length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold text-dark mb-3 flex items-center gap-1.5">
              <Award className="w-3.5 h-3.5 text-amber-500" /> Mes certificats
            </h2>
            <div className="grid md:grid-cols-2 gap-3">
              {(certs ?? []).map((certRaw) => {
                const cert = certRaw as unknown as {
                  id: string; certificate_number: string; issued_at: string; pdf_url?: string | null
                  courses: { title: string; slug: string }
                }
                return (
                  <div key={cert.id} className="cx-card p-4">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shrink-0">
                        <Award className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-dark text-sm leading-tight truncate">{cert.courses?.title}</p>
                        <p className="text-[11px] text-cx-gray mt-0.5 font-mono">{cert.certificate_number}</p>
                        <p className="text-[11px] text-cx-gray">Délivré le {formatDateFR(cert.issued_at)}</p>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Link
                        href={`/certificates/${cert.id}`}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition-colors"
                      >
                        <Award className="w-3 h-3" /> Voir
                      </Link>
                      <Link
                        href={`/verify-certificate/${cert.id}`}
                        target="_blank"
                        className="flex items-center gap-1 px-3 py-1.5 bg-light border border-black/[0.08] text-cx-gray text-xs font-semibold rounded-lg hover:bg-white transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" /> Vérifier
                      </Link>
                      {cert.pdf_url && (
                        <a
                          href={cert.pdf_url}
                          download
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 px-3 py-1.5 bg-success/10 text-success text-xs font-semibold rounded-lg hover:bg-success/20 transition-colors"
                        >
                          PDF
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
