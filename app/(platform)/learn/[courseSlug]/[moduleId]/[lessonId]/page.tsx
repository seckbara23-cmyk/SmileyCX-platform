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

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LessonPlayerPage() {
  const params    = useParams()
  const router    = useRouter()
  const supabase  = createClient()

  const courseSlug = params.courseSlug as string
  const moduleId   = params.moduleId   as string
  const lessonId   = params.lessonId   as string

  const [modules,          setModules]          = useState<ModuleRow[]>([])
  const [lesson,           setLesson]           = useState<LessonRow | null>(null)
  const [module,           setModule]           = useState<ModuleRow | null>(null)
  const [completed,        setCompleted]        = useState(false)
  const [sideOpen,         setSideOpen]         = useState(false)
  const [userId,           setUserId]           = useState<string | null>(null)
  const [progress,         setProgress]         = useState<Record<string, boolean>>({})
  const [loading,          setLoading]          = useState(true)
  const [ccEnabled,        setCcEnabled]        = useState(true)

  // ── Module validation state (from localStorage) ───────────────────────────
  const [validatedModules, setValidatedModules] = useState<Set<string>>(new Set())
  const [modulesWithQuiz,  setModulesWithQuiz]  = useState<Set<string>>(new Set())

  const videoRef = useRef<HTMLVideoElement>(null)

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

  // ── PILOT_MODE: load course anonymously ───────────────────────────────────
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
      loadCourseAnon().finally(() => setLoading(false))
      return
    }
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/login'); return }
      setUserId(user.id)
      Promise.all([loadCourse(user.id), loadUserProgress(user.id)]).finally(() => setLoading(false))
    })
  }, [supabase, router, loadCourse, loadCourseAnon, loadUserProgress])

  // ── Load validated modules + quiz existence ───────────────────────────────
  // For authenticated users, DB quiz_attempts is the source of truth.
  // In PILOT_MODE, gating is disabled entirely — all modules are accessible.
  useEffect(() => {
    if (modules.length === 0) return
    const modIds = modules.map(m => m.id)

    // Always fetch which modules have a quiz (for sidebar icon display).
    supabase
      .from('quizzes')
      .select('module_id')
      .in('module_id', modIds)
      .then(({ data }) => {
        setModulesWithQuiz(new Set((data ?? []).map(q => q.module_id as string)))
      })

    // In PILOT_MODE there is no user account or enrollment — skip gating.
    if (PILOT_MODE) return

    // Authenticated path: use quiz_attempts from the DB.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase
        .from('quiz_attempts')
        .select('module_id')
        .eq('user_id', user.id)
        .eq('passed', true)
        .in('module_id', modIds)
        .then(({ data: attempts }) => {
          setValidatedModules(
            new Set((attempts ?? []).map(a => a.module_id as string))
          )
        })
    })
  }, [modules]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const prevLesson   = currentIndex > 0                      ? allLessons[currentIndex - 1] : null
  const nextLesson   = currentIndex < allLessons.length - 1 ? allLessons[currentIndex + 1] : null
  const isLastLesson         = currentIndex === allLessons.length - 1
  const isLastLessonInModule = !!lesson && !!module &&
    module.lessons[module.lessons.length - 1]?.id === lesson.id

  // ── Next-module gating ────────────────────────────────────────────────────
  // PILOT_MODE: anonymous access — no accounts, no quiz records, no gating.
  const nextIsNewModule    = !!nextLesson && nextLesson.module.id !== module?.id
  const currentModHasQuiz  = modulesWithQuiz.has(module?.id ?? '')
  const currentModPassed   = validatedModules.has(module?.id ?? '')
  const nextIsBlocked      = !PILOT_MODE && nextIsNewModule && isLastLessonInModule && currentModHasQuiz && !currentModPassed

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
          {modules.map((mod, mi) => {
            const isValidated = validatedModules.has(mod.id)
            return (
              <div key={mod.id}>
                {/* Module header */}
                <div className="px-4 py-2.5 bg-white/5 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-bold text-white/50 uppercase tracking-wider truncate">
                    {mi + 1}. {mod.title}
                  </p>
                  {isValidated && (
                    <span className="flex items-center gap-1 shrink-0 text-[10px] font-bold text-success">
                      <CheckCircle className="w-3 h-3" /> Valid&eacute;
                    </span>
                  )}
                </div>

                {/* Lessons */}
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

                {/* Quiz entry */}
                {mod.lessons.length > 0 && (
                  <Link
                    href={`/learn/${courseSlug}/${mod.id}/quiz`}
                    className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors border-l-2 ${
                      module?.id === mod.id && !lesson
                        ? 'bg-secondary/20 text-secondary border-secondary'
                        : 'text-white/40 border-transparent hover:bg-white/5 hover:text-white/60'
                    }`}
                  >
                    <ClipboardList className="w-4 h-4 shrink-0" />
                    <span className="italic">Quiz</span>
                    {isValidated && <CheckCircle className="w-3.5 h-3.5 text-success ml-auto shrink-0" />}
                  </Link>
                )}
              </div>
            )
          })}
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

            {/* ── Actions ───────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3 mt-10 pt-6 border-t border-white/10">
              {PILOT_MODE ? (
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

              {/* "Passer au quiz" CTA on the last lesson of a module */}
              {isLastLessonInModule && (
                <Link
                  href={`/learn/${courseSlug}/${module?.id}/quiz`}
                  className="flex items-center gap-2 px-5 py-2.5 bg-secondary text-white font-semibold rounded-cx hover:opacity-90 transition-opacity text-sm"
                >
                  <ClipboardList className="w-4 h-4" /> Passer au quiz
                </Link>
              )}
            </div>

            {/* ── Navigation ────────────────────────────────────────────── */}
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
