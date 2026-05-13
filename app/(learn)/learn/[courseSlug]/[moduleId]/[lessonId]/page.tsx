'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { List, Loader2, Captions } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { enrollForFree } from '@/app/actions/enrollment'
import { FREE_ACCESS_MODE, PILOT_MODE } from '@/lib/pilot'
import LessonSidebar, { type SidebarModuleRow, type SidebarLessonRow } from '@/components/lms/LessonSidebar'
import LessonNavigation, { type NavLesson } from '@/components/lms/LessonNavigation'
import AutoAdvanceBanner from '@/components/lms/AutoAdvanceBanner'

// ── Types ─────────────────────────────────────────────────────────────────────
interface LessonRow extends SidebarLessonRow {}
interface ModuleRow extends SidebarModuleRow { lessons: LessonRow[] }
interface FlatLesson extends LessonRow { module: ModuleRow }

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LessonPlayerPage() {
  const params   = useParams()
  const router   = useRouter()
  const supabase = createClient()

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

  const [validatedModules, setValidatedModules] = useState<Set<string>>(new Set())
  const [modulesWithQuiz,  setModulesWithQuiz]  = useState<Set<string>>(new Set())

  // Auto-advance state — only active when completion fires in this session
  const [justCompleted,        setJustCompleted]        = useState(false)
  const [autoAdvanceCancelled, setAutoAdvanceCancelled] = useState(false)

  const videoRef         = useRef<HTMLVideoElement>(null)
  const autoCompletedRef = useRef(false)

  function toggleCC() {
    const track = videoRef.current?.textTracks[0]
    if (!track) return
    const next = !ccEnabled
    track.mode = next ? 'showing' : 'hidden'
    setCcEnabled(next)
  }

  // ── Resolve active module/lesson from sorted data ─────────────────────────
  function resolveLesson(sorted: ModuleRow[]) {
    setModules(sorted)
    for (const mod of sorted) {
      if (mod.id === moduleId || mod.slug === moduleId) {
        for (const les of mod.lessons) {
          if (les.id === lessonId || les.slug === lessonId) {
            setModule(mod); setLesson(les); return
          }
        }
        if (mod.lessons[0]) { setModule(mod); setLesson(mod.lessons[0]); return }
      }
    }
    if (sorted[0]?.lessons[0]) { setModule(sorted[0]); setLesson(sorted[0].lessons[0]) }
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadCourseAnon = useCallback(async () => {
    const { data: course } = await supabase
      .from('courses').select('id')
      .eq('slug', courseSlug).eq('is_published', true).single()
    if (!course) { router.push('/courses'); return }

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, duration_minutes, order_index)')
      .eq('course_id', course.id).order('order_index')
    if (!mods) return

    resolveLesson(mods.map(m => ({
      ...m, lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    })))
  }, [courseSlug, moduleId, lessonId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCourse = useCallback(async (uid: string) => {
    const { data: course } = await supabase
      .from('courses').select('id').eq('slug', courseSlug).single()
    if (!course) return

    const { data: enrollment } = await supabase
      .from('enrollments').select('id, status')
      .eq('user_id', uid).eq('course_id', course.id).eq('status', 'active').single()

    if (!enrollment) {
      if (FREE_ACCESS_MODE) {
        const { error } = await enrollForFree(course.id)
        if (error) { router.push(`/courses/${courseSlug}`); return }
      } else {
        router.push(`/courses/${courseSlug}`); return
      }
    }

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, duration_minutes, order_index)')
      .eq('course_id', course.id).order('order_index')
    if (!mods) return

    resolveLesson(mods.map(m => ({
      ...m, lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    })))
  }, [courseSlug, moduleId, lessonId, supabase, router]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadUserProgress = useCallback(async (uid: string) => {
    const { data } = await supabase
      .from('lesson_progress').select('lesson_id')
      .eq('user_id', uid).eq('is_completed', true)
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

  // ── Quiz metadata ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (modules.length === 0) return
    const modIds = modules.map(m => m.id)
    supabase.from('quizzes').select('module_id').in('module_id', modIds)
      .then(({ data }) => setModulesWithQuiz(new Set((data ?? []).map(q => q.module_id as string))))
    if (PILOT_MODE) return
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('quiz_attempts').select('module_id')
        .eq('user_id', user.id).eq('passed', true).in('module_id', modIds)
        .then(({ data: a }) => setValidatedModules(new Set((a ?? []).map(x => x.module_id as string))))
    })
  }, [modules]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-lesson reset: fires when navigating to a new lesson ───────────────
  useEffect(() => {
    autoCompletedRef.current = false
    setJustCompleted(false)
    setAutoAdvanceCancelled(false)
  }, [lesson?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync completed state from persisted progress ──────────────────────────
  useEffect(() => {
    if (lesson) setCompleted(!!progress[lesson.id])
  }, [lesson?.id, progress]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Completion: save progress and optionally trigger auto-advance ─────────
  async function markComplete(suppressAutoAdvance = false) {
    if (!lesson || completed) return
    setCompleted(true)
    setProgress(p => ({ ...p, [lesson.id]: true }))
    if (!suppressAutoAdvance) setJustCompleted(true)
    if (!userId) return
    await supabase.from('lesson_progress').upsert(
      { user_id: userId, lesson_id: lesson.id, is_completed: true, completed_at: new Date().toISOString() },
      { onConflict: 'user_id,lesson_id' }
    )
  }

  // ── Video: auto-complete at 85% — only while actively playing ─────────────
  function handleVideoTimeUpdate() {
    if (completed || autoCompletedRef.current || !videoRef.current) return
    const { currentTime, duration, paused } = videoRef.current
    if (duration > 0 && currentTime / duration >= 0.85) {
      autoCompletedRef.current = true
      // If paused at 85%: save progress but don't start countdown
      markComplete(paused)
    }
  }

  // ── Video: auto-complete on natural end ───────────────────────────────────
  function handleVideoEnded() {
    if (completed) return
    autoCompletedRef.current = true
    markComplete(false) // always trigger auto-advance on natural end
  }

  // ── Derived navigation state ──────────────────────────────────────────────
  const allLessons: FlatLesson[]  = modules.flatMap(m => m.lessons.map(l => ({ ...l, module: m })))
  const currentIndex              = lesson ? allLessons.findIndex(l => l.id === lesson.id) : -1
  const prevLesson                = currentIndex > 0                       ? allLessons[currentIndex - 1] : null
  const nextLesson                = currentIndex < allLessons.length - 1  ? allLessons[currentIndex + 1] : null
  const isLastLesson              = currentIndex === allLessons.length - 1
  const isLastLessonInModule      = !!lesson && !!module &&
    module.lessons[module.lessons.length - 1]?.id === lesson.id

  const nextIsNewModule    = !!nextLesson && nextLesson.module.id !== module?.id
  const currentModHasQuiz  = modulesWithQuiz.has(module?.id ?? '')
  const currentModPassed   = validatedModules.has(module?.id ?? '')
  const nextIsBlocked      = !PILOT_MODE && nextIsNewModule && isLastLessonInModule && currentModHasQuiz && !currentModPassed

  // ── Auto-advance target ────────────────────────────────────────────────────
  type AdvanceTarget = { href: string; label: string }

  function getAutoAdvanceTarget(): AdvanceTarget | null {
    if (PILOT_MODE) {
      if (!nextLesson) return null
      return { href: `/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`, label: 'Leçon suivante' }
    }
    if (isLastLesson) {
      return { href: `/certificate/${courseSlug}`, label: 'Vers votre certificat' }
    }
    if (nextIsBlocked || (isLastLessonInModule && currentModHasQuiz && !currentModPassed)) {
      return { href: `/learn/${courseSlug}/${module?.id}/quiz`, label: 'Quiz du module' }
    }
    if (nextLesson) {
      return { href: `/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`, label: 'Leçon suivante' }
    }
    return null
  }

  const autoAdvanceTarget   = getAutoAdvanceTarget()
  const showAutoAdvance     = justCompleted && !autoAdvanceCancelled && autoAdvanceTarget !== null

  const navPrevLesson: NavLesson | null = prevLesson
    ? { id: prevLesson.id, title: prevLesson.title, module: { id: prevLesson.module.id } }
    : null
  const navNextLesson: NavLesson | null = nextLesson
    ? { id: nextLesson.id, title: nextLesson.title, module: { id: nextLesson.module.id } }
    : null

  // ── Loading / error ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-72px)] bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement…</span>
      </div>
    )
  }

  if (!lesson) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-72px)] bg-[#0f1117] text-white/40 gap-4">
        <p className="text-sm">Leçon introuvable.</p>
        <Link href="/courses" className="text-primary text-sm hover:underline">← Les formations</Link>
      </div>
    )
  }

  return (
    <div className="relative flex h-[calc(100vh-72px)] bg-[#0f1117]">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <LessonSidebar
        modules={modules}
        courseSlug={courseSlug}
        activeLessonId={lesson.id}
        activeModuleId={module?.id ?? null}
        progress={progress}
        validatedModules={validatedModules}
        modulesWithQuiz={modulesWithQuiz}
        pilotMode={PILOT_MODE}
        sideOpen={sideOpen}
        onClose={() => setSideOpen(false)}
      />

      {/* ── Main area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 bg-[#1a1d27] border-b border-white/10 shrink-0">
          <button
            onClick={() => setSideOpen(o => !o)}
            className="md:hidden p-1.5 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Ouvrir le menu"
          >
            <List className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/45 truncate">{module?.title}</p>
            <p className="text-sm font-semibold text-white truncate">{lesson.title}</p>
          </div>
          {!PILOT_MODE && completed && (
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-success font-semibold shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Complétée
            </span>
          )}
        </div>

        {/* Content area — internal scroll */}
        <div className="flex-1 overflow-y-auto bg-[#0f1117]">

          {/* Video */}
          <div className="lesson-video-wrapper max-w-4xl mx-auto mt-6">
            {lesson.video_url ? (
              /\.(mp4|webm|mov|ogg)(\?|$)/i.test(lesson.video_url) || lesson.video_url.startsWith('/') ? (
                <>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    ref={videoRef}
                    key={lesson.video_url}
                    src={lesson.video_url}
                    controls
                    controlsList="nodownload"
                    className="absolute inset-0 w-full h-full bg-black"
                    title={lesson.title}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onEnded={handleVideoEnded}
                  >
                    {lesson.subtitle_url && (
                      <track kind="subtitles" src={lesson.subtitle_url} label="Français" srcLang="fr" default />
                    )}
                  </video>
                  {lesson.subtitle_url && (
                    <button
                      onClick={toggleCC}
                      title={ccEnabled ? 'Désactiver les sous-titres' : 'Activer les sous-titres'}
                      className={`absolute bottom-14 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-bold transition-colors ${
                        ccEnabled ? 'bg-primary text-white' : 'bg-black/60 text-white/60 hover:text-white'
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

          {/* Lesson content + navigation */}
          <div className="max-w-3xl mx-auto px-4 pt-6 pb-28 md:pb-10">

            {/* Auto-advance banner — appears immediately after video on completion */}
            {showAutoAdvance && autoAdvanceTarget && (
              <div className="mb-6">
                <AutoAdvanceBanner
                  nextHref={autoAdvanceTarget.href}
                  nextLabel={autoAdvanceTarget.label}
                  delaySeconds={5}
                  onCancel={() => setAutoAdvanceCancelled(true)}
                />
              </div>
            )}

            <h1 className="text-2xl font-extrabold text-white mb-6">{lesson.title}</h1>

            {lesson.content && (
              <div
                className="prose prose-invert prose-sm max-w-none text-white/80"
                dangerouslySetInnerHTML={{ __html: lesson.content.replace(/\n/g, '<br/>') }}
              />
            )}

            <LessonNavigation
              courseSlug={courseSlug}
              prevLesson={navPrevLesson}
              nextLesson={navNextLesson}
              completed={completed}
              justCompleted={justCompleted && !autoAdvanceCancelled}
              isLastLesson={isLastLesson}
              isLastLessonInModule={isLastLessonInModule}
              currentModHasQuiz={currentModHasQuiz}
              currentModPassed={currentModPassed}
              nextIsBlocked={nextIsBlocked}
              moduleId={module?.id ?? null}
              pilotMode={PILOT_MODE}
              onMarkComplete={() => markComplete(false)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
