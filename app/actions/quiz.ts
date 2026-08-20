'use server'

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import {
  resolveQuizContext,
  countAttempts,
  FINAL_EXAM_MAX_ATTEMPTS,
} from '@/lib/learn/assessment'

const log = createLogger('actions/quiz')

const MCAnswerSchema = z.number().int().min(0).max(10)
const MAAnswerSchema = z.array(z.number().int().min(0).max(10))
const DMAnswerSchema = z.record(z.string().uuid(), z.string().uuid())

const SubmitSchema = z.object({
  quizId:   UuidSchema,
  moduleId: z.union([UuidSchema, z.null()]),
  answers:  z.record(UuidSchema, z.union([MCAnswerSchema, MAAnswerSchema, DMAnswerSchema])),
})

export interface QuizSubmitResult {
  error?:                 string
  passed?:                boolean
  score?:                 number
  correctCount?:          number
  totalQuestions?:        number
  /** FORMATIVE ONLY. Never populated for a final exam. */
  correctAnswers?:        Record<string, number>
  /** FORMATIVE ONLY. */
  multipleAnswerCorrect?: Record<string, number[]>
  /** FORMATIVE ONLY. */
  dragMatchAnswers?:      Record<string, Record<string, string>>
  /** FORMATIVE ONLY. */
  explanations?:          Record<string, string | null>
  /** Final exams only: how the attempt budget stands after this submission. */
  attemptsUsed?:          number
  attemptsRemaining?:     number
  /** True when the response deliberately withholds answer-key material. */
  restrictedFeedback?:    boolean
}

/**
 * Floor on the pass mark.
 *
 * An authored `passing_score` below this is raised to it, so a mis-authored
 * quiz cannot certify at 40%. Pre-existing behaviour, unchanged by B-2.3A.
 */
const MIN_PASS = 80

/**
 * Score a submission.
 *
 * ── XPA-8 B-2.3A: THREE THINGS CHANGED, AND WHY ───────────────────────────
 *
 * 1. ENTITLEMENT. This action never checked whether the caller may open the
 *    course. `quiz_attempts` RLS is identity-only (`attempts_own FOR ALL`), so
 *    an expired, revoked, enrollment-only or never-entitled account could
 *    record a PASSING attempt for any quiz — the exact S-1 shape B-2.6 closed
 *    for `lesson_progress`. It was inert only because nothing read attempts.
 *    The moment a certificate consults them it becomes a way to mint one, so
 *    the seam is checked here, on the course resolved from the QUIZ.
 *
 * 2. ATTEMPT BUDGET. Final exams allow three attempts. Formative quizzes stay
 *    unlimited — a warm-up you may only take three times is not a warm-up.
 *
 * 3. RESTRICTED FEEDBACK. This action returned the complete answer key and the
 *    explanations on EVERY submission. Submit blank, receive the key, resubmit
 *    perfect: the XPA-6D harvest-and-retry residual, and fatal for anything
 *    that mints a certificate. Final exams now return score and pass/fail and
 *    nothing else. Formative quizzes keep full feedback, which is the whole
 *    point of them.
 *
 * Migration 038 protects the answer-key COLUMNS at rest. That was never in
 * question; what leaked was this function handing the same data back after one
 * throwaway attempt.
 */
