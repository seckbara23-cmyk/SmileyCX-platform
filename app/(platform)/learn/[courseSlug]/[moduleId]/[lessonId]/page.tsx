'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { CheckCircle, ChevronLeft, ChevronRight, List, Award, Loader2, Captions, ClipboardList } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { enrollForFree } from '@/app/actions/enrollment'
import { FREE_ACCESS_MODE, PILOT_MODE } from '@/lib/pilot'

// ── Types ─────────────────────────────────────────────────────────────────────
interface LessonRow {
  id:               string
  slug:             string
  title:            string
  content:          string | null
  video_url:        string | null
  subtitle_url:     string | null
  duration_minutes: number | null
  order_index:      number
}

interface ModuleRow {
  id:          string
  slug:        string
  title:       string
  order_index: number
  lessons:     LessonRow[]
}

interface FlatLesson extends LessonRow {
  module: ModuleRow
}

interface QuizRow {
  id:            string
  title:         string
  passing_score: number | null
}

interface QuizQuestionRow {
  id:             string
  question:       string
  options:        string[]
  correct_answer: number
  explanation:    string | null
  order_index:    number
}

const OPTION_LABELS = ['A', 'B', 'C', 'D']

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LessonPlayerPage() {
  const params    = useParams()
  const router    = useRouter()
  const supabase  = createClient()

  const courseSlug = params.courseSlug as string
  const moduleId   = params.moduleId   as string
  const lessonId   = params.lessonId   as string

  const [modules,   setModules]   = useState<ModuleRow[]>([])
  const [lesson,    setLesson]    = useState<LessonRow | null>(null)
  const [module,    setModule]    = useState<ModuleRow | null>(null)
  const [completed, setCompleted] = useState(false)
  const [sideOpen,  setSideOpen]  = useState(false)
  const [userId,    setUserId]    = useState<string | null>(null)
  const [progress,  setProgress]  = useState<Record<string, boolean>>({})
  const [loading,   setLoading]   = useState(true)
  const [ccEnabled, setCcEnabled] = useState(true)
  const videoRef = useRef<HTMLVideoElement>(null)

  const [quiz,          setQuiz]          = useState<QuizRow | null>(null)
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestionRow[]>([])
  const [quizAnswers,   setQuizAnswers]   = useState<Record<string, number>>({})
  const [quizSubmitted, setQuizSubmitted] = useState(false)
  const [quizLoading,   setQuizLoading]   = useState(false)

  function toggleCC() {
    const track = videoRef.current?.textTracks[0]
    if (!track) return
    const next = !ccEnabled
    track.mode = next ? 'showing' : 'hidden'
    setCcEnabled(next)
  }

  // ── Shared: set modules and find the active lesson ─────────────────────────
  function resolveLesson(sorted: ModuleRow[]) {
    setModules(sorted)
    for (const mod of sorted) {
      if (mod.id === moduleId || mod.slug === moduleId) {
        for (const les of mod.lessons) {
          if (les.id === lessonId || les.slug === lessonId) {
            setModule(mod)
            setLesson(les)
            return
          }
        }
        if (mod.lessons[0]) { setModule(mod); setLesson(mod.lessons[0]); return }
      }
    }
    if (sorted[0]?.lessons[0]) { setModule(sorted[0]); setLesson(sorted[0].lessons[0]) }
  }

  // ── PILOT_MODE: load course anonymously (no auth / no enrollment) ──────────
  const loadCourseAnon = useCallback(async () => {
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', courseSlug)
      .eq('is_published', true)
      .single()

    if (!course) { router.push('/courses'); return }

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, duration_minutes, order_index)')
      .eq('course_id', course.id)
      .order('order_index')

    if (!mods) return

    const sorted: ModuleRow[] = mods.map(m => ({
      ...m,
      lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    }))

    resolveLesson(sorted)
  }, [courseSlug, moduleId, lessonId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Authenticated: load course structure + verify enrollment ──────────────
  const loadCourse = useCallback(async (uid: string) => {
    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', courseSlug)
      .single()

    if (!course) return

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, status')
      .eq('user_id', uid)
      .eq('course_id', course.id)
      .eq('status', 'active')
      .single()

    if (!enrollment) {
      // TEMP_FREE_ACCESS: Auto-enroll in free pilot mode instead of redirecting away.
      if (FREE_ACCESS_MODE) {
        const { error } = await enrollForFree(course.id)
        if (error) { router.push(`/courses/${courseSlug}`); return }
      } else {
        router.push(`/courses/${courseSlug}`)
        return
      }
    }

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, duration_minutes, order_index)')
      .eq('course_id', course.id)
      .order('order_index')

    if (!mods) return

    const sorted: ModuleRow[] = mods.map(m => ({
      ...m,
      lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    }))

    resolveLesson(sorted)
  }, [courseSlug, moduleId, lessonId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load quiz for the current module ──────────────────────────────────────
  const loadQuiz = useCallback(async (modId: string) => {
    setQuizLoading(true)
    const { data: quizData, error: quizErr } = await supabase
      .from('quizzes')
      .select('id, title, passing_score')
      .eq('module_id', modId)
      .limit(1)
      .maybeSingle()

    if (quizErr) console.error('[quiz] fetch error:', quizErr.message, quizErr.code)

    if (!quizData) {
      setQuiz(null)
      setQuizQuestions([])
      setQuizLoading(false)
      return
    }

    setQuiz(quizData)
    const { data: questions, error: qErr } = await supabase
      .from('quiz_questions')
      .select('id, question, options, correct_answer, explanation, order_index')
      .eq('quiz_id', quizData.id)
      .order('order_index', { ascending: true })

    if (qErr) console.error('[quiz_questions] fetch error:', qErr.message, qErr.code)
    setQuizQuestions(questions ?? [])
    setQuizLoading(false)
  }, [supabase])

  // ── Load user progress ─────────────────────────────────────────────────────
  const loadUserProgress = useCallback(async (uid: string) => {
    const { data } = await supabase
      .from('lesson_progress')
      .select('lesson_id')
      .eq('user_id', uid)
      .eq('is_completed', true)

    const map: Record<string, boolean> = {}
    data?.forEach(p => { map[p.lesson_id] = true })
    setProgress(map)
  }, [supabase])

  useEffect(() => {
    if (PILOT_MODE) {
      // Pilot: no auth required — load content anonymously
      loadCourseAnon().finally(() => setLoading(false))
      return
    }
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/login'); return }
      setUserId(user.id)
      Promise.all([loadCourse(user.id), loadUserProgress(user.id)]).finally(() => setLoading(false))
    })
  }, [supabase, router, loadCourse, loadCourseAnon, loadUserProgress])

  // ── Load quiz when the active module changes ──────────────────────────────
  useEffect(() => {
    if (module) loadQuiz(module.id)
  }, [module?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset quiz answers when the lesson changes ────────────────────────────
  useEffect(() => {
    setQuizAnswers({})
    setQuizSubmitted(false)
  }, [lesson?.id])

  // ── Sync completion state when lesson changes ──────────────────────────────
  useEffect(() => {
    if (lesson) setCompleted(!!progress[lesson.id])
  }, [lesson, progress])

  // ── Mark lesson complete (authenticated users only) ────────────────────────
  async function markComplete() {
    if (!lesson || !userId) return
    setCompleted(true)
    setProgress(p => ({ ...p, [lesson.id]: true }))

    await supabase.from('lesson_progress').upsert(
      {
        user_id:      userId,
        lesson_id:    lesson.id,
        is_completed: true,
        completed_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,lesson_id' }
    )
  }

  // ── Build flat lesson list for prev/next navigation ────────────────────────
  const allLessons: FlatLesson[] = modules.flatMap(m =>
    m.lessons.map(l => ({ ...l, module: m }))
  )
  const currentIndex = lesson ? allLessons.findIndex(l => l.id === lesson.id) : -1
  const prevLesson   = currentIndex > 0                       ? allLessons[currentIndex - 1] : null
  const nextLesson   = currentIndex < allLessons.length - 1  ? allLessons[currentIndex + 1] : null
  const isLastLesson         = currentIndex === allLessons.length - 1
  const isLastLessonInModule = !!lesson && !!module &&
    module.lessons[module.lessons.length - 1]?.id === lesson.id

  // ── Quiz pass/fail derived values ──────────────────────────────────────────
  const requiredScore   = Math.max(quiz?.passing_score ?? 80, 80)
  const correctCount    = quizQuestions.filter(q => quizAnswers[q.id] === q.correct_answer).length
  const scorePercent    = quizQuestions.length > 0
    ? Math.round((correctCount / quizQuestions.length) * 100)
    : 0
  const quizPassed      = quizSubmitted && scorePercent >= requiredScore
  const nextIsNewModule = !!nextLesson && nextLesson.module.id !== module?.id
  const nextIsBlocked   = nextIsNewModule && isLastLessonInModule &&
    !!quiz && quizQuestions.length > 0 && !quizPassed

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement…</span>
      </div>
    )
  }

  if (!lesson) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0f1117] text-white/40 gap-4">
        <p className="text-sm">Leçon introuvable.</p>
        <Link href="/courses" className="text-primary text-sm hover:underline">← Les formations</Link>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-72px)] bg-[#0f1117]">

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className={`
        shrink-0 bg-[#1a1d27] border-r border-white/10 overflow-y-auto
        transition-all duration-300 z-40
        ${sideOpen ? 'w-72' : 'w-0 md:w-64'} overflow-hidden
      `}>
        <div className="p-4 border-b border-white/10">
          <Link
            href={PILOT_MODE ? '/courses' : '/dashboard'}
            className="text-xs text-white/50 hover:text-white/80 transition-colors"
          >
            {PILOT_MODE ? '← Les formations' : '← Mon espace'}
          </Link>
        </div>

        <nav>
          {modules.map((mod, mi) => (
            <div key={mod.id}>
              <div className="px-4 py-2.5 bg-white/5">
                <p className="text-[11px] font-bold text-white/50 uppercase tracking-wider">
                  {mi + 1}. {mod.title}
                </p>
              </div>
              {mod.lessons.map(les => {
                const isActive = les.id === lesson?.id
                const isDone   = !!progress[les.id]
                return (
                  <Link
                    key={les.id}
                    href={`/learn/${courseSlug}/${mod.id}/${les.id}`}
                    className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors border-l-2 ${
                      isActive
                        ? 'bg-primary/20 text-white border-primary'
                        : 'text-white/60 border-transparent hover:bg-white/5 hover:text-white/80'
                    }`}
                  >
                    {isDone
                      ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
                      : <span className={`w-4 h-4 rounded-full border shrink-0 ${isActive ? 'border-primary' : 'border-white/20'}`} />
                    }
                    <span className="line-clamp-2 leading-tight">{les.title}</span>
                  </Link>
                )
              })}

              {/* Quiz entry at the bottom of each module */}
              {mod.lessons.length > 0 && (
                <a
                  href={`/learn/${courseSlug}/${mod.id}/${mod.lessons[mod.lessons.length - 1].id}#quiz-section`}
                  className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors border-l-2 ${
                    isLastLessonInModule && mod.id === module?.id
                      ? 'bg-secondary/20 text-secondary border-secondary'
                      : 'text-white/40 border-transparent hover:bg-white/5 hover:text-white/60'
                  }`}
                >
                  <ClipboardList className="w-4 h-4 shrink-0" />
                  <span className="italic">Quiz</span>
                </a>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 bg-[#1a1d27] border-b border-white/10">
          <button
            onClick={() => setSideOpen(o => !o)}
            className="md:hidden p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Toggle sidebar"
          >
            <List className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/50 truncate">{module?.title}</p>
            <p className="text-sm font-semibold text-white truncate">{lesson.title}</p>
          </div>
          {!PILOT_MODE && completed && (
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-success font-semibold">
              <CheckCircle className="w-4 h-4" /> Complétée
            </span>
          )}
        </div>

        {/* Video / Content area */}
        <div className="flex-1 overflow-y-auto bg-[#0f1117]">
          <div className="lesson-video-wrapper max-w-4xl mx-auto mt-6">
            {lesson.video_url ? (
              /\.(mp4|webm|mov|ogg)(\?|$)/i.test(lesson.video_url) || lesson.video_url.startsWith('/') ? (
                <>
                  <video
                    ref={videoRef}
                    key={lesson.video_url}
                    src={lesson.video_url}
                    controls
                    autoPlay
                    controlsList="nodownload"
                    className="absolute inset-0 w-full h-full bg-black"
                    title={lesson.title}
                  >
                    {lesson.subtitle_url && (
                      <track
                        kind="subtitles"
                        src={lesson.subtitle_url}
                        label="Français"
                        srcLang="fr"
                        default
                      />
                    )}
                  </video>
                  {lesson.subtitle_url && (
                    <button
                      onClick={toggleCC}
                      title={ccEnabled ? 'Désactiver les sous-titres' : 'Activer les sous-titres'}
                      className={`absolute bottom-14 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-bold transition-colors ${
                        ccEnabled
                          ? 'bg-primary text-white'
                          : 'bg-black/60 text-white/60 hover:text-white'
                      }`}
                    >
                      <Captions className="w-3.5 h-3.5" /> CC
                    </button>
                  )}
                </>
              ) : (
                <iframe
                  src={lesson.video_url}
                  className="absolute inset-0 w-full h-full"
                  allowFullScreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  title={lesson.title}
                />
              )
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/40 gap-4">
                <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
                  <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
                <p className="text-sm">Vidéo à venir</p>
              </div>
            )}
          </div>

          {/* Lesson content */}
          <div className="max-w-3xl mx-auto px-4 py-8">
            <h1 className="text-2xl font-extrabold text-white mb-6">{lesson.title}</h1>

            {lesson.content && (
              <div
                className="prose prose-invert prose-sm max-w-none text-white/80"
                dangerouslySetInnerHTML={{ __html: lesson.content.replace(/\n/g, '<br/>') }}
              />
            )}

            {/* ── Quiz ──────────────────────────────────────────────────── */}
            <div id="quiz-section" className="mt-10 pt-8 border-t border-white/10">
              {!isLastLessonInModule ? (
                <p className="text-sm text-white/40 italic">
                  Le quiz de ce module sera disponible &agrave; la derni&egrave;re le&ccedil;on.
                </p>
              ) : quizLoading ? (
                <div className="flex items-center gap-2 text-white/40 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Chargement du quiz…
                </div>
              ) : !quiz || quizQuestions.length === 0 ? (
                <p className="text-sm text-white/40 italic">Aucun quiz disponible pour cette le&ccedil;on.</p>
              ) : (
                <div>
                  <h2 className="text-lg font-bold text-white mb-4">{quiz.title}</h2>

                  {/* Instructions */}
                  <div className="mb-7 p-4 rounded-xl bg-white/5 border border-white/10 text-sm text-white/70">
                    <p className="font-semibold text-white/90 mb-2">Instructions</p>
                    <ul className="space-y-1.5">
                      <li>• S&eacute;lectionnez une seule r&eacute;ponse par question</li>
                      <li>• Cliquez sur &laquo;&nbsp;V&eacute;rifier mes r&eacute;ponses&nbsp;&raquo; pour voir votre score</li>
                      <li>• Vous devez obtenir au moins {requiredScore}&nbsp;% pour valider ce module</li>
                      <li>• Vous pouvez recommencer le quiz autant de fois que n&eacute;cessaire</li>
                    </ul>
                  </div>

                  <div className="flex flex-col gap-8">
                    {quizQuestions.map((q, qi) => (
                      <div key={q.id}>
                        <p className="text-sm font-semibold text-white mb-3">{qi + 1}. {q.question}</p>
                        <div className="flex flex-col gap-2">
                          {(q.options as string[]).map((opt, oi) => {
                            const isSelected   = quizAnswers[q.id] === oi
                            const isCorrectOpt = quizSubmitted && oi === q.correct_answer
                            const isWrongOpt   = quizSubmitted && isSelected && oi !== q.correct_answer
                            return (
                              <button
                                key={oi}
                                disabled={quizSubmitted}
                                onClick={() => setQuizAnswers(a => ({ ...a, [q.id]: oi }))}
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
                        {quizSubmitted && q.explanation && (
                          <p className="mt-3 text-xs text-white/50 italic">{q.explanation}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  {!quizSubmitted ? (
                    <button
                      onClick={() => setQuizSubmitted(true)}
                      disabled={Object.keys(quizAnswers).length < quizQuestions.length}
                      className="mt-8 px-6 py-2.5 bg-primary text-white text-sm font-bold rounded-cx hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      V&eacute;rifier mes r&eacute;ponses
                    </button>
                  ) : (
                    <div className="mt-8 p-5 rounded-xl bg-white/5 border border-white/10">
                      <p className="text-sm font-bold text-white">
                        Score&nbsp;: {correctCount}&nbsp;/&nbsp;{quizQuestions.length} ({scorePercent}&nbsp;%)
                      </p>
                      {quizPassed ? (
                        <p className="mt-2 text-sm font-semibold text-success flex items-center gap-1.5">
                          <CheckCircle className="w-4 h-4 shrink-0" />
                          Bravo&nbsp;! Vous avez valid&eacute; ce module.
                        </p>
                      ) : (
                        <p className="mt-2 text-sm text-red-400">
                          Vous devez obtenir au moins {requiredScore}&nbsp;% pour passer au module suivant.
                        </p>
                      )}
                      <button
                        onClick={() => { setQuizAnswers({}); setQuizSubmitted(false) }}
                        className="mt-3 text-xs text-primary hover:underline"
                      >
                        Recommencer le quiz
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 mt-10 pt-6 border-t border-white/10">
              {PILOT_MODE ? (
                // Pilot: no auth — progress tracking unavailable
                <p className="text-sm text-white/40 italic">
                  Le suivi de progression et les certificats seront disponibles après le lancement complet.
                </p>
              ) : (
                <>
                  {!completed ? (
                    <button
                      onClick={markComplete}
                      className="flex items-center gap-2 px-5 py-2.5 bg-success text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm"
                    >
                      <CheckCircle className="w-4 h-4" /> Marquer comme complétée
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 text-success font-semibold text-sm">
                      <CheckCircle className="w-5 h-5" /> Leçon complétée
                    </span>
                  )}

                  {isLastLesson && completed && (
                    <Link
                      href={`/certificate/${courseSlug}`}
                      className="flex items-center gap-2 px-5 py-2.5 bg-yellow-500 text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm"
                    >
                      <Award className="w-4 h-4" /> Obtenir mon certificat
                    </Link>
                  )}
                </>
              )}
            </div>

            {/* Navigation */}
            <div className="flex justify-between mt-8">
              {prevLesson ? (
                <Link
                  href={`/learn/${courseSlug}/${prevLesson.module.id}/${prevLesson.id}`}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white/10 text-white text-sm font-medium rounded-cx hover:bg-white/15 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" /> Leçon précédente
                </Link>
              ) : <div />}

              {nextLesson && (
                nextIsBlocked ? (
                  <span className="flex items-center gap-2 px-4 py-2.5 bg-white/5 text-white/25 text-sm font-semibold rounded-cx cursor-not-allowed select-none">
                    Le&ccedil;on suivante <ChevronRight className="w-4 h-4" />
                  </span>
                ) : (
                  <Link
                    href={`/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary text-white text-sm font-semibold rounded-cx hover:opacity-90 transition-opacity"
                  >
                    Le&ccedil;on suivante <ChevronRight className="w-4 h-4" />
                  </Link>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
