import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { deleteQuiz } from './actions'
import { createLogger } from '@/lib/logger'

export const metadata: Metadata = { title: 'Admin — Quiz' }

const log = createLogger('admin/quiz-detail')

export default async function AdminQuizDetailPage({
  params,
}: {
  params: { id: string }
}) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: quiz } = await supabase
    .from('quizzes')
    .select(`id, title, modules(title, courses(title)), lessons(title)`)
    .eq('id', params.id)
    .single()

  if (!quiz) notFound()

  const { data: questions, error: qErr } = await supabase
    .from('quiz_questions')
    .select('id, question, question_type, options, correct_answer, drag_match_answers, explanation, order_index')
    .eq('quiz_id', params.id)
    .order('order_index')

  if (qErr) {
    log.error({ quizId: params.id, error: qErr.message }, 'Failed to load quiz questions for detail page')
  }

  const mod    = quiz.modules as unknown as { title: string; courses: { title: string } | null } | null
  const lesson = quiz.lessons as unknown as { title: string } | null

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link
        href="/admin/quizzes"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux quiz
      </Link>

      {/* Header */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-extrabold text-gray-900">{quiz.title}</h1>
            <p className="text-sm text-gray-400 mt-1">
              {mod?.courses?.title ? `${mod.courses.title} › ` : ''}{mod?.title ?? lesson?.title ?? '—'}
            </p>
            <p className="text-xs text-gray-300 mt-0.5">{questions?.length ?? 0} question(s)</p>
          </div>
          <Link
            href={`/admin/quizzes/${params.id}/edit`}
            className="shrink-0 px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Modifier le quiz
          </Link>
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-4">
        {(questions ?? []).map((q, idx) => {
          const qType = (q.question_type as string | null) ?? 'multiple_choice'

          // ── Drag-match question ─────────────────────────────────────────
          if (qType === 'drag_match') {
            let categories: { id: string; label: string }[] = []
            let items: { id: string; label: string }[] = []
            let dmAnswers: Record<string, string> = {}

            try {
              const opts = (q.options ?? {}) as {
                categories?: { id: string; label: string }[]
                items?: { id: string; label: string }[]
              }
              categories = opts.categories ?? []
              items      = opts.items ?? []
              dmAnswers  = (q.drag_match_answers ?? {}) as Record<string, string>
            } catch (err) {
              log.error({ quizId: params.id, questionId: q.id, err }, 'Malformed drag_match options')
            }

            return (
              <div key={q.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-medium text-primary/80 bg-primary/8 px-2 py-0.5 rounded-full">
                    Glisser-Déposer
                  </span>
                </div>
                <p className="text-sm font-semibold text-gray-800 mb-4">
                  <span className="text-gray-300 mr-2">{idx + 1}.</span>
                  {q.question}
                </p>

                {categories.length > 0 ? (
                  <div className="flex flex-wrap gap-3">
                    {categories.map(cat => {
                      const catItems = items.filter(item => dmAnswers[item.id] === cat.id)
                      return (
                        <div
                          key={cat.id}
                          className="flex-1 min-w-[120px] rounded-xl border border-gray-200 bg-gray-50 p-3"
                        >
                          <p className="text-xs font-bold text-gray-700 mb-2 truncate">{cat.label}</p>
                          <ul className="space-y-1">
                            {catItems.map(item => (
                              <li
                                key={item.id}
                                className="text-xs text-gray-600 bg-white rounded-lg px-2 py-1.5 border border-gray-100"
                              >
                                {item.label}
                              </li>
                            ))}
                            {catItems.length === 0 && (
                              <li className="text-xs text-gray-300 italic">Aucun élément</li>
                            )}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">Données de catégories manquantes.</p>
                )}

                {q.explanation && (
                  <p className="mt-3 text-xs text-gray-400 border-t border-gray-50 pt-3">
                    <span className="font-semibold">Explication :</span> {q.explanation as string}
                  </p>
                )}
              </div>
            )
          }

          // ── Multiple-choice question ────────────────────────────────────
          const options = Array.isArray(q.options) ? (q.options as string[]) : []
          const correctAnswer = q.correct_answer as number | null

          return (
            <div key={q.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <p className="text-sm font-semibold text-gray-800 mb-3">
                <span className="text-gray-300 mr-2">{idx + 1}.</span>
                {q.question}
              </p>
              {options.length > 0 ? (
                <ul className="space-y-1.5">
                  {options.map((opt, i) => (
                    <li
                      key={i}
                      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-xl ${
                        i === correctAnswer
                          ? 'bg-green-50 text-green-700 font-medium'
                          : 'bg-gray-50 text-gray-600'
                      }`}
                    >
                      <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        i === correctAnswer ? 'border-green-500 text-green-600' : 'border-gray-300 text-gray-400'
                      }`}>
                        {String.fromCharCode(65 + i)}
                      </span>
                      {opt}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-gray-400 italic">Options manquantes.</p>
              )}
              {q.explanation && (
                <p className="mt-3 text-xs text-gray-400 border-t border-gray-50 pt-3">
                  <span className="font-semibold">Explication :</span> {q.explanation as string}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Danger zone */}
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5">
        <h2 className="font-bold text-gray-800 text-sm mb-1 flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-red-500" /> Zone de danger
        </h2>
        <p className="text-xs text-gray-400 mb-4">Supprimer ce quiz et toutes ses questions.</p>
        <form action={deleteQuiz}>
          <input type="hidden" name="quizId" value={quiz.id} />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
          >
            Supprimer ce quiz
          </button>
        </form>
      </div>
    </div>
  )
}
