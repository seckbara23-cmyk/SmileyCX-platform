'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { CheckCircle, ChevronLeft, ChevronRight, Loader2, Award } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'

const OPTION_LABELS = ['A', 'B', 'C', 'D']
const MIN_PASS      = 80

// ── Types ─────────────────────────────────────────────────────────────────────
interface QuizRow {
  id:            string
  title:         string
  passing_score: number | null
}
interface QuestionRow {
  id:             string
  question:       string
  options:        string[]
  correct_answer: number
  explanation:    string | null
  order_index:    number
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ModuleQuizPage() {
  const params   = useParams()
  const router   = useRouter()
  const supabase = createClient()

  const courseSlug = params.courseSlug as string
  const moduleId   = params.moduleId   as string  // may be UUID or slug

  const [loading,       setLoading]       = useState(true)
  const [moduleTitle,   setModuleTitle]   = useState('')
  const [resolvedModId, setResolvedModId] = useState('')
  const [lastLessonId,  setLastLessonId]  = useState<string | null>(null)
  const [quiz,          setQuiz]          = useState<QuizRow | null>(null)
  const [questions,     setQuestions]     = useState<QuestionRow[]>([])
  const [nextModFirst,  setNextModFirst]  = useState<{ modId: string; lessonId: string } | null>(null)
  const [isLastModule,  setIsLastModule]  = useState(false)

  const [answers,       setAnswers]       = useState<Record<string, number>>({})
  const [submitted,     setSubmitted]     = useState(false)
  const [alreadyPassed, setAlreadyPassed] = useState(false)

  // ── Fetch all data ────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', courseSlug)
      .maybeSingle()

    if (!course) { router.push('/courses'); return }

    const { data: rawMods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, order_index)')
      .eq('course_id', course.id)
      .order('order_index')

    if (!rawMods || rawMods.length === 0) { setLoading(false); return }

    type LessonMeta = { id: string; order_index: number }

    const curIdx    = rawMods.findIndex(m => m.id === moduleId || m.slug === moduleId)
    if (curIdx < 0) { setLoading(false); return }

    const curMod     = rawMods[curIdx]
    const resolvedId = curMod.id
    setResolvedModId(resolvedId)
    setModuleTitle(curMod.title)
    setIsLastModule(curIdx === rawMods.length - 1)

    // Last lesson of current module (back-link target)
    const curLessons = [...(curMod.lessons as LessonMeta[])].sort((a, b) => a.order_index - b.order_index)
    setLastLessonId(curLessons[curLessons.length - 1]?.id ?? null)

    // First lesson of next module (CTA target)
    const nextMod = rawMods[curIdx + 1]
    if (nextMod) {
      const nextLessons = [...(nextMod.lessons as LessonMeta[])].sort((a, b) => a.order_index - b.order_index)
      if (nextLessons[0]) setNextModFirst({ modId: nextMod.id, lessonId: nextLessons[0].id })
    }

    // Restore persisted pass state
    try {
      const s = localStorage.getItem(`quiz-${resolvedId}`)
      if (s && JSON.parse(s).passed) setAlreadyPassed(true)
    } catch {}

    // Fetch quiz
    const { data: quizData, error: quizErr } = await supabase
      .from('quizzes')
      .select('id, title, passing_score')
      .eq('module_id', resolvedId)
      .limit(1)
      .maybeSingle()

    if (quizErr) console.error('[quiz]', quizErr.message, quizErr.code)

    if (quizData) {
      setQuiz(quizData)

      const { data: qs, error: qsErr } = await supabase
        .from('quiz_questions')
        .select('id, question, options, correct_answer, explanation, order_index')
        .eq('quiz_id', quizData.id)
        .order('order_index', { ascending: true })

      if (qsErr) console.error('[quiz_questions]', qsErr.message, qsErr.code)
      setQuestions(qs ?? [])
    }

    setLoading(false)
  }, [courseSlug, moduleId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData() }, [loadData])

  // ── Derived ───────────────────────────────────────────────────────────────
  const requiredScore = Math.max(quiz?.passing_score ?? MIN_PASS, MIN_PASS)
  const correctCount  = questions.filter(q => answers[q.id] === q.correct_answer).length
  const scorePercent  = questions.length > 0
    ? Math.round((correctCount / questions.length) * 100)
    : 0
  const quizPassed = submitted && scorePercent >= requiredScore
  const isPassed   = quizPassed || alreadyPassed

  // ── Submit ────────────────────────────────────────────────────────────────
  function handleSubmit() {
    setSubmitted(true)
    const score  = questions.length > 0
      ? Math.round((questions.filter(q => answers[q.id] === q.correct_answer).length / questions.length) * 100)
      : 0
    const passed = score >= requiredScore
    try {
      localStorage.setItem(`quiz-${resolvedModId}`, JSON.stringify({ passed, score }))
    } catch {}
    if (passed) setAlreadyPassed(true)
  }

  function handleRetry() { setAnswers({}); setSubmitted(false) }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-72px)] bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement du quiz…</span>
      </div>
    )
  }

  const backHref = lastLessonId
    ? `/learn/${courseSlug}/${moduleId}/${lastLessonId}`
    : `/courses/${courseSlug}`

  return (
    <div className="min-h-[calc(100vh-72px)] bg-[#0f1117]">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-white/10">
        <Link
          href={backHref}
          className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors shrink-0"
        >
          <ChevronLeft className="w-4 h-4" /> Le&ccedil;ons
        </Link>
        <span className="text-white/20 select-none">·</span>
        <span className="text-xs text-white/50 truncate">{moduleTitle}</span>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="max-w-2xl mx-auto px-4 py-10">

        {/* Already-passed banner */}
        {alreadyPassed && !submitted && (
          <div className="mb-8 flex flex-wrap items-center gap-4 p-4 rounded-xl bg-success/10 border border-success/30">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <Award className="w-5 h-5 text-success shrink-0" />
              <div>
                <p className="text-sm font-semibold text-success">Module d&eacute;j&agrave; valid&eacute;</p>
                <p className="text-xs text-white/50 mt-0.5">
                  Vous pouvez repasser le quiz ci-dessous si vous le souhaitez.
                </p>
              </div>
            </div>
            {nextModFirst && (
              <Link
                href={`/learn/${courseSlug}/${nextModFirst.modId}/${nextModFirst.lessonId}`}
                className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-success text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
              >
                Module suivant <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            )}
            {isLastModule && (
              <Link
                href={`/courses/${courseSlug}`}
                className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-secondary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
              >
                Voir le cours <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            )}
          </div>
        )}

        {/* No quiz */}
        {!quiz || questions.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-white/40 text-sm italic mb-6">Aucun quiz disponible pour ce module.</p>
            <Link
              href={backHref}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 text-white text-sm rounded-lg hover:bg-white/15 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Retour aux le&ccedil;ons
            </Link>
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-extrabold text-white mb-6">
              Quiz &mdash; {quiz.title}
            </h1>

            {/* Instructions (only before submission) */}
            {!submitted && (
              <div className="mb-8 p-4 rounded-xl bg-white/5 border border-white/10 text-sm text-white/70">
                <p className="font-semibold text-white/90 mb-2">Instructions</p>
                <ul className="space-y-1.5">
                  <li>• S&eacute;lectionnez une seule r&eacute;ponse par question</li>
                  <li>• Cliquez sur &laquo;&nbsp;V&eacute;rifier mes r&eacute;ponses&nbsp;&raquo; pour voir votre score</li>
                  <li>• Vous devez obtenir au moins {requiredScore}&nbsp;% pour valider ce module</li>
                  <li>• Vous pouvez recommencer le quiz autant de fois que n&eacute;cessaire</li>
                </ul>
              </div>
            )}

            {/* Questions */}
            <div className="flex flex-col gap-8">
              {questions.map((q, qi) => (
                <div key={q.id}>
                  <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                  <div className="flex flex-col gap-2">
                    {(q.options as string[]).map((opt, oi) => {
                      const isSelected   = answers[q.id] === oi
                      const isCorrectOpt = submitted && oi === q.correct_answer
                      const isWrongOpt   = submitted && isSelected && oi !== q.correct_answer
                      return (
                        <button
                          key={oi}
                          disabled={submitted}
                          onClick={() => setAnswers(a => ({ ...a, [q.id]: oi }))}
                          className={`text-left px-4 py-2.5 rounded-lg text-sm transition-colors border ${
                            isCorrectOpt
                              ? 'border-success/60 bg-success/10 text-success'
                              : isWrongOpt
                              ? 'border-red-500/60 bg-red-500/10 text-red-400'
                              : isSelected
                              ? 'border-primary bg-primary/20 text-white'
                              : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default'
                          }`}
                        >
                          <span className="font-semibold mr-1.5">{OPTION_LABELS[oi]}.</span>{opt}
                        </button>
                      )
                    })}
                  </div>
                  {submitted && q.explanation && (
                    <p className="mt-3 text-xs text-white/50 italic">{q.explanation}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Submit / result */}
            {!submitted ? (
              <button
                onClick={handleSubmit}
                disabled={Object.keys(answers).length < questions.length}
                className="mt-10 px-6 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                V&eacute;rifier mes r&eacute;ponses
              </button>
            ) : (
              <div className="mt-10 p-6 rounded-2xl bg-white/5 border border-white/10">
                <p className="text-base font-bold text-white">
                  Score&nbsp;: {correctCount}&nbsp;/&nbsp;{questions.length}&nbsp;
                  <span className="text-white/50 font-normal">({scorePercent}&nbsp;%)</span>
                </p>

                {quizPassed ? (
                  <div className="flex items-center gap-2 mt-3 text-success">
                    <Award className="w-5 h-5 shrink-0" />
                    <p className="text-sm font-semibold">
                      Bravo&nbsp;! Vous avez valid&eacute; ce module.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-red-400">
                    Vous devez obtenir au moins {requiredScore}&nbsp;% pour passer au module suivant.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3 mt-5">
                  {isPassed && nextModFirst && (
                    <Link
                      href={`/learn/${courseSlug}/${nextModFirst.modId}/${nextModFirst.lessonId}`}
                      className="flex items-center gap-2 px-5 py-2.5 bg-success text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity"
                    >
                      Passer au module suivant <ChevronRight className="w-4 h-4" />
                    </Link>
                  )}
                  {isPassed && isLastModule && (
                    <Link
                      href={`/courses/${courseSlug}`}
                      className="flex items-center gap-2 px-5 py-2.5 bg-secondary text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity"
                    >
                      Terminer le cours <CheckCircle className="w-4 h-4" />
                    </Link>
                  )}
                  <button
                    onClick={handleRetry}
                    className="text-sm text-primary hover:underline"
                  >
                    Recommencer le quiz
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
