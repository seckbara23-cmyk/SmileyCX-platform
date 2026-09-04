// @vitest-environment node
/**
 * QUIZ-1A FIX — behavioural coverage for the auto-advance decision.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────
 *
 * QUIZ-1A shipped with 20 source-string assertions. They all passed, CI was
 * green, and the deployed behaviour was still wrong: the learner played
 * "Les 3 niveaux d'expérience" and was carried straight to "Pourquoi viser le
 * mémorable" without ever being offered the quiz.
 *
 * The reason those assertions could not catch it: they proved the formative
 * branch EXISTED and sat after the module gate. They could not prove it was
 * REACHABLE. `getAutoAdvanceTarget()` opened with
 *
 *     if (PILOT_MODE) { return nextLesson }
 *
 * and production runs `PLATFORM_MODE=pilot`, so every quiz branch below it was
 * dead code. A string assertion cannot see that; a resolver you can call can.
 *
 * So the decision is now a pure function and `pilotMode` is an ordinary input
 * rather than a build-time constant. Each case below is the real decision, run.
 */
import { describe, it, expect } from 'vitest'
import { resolveAutoAdvanceTarget, type AutoAdvanceInput } from '@/lib/learn/auto-advance'

const SLUG    = 'les-fondamentaux-de-l-experience-client'
const MODULE  = '95b7dcaf-d236-4076-8cf0-d926f075351d'   // Comprendre la CX
const QUIZ    = '70bbc2a8-9c34-4607-88a3-7ce328ea9e7e'   // Échauffement — Repérez le niveau
const NEXT    = '491c1e03-268f-4be0-850e-df13a9808943'   // Pourquoi viser le mémorable

/** The production shape: mid-module lesson, formative quiz attached, pilot mode. */
const base = (over: Partial<AutoAdvanceInput> = {}): AutoAdvanceInput => ({
  pilotMode:           true,
  courseSlug:          SLUG,
  module:              { id: MODULE },
  nextLesson:          { moduleId: MODULE, lessonId: NEXT },
  isLastLesson:        false,
  isLastLessonInModule: false,
  moduleHasQuiz:       false,
  moduleQuizPassed:    false,
  lessonQuizId:        null,
  lessonQuizAttempted: false,
  hasFinalExam:        false,
  finalExamPassed:     false,
  ...over,
})

