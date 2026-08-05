import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import {
  ArrowLeft, Shield, User, BookOpen, Award, GraduationCap,
  CheckCircle, Circle, ClipboardList, Trash2, Clock, TrendingUp,
  ExternalLink,
} from 'lucide-react'
import { notFound } from 'next/navigation'
import { deleteUser } from './actions'
import type { Metadata } from 'next'
import { PUBLIC_SITE_URL } from '@/lib/brand'

export const metadata: Metadata = { title: 'Admin — Profil apprenant' }

// ── Shared badge helpers ──────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  if (role === 'super_admin')
    return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-secondary/10 text-secondary-dark"><Shield className="w-3 h-3" /> Super Admin</span>
  if (role === 'consultant')
    return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-primary/10 text-primary"><User className="w-3 h-3" /> Consultant</span>
  return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Apprenant</span>
}

function EnrollBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:    'bg-green-100 text-green-700',
    expired:   'bg-gray-100 text-gray-500',
    suspended: 'bg-red-100 text-red-600',
  }
  const labels: Record<string, string> = { active: 'Actif', expired: 'Expiré', suspended: 'Suspendu' }
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>{labels[status] ?? status}</span>
}

function CertStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    valid:     'bg-green-100 text-green-700',
    revoked:   'bg-red-100 text-red-600',
    pilot:     'bg-amber-100 text-amber-700',
    duplicate: 'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = { valid: 'Valide', revoked: 'Révoqué', pilot: 'Pilote', duplicate: 'Doublon' }
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>{labels[status] ?? status}</span>
}

