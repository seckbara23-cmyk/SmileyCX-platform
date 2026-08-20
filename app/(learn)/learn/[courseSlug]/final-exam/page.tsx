'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { CheckCircle, ChevronLeft, Loader2, Award, Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { submitQuizAnswers } from '@/app/actions/quiz'
import type { QuizSubmitResult } from '@/app/actions/quiz'
import DragMatchQuestion, { type DragMatchOptions } from '@/components/quiz/DragMatchQuestion'
import { orderQuestions, newAttemptSeed } from '@/lib/quiz/presentation'

const OPTION_LABELS = ['A', 'B', 'C', 'D']
const MIN_PASS      = 80

interface QuizRow {
  id:            string
  title:         string
  passing_score: number | null
}
interface QuestionRow {
  id:                 string
  question:           string
  options:            unknown
  order_index:        number
  question_type:      string
  question_image_url: string | null
}

type AnswerMap = Record<string, number | number[] | Record<string, string>>

function isQuestionAnswered(q: QuestionRow, answers: AnswerMap): boolean {
  if (q.question_type === 'drag_match') {
    const opts = q.options as DragMatchOptions
    const placed = answers[q.id] as Record<string, string> | undefined
    if (!placed) return false
    return opts.items.every(item => item.id in placed)
  }
  if (q.question_type === 'multiple_answer') {
    const sel = answers[q.id] as number[] | undefined
    return Array.isArray(sel) && sel.length > 0
  }
  return q.id in answers
}

