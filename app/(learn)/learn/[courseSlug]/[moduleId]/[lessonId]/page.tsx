'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { List, Loader2, Captions } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { ensureAcademicEnrollment } from '@/app/actions/enrollment'
// UAT-ACCESS-01: FREE_ACCESS_MODE is deliberately no longer imported here.
// It was an access authority in this file and must never be one again.
import { PILOT_MODE } from '@/lib/pilot'
import { moduleQuizHref } from '@/lib/learn/routes'
import { lessonAssetSrc } from '@/lib/media/paths'
import LessonSidebar, { type SidebarModuleRow, type SidebarLessonRow } from '@/components/lms/LessonSidebar'
import { buildSidebarStructure } from '@/components/lms/sidebarStructure'
import LessonNavigation, { type NavLesson } from '@/components/lms/LessonNavigation'
import AutoAdvanceBanner from '@/components/lms/AutoAdvanceBanner'
import ExerciseBlock, { type ExerciseData } from '@/components/lms/ExerciseBlock'
import VoicePracticeBlock from '@/components/ai/VoicePracticeBlock'
import { AI_VOICE_ENABLED } from '@/lib/ai/flags'
import { fetchVoiceScenario, type VoiceScenario } from '@/app/actions/ai-practice'
import { completeLesson } from '@/app/actions/progress'