function ProgressBar({ pct, color = 'bg-primary' }: { pct: number; color?: string }) {
  return (
    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  color: string
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-2 ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <p className="text-xl font-extrabold text-gray-900">{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{label}</p>
    </div>
  )
}

// XPA-1: certificate links must resolve on the PUBLIC academy domain.
// This previously defaulted to the private admin portal host, so a shared
// certificate link sent recipients to a page that redirects them to /login.
const SITE_URL = PUBLIC_SITE_URL

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function AdminUserDetailPage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()
  const userId = params.id

  // ── All data in parallel ────────────────────────────────────────────────
  const [
    { data: userRaw },
    { data: enrollmentsRaw },
    { data: lessonProgressRaw },
    { data: quizAttemptsRaw },
    { data: certsRaw },
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, full_name, platform_role, created_at')
      .eq('id', userId)
      .single(),

    supabase
      .from('enrollments')
      .select(`id, status, enrolled_at, course_id,
        courses(id, title, slug,
          modules(id, title, order_index,
            lessons(id, title, order_index)))`)
      .eq('user_id', userId)
      .order('enrolled_at', { ascending: false }),

    supabase
      .from('lesson_progress')
      .select('lesson_id, is_completed, completed_at')
      .eq('user_id', userId)
      .eq('is_completed', true),

    supabase
      .from('quiz_attempts')
      .select('module_id, score, passed, created_at')
      .eq('user_id', userId)
      .order('score', { ascending: false }),

    supabase
      .from('certificates')
      .select('id, certificate_number, issued_at, status, pdf_url, course_id, courses(title, slug)')
      .eq('user_id', userId)
      .order('issued_at', { ascending: false }),
  ])

  if (!userRaw) notFound()

  // ── Typed helpers ────────────────────────────────────────────────────────

  interface LessonRaw  { id: string; title: string; order_index: number }
  interface ModuleRaw  { id: string; title: string; order_index: number; lessons: LessonRaw[] }
  interface CourseRaw  { id: string; title: string; slug: string; modules: ModuleRaw[] }
  interface EnrollRaw  { id: string; status: string; enrolled_at: string; course_id: string; courses: CourseRaw | null }

  function normArr<T>(v: unknown): T {
    if (Array.isArray(v)) return (v[0] as T) ?? null as T
    return v as T
  }

  const enrollments: EnrollRaw[] = (enrollmentsRaw ?? []).map(e => {
    const er = e as Record<string, unknown>
    const course = normArr<CourseRaw | null>(er.courses)
    const courseUnknown = course as unknown as Record<string, unknown> | null
    const modules: ModuleRaw[] = courseUnknown
      ? (Array.isArray(courseUnknown.modules)
          ? (courseUnknown.modules as Record<string, unknown>[]).map(m => ({
              id:          m.id as string,
              title:       m.title as string,
              order_index: m.order_index as number,
              lessons:     Array.isArray(m.lessons)
                ? (m.lessons as Record<string, unknown>[]).map(l => ({
                    id:          l.id as string,
                    title:       l.title as string,
                    order_index: l.order_index as number,
                  }))
                : [],
            }))
          : [])
      : []
    return {
      id:          er.id as string,
      status:      er.status as string,
      enrolled_at: er.enrolled_at as string,
      course_id:   er.course_id as string,
      courses:     course ? { ...course, modules } : null,
    }
  })

  // Lesson completion set
  const completedSet = new Set((lessonProgressRaw ?? []).map(p => p.lesson_id))
  const completedAtMap: Record<string, string> = {}
  for (const p of lessonProgressRaw ?? []) {
    if (p.completed_at) completedAtMap[p.lesson_id] = p.completed_at
  }

  // Best quiz score per module (highest score wins)
  const bestQuizByModule: Record<string, { score: number; passed: boolean }> = {}
  for (const a of quizAttemptsRaw ?? []) {
    if (!a.module_id) continue
    const existing = bestQuizByModule[a.module_id]
    if (!existing || (a.score as number) > existing.score) {
      bestQuizByModule[a.module_id] = { score: a.score as number, passed: a.passed as boolean }
    }
  }

  // Certs indexed by course_id
  const certByCourseId: Record<string, { id: string; certificate_number: string; issued_at: string; status: string; pdf_url: string | null }> = {}
  for (const c of certsRaw ?? []) {
    certByCourseId[(c as Record<string, unknown>).course_id as string] = {
      id:                 (c as Record<string, unknown>).id as string,
      certificate_number: (c as Record<string, unknown>).certificate_number as string,
      issued_at:          (c as Record<string, unknown>).issued_at as string,
      status:             ((c as Record<string, unknown>).status as string) ?? 'valid',
      pdf_url:            (c as Record<string, unknown>).pdf_url as string | null,
    }
  }

  // Fetch modules that have quizzes (for those enrolled courses)
  const allModuleIds = enrollments.flatMap(e => (e.courses?.modules ?? []).map(m => m.id))
  const { data: quizModulesRaw } = allModuleIds.length > 0
    ? await supabase.from('quizzes').select('module_id').in('module_id', allModuleIds)
    : { data: [] }
  const quizModuleSet = new Set((quizModulesRaw ?? []).map(q => q.module_id as string))

  // ── Compute per-enrollment stats ─────────────────────────────────────────

  const courseStats = enrollments.map(e => {
    const course  = e.courses
    const modules = (course?.modules ?? [])
      .sort((a, b) => a.order_index - b.order_index)
      .map(mod => {
        const lessons = [...mod.lessons].sort((a, b) => a.order_index - b.order_index)
        const completedLessons = lessons.filter(l => completedSet.has(l.id))
        const hasQuiz  = quizModuleSet.has(mod.id)
        const quizBest = bestQuizByModule[mod.id] ?? null
        const lastLessonActivity = completedLessons.reduce<Date | null>((max, l) => {
          const at = completedAtMap[l.id] ? new Date(completedAtMap[l.id]) : null
          return at && (!max || at > max) ? at : max
        }, null)
        return {
          mod,
          lessons,
          completedCount: completedLessons.length,
          totalCount:     lessons.length,
          hasQuiz,
          quizBest,
          lastActivity:   lastLessonActivity,
        }
      })

    const totalLessons     = modules.reduce((s, m) => s + m.totalCount, 0)
    const completedLessons = modules.reduce((s, m) => s + m.completedCount, 0)
    const completedModules = modules.filter(m => m.completedCount === m.totalCount && m.totalCount > 0).length
    const percentage       = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0
    const cert             = certByCourseId[e.course_id] ?? null

    return { enrollment: e, course, modules, totalLessons, completedLessons, completedModules, percentage, cert }
  })

  // Overall stats
  const totalEnrolled   = enrollments.length
  const totalCompleted  = courseStats.filter(cs => cs.percentage === 100).length
  const totalLessons    = courseStats.reduce((s, cs) => s + cs.totalLessons, 0)
  const doneAll         = courseStats.reduce((s, cs) => s + cs.completedLessons, 0)
  const totalCerts      = (certsRaw ?? []).length
  const avgPct          = courseStats.length > 0
    ? Math.round(courseStats.reduce((s, cs) => s + cs.percentage, 0) / courseStats.length)
    : 0

  // Last activity across all courses
  const allCompletedDates = Object.values(completedAtMap).map(d => new Date(d))
  const lastActivity = allCompletedDates.length > 0
    ? new Date(Math.max(...allCompletedDates.map(d => d.getTime())))
    : null

  const joinedDate = new Date(userRaw.created_at).toLocaleDateString('fr-FR', { dateStyle: 'long' })

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Back */}
      <Link href="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Retour aux utilisateurs
      </Link>

      {/* ── Profile header ───────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-xl font-bold shrink-0">
              {(userRaw.full_name || userRaw.email || '?').charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-gray-900">{userRaw.full_name || '—'}</h1>
              <p className="text-sm text-gray-500">{userRaw.email}</p>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-xs text-gray-400">Inscrit le {joinedDate}</p>
                {lastActivity && (
                  <p className="text-xs text-gray-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Actif le {lastActivity.toLocaleDateString('fr-FR')}
                  </p>
                )}
              </div>
            </div>
          </div>
          <RoleBadge role={userRaw.platform_role} />
        </div>
      </div>

      {/* ── Stats cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard icon={BookOpen}     label="Inscriptions"   value={totalEnrolled}  color="text-primary bg-primary/10" />
        <StatCard icon={CheckCircle}  label="Terminées"      value={totalCompleted} color="text-success bg-success/10" />
        <StatCard icon={TrendingUp}   label="Leçons faites"  value={doneAll}        color="text-secondary bg-secondary/10" />
        <StatCard icon={GraduationCap} label="Certificats"   value={totalCerts}     color="text-amber-600 bg-amber-100" />
        <StatCard icon={TrendingUp}   label="Progression moy." value={totalLessons > 0 ? `${avgPct}%` : '—'} color="text-cx-gray bg-gray-100" />
      </div>

      {/* ── Course progression ───────────────────────────────────────── */}
      {courseStats.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Aucune inscription à une formation.</p>
        </div>
      ) : (
        <section className="space-y-4">
          <h2 className="text-sm font-extrabold text-gray-700 uppercase tracking-wider">Progression par formation</h2>

          {courseStats.map(({ enrollment, course, modules, totalLessons: tl, completedLessons: cl, completedModules, percentage, cert }) => (
            <div key={enrollment.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

              {/* Course header */}
              <div className="px-5 py-4 border-b border-gray-50">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-gray-900 text-sm">{course?.title ?? '—'}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <EnrollBadge status={enrollment.status} />
                      <span className="text-xs text-gray-400">
                        Inscrit le {new Date(enrollment.enrolled_at).toLocaleDateString('fr-FR')}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-2xl font-extrabold ${percentage === 100 ? 'text-success' : 'text-primary'}`}>
                      {percentage}%
                    </p>
                    <p className="text-[11px] text-gray-400">{cl}/{tl} leçons</p>
                  </div>
                </div>
                <ProgressBar pct={percentage} color={percentage === 100 ? 'bg-success' : 'bg-primary'} />
                <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                  <span>{completedModules}/{modules.length} modules</span>
                  {cert && (
                    <span className="flex items-center gap-1 text-amber-600 font-semibold">
                      <Award className="w-3 h-3" /> Certifié
                    </span>
                  )}
                </div>
              </div>

              {/* Module breakdown */}
              <div className="divide-y divide-gray-50">
                {modules.map(({ mod, lessons, completedCount, totalCount, hasQuiz, quizBest, lastActivity: modActivity }) => {
                  const modPct   = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
                  const allDone  = completedCount === totalCount && totalCount > 0

                  return (
                    <details key={mod.id} className="group">
                      <summary className="flex items-center justify-between gap-3 px-5 py-3 cursor-pointer hover:bg-gray-50/60 transition-colors list-none">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {allDone
                            ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
                            : <Circle className="w-4 h-4 text-gray-300 shrink-0" />
                          }
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              <span className="text-gray-400 mr-1.5">{mod.order_index}.</span>
                              {mod.title}
                            </p>
                            <div className="flex items-center gap-3 mt-0.5">
                              <div className="w-24 h-1 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${allDone ? 'bg-success' : 'bg-primary/60'}`} style={{ width: `${modPct}%` }} />
                              </div>
                              <span className="text-[11px] text-gray-400">{completedCount}/{totalCount} leçons</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {hasQuiz && (
                            quizBest ? (
                              <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${quizBest.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                                <ClipboardList className="w-3 h-3" />
                                {quizBest.passed ? `Quiz ${quizBest.score}%` : `Échoué ${quizBest.score}%`}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                                <ClipboardList className="w-3 h-3" /> Quiz
                              </span>
                            )
                          )}
                          <svg className="w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      </summary>

                      {/* Lesson list */}
                      <div className="bg-gray-50/50 border-t border-gray-100 divide-y divide-gray-100">
                        {lessons.length === 0 ? (
                          <p className="px-12 py-3 text-xs text-gray-400 italic">Aucune leçon dans ce module.</p>
                        ) : (
                          lessons.map(l => {
                            const done  = completedSet.has(l.id)
                            const donAt = completedAtMap[l.id]
                            return (
                              <div key={l.id} className="flex items-center gap-3 px-12 py-2.5">
                                {done
                                  ? <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                                  : <Circle className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                                }
                                <p className={`text-xs flex-1 ${done ? 'text-gray-700' : 'text-gray-400'}`}>
                                  {l.order_index}. {l.title}
                                </p>
                                {donAt && (
                                  <span className="text-[11px] text-gray-400 shrink-0">
                                    {new Date(donAt).toLocaleDateString('fr-FR')}
                                  </span>
                                )}
                              </div>
                            )
                          })
                        )}

                        {/* Quiz row inside module */}
                        {hasQuiz && (
                          <div className="flex items-center gap-3 px-12 py-2.5 bg-white/60">
                            <ClipboardList className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            <p className="text-xs text-gray-500 flex-1 italic">Quiz du module</p>
                            {quizBest ? (
                              <span className={`text-[11px] font-semibold ${quizBest.passed ? 'text-success' : 'text-red-500'}`}>
                                {quizBest.passed ? '✓ Réussi' : '✗ Échoué'} · {quizBest.score}%
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-400">Non tenté</span>
                            )}
                          </div>
                        )}

                        {modActivity && (
                          <div className="flex items-center gap-2 px-12 py-2 text-[11px] text-gray-400">
                            <Clock className="w-3 h-3" />
                            Dernière activité : {modActivity.toLocaleDateString('fr-FR')}
                          </div>
                        )}
                      </div>
                    </details>
                  )
                })}
              </div>

              {/* Certificate row */}
              {cert && (
                <div className="px-5 py-3 bg-amber-50/60 border-t border-amber-100 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Award className="w-4 h-4 text-amber-600" />
                    <div>
                      <p className="text-xs font-semibold text-amber-700">Certificat obtenu</p>
                      <p className="text-[11px] font-mono text-amber-600">{cert.certificate_number}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-400">{new Date(cert.issued_at).toLocaleDateString('fr-FR')}</span>
                    <CertStatusBadge status={cert.status} />
                    <Link href={`/admin/certificates/${cert.id}`} className="text-[11px] text-primary font-semibold hover:underline">
                      Voir →
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ── Certificates section ─────────────────────────────────────── */}
      {(certsRaw ?? []).length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-extrabold text-gray-700 uppercase tracking-wider">
            Certificats ({(certsRaw ?? []).length})
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {(certsRaw ?? []).map(rawCert => {
              const cert = rawCert as Record<string, unknown>
              const certCourse = Array.isArray(cert.courses)
                ? (cert.courses as { title: string; slug: string }[])[0] ?? null
                : cert.courses as { title: string; slug: string } | null
              const certId     = cert.id as string
              const certNum    = cert.certificate_number as string
              const issuedAt   = cert.issued_at as string
              const certStatus = (cert.status as string) ?? 'valid'
              const pdfUrl     = cert.pdf_url as string | null
              const certPageUrl = `${SITE_URL}/certificates/${certId}`
              const verifyUrl   = `${SITE_URL}/verify-certificate/${certId}`

              return (
                <div key={certId} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shrink-0 shadow-sm">
                      <Award className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800 truncate">{certCourse?.title ?? '—'}</p>
                      <p className="text-xs font-mono text-gray-500">{certNum}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[11px] text-gray-400">{new Date(issuedAt).toLocaleDateString('fr-FR')}</span>
                        <CertStatusBadge status={certStatus} />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={certPageUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-primary bg-primary/10 rounded-lg hover:bg-primary/20 transition-colors">
                      <ExternalLink className="w-3 h-3" /> Voir
                    </a>
                    <a href={verifyUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                      <ExternalLink className="w-3 h-3" /> Vérifier
                    </a>
                    {pdfUrl && (
                      <a href={pdfUrl} download target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-success bg-success/10 rounded-lg hover:bg-success/20 transition-colors">
                        PDF
                      </a>
                    )}
                    <Link href={`/admin/certificates/${certId}`}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                      Admin →
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Danger zone ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5 sm:p-6">
        <h2 className="font-bold text-gray-800 text-sm mb-1 flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-red-500" /> Zone de danger
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Supprimer cet utilisateur supprime son compte Supabase Auth, son profil et toutes ses données.
          Cette action est irréversible.
        </p>
        <form action={deleteUser}>
          <input type="hidden" name="userId" value={userRaw.id} />
          <button type="submit"
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors">
            Supprimer cet utilisateur
          </button>
        </form>
      </div>

    </div>
  )
}