const QUIZ_HREF = `/learn/${SLUG}/${MODULE}/quiz`
const NEXT_HREF = `/learn/${SLUG}/${MODULE}/${NEXT}`

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A resolver — the defect the UAT reproduced', () => {
  it('PRODUCTION SHAPE: pilot mode + unattempted formative quiz → offers the quiz', () => {
    // This is the exact case that failed in production. Before the fix the
    // pilot short-cut returned the next lesson and the quiz was skipped.
    const t = resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ }))
    expect(t).toEqual({ href: QUIZ_HREF, label: 'Faire le quiz' })
    expect(t!.href).not.toBe(NEXT_HREF)
  })

  it('the offer is mode-independent — non-pilot behaves identically', () => {
    const t = resolveAutoAdvanceTarget(base({ pilotMode: false, lessonQuizId: QUIZ }))
    expect(t).toEqual({ href: QUIZ_HREF, label: 'Faire le quiz' })
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A resolver — required scenarios', () => {
  it('lesson has an unattempted lesson-scoped quiz → target is the quiz', () => {
    expect(resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ })))
      .toEqual({ href: QUIZ_HREF, label: 'Faire le quiz' })
  })

  it('lesson has an ATTEMPTED formative quiz → target is the next lesson', () => {
    expect(resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ, lessonQuizAttempted: true })))
      .toEqual({ href: NEXT_HREF, label: 'Leçon suivante' })
  })

  it('lesson has no quiz → target is the next lesson', () => {
    expect(resolveAutoAdvanceTarget(base()))
      .toEqual({ href: NEXT_HREF, label: 'Leçon suivante' })
  })

  it('module gate active → the GATE wins over the formative offer', () => {
    const t = resolveAutoAdvanceTarget(base({
      pilotMode: false, isLastLessonInModule: true,
      moduleHasQuiz: true, moduleQuizPassed: false,
      lessonQuizId: QUIZ,
    }))
    expect(t).toEqual({ href: QUIZ_HREF, label: 'Quiz du module' })
  })

  it('a passed module gate falls through to the formative offer', () => {
    const t = resolveAutoAdvanceTarget(base({
      pilotMode: false, isLastLessonInModule: true,
      moduleHasQuiz: true, moduleQuizPassed: true,
      lessonQuizId: QUIZ,
    }))
    expect(t).toEqual({ href: QUIZ_HREF, label: 'Faire le quiz' })
  })

  it('the module gate stays dormant in pilot mode — QUIZ-1A must not arm it', () => {
    const t = resolveAutoAdvanceTarget(base({
      pilotMode: true, isLastLessonInModule: true,
      moduleHasQuiz: true, moduleQuizPassed: false,
    }))
    expect(t).toEqual({ href: NEXT_HREF, label: 'Leçon suivante' })
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A resolver — loop safety and continuation', () => {
  it('offer → attempt → next lesson: the sequence terminates', () => {
    const before = resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ }))
    expect(before!.label).toBe('Faire le quiz')
    // After the learner attempts it (pass OR fail) the offer stops.
    const after = resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ, lessonQuizAttempted: true }))
    expect(after!.href).toBe(NEXT_HREF)
    // And it stays terminated — no oscillation back to the quiz.
    expect(resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ, lessonQuizAttempted: true }))!.href)
      .toBe(NEXT_HREF)
  })

  it('a failed formative attempt still advances — the quiz never traps', () => {
    // "Attempted" is what suppresses the offer; passing is irrelevant here,
    // which is precisely what "offer, not gate" means.
    const t = resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ, lessonQuizAttempted: true }))
    expect(t).toEqual({ href: NEXT_HREF, label: 'Leçon suivante' })
  })

  it('continuation stays inside the SAME module', () => {
    const t = resolveAutoAdvanceTarget(base({ lessonQuizId: QUIZ, lessonQuizAttempted: true }))
    expect(t!.href).toContain(`/${MODULE}/`)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A resolver — pre-existing routing preserved', () => {
  it('last lesson with an unpassed final exam → the exam', () => {
    expect(resolveAutoAdvanceTarget(base({
      pilotMode: false, isLastLesson: true, nextLesson: null, hasFinalExam: true,
    }))).toEqual({ href: `/learn/${SLUG}/final-exam`, label: 'Examen final' })
  })

  it('last lesson, exam passed → the certificate', () => {
    expect(resolveAutoAdvanceTarget(base({
      pilotMode: false, isLastLesson: true, nextLesson: null,
      hasFinalExam: true, finalExamPassed: true,
    }))).toEqual({ href: `/certificate/${SLUG}`, label: 'Vers votre certificat' })
  })

  it('pilot mode never routes to an exam or a certificate', () => {
    expect(resolveAutoAdvanceTarget(base({
      pilotMode: true, isLastLesson: true, nextLesson: null, hasFinalExam: true,
    }))).toBeNull()
  })

  it('no next lesson and nothing else to do → null', () => {
    expect(resolveAutoAdvanceTarget(base({ nextLesson: null }))).toBeNull()
  })

  it('an unresolved module never manufactures a quiz route (UAT-ROUTE-01)', () => {
    // `module` is state and is null before resolution. The old inline code
    // would have produced "/learn/<slug>/undefined/quiz".
    const t = resolveAutoAdvanceTarget(base({ module: null, lessonQuizId: QUIZ }))
    expect(t).toEqual({ href: NEXT_HREF, label: 'Leçon suivante' })
    expect(JSON.stringify(t)).not.toContain('undefined')
  })
})