export default function FinalExamPage() {
  const params   = useParams()
  const router   = useRouter()
  const supabase = createClient()

  const courseSlug = params.courseSlug as string

  const [loading,          setLoading]          = useState(true)
  const [backHref,         setBackHref]         = useState(`/courses/${courseSlug}`)
  const [quiz,             setQuiz]             = useState<QuizRow | null>(null)
  const [questions,        setQuestions]        = useState<QuestionRow[]>([])

  const [answers,          setAnswers]          = useState<AnswerMap>({})
  const [submitted,        setSubmitted]        = useState(false)
  const [submitting,       setSubmitting]       = useState(false)
  const [submitError,      setSubmitError]      = useState('')
  const [submissionResult, setSubmissionResult] = useState<QuizSubmitResult | null>(null)
  const [alreadyPassed,    setAlreadyPassed]    = useState(false)
  // ── XPA-8 B-2.3A: final exams randomize, unconditionally ────────────────
  //
  // Ratified as a property of BEING an exam, not a per-quiz preference, so the
  // `randomize_questions` / `randomize_options` flags are not consulted here -
  // they remain the formative quizzes' opt-in. Presentation only: migration 032
  // established that the client shuffles {originalIndex, text} pairs and submits
  // the ORIGINAL index, so display order and grading stay fully decoupled and
  // `correct_answer` keeps its exact meaning.
  //
  // The seed is held for the attempt's lifetime so a re-render never reshuffles
  // under the learner's cursor.
  const [shuffleSeed,       setShuffleSeed]       = useState(() => newAttemptSeed())
  // Attempt budget, as reported by the server after each submission.
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null)

  const loadData = useCallback(async () => {
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', courseSlug)
      .eq('is_published', true)
      .maybeSingle()

    if (!course) { router.push('/courses'); return }

    // Find last lesson of last module for the back link
    const { data: rawMods } = await supabase
      .from('modules')
      .select('id, lessons(id, order_index)')
      .eq('course_id', course.id)
      .order('order_index', { ascending: false })
      .limit(1)

    if (rawMods?.[0]) {
      const lastMod     = rawMods[0]
      type LessonMeta   = { id: string; order_index: number }
      const lessons     = [...(lastMod.lessons as LessonMeta[])].sort((a, b) => b.order_index - a.order_index)
      const lastLesson  = lessons[0]
      if (lastLesson) setBackHref(`/learn/${courseSlug}/${lastMod.id}/${lastLesson.id}`)
    }

    // Load final exam quiz first (needed for accurate already-passed check)
    const { data: fq, error: fqErr } = await supabase
      .from('quizzes')
      .select('id, title, passing_score, randomize_questions, randomize_options')
      .eq('course_id', course.id)
      // XPA-4: deterministic selection. `.limit(1)` with no ORDER BY made this an
      // ACCIDENTAL selector — with more than one matching quiz Postgres may return
      // any row, and a different one between page loads. Ordering by creation time
      // (then id, to break ties) makes the served quiz stable and reproducible.
      // Random selection among several quizzes is a separate, opt-in capability
      // and is deliberately NOT what an unordered limit provides.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (fqErr) console.error('[final-exam quiz]', fqErr.message)

    if (fq) {
      setQuiz(fq)

      // ── XPA-8 B-2.3A: the operating mode has no say in assessment ──────
      //
      // This read was wrapped in `if (!PILOT_MODE)`, so in pilot a learner who
      // had genuinely passed was not recognised as having passed - an academic
      // fact decided by a deployment flag. Ratified: PLATFORM_MODE has zero
      // authority over assessment or certificate eligibility. It now runs for
      // any authenticated learner, in every mode.
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: attempt } = await supabase
          .from('quiz_attempts')
          .select('id')
          .eq('user_id', user.id)
          .eq('quiz_id', fq.id)
          .eq('passed', true)
          .limit(1)
          .maybeSingle()
        if (attempt) setAlreadyPassed(true)
      }
      try {
        const s = localStorage.getItem(`final-exam-${courseSlug}`)
        if (s && JSON.parse(s).passed) setAlreadyPassed(true)
      } catch {}

      const { data: qs, error: qsErr } = await supabase
        .from('quiz_questions')
        .select('id, question, options, order_index, question_type, question_image_url')
        .eq('quiz_id', fq.id)
        .order('order_index', { ascending: true })
      if (qsErr) console.error('[final-exam questions]', qsErr.message)
      setQuestions((qs ?? []).map(q => ({
        ...q,
        question_type:      (q as { question_type?: string }).question_type ?? 'multiple_choice',
        question_image_url: (q as { question_image_url?: string | null }).question_image_url ?? null,
      })))
    }

    setLoading(false)
  }, [courseSlug, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData() }, [loadData])

  const requiredScore  = Math.max(quiz?.passing_score ?? MIN_PASS, MIN_PASS)
  const scorePercent   = submissionResult?.score       ?? 0
  const correctCount   = submissionResult?.correctCount ?? 0
  const totalQuestions = questions.length
  const quizPassed     = submissionResult?.passed      ?? false
  const isPassed       = quizPassed || alreadyPassed
  const allAnswered    = questions.every(q => isQuestionAnswered(q, answers))

  async function handleSubmit() {
    if (submitting || !quiz) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const result = await submitQuizAnswers({ quizId: quiz.id, moduleId: null, answers })
      if (result.error) { setSubmitError(result.error); return }
      setSubmissionResult(result)
      setSubmitted(true)
      if (typeof result.attemptsRemaining === 'number') setAttemptsRemaining(result.attemptsRemaining)
      try {
        localStorage.setItem(`final-exam-${courseSlug}`, JSON.stringify({ passed: result.passed, score: result.score }))
      } catch {}
      if (result.passed) setAlreadyPassed(true)
    } catch {
      setSubmitError('Une erreur est survenue. Veuillez réessayer.')
    } finally {
      setSubmitting(false)
    }
  }

  function handleRetry() {
    setAnswers({})
    setSubmitted(false)
    setSubmissionResult(null)
    setSubmitError('')
    // XPA-8 B-2.3A: a new attempt gets a new presentation order.
    setShuffleSeed(newAttemptSeed())
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-48px)] bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement de l&apos;examen…</span>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col bg-[#0f1117]">

      {/* Nav bar */}
      <div className="shrink-0 flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-amber-500/20">
        <Link href={backHref} className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors shrink-0">
          <ChevronLeft className="w-4 h-4" /> Leçons
        </Link>
        <span className="text-white/20 select-none">·</span>
        <div className="flex items-center gap-1.5 text-xs text-amber-400/80 font-semibold">
          <Star className="w-3.5 h-3.5" /> Examen final
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-7">

          {attemptsRemaining !== null && !isPassed && (
            <p className="mb-4 text-xs text-amber-200/80">
              {attemptsRemaining > 0
                ? `Il vous reste ${attemptsRemaining} tentative${attemptsRemaining > 1 ? 's' : ''}.`
                : 'Vous avez utilisé toutes vos tentatives pour cet examen.'}
            </p>
          )}

          {alreadyPassed && !submitted && (
            <div className="mb-8 flex flex-wrap items-center gap-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Award className="w-5 h-5 text-amber-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-300">Examen déjà validé</p>
                  <p className="text-xs text-white/50 mt-0.5">Vous pouvez repasser l&apos;examen ci-dessous si vous le souhaitez.</p>
                </div>
              </div>
              <Link
                href={`/certificate/${courseSlug}`}
                className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
              >
                <Award className="w-3.5 h-3.5" /> Obtenir mon certificat
              </Link>
            </div>
          )}

          {!quiz || questions.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-white/40 text-sm italic mb-6">Aucun examen final disponible pour cette formation.</p>
              <Link href={backHref}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 text-white text-sm rounded-lg hover:bg-white/15 transition-colors">
                <ChevronLeft className="w-4 h-4" /> Retour aux leçons
              </Link>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-400 flex items-center justify-center shrink-0">
                  <Star className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl font-extrabold text-white">Examen final</h1>
                  <p className="text-sm text-amber-400/70">{quiz.title}</p>
                </div>
              </div>

              {!submitted && (
                <div className="mb-8 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 text-sm text-white/70">
                  <p className="font-semibold text-amber-300/90 mb-2">Instructions</p>
                  <ul className="space-y-1.5">
                    <li>• Répondez à toutes les questions</li>
                    <li>• Cliquez sur «&nbsp;Vérifier mes réponses&nbsp;» pour voir votre score</li>
                    <li>• Vous devez obtenir au moins {requiredScore}&nbsp;% pour valider la formation</li>
                    <li>• Vous pouvez recommencer l&apos;examen autant de fois que n&eacute;cessaire</li>
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-6">
                {orderQuestions(questions, true, shuffleSeed).map((q, qi) => {
                  const qType = q.question_type

                  // ── Drag & Match ──────────────────────────────────────────────
                  if (qType === 'drag_match') {
                    return (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                        <DragMatchQuestion
                          questionId={q.id}
                          options={q.options as DragMatchOptions}
                          placements={(answers[q.id] as Record<string, string>) ?? {}}
                          onPlacementsChange={p => setAnswers(a => ({ ...a, [q.id]: p }))}
                          submitted={submitted}
                          correctPlacements={submissionResult?.dragMatchAnswers?.[q.id]}
                          explanation={submissionResult?.explanations?.[q.id]}
                        />
                      </div>
                    )
                  }

                  // ── Multiple Answer ───────────────────────────────────────────
                  if (qType === 'multiple_answer') {
                    const opts      = q.options as string[]
                    const selected  = (answers[q.id] as number[]) ?? []
                    const maCorrect = submissionResult?.multipleAnswerCorrect?.[q.id]
                    return (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-1">{qi + 1}. {q.question}</p>
                        <p className="text-xs text-white/40 mb-3 italic">Plusieurs réponses possibles</p>
                        <div className="flex flex-col gap-2">
                          {opts.map((opt, oi) => {
                            const isSelected   = selected.includes(oi)
                            const isCorrectOpt = submitted && maCorrect?.includes(oi)
                            const isWrongOpt   = submitted && isSelected && !maCorrect?.includes(oi)
                            return (
                              <button key={oi} disabled={submitted}
                                onClick={() => {
                                  const curr = (answers[q.id] as number[]) ?? []
                                  const next = curr.includes(oi) ? curr.filter(x => x !== oi) : [...curr, oi]
                                  setAnswers(a => ({ ...a, [q.id]: next }))
                                }}
                                className={`text-left px-4 py-2.5 rounded-lg text-sm transition-colors border flex items-center gap-3 ${
                                  isCorrectOpt ? 'border-success/60 bg-success/10 text-success'
                                  : isWrongOpt ? 'border-red-500/60 bg-red-500/10 text-red-400'
                                  : isSelected ? 'border-amber-500 bg-amber-500/20 text-white'
                                  : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                                }`}>
                                <span className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
                                  isSelected ? 'bg-amber-500 border-amber-500' : 'border-white/30'
                                }`}>
                                  {isSelected && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                                </span>
                                <span className="font-semibold mr-1">{OPTION_LABELS[oi]}.</span>{opt}
                              </button>
                            )
                          })}
                        </div>
                        {submitted && submissionResult?.explanations?.[q.id] && (
                          <p className="mt-3 text-xs text-white/50 italic">{submissionResult.explanations[q.id]}</p>
                        )}
                      </div>
                    )
                  }

                  // ── True / False ──────────────────────────────────────────────
                  if (qType === 'true_false') {
                    const serverCorrect = submissionResult?.correctAnswers?.[q.id]
                    return (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                        <div className="flex gap-3">
                          {['Vrai', 'Faux'].map((label, oi) => {
                            const isSelected   = answers[q.id] === oi
                            const isCorrectOpt = submitted && oi === serverCorrect
                            const isWrongOpt   = submitted && isSelected && oi !== serverCorrect
                            return (
                              <button key={oi} disabled={submitted}
                                onClick={() => setAnswers(a => ({ ...a, [q.id]: oi }))}
                                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-colors border-2 ${
                                  isCorrectOpt ? 'border-success/60 bg-success/10 text-success'
                                  : isWrongOpt ? 'border-red-500/60 bg-red-500/10 text-red-400'
                                  : isSelected ? 'border-amber-500 bg-amber-500/20 text-white'
                                  : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30 hover:text-white disabled:cursor-default'
                                }`}>
                                {label}
                              </button>
                            )
                          })}
                        </div>
                        {submitted && submissionResult?.explanations?.[q.id] && (
                          <p className="mt-3 text-xs text-white/50 italic">{submissionResult.explanations[q.id]}</p>
                        )}
                      </div>
                    )
                  }

                  // ── Visual Choice ─────────────────────────────────────────────
                  if (qType === 'visual_choice') {
                    const opts          = q.options as string[]
                    const serverCorrect = submissionResult?.correctAnswers?.[q.id]
                    return (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                        {q.question_image_url && (
                          <div className="mb-4 rounded-xl overflow-hidden border border-white/10">
                            <Image
                              src={q.question_image_url}
                              alt={`Question ${qi + 1}`}
                              width={600}
                              height={300}
                              className="w-full h-48 object-cover"
                            />
                          </div>
                        )}
                        <div className="flex flex-col gap-2">
                          {opts.map((opt, oi) => {
                            const isSelected   = answers[q.id] === oi
                            const isCorrectOpt = submitted && oi === serverCorrect
                            const isWrongOpt   = submitted && isSelected && oi !== serverCorrect
                            return (
                              <button key={oi} disabled={submitted}
                                onClick={() => setAnswers(a => ({ ...a, [q.id]: oi }))}
                                className={`text-left px-4 py-2.5 rounded-lg text-sm transition-colors border ${
                                  isCorrectOpt ? 'border-success/60 bg-success/10 text-success'
                                  : isWrongOpt ? 'border-red-500/60 bg-red-500/10 text-red-400'
                                  : isSelected ? 'border-amber-500 bg-amber-500/20 text-white'
                                  : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                                }`}>
                                <span className="font-semibold mr-1.5">{OPTION_LABELS[oi]}.</span>{opt}
                              </button>
                            )
                          })}
                        </div>
                        {submitted && submissionResult?.explanations?.[q.id] && (
                          <p className="mt-3 text-xs text-white/50 italic">{submissionResult.explanations[q.id]}</p>
                        )}
                      </div>
                    )
                  }

                  // ── Multiple Choice (default) ─────────────────────────────────
                  const opts          = q.options as string[]
                  const serverCorrect = submissionResult?.correctAnswers?.[q.id]
                  return (
                    <div key={q.id}>
                      <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                      <div className="flex flex-col gap-2">
                        {opts.map((opt, oi) => {
                          const isSelected   = answers[q.id] === oi
                          const isCorrectOpt = submitted && oi === serverCorrect
                          const isWrongOpt   = submitted && isSelected && oi !== serverCorrect
                          return (
                            <button key={oi} disabled={submitted}
                              onClick={() => setAnswers(a => ({ ...a, [q.id]: oi }))}
                              className={`text-left px-4 py-2.5 rounded-lg text-sm transition-colors border ${
                                isCorrectOpt ? 'border-success/60 bg-success/10 text-success'
                                : isWrongOpt ? 'border-red-500/60 bg-red-500/10 text-red-400'
                                : isSelected ? 'border-amber-500 bg-amber-500/20 text-white'
                                : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                              }`}>
                              <span className="font-semibold mr-1.5">{OPTION_LABELS[oi]}.</span>{opt}
                            </button>
                          )
                        })}
                      </div>
                      {submitted && submissionResult?.explanations?.[q.id] && (
                        <p className="mt-3 text-xs text-white/50 italic">{submissionResult.explanations[q.id]}</p>
                      )}
                    </div>
                  )
                })}
              </div>

              {!submitted ? (
                <div className="mt-8 flex flex-col gap-3">
                  {submitError && <p className="text-sm text-red-400">{submitError}</p>}
                  <button onClick={handleSubmit} disabled={submitting || !allAnswered}
                    className="px-6 py-3 bg-gradient-to-r from-amber-600 to-amber-400 text-white text-sm font-bold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 w-fit shadow-lg shadow-amber-500/20">
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {submitting ? 'Vérification…' : 'Vérifier mes réponses'}
                  </button>
                </div>
              ) : (
                <div className="mt-8 p-5 rounded-2xl bg-amber-500/5 border border-amber-500/20">
                  <p className="text-base font-bold text-white">
                    Score&nbsp;: {correctCount}&nbsp;/&nbsp;{totalQuestions}&nbsp;
                    <span className="text-white/50 font-normal">({scorePercent}&nbsp;%)</span>
                  </p>

                  {quizPassed ? (
                    <div className="flex items-center gap-2 mt-3 text-amber-300">
                      <Award className="w-5 h-5 shrink-0" />
                      <p className="text-sm font-semibold">F&eacute;licitations&nbsp;! Vous avez valid&eacute; l&apos;examen final.</p>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-red-400">
                      Vous devez obtenir au moins {requiredScore}&nbsp;% pour valider la formation.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 mt-5">
                    {isPassed && (
                      <Link
                        href={`/certificate/${courseSlug}`}
                        className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity shadow-md shadow-amber-500/30"
                      >
                        <Award className="w-4 h-4" /> 🎉 Obtenir mon certificat
                      </Link>
                    )}
                    <button onClick={handleRetry} className="text-sm text-amber-400 hover:underline">
                      Recommencer l&apos;examen
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
