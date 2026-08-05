import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { Mic, AlertTriangle, CheckCircle2, CircleDashed, Users, RotateCcw } from 'lucide-react'

/**
 * Voice Practice administration and instructor reporting (XPA-5).
 *
 * Read-only in this phase, matching /admin/catalogue. It makes the scenario
 * inventory and learner activity visible so an administrator can see exactly
 * which exercises are live, which are waiting on an ElevenLabs agent, and how
 * learners are doing. Editing (agent id, prompt, publish) is the next step and
 * is deliberately not bolted on here without its own review.
 *
 * Reuses the existing tables — ai_scenarios / ai_sessions / ai_turns /
 * ai_feedback / ai_scores. No new reporting store, no duplicated model.
 *
 * Authorization is the platform standard: requirePlatformAdmin() server-side.
 */

export const dynamic = 'force-dynamic'

const DIFFICULTY_STYLE: Record<string, string> = {
  facile:        'bg-green-100 text-green-700',
  intermediaire: 'bg-amber-100 text-amber-700',
  avance:        'bg-red-100 text-red-700',
}

export default async function VoiceAdminPage() {
  await requirePlatformAdmin()
  const db = createAdminClient()

  const [{ data: scenarios }, { data: sessions }, { data: feedback }] = await Promise.all([
    db.from('ai_scenarios').select('*').order('slug'),
    db.from('ai_sessions').select('id, scenario_id, status, user_id, anon_id, created_at, duration_seconds'),
    db.from('ai_feedback').select('session_id, source'),
  ])

  if (!scenarios) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-extrabold text-dark mb-2">Voice Practice</h1>
        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>Tables Voice Practice indisponibles — migrations 024–026 non appliquées.</p>
        </div>
      </div>
    )
  }

  // Resolve each scenario's lesson → module → course for context.
  const lessonIds = Array.from(new Set(scenarios.map(s => s.lesson_id as string).filter(Boolean)))
  const { data: lessons } = lessonIds.length
    ? await db.from('lessons').select('id, title, module_id').in('id', lessonIds)
    : { data: [] as { id: string; title: string; module_id: string }[] }

  const moduleIds = Array.from(new Set((lessons ?? []).map(l => l.module_id as string)))
  const { data: modules } = moduleIds.length
    ? await db.from('modules').select('id, title, order_index, course_id').in('id', moduleIds)
    : { data: [] as { id: string; title: string; order_index: number; course_id: string }[] }

  const courseIds = Array.from(new Set((modules ?? []).map(m => m.course_id as string)))
  const { data: courses } = courseIds.length
    ? await db.from('courses').select('id, code, title').in('id', courseIds)
    : { data: [] as { id: string; code: string | null; title: string }[] }

  const lessonById = new Map((lessons ?? []).map(l => [l.id as string, l]))
  const moduleById = new Map((modules ?? []).map(m => [m.id as string, m]))
  const courseById = new Map((courses ?? []).map(c => [c.id as string, c]))

  const sessionsByScenario = new Map<string, typeof sessions>()
  for (const s of sessions ?? []) {
    const arr = sessionsByScenario.get(s.scenario_id as string) ?? []
    arr.push(s)
    sessionsByScenario.set(s.scenario_id as string, arr as typeof sessions)
  }
  const feedbackSessions = new Set((feedback ?? []).map(f => f.session_id as string))

  const live      = scenarios.filter(s => s.is_published && s.agent_id)
  const awaiting  = scenarios.filter(s => !s.agent_id)
  const totalSess = (sessions ?? []).length
  const completed = (sessions ?? []).filter(s => s.status === 'completed').length

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-dark">
          <Mic className="w-5 h-5 text-primary" aria-hidden /> Voice Practice
        </h1>
        <p className="text-sm text-cx-gray mt-1">
          Exercices vocaux par leçon — inventaire et activité des apprenants. Lecture seule.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Scénarios',            value: scenarios.length },
          { label: 'En ligne',             value: live.length },
          { label: 'Sessions',             value: totalSess },
          { label: 'Sessions terminées',   value: completed },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-black/[0.07] bg-white p-4">
            <p className="text-2xl font-extrabold text-dark">{s.value}</p>
            <p className="text-xs text-cx-gray mt-0.5">{s.label}</p>
          </div>
        ))}
      </section>

      {awaiting.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-amber-900 mb-2">
            <AlertTriangle className="w-4 h-4" aria-hidden />
            En attente d&apos;un agent ElevenLabs ({awaiting.length})
          </h2>
          <p className="text-xs text-amber-900/80">
            Ces scénarios sont configurés mais restent invisibles pour les apprenants tant qu&apos;un
            agent n&apos;est pas associé. Un scénario publié sans agent afficherait un exercice cassé.
          </p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-dark uppercase tracking-wide">Scénarios</h2>

        {scenarios.map(s => {
          const lesson = lessonById.get(s.lesson_id as string)
          const mod    = lesson ? moduleById.get(lesson.module_id as string) : undefined
          const course = mod ? courseById.get(mod.course_id as string) : undefined
          const sess   = sessionsByScenario.get(s.id as string) ?? []
          const done   = sess.filter(x => x.status === 'completed')
          const learners = new Set(sess.map(x => (x.user_id as string) ?? `anon:${x.anon_id}`)).size
          // Retries: sessions beyond the first, per learner.
          const retries = Math.max(0, sess.length - learners)
          const withFeedback = sess.filter(x => feedbackSessions.has(x.id as string)).length
          const rate = sess.length > 0 ? Math.round((done.length / sess.length) * 100) : 0

          return (
            <div key={s.id as string} className="rounded-xl border border-black/[0.07] bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-black/[0.06] flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-dark text-sm">{s.title as string}</p>
                    {s.difficulty ? (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${DIFFICULTY_STYLE[s.difficulty as string] ?? 'bg-gray-100 text-gray-600'}`}>
                        {s.difficulty as string}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-cx-gray mt-0.5 font-mono">{s.slug as string}</p>
                  <p className="text-xs text-cx-gray mt-1">
                    {course ? `${course.code ?? ''} · ` : ''}
                    {mod ? `Module ${mod.order_index} · ` : ''}
                    {lesson ? (lesson.title as string) : <span className="text-red-600">leçon introuvable</span>}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {s.agent_id
                    ? <span className="inline-flex items-center gap-1 text-[11px] text-green-700"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> agent</span>
                    : <span className="inline-flex items-center gap-1 text-[11px] text-amber-700"><CircleDashed className="w-3.5 h-3.5" aria-hidden /> pas d&apos;agent</span>}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${s.is_published ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {s.is_published ? 'publié' : 'brouillon'}
                  </span>
                </div>
              </div>

              <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div><p className="text-cx-gray">Sessions</p><p className="font-bold text-dark">{sess.length}</p></div>
                <div><p className="text-cx-gray">Terminées</p><p className="font-bold text-dark">{done.length}</p></div>
                <div className="flex flex-col"><p className="text-cx-gray flex items-center gap-1"><Users className="w-3 h-3" aria-hidden />Apprenants</p><p className="font-bold text-dark">{learners}</p></div>
                <div className="flex flex-col"><p className="text-cx-gray flex items-center gap-1"><RotateCcw className="w-3 h-3" aria-hidden />Reprises</p><p className="font-bold text-dark">{retries}</p></div>
                <div><p className="text-cx-gray">Avec feedback</p><p className="font-bold text-dark">{withFeedback}</p></div>
              </div>

              {sess.length > 0 && (
                <div className="px-4 pb-3">
                  <div className="cx-progress-bar"><div className="cx-progress-bar-fill" style={{ width: `${rate}%` }} /></div>
                  <p className="text-[11px] text-cx-gray mt-1">{rate}% de sessions menées à leur terme</p>
                </div>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
