import { moduleQuizHref } from '@/lib/learn/routes'

/**
 * Where the lesson player goes when a video finishes.
 *
 * ── WHY THIS IS A PURE FUNCTION ────────────────────────────────────────────
 *
 * QUIZ-1A shipped this decision inline in the lesson player and proved it with
 * source-string assertions. Those assertions passed while the deployed
 * behaviour was wrong, because they could see that a branch EXISTED but not
 * that it was UNREACHABLE. Production runs `PLATFORM_MODE=pilot`, and the
 * `if (PILOT_MODE)` early return sat above every quiz branch, so the player
 * skipped straight to the next lesson and the formative quiz was never offered.
 *
 * The decision is now data-in / data-out so it can be exercised directly, with
 * `pilotMode` as an ordinary input rather than a module-level constant baked in
 * at build time.
 *
 * ── THE ORDER, AND WHY ─────────────────────────────────────────────────────
 *
 *   1. module gate     a genuine module quiz BLOCKS; it must win over an offer
 *   2. formative offer  offered in every mode, blocks nothing
 *   3. pilot short-cut  pilot has no final exam or certificate routing
 *   4. final exam / certificate / next lesson
 *
 * Step 1 keeps its `!pilotMode` condition: that is pre-existing behaviour
 * (`nextIsBlocked` is likewise `!PILOT_MODE`), and QUIZ-1A must not turn a
 * dormant gate on. Step 2 is deliberately mode-independent — a formative quiz
 * is an offer, and there is no reason a pilot learner should be raced past it.
 */

export interface AdvanceTarget {
  href:  string
  label: string
}

export interface AutoAdvanceInput {
  pilotMode:  boolean
  courseSlug: string
  /** The module the current lesson belongs to. Null until resolved. */
  module: { id: string } | null
  /** The lesson that follows in sidebar order, with its owning module. */
  nextLesson: { moduleId: string; lessonId: string } | null
  isLastLesson:         boolean
  isLastLessonInModule: boolean
  /** A MODULE-scoped quiz exists for this module (the gate). */
  moduleHasQuiz:    boolean
  moduleQuizPassed: boolean
  /** A LESSON-scoped formative quiz hangs off the current lesson. */
  lessonQuizId:        string | null
  lessonQuizAttempted: boolean
  hasFinalExam:    boolean
  finalExamPassed: boolean
}

const nextLessonTarget = (i: AutoAdvanceInput): AdvanceTarget | null =>
  i.nextLesson
    ? {
        href:  `/learn/${i.courseSlug}/${i.nextLesson.moduleId}/${i.nextLesson.lessonId}`,
        label: 'Leçon suivante',
      }
    : null

export function resolveAutoAdvanceTarget(i: AutoAdvanceInput): AdvanceTarget | null {
  // 1. Module gate. Blocks progression, so it outranks any offer.
  if (!i.pilotMode && i.isLastLessonInModule && i.moduleHasQuiz && !i.moduleQuizPassed) {
    const href = moduleQuizHref(i.courseSlug, i.module)
    if (href) return { href, label: 'Quiz du module' }
  }

  // 2. Formative offer. Mode-independent, and blocks nothing: a learner who
  //    ignores or fails it still advances, keeps course access and keeps
  //    certificate eligibility. Suppressed once attempted, which is what makes
  //    lesson -> quiz -> lesson terminate rather than cycle.
  if (i.lessonQuizId && !i.lessonQuizAttempted) {
    const href = moduleQuizHref(i.courseSlug, i.module)
    if (href) return { href, label: 'Faire le quiz' }
  }

  // 3. Pilot stops here: it has no final-exam or certificate routing.
  if (i.pilotMode) return nextLessonTarget(i)

  if (i.isLastLesson && i.hasFinalExam && !i.finalExamPassed) {
    return { href: `/learn/${i.courseSlug}/final-exam`, label: 'Examen final' }
  }
  if (i.isLastLesson) {
    return { href: `/certificate/${i.courseSlug}`, label: 'Vers votre certificat' }
  }
  return nextLessonTarget(i)
}
