'use client'
import { useEffect, useState, useCallback } from 'react'
import { buildDisplayOptions, orderQuestions, newAttemptSeed } from '@/lib/quiz/presentation'
import Link from 'next/link'
import Image from 'next/image'
import { CheckCircle, ChevronLeft, ChevronRight, Loader2, Award, Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { submitQuizAnswers } from '@/app/actions/quiz'
import { PILOT_MODE } from '@/lib/pilot'
import type { QuizSubmitResult } from '@/app/actions/quiz'
import DragMatchQuestion, { type DragMatchOptions } from '@/components/quiz/DragMatchQuestion'

const OPTION_LABELS = ['A', 'B', 'C', 'D']
const MIN_PASS      = 80

interface QuizRow {
  id:            string
  title:         string
  passing_score: number | null
  // XPA-4 (migration 032). Both default false, so a quiz that has not opted in
  // renders exactly as before. Presentation only — never affects grading.
  randomize_questions?: boolean | null
  randomize_options?:   boolean | null
}
interface QuestionRow {
  id:                 string
  question:           string
  options:            unknown
  order_index:        number
  question_type:      string
  question_image_url: string | null
}

// Answers: MC/TF/VC → number; MA → number[]; DM → Record<string,string>
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

export default function ModuleQuizPage() {
  const params   = useParams()
  const router   = useRouter()
  const supabase = createClient()

  const courseSlug = params.courseSlug as string
  const moduleId   = params.moduleId   as string

  const [loading,          setLoading]          = useState(true)
  const [moduleTitle,      setModuleTitle]       = useState('')
  const [resolvedModId,    setResolvedModId]     = useState('')
  const [lastLessonId,     setLastLessonId]      = useState<string | null>(null)
  const [quiz,             setQuiz]              = useState<QuizRow | null>(null)
  const [questions,        setQuestions]         = useState<QuestionRow[]>([])
  const [nextModFirst,     setNextModFirst]      = useState<{ modId: string; lessonId: string } | null>(null)
  const [isLastModule,     setIsLastModule]      = useState(false)
  const [hasFinalExam,     setHasFinalExam]      = useState(false)

  const [answers,          setAnswers]           = useState<AnswerMap>({})
  // XPA-4: per-attempt shuffle seed. Held for the attempt's lifetime so a
  // re-render never reshuffles under the learner's cursor. Presentation only.
  const [shuffleSeed,      setShuffleSeed]       = useState(() => newAttemptSeed())
  const [submitted,        setSubmitted]         = useState(false)
  const [submitting,       setSubmitting]        = useState(false)
  const [submitError,      setSubmitError]       = useState('')
  const [submissionResult, setSubmissionResult]  = useState<QuizSubmitResult | null>(null)
  const [alreadyPassed,    setAlreadyPassed]     = useState(false)

  const loadData = useCallback(async () => {
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', courseSlug)
      .maybeSingle()

    if (!course) { router.push('/courses'); return }

    // Check if this course has a final exam (course-level quiz with no module_id)
    const { data: finalExamQuiz } = await supabase
      .from('quizzes')
      .select('id')
      .eq('course_id', course.id)
      .is('module_id', null)
      // XPA-4: deterministic even for an existence check, so "does a final exam
      // exist" can never depend on which row Postgres happens to return.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    setHasFinalExam(!!finalExamQuiz)

    const { data: rawMods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, order_index)')
      .eq('course_id', course.id)
      .order('order_index')

    if (!rawMods || rawMods.length === 0) { setLoading(false); return }

    type LessonMeta = { id: string; order_index: number }

    const curIdx = rawMods.findIndex(m => m.id === moduleId || m.slug === moduleId)
    if (curIdx < 0) { setLoading(false); return }

    const curMod     = rawMods[curIdx]
    const resolvedId = curMod.id
    setResolvedModId(resolvedId)
    setModuleTitle(curMod.title)
    setIsLastModule(curIdx === rawMods.length - 1)

    const curLessons = [...(curMod.lessons as LessonMeta[])].sort((a, b) => a.order_index - b.order_index)
    setLastLessonId(curLessons[curLessons.length - 1]?.id ?? null)

    const nextMod = rawMods[curIdx + 1]
    if (nextMod) {
      const nextLessons = [...(nextMod.lessons as LessonMeta[])].sort((a, b) => a.order_index - b.order_index)
      if (nextLessons[0]) setNextModFirst({ modId: nextMod.id, lessonId: nextLessons[0].id })
    }

    if (!PILOT_MODE) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: attempt } = await supabase
          .from('quiz_attempts')
          .select('id')
          .eq('user_id', user.id)
          .eq('module_id', resolvedId)
          .eq('passed', true)
          .limit(1)
          .maybeSingle()
        if (attempt) setAlreadyPassed(true)
      }
    }
    try {
      const s = localStorage.getItem(`quiz-${resolvedId}`)
      if (s && JSON.parse(s).passed) setAlreadyPassed(true)
    } catch {}

    // Primary: module-level quiz (lesson_id = NULL, module_id = this module)
    const { data: modQuiz, error: quizErr } = await supabase
      .from('quizzes')
      .select('id, title, passing_score, randomize_questions, randomize_options')
      .eq('module_id', resolvedId)
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

    if (quizErr) console.error('[quiz]', quizErr.message, quizErr.code)

    // Fallback: lesson-attached quiz — any quiz whose lesson_id belongs to
    // this module (covers quizzes created with the "lesson" attachment option)
    let quizData = modQuiz
    if (!quizData) {
      const lessonIds = curLessons.map((l: LessonMeta) => l.id)
      if (lessonIds.length > 0) {
        // XPA-4: deterministic. This fallback matches ANY quiz attached to ANY
        // lesson of the module, so it is the lookup most likely to have several
        // candidates — precisely where an unordered limit(1) is unsafe.
        const { data: lessonQuiz, error: lqErr } = await supabase
          .from('quizzes')
          .select('id, title, passing_score, randomize_questions, randomize_options')
          .in('lesson_id', lessonIds)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle()
        if (lqErr) console.error('[quiz:lesson-fallback]', lqErr.message, lqErr.code)
        quizData = lessonQuiz ?? null
      }
    }

    if (quizData) {
      setQuiz(quizData)

      const { data: qs, error: qsErr } = await supabase
        .from('quiz_questions')
        .select('id, question, options, order_index, question_type, question_image_url')
        .eq('quiz_id', quizData.id)
        .order('order_index', { ascending: true })

      if (qsErr) console.error('[quiz_questions]', qsErr.message, qsErr.code)
      setQuestions((qs ?? []).map(q => ({
        ...q,
        question_type:      (q as { question_type?: string }).question_type ?? 'multiple_choice',
        question_image_url: (q as { question_image_url?: string | null }).question_image_url ?? null,
      })))
    }

    setLoading(false)
  }, [courseSlug, moduleId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData() }, [loadData])

  const requiredScore  = Math.max(quiz?.passing_score ?? MIN_PASS, MIN_PASS)
  const scorePercent   = submissionResult?.score   ?? 0
  const correctCount   = submissionResult?.correctCount ?? 0
  const totalQuestions = questions.length
  const quizPassed     = submissionResult?.passed  ?? false
  const isPassed       = quizPassed || alreadyPassed
  const allAnswered    = questions.every(q => isQuestionAnswered(q, answers))

  async function handleSubmit() {
    if (submitting || !quiz) return
    setSubmitting(true)
    setSubmitError('')

    try {
      const result = await submitQuizAnswers({
        quizId:   quiz.id,
        moduleId: resolvedModId,
        answers,
      })

      if (result.error) {
        setSubmitError(result.error)
        return
      }

      setSubmissionResult(result)
      setSubmitted(true)

      try {
        localStorage.setItem(
          `quiz-${resolvedModId}`,
          JSON.stringify({ passed: result.passed, score: result.score })
        )
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
    setShuffleSeed(newAttemptSeed())   // XPA-4: fresh presentation order per attempt
    setSubmitted(false)
    setSubmissionResult(null)
    setSubmitError('')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-48px)] bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement du quiz…</span>
      </div>
    )
  }

  const backHref = lastLessonId
    ? `/learn/${courseSlug}/${moduleId}/${lastLessonId}`
    : `/courses/${courseSlug}`

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col bg-[#0f1117]">

      {/* Nav bar — fixed inside the column, not sticky against document scroll */}
      <div className="shrink-0 flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-white/10">
        <Link href={backHref} className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors shrink-0">
          <ChevronLeft className="w-4 h-4" /> Le&ccedil;ons
        </Link>
        <span className="text-white/20 select-none">·</span>
        <span className="text-xs text-white/50 truncate">{moduleTitle}</span>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-7">

          {alreadyPassed && !submitted && (
            <div className="mb-8 flex flex-wrap items-center gap-4 p-4 rounded-xl bg-success/10 border border-success/30">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Award className="w-5 h-5 text-success shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-success">Module d&eacute;j&agrave; valid&eacute;</p>
                  <p className="text-xs text-white/50 mt-0.5">Vous pouvez repasser le quiz ci-dessous si vous le souhaitez.</p>
                </div>
              </div>
              {nextModFirst && (
                <Link href={`/learn/${courseSlug}/${nextModFirst.modId}/${nextModFirst.lessonId}`}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-success text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity">
                  Module suivant <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              )}
              {isLastModule && hasFinalExam && (
                <Link href={`/learn/${courseSlug}/final-exam`}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-amber-600 to-amber-400 text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity">
                  <Star className="w-3.5 h-3.5" /> Passer l&apos;examen final
                </Link>
              )}
              {isLastModule && !hasFinalExam && (
                <Link href={`/certificate/${courseSlug}`}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity">
                  <Award className="w-3.5 h-3.5" /> Obtenir mon certificat
                </Link>
              )}
            </div>
          )}

          {!quiz || questions.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-white/40 text-sm italic mb-6">Aucun quiz disponible pour ce module.</p>
              <Link href={backHref}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 text-white text-sm rounded-lg hover:bg-white/15 transition-colors">
                <ChevronLeft className="w-4 h-4" /> Retour aux le&ccedil;ons
              </Link>
            </div>
          ) : (
            <div>
              <h1 className="text-2xl font-extrabold text-white mb-6">Quiz &mdash; {quiz.title}</h1>

              {!submitted && (
                <div className="mb-8 p-4 rounded-xl bg-white/5 border border-white/10 text-sm text-white/70">
                  <p className="font-semibold text-white/90 mb-2">Instructions</p>
                  <ul className="space-y-1.5">
                    <li>• R&eacute;pondez &agrave; toutes les questions</li>
                    <li>• Cliquez sur &laquo;&nbsp;V&eacute;rifier mes r&eacute;ponses&nbsp;&raquo; pour voir votre score</li>
                    <li>• Vous devez obtenir au moins {requiredScore}&nbsp;% pour valider ce module</li>
                    <li>• Vous pouvez recommencer le quiz autant de fois que n&eacute;cessaire</li>
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-6">
                {orderQuestions(questions, !!quiz?.randomize_questions, shuffleSeed).map((q, qi) => {
                  const qType = q.question_type

                  // ── Drag & Match ─────────────────────────────────────────────
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

                  // ── Multiple Answer (checkboxes) ──────────────────────────────
                  if (qType === 'multiple_answer') {
                    const opts     = q.options as string[]
                    const selected = (answers[q.id] as number[]) ?? []
                    const maCorrect = submissionResult?.multipleAnswerCorrect?.[q.id]
                    return (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-1">{qi + 1}. {q.question}</p>
                        <p className="text-xs text-white/40 mb-3 italic">Plusieurs réponses possibles</p>
                        <div className="flex flex-col gap-2">
                          {opts.map((opt, oi) => {
                            const isSelected    = selected.includes(oi)
                            const isCorrectOpt  = submitted && maCorrect?.includes(oi)
                            const isWrongOpt    = submitted && isSelected && !maCorrect?.includes(oi)
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
                                  : isSelected ? 'border-primary bg-primary/20 text-white'
                                  : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                                }`}>
                                <span className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
                                  isSelected ? 'bg-primary border-primary' : 'border-white/30'
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
                                  : isSelected ? 'border-primary bg-primary/20 text-white'
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

                  // ── Visual Choice (image + options) ───────────────────────────
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
                                  : isSelected ? 'border-primary bg-primary/20 text-white'
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
                  // XPA-4: display order may be shuffled, but every option carries the
                  // index it holds in the STORED options array, and that ORIGINAL index is
                  // what gets submitted. correct_answer therefore keeps its exact meaning
                  // and shuffling can never change which answer is correct.
                  const opts          = buildDisplayOptions(
                                          q.options as string[],
                                          !!quiz?.randomize_options,
                                          shuffleSeed + qi,
                                        )
                  const serverCorrect = submissionResult?.correctAnswers?.[q.id]
                  return (
                    <div key={q.id}>
                      <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                      <div className="flex flex-col gap-2">
                        {opts.map(({ originalIndex: oi, text: opt }, slot) => {
                          const isSelected   = answers[q.id] === oi
                          const isCorrectOpt = submitted && oi === serverCorrect
                          const isWrongOpt   = submitted && isSelected && oi !== serverCorrect
                          return (
                            <button key={oi} disabled={submitted}
                              onClick={() => setAnswers(a => ({ ...a, [q.id]: oi }))}
                              className={`text-left px-4 py-2.5 rounded-lg text-sm transition-colors border ${
                                isCorrectOpt ? 'border-success/60 bg-success/10 text-success'
                                : isWrongOpt ? 'border-red-500/60 bg-red-500/10 text-red-400'
                                : isSelected ? 'border-primary bg-primary/20 text-white'
                                : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                              }`}>
                              <span className="font-semibold mr-1.5">{OPTION_LABELS[slot]}.</span>{opt}
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
                    className="px-6 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 w-fit">
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {submitting ? 'Vérification…' : 'Vérifier mes réponses'}
                  </button>
                </div>
              ) : (
                <div className="mt-8 p-5 rounded-2xl bg-white/5 border border-white/10">
                  <p className="text-base font-bold text-white">
                    Score&nbsp;: {correctCount}&nbsp;/&nbsp;{totalQuestions}&nbsp;
                    <span className="text-white/50 font-normal">({scorePercent}&nbsp;%)</span>
                  </p>

                  {quizPassed ? (
                    <div className="flex items-center gap-2 mt-3 text-success">
                      <Award className="w-5 h-5 shrink-0" />
                      <p className="text-sm font-semibold">Bravo&nbsp;! Vous avez valid&eacute; ce module.</p>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-red-400">
                      Vous devez obtenir au moins {requiredScore}&nbsp;% pour passer au module suivant.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 mt-5">
                    {isPassed && nextModFirst && (
                      <Link href={`/learn/${courseSlug}/${nextModFirst.modId}/${nextModFirst.lessonId}`}
                        className="flex items-center gap-2 px-5 py-2.5 bg-success text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity">
                        Passer au module suivant <ChevronRight className="w-4 h-4" />
                      </Link>
                    )}
                    {isPassed && isLastModule && hasFinalExam && (
                      <Link href={`/learn/${courseSlug}/final-exam`}
                        className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-amber-600 to-amber-400 text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity shadow-md shadow-amber-500/30">
                        <Star className="w-4 h-4" /> Passer l&apos;examen final
                      </Link>
                    )}
                    {isPassed && isLastModule && !hasFinalExam && (
                      <Link href={`/certificate/${courseSlug}`}
                        className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity shadow-md shadow-amber-500/30 animate-pulse-once">
                        <Award className="w-4 h-4" /> 🎉 Obtenir mon certificat
                      </Link>
                    )}
                    <button onClick={handleRetry} className="text-sm text-primary hover:underline">
                      Recommencer le quiz
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