export async function submitQuizAnswers(input: {
  quizId:   string
  moduleId: string | null
  answers:  Record<string, number | number[] | Record<string, string>>
}): Promise<QuizSubmitResult> {
  const parsed = SubmitSchema.safeParse(input)
  if (!parsed.success) {
    return { error: 'Données invalides.' }
  }

  const { quizId, moduleId, answers } = parsed.data

  // ── 1. Resolve the quiz server-side: which course, and which KIND ───────
  const { context, failed } = await resolveQuizContext(quizId)
  if (failed)   return { error: 'Service indisponible.' }
  if (!context) return { error: 'Quiz introuvable.' }

  const isFinalExam = context.kind === 'final_exam'

  // ── 2. THE authority check ──────────────────────────────────────────────
  //
  // Keyed on the course derived from the quiz, never on anything the client
  // sent. `resolveCourseAccessById` refuses an expired entitlement, a revoked
  // one, an enrollment with no entitlement behind it (Q-L), an unverified email
  // and a suspended account. It has no `is_published` arm, so a learner holding
  // a valid entitlement to a withdrawn course may still sit its assessments —
  // publication controls discovery, never access.
  const access = await resolveCourseAccessById(context.courseId)
  if (!access.allowed || !access.userId) {
    log.warn({ quizId, courseId: context.courseId, reason: access.reason },
      'quiz submission refused — no course access')
    return { error: "Vous n'avez pas accès à cette formation." }
  }
  const userId = access.userId

  // ── 3. Attempt budget, final exams only ─────────────────────────────────
  let attemptsUsed = 0
  if (isFinalExam) {
    const used = await countAttempts(userId, quizId)
    if (used === null) return { error: 'Service indisponible.' }
    attemptsUsed = used

    if (used >= FINAL_EXAM_MAX_ATTEMPTS) {
      log.warn({ userId, quizId, used }, 'final exam attempt budget exhausted')
      return {
        error: `Vous avez utilisé vos ${FINAL_EXAM_MAX_ATTEMPTS} tentatives pour cet examen. Contactez-nous pour toute question.`,
        attemptsUsed: used,
        attemptsRemaining: 0,
      }
    }
  }

  // ── 4. Grade ────────────────────────────────────────────────────────────
  const admin = createAdminClient()

  const { data: questions, error: qErr } = await admin
    .from('quiz_questions')
    .select('id, question_type, correct_answer, drag_match_answers, explanation')
    .eq('quiz_id', quizId)

  if (qErr) {
    log.error({ quizId, error: qErr.message }, 'Failed to load quiz questions for scoring')
    return { error: 'Service indisponible.' }
  }
  if (!questions || questions.length === 0) {
    return { error: 'Quiz introuvable.' }
  }

  const passingThreshold = Math.max(context.passingScore || MIN_PASS, MIN_PASS)

  let correctCount = 0
  const correctAnswers:        Record<string, number>                 = {}
  const multipleAnswerCorrect: Record<string, number[]>               = {}
  const dragMatchAnswers:      Record<string, Record<string, string>> = {}
  const explanations:          Record<string, string | null>          = {}

  for (const q of questions) {
    explanations[q.id] = q.explanation as string | null

    if (q.question_type === 'drag_match') {
      const dmCorrect = q.drag_match_answers as Record<string, string> | null
      if (!dmCorrect) continue

      dragMatchAnswers[q.id] = dmCorrect

      const userAnswer = answers[q.id]
      if (typeof userAnswer !== 'object' || Array.isArray(userAnswer) || userAnswer === null) continue

      const placements = userAnswer as Record<string, string>
      const allCorrect = Object.entries(dmCorrect).every(
        ([itemId, correctCatId]) => placements[itemId] === correctCatId
      )
      if (allCorrect) correctCount++

    } else if (q.question_type === 'multiple_answer') {
      const dma = q.drag_match_answers as { correct_indices?: number[] } | null
      const correctIndices = dma?.correct_indices ?? []
      multipleAnswerCorrect[q.id] = correctIndices

      const userAnswer = answers[q.id]
      if (Array.isArray(userAnswer)) {
        const ua = [...(userAnswer as number[])].sort((a, b) => a - b)
        const ca = [...correctIndices].sort((a, b) => a - b)
        if (ua.length === ca.length && ua.every((v, i) => v === ca[i])) correctCount++
      }

    } else {
      // multiple_choice, true_false, visual_choice — all use integer correct_answer
      correctAnswers[q.id] = q.correct_answer as number
      const userAnswer = answers[q.id]
      if (typeof userAnswer === 'number' && userAnswer === q.correct_answer) {
        correctCount++
      }
    }
  }

  const totalQuestions = questions.length
  const score  = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0
  const passed = score >= passingThreshold

  // ── 5. Persist ──────────────────────────────────────────────────────────
  //
  // The subject is the id the ACCESS SEAM returned, never a client-supplied
  // one, so this cannot be asked to record an attempt for somebody else.
  const { error: insertErr } = await admin
    .from('quiz_attempts')
    .insert({
      user_id:   userId,
      quiz_id:   quizId,
      module_id: moduleId,
      answers,
      score,
      max_score: 100,
      passed,
    })

  if (insertErr) {
    log.error({ userId, quizId, error: insertErr.message }, 'Failed to persist quiz attempt')
  } else {
    log.info({ userId, quizId, moduleId, kind: context.kind, score, passed },
      'Quiz attempt saved')
  }

  // ── 6. Respond ──────────────────────────────────────────────────────────
  //
  // A final exam returns the OUTCOME and nothing that could be replayed into a
  // later attempt: no correct indices, no drag-match key, no explanations. The
  // enumerated restriction is ratified; explanations are withheld wholesale
  // because whether a given explanation reveals its answer cannot be decided
  // programmatically, and the safe reading of "must not return reusable
  // answer-key material" is to withhold it.
  //
  // Per-question correctness is also withheld. It is not on the ratified list,
  // but across a three-attempt budget it narrows the search, and B-2.3A's job
  // is to make a certificate mean something. Relaxing this later is a one-line
  // change; un-leaking a key is not.
  if (isFinalExam) {
    const used = attemptsUsed + 1
    return {
      passed,
      score,
      correctCount,
      totalQuestions,
      attemptsUsed:       used,
      attemptsRemaining:  Math.max(0, FINAL_EXAM_MAX_ATTEMPTS - used),
      restrictedFeedback: true,
    }
  }

  return {
    passed,
    score,
    correctCount,
    totalQuestions,
    correctAnswers,
    multipleAnswerCorrect,
    dragMatchAnswers,
    explanations,
    restrictedFeedback: false,
  }
}