// ── Types ─────────────────────────────────────────────────────────────────────
interface LessonRow extends SidebarLessonRow {}
interface ModuleRow extends SidebarModuleRow { lessons: LessonRow[] }
interface FlatLesson extends LessonRow { module: ModuleRow }

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m} min` : `${h}h`
}

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
  const [hasFinalExam,     setHasFinalExam]     = useState(false)
  const [finalExamPassed,  setFinalExamPassed]  = useState(false)
  const [exercises,        setExercises]        = useState<ExerciseData[]>([])
  const [voiceScenario,    setVoiceScenario]    = useState<VoiceScenario | null>(null)
  // XPA-8 B-2.6 — set when the server REFUSES a completion the UI had already
  // shown optimistically. Null in the overwhelmingly common case.
  const [completionError,  setCompletionError]  = useState<string | null>(null)

  // Auto-advance state — only active when completion fires in this session
  const [justCompleted,        setJustCompleted]        = useState(false)
  const [autoAdvanceCancelled, setAutoAdvanceCancelled] = useState(false)
  // Actual video duration in minutes, populated by loadedmetadata; overrides lesson.duration_minutes
  const [videoDuration,        setVideoDuration]        = useState<number | null>(null)

  const videoRef         = useRef<HTMLVideoElement>(null)
  const autoCompletedRef = useRef(false)
  const progressRef      = useRef<Record<string, boolean>>({})
  const courseIdRef      = useRef<string | null>(null)

  // ── Progress persistence helpers ──────────────────────────────────────────
  // Key is scoped to the real course UUID so multiple courses never collide.
  const updateProgress = useCallback((map: Record<string, boolean>) => {
    progressRef.current = map
    setProgress(map)
    if (!courseIdRef.current) return
    try { localStorage.setItem(`lms_progress_${courseIdRef.current}`, JSON.stringify(map)) } catch {}
  }, [])

  // Called as soon as courseId is known (before the module/progress fetches
  // complete) so that PILOT_MODE progress and the auth-user warm cache are
  // available the moment the sidebar renders.
  // Also handles one-time migration from the old flat `lms_progress` key.
  const loadProgressFromCache = useCallback((courseId: string) => {
    courseIdRef.current = courseId
    const key = `lms_progress_${courseId}`
    try {
      // One-time migration: if the legacy flat key exists and the scoped key
      // has no data yet, copy it over, then delete the legacy key.
      const legacy = localStorage.getItem('lms_progress')
      if (legacy) {
        if (!localStorage.getItem(key)) localStorage.setItem(key, legacy)
        localStorage.removeItem('lms_progress')
      }
      const s = localStorage.getItem(key)
      if (s) { const m = JSON.parse(s); progressRef.current = m; setProgress(m) }
    } catch {}
  }, [])

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

    // Hydrate from localStorage immediately with the now-known courseId,
    // before the (slower) module fetch completes.
    loadProgressFromCache(course.id)

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, video_object_path, subtitle_object_path, duration_minutes, order_index)')
      .eq('course_id', course.id).order('order_index')
    if (!mods) return

    resolveLesson(mods.map(m => ({
      ...m, lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    })))
  }, [courseSlug, moduleId, lessonId, supabase, router, loadProgressFromCache]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCourse = useCallback(async (uid: string) => {
    const { data: course } = await supabase
      .from('courses').select('id').eq('slug', courseSlug).single()
    if (!course) return

    // Set courseId and warm the progress cache before the enrollment + module
    // fetches run; courseIdRef is also needed by updateProgress (DB path).
    loadProgressFromCache(course.id)

    // ── UAT-ACCESS-01: the ENTITLEMENT decides, not the enrollment ──────────
    //
    // This used to read `enrollments` and redirect when none existed, falling
    // back to `enrollForFree` under FREE_ACCESS_MODE. Two things were wrong:
    // an enrollment is academic state and never an authority (Q-L), and the
    // fallback made a mode flag decide access. A learner holding a valid
    // entitlement was bounced out of a player the layout had already admitted
    // them to — two gates disagreeing, with the wrong one winning.
    //
    // `my_course_access` is the learner-safe projection of the same seam the
    // layout enforces server-side and `has_course_access()` enforces in SQL.
    // It is the browser-readable half, and it is what the dashboard already uses.
    const { data: access } = await supabase
      .from('my_course_access')
      .select('has_access')
      .eq('course_id', course.id)
      .maybeSingle()

    if (!access?.has_access) { router.push(`/courses/${courseSlug}`); return }

    // Authorized. NOW give them somewhere to accumulate progress. This runs
    // after the decision, never as part of it, and its failure cannot deny
    // entry — `lesson_progress` is keyed on (user_id, lesson_id) and does not
    // reference an enrollment.
    void ensureAcademicEnrollment(course.id)

    const { data: mods } = await supabase
      .from('modules')
      .select('id, slug, title, order_index, lessons(id, slug, title, content, video_url, subtitle_url, video_object_path, subtitle_object_path, duration_minutes, order_index)')
      .eq('course_id', course.id).order('order_index')
    if (!mods) return

    resolveLesson(mods.map(m => ({
      ...m, lessons: [...(m.lessons as LessonRow[])].sort((a, b) => a.order_index - b.order_index),
    })))
  }, [courseSlug, moduleId, lessonId, supabase, router, loadProgressFromCache]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadUserProgress = useCallback(async (uid: string) => {
    const { data } = await supabase
      .from('lesson_progress').select('lesson_id')
      .eq('user_id', uid).eq('is_completed', true)
    const map: Record<string, boolean> = {}
    data?.forEach(p => { map[p.lesson_id] = true })
    updateProgress(map) // DB is source of truth for auth users; caches to localStorage
  }, [supabase, updateProgress])

  useEffect(() => {
    // UAT-ACCESS-01 — operating-mode independence.
    //
    // PILOT_MODE used to short-circuit here, so an authenticated learner never
    // reached `loadCourse` and their access was never evaluated against the
    // entitlement seam at all. A signed-in learner now always takes the
    // authorized path, in every mode; the anonymous branch survives only for
    // pilot browsing, and the layout redirects unauthenticated callers to
    // /login before this component renders anyway.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        if (PILOT_MODE) { loadCourseAnon().finally(() => setLoading(false)); return }
        router.push('/login')
        return
      }
      setUserId(user.id)
      Promise.all([loadCourse(user.id), loadUserProgress(user.id)]).finally(() => setLoading(false))
    })
  }, [supabase, router, loadCourse, loadCourseAnon, loadUserProgress])

  // ── Quiz metadata ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (modules.length === 0) return
    const modIds   = modules.map(m => m.id)
    const courseId = courseIdRef.current

    // ── XPA-8 B-2.3A: only a MODULE-SCOPED quiz gates a module ─────────────
    //
    // This used to add a module to the gated set if any of its LESSONS carried
    // a quiz. C1-F1 has exactly one quiz — "Echauffement — Reperez le niveau",
    // a 3-question lesson-scoped warm-up — so that rule quietly made a warm-up
    // a hard progression gate on the course's first module. It was invisible
    // only because `nextIsBlocked` is additionally `!PILOT_MODE`, i.e. the gate
    // would have armed itself the day the platform flipped to private. That is
    // the same latent mode coupling B-2.6 removed from completion.
    //
    // Ratified: the warm-up is FORMATIVE and ungated. It keeps its full
    // feedback and blocks nothing. Module-quiz infrastructure is preserved —
    // a genuine module-scoped quiz still gates its module — but a lesson-scoped
    // quiz never does, and neither gates certification (see
    // lib/learn/assessment.ts).
    supabase.from('quizzes').select('module_id').in('module_id', modIds)
      .then(({ data: modData }) => {
        const gated = new Set<string>()
        ;(modData ?? []).forEach(q => { if (q.module_id) gated.add(q.module_id as string) })
        setModulesWithQuiz(gated)
      })

    // Check for course-level final exam quiz
    if (courseId) {
      supabase.from('quizzes').select('id').eq('course_id', courseId).maybeSingle()
        .then(({ data: fq }) => {
          if (!fq) return
          setHasFinalExam(true)
          if (PILOT_MODE) {
            try {
              const s = localStorage.getItem(`final-exam-${courseSlug}`)
              if (s && JSON.parse(s).passed) setFinalExamPassed(true)
            } catch {}
            return
          }
          supabase.auth.getUser().then(({ data: { user } }) => {
            if (!user) return
            supabase.from('quiz_attempts').select('id')
              .eq('user_id', user.id).eq('quiz_id', fq.id).eq('passed', true).limit(1)
              .then(({ data: a }) => { if ((a ?? []).length > 0) setFinalExamPassed(true) })
          })
        })
    }

    if (PILOT_MODE) {
      // For pilot users there are no quiz_attempts rows; read from localStorage instead.
      const validated = new Set<string>()
      for (const mod of modules) {
        try {
          const s = localStorage.getItem(`quiz-${mod.id}`)
          if (s && JSON.parse(s).passed) validated.add(mod.id)
        } catch {}
      }
      setValidatedModules(validated)
      return
    }
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('quiz_attempts').select('module_id')
        .eq('user_id', user.id).eq('passed', true).in('module_id', modIds)
        .then(({ data: a }) => setValidatedModules(new Set((a ?? []).map(x => x.module_id as string))))
    })
  }, [modules]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-lesson reset + exercise load: fires when navigating to a new lesson
  useEffect(() => {
    autoCompletedRef.current = false
    setJustCompleted(false)
    setAutoAdvanceCancelled(false)
    setVideoDuration(null)
    setExercises([])
    setVoiceScenario(null)
    setCompletionError(null)

    if (!lesson?.id) return

    // Voice Practice: only query when the feature flag is enabled, so lessons
    // without the flag (i.e. production by default) make zero extra requests
    // and render exactly as before. Fails safe to null (no block) on any error.
    if (AI_VOICE_ENABLED) {
      fetchVoiceScenario(lesson.id).then(setVoiceScenario).catch(() => setVoiceScenario(null))
    }

    supabase
      .from('exercises')
      // XPA-6D: `correct_category_id` must never be selected here. This is the
      // BROWSER client, so anything named in this projection is shipped to the
      // learner. Migration 038 also revokes the column, so adding it back turns
      // this query into a 42501 rather than a silent leak.
      .select('id, title, instructions, exercise_categories(id, name, color, order_index), exercise_items(id, label, order_index)')
      .eq('lesson_id', lesson.id)
      .eq('is_published', true)
      .order('order_index')
      .then(({ data }) => {
        if (!data) return
        type CatRow  = ExerciseData['categories'][number] & { order_index: number }
        type ItemRow = ExerciseData['items'][number]      & { order_index: number }
        setExercises(data.map(ex => ({
          id:           ex.id,
          title:        ex.title,
          instructions: ex.instructions,
          categories:   ([...(ex.exercise_categories as unknown as CatRow[])]).sort((a, b) => a.order_index - b.order_index),
          items:        ([...(ex.exercise_items      as unknown as ItemRow[])]).sort((a, b) => a.order_index - b.order_index),
        })))
      })
  }, [lesson?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync completed state from persisted progress ──────────────────────────
  useEffect(() => {
    if (lesson) setCompleted(!!progress[lesson.id])
  }, [lesson?.id, progress]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Completion: save progress and optionally trigger auto-advance ─────────
  //
  // XPA-8 B-2.6 — this used to upsert `lesson_progress` straight from the
  // browser with the learner's own JWT. RLS enforced `user_id = auth.uid()` and
  // nothing else, so the write was authenticated but not AUTHORIZED: a single
  // API call let any account complete any lesson, in a course it had never been
  // entitled to, with an expired or revoked entitlement, or in a course
  // withdrawn from publication. Four of six production fixtures wrote
  // successfully with `has_course_access() = false`.
  //
  // Completion is now asserted through `completeLesson`, which re-checks the
  // entitlement seam server-side before writing. The browser proposes; the
  // server decides.
  //
  // The stale comment that used to sit here claimed "In PILOT_MODE userId is
  // null, so localStorage is the only persistence." That has been false since
  // UAT-ACCESS-01 — `userId` is set at line ~217 for any signed-in learner, in
  // every mode, and authenticated pilot learners have been persisting to the
  // database all along. It was the residue that made the mode coupling look
  // deliberate.
  async function markComplete(suppressAutoAdvance = false) {
    if (!lesson || completed) return
    const courseId = courseIdRef.current
    const snapshot = progressRef.current

    // Optimistic. The sidebar ticks, the remaining-time estimate and the
    // auto-advance banner all read this state, and a completion that is going
    // to be accepted should not wait a round trip to feel done.
    setCompleted(true)
    if (!suppressAutoAdvance) setJustCompleted(true)
    setCompletionError(null)
    updateProgress({ ...snapshot, [lesson.id]: true })

    // Anonymous pilot browsing has no identity to attribute progress to and no
    // entitlement to check; localStorage above is the whole of its persistence,
    // exactly as before. This is the one remaining branch and it turns on
    // IDENTITY, not on PLATFORM_MODE.
    if (!userId || !courseId) return

    const result = await completeLesson(lesson.id, courseId)
    if (result.ok) return

    // Refused. Put the UI back where it was rather than showing a tick the
    // server did not record — a learner whose access lapsed mid-course must not
    // be told they finished something the transcript will not contain.
    setCompleted(false)
    setJustCompleted(false)
    autoCompletedRef.current = false
    updateProgress(snapshot)
    setCompletionError(
      result.reason === 'access_ended'
        ? 'Votre accès à cette formation n’est plus actif. Votre progression est conservée — contactez-nous pour le rétablir.'
        : 'Votre progression n’a pas pu être enregistrée. Rechargez la page ou contactez-nous si cela persiste.'
    )
  }

  // ── Video: complete within final 2 s — save progress, suppress countdown ──
  function handleVideoTimeUpdate() {
    if (completed || autoCompletedRef.current || !videoRef.current) return
    const { currentTime, duration, seeking } = videoRef.current
    if (seeking) return
    if (duration > 0 && currentTime > 0 && duration - currentTime <= 2) {
      autoCompletedRef.current = true
      markComplete(true) // suppress auto-advance; onEnded triggers the countdown
    }
  }

  // ── Video: capture real duration from metadata for the lesson info strip ──
  function handleVideoLoadedMetadata() {
    const dur = videoRef.current?.duration
    if (dur && isFinite(dur) && dur > 0) setVideoDuration(Math.ceil(dur / 60))
  }

  // ── Video: natural end — trigger auto-advance countdown ──────────────────
  function handleVideoEnded() {
    autoCompletedRef.current = true
    if (!completed) {
      markComplete(false) // short video or seeked to end before threshold
    } else if (!autoAdvanceCancelled) {
      setJustCompleted(true) // threshold already saved progress; start countdown
    }
  }

  // ── Derived navigation state ──────────────────────────────────────────────
  // Order lessons the same way the sidebar renders them: standalone intro
  // lessons first, then the numbered modules' remaining lessons. Each lesson
  // keeps its *raw* owning module (so its URL and quiz gating are unchanged).
  const sidebarStructure = buildSidebarStructure(modules)
  const rawModuleById     = new Map(modules.map(m => [m.id, m]))
  const allLessons: FlatLesson[] = [
    ...sidebarStructure.standalone.map(s => ({ ...s.lesson, module: rawModuleById.get(s.moduleId)! })),
    ...sidebarStructure.modules.flatMap(m =>
      m.lessons.map(l => ({ ...l, module: rawModuleById.get(m.id)! }))
    ),
  ]
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

  // ── Lesson metadata ────────────────────────────────────────────────────────
  // moduleIndex is kept on the raw module list for the remaining-time / quiz math.
  const moduleIndex     = module ? modules.findIndex(m => m.id === module.id) : -1
  // Display numbering follows the visible (standalone-partitioned) structure.
  const activeIsStandalone = !!lesson && sidebarStructure.standalone.some(s => s.lesson.id === lesson.id)
  const numberedIndex   = module ? sidebarStructure.modules.findIndex(m => m.id === module.id) : -1
  const numberedModule  = numberedIndex >= 0 ? sidebarStructure.modules[numberedIndex] : undefined
  const moduleNumber    = numberedIndex + 1
  const lessonInModIdx  = lesson && numberedModule ? numberedModule.lessons.findIndex(l => l.id === lesson.id) : -1
  const lessonNumber    = lessonInModIdx + 1
  const totalModLessons = numberedModule?.lessons.length ?? 0
  // videoDuration (from loadedmetadata) is more accurate than the DB field; fall back gracefully
  const displayDuration = videoDuration ?? lesson?.duration_minutes ?? null

  // Remaining incomplete steps after the current lesson (lessons + unpassed quizzes)
  const FALLBACK_MINS = 5
  const remainingMinutes = (() => {
    if (currentIndex < 0 || moduleIndex < 0) return 0
    const lessonMins = allLessons
      .slice(currentIndex + 1)
      .filter(l => !progress[l.id])
      .reduce((s, l) => s + (l.duration_minutes ?? FALLBACK_MINS), 0)
    const quizMins = modules
      .filter((m, i) => i >= moduleIndex && modulesWithQuiz.has(m.id) && !validatedModules.has(m.id))
      .length * FALLBACK_MINS
    return lessonMins + quizMins
  })()

  // ── Auto-advance target ────────────────────────────────────────────────────
  type AdvanceTarget = { href: string; label: string }

  function getAutoAdvanceTarget(): AdvanceTarget | null {
    if (PILOT_MODE) {
      if (!nextLesson) return null
      return { href: `/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`, label: 'Leçon suivante' }
    }
    // Quiz gate: always route through the module quiz before advancing further,
    // even when this is the very last lesson of the course.
    if (isLastLessonInModule && currentModHasQuiz && !currentModPassed) {
      // UAT-ROUTE-01: `module` is state and can be null before resolution, so
      // `${module?.id}` would have produced "/learn/<slug>/undefined/quiz".
      const quizHref = moduleQuizHref(courseSlug, module)
      if (quizHref) return { href: quizHref, label: 'Quiz du module' }
    }
    if (isLastLesson && hasFinalExam && !finalExamPassed) {
      return { href: `/learn/${courseSlug}/final-exam`, label: 'Examen final' }
    }
    if (isLastLesson) {
      return { href: `/certificate/${courseSlug}`, label: 'Vers votre certificat' }
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
      <div className="flex items-center justify-center h-[calc(100vh-48px)] bg-[#0f1117] text-white/40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Chargement…</span>
      </div>
    )
  }

  if (!lesson) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-48px)] bg-[#0f1117] text-white/40 gap-4">
        <p className="text-sm">Leçon introuvable.</p>
        <Link href="/courses" className="text-primary text-sm hover:underline">← Les formations</Link>
      </div>
    )
  }

  // ── XPA-8 W3 (F-2): where the media actually comes from ───────────────────
  //
  // A lesson we host resolves to `/api/media/lesson/<id>/video`, which
  // re-checks the entitlement and 302s to a URL valid for five minutes. A
  // lesson pointing at somebody else's platform keeps its own URL. Precedence
  // is decided by `lessonAssetSrc`, never here, so the player and the delivery
  // route cannot disagree about which asset a lesson has.
  //
  // Until migration 042 backfills the paths this returns the existing
  // video_url unchanged — which is what makes this code safe to deploy before
  // the objects have moved.
  const isProtectedVideo = Boolean(lesson.video_object_path)
  const videoSrc    = lessonAssetSrc(lesson.id, 'video',    lesson.video_object_path,    lesson.video_url)
  const subtitleSrc = lessonAssetSrc(lesson.id, 'subtitle', lesson.subtitle_object_path, lesson.subtitle_url)

  return (
    <div className="relative flex h-[calc(100vh-48px)] bg-[#0f1117]">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <LessonSidebar
        modules={modules}
        courseSlug={courseSlug}
        activeLessonId={lesson.id}
        activeModuleId={module?.id ?? null}
        progress={progress}
        validatedModules={validatedModules}
        modulesWithQuiz={modulesWithQuiz}
        hasFinalExam={hasFinalExam}
        finalExamPassed={finalExamPassed}
        isFinalExamActive={false}
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
            <p className="text-xs text-white/45 truncate">{activeIsStandalone ? 'Introduction' : module?.title}</p>
            <p className="text-sm font-semibold text-white truncate">{lesson.title}</p>
          </div>
          {/* XPA-8 B-2.6 — was `!PILOT_MODE &&`. The badge reports a fact about
              this learner's record, so it follows identity like every other
              completion affordance, not the operating mode. */}
          {userId !== null && completed && (
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-success font-semibold shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Complétée
            </span>
          )}
        </div>

        {/* Content area — internal scroll */}
        <div className="flex-1 overflow-y-auto bg-[#0f1117]">

          {/* Video */}
          <div className="lesson-video-wrapper max-w-4xl mx-auto mt-4">
            {videoSrc ? (
              /* XPA-8 W3 (F-2): a protected asset resolves to an application
                 route, not a Storage URL. `/api/media/...` has no file
                 extension, so it is matched explicitly here — the extension
                 test below still decides between <video> and an <iframe> for
                 EXTERNAL urls (a YouTube embed is not a media file). */
              isProtectedVideo
              || /\.(mp4|webm|mov|ogg)(\?|$)/i.test(videoSrc)
              || videoSrc.startsWith('/') ? (
                <>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    ref={videoRef}
                    key={videoSrc}
                    src={videoSrc}
                    controls
                    controlsList="nodownload"
                    className="absolute inset-0 w-full h-full bg-black"
                    title={lesson.title}
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onEnded={handleVideoEnded}
                  >
                    {subtitleSrc && (
                      <track kind="subtitles" src={subtitleSrc} label="Français" srcLang="fr" default />
                    )}
                  </video>
                  {subtitleSrc && (
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
                  src={videoSrc}
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

            <h1 className="text-2xl font-extrabold text-white mb-1.5">{lesson.title}</h1>

            {/* Lesson metadata strip */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 mb-6 text-[11px] text-white/35 font-medium select-none leading-relaxed">
              {activeIsStandalone ? (
                <span>Introduction</span>
              ) : moduleNumber > 0 && (
                <span>Module&nbsp;{moduleNumber}&ensp;·&ensp;Leçon&nbsp;{lessonNumber}&nbsp;/&nbsp;{totalModLessons}</span>
              )}
              {displayDuration !== null && displayDuration > 0 && (
                <>
                  <span className="text-white/15" aria-hidden>·</span>
                  <span>{displayDuration}&nbsp;min</span>
                </>
              )}
              {remainingMinutes > 0 && (
                <>
                  <span className="text-white/15" aria-hidden>·</span>
                  <span>~{fmtMinutes(remainingMinutes)}&nbsp;restantes</span>
                </>
              )}
            </div>

            {lesson.content && (
              <div
                className="prose prose-invert prose-sm max-w-none text-white/80"
                dangerouslySetInnerHTML={{ __html: lesson.content.replace(/\n/g, '<br/>') }}
              />
            )}

            {exercises.map(ex => (
              <ExerciseBlock key={ex.id} exercise={ex} />
            ))}

            {AI_VOICE_ENABLED && voiceScenario && (
              <VoicePracticeBlock scenario={voiceScenario} pilotMode={PILOT_MODE} />
            )}

            {completionError && (
              <p
                role="status"
                className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200/90"
              >
                {completionError}
              </p>
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
              // XPA-8 B-2.6 — was `pilotMode={PILOT_MODE}`. An operating mode is
              // not an academic authority; identity is. A signed-in learner sees
              // the same completion control in pilot and in private mode, and
              // whether they may actually record it is decided server-side by
              // the entitlement seam, not here.
              canComplete={userId !== null}
              hasFinalExam={hasFinalExam}
              finalExamPassed={finalExamPassed}
              onMarkComplete={() => markComplete(false)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
