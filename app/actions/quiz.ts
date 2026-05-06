'use server'
/**
 * Quiz server actions.
 *
 * submitQuizAnswers — scores a quiz submission entirely server-side.
 *   The client sends only the selected option indices; correct answers are
 *   never sent to the browser. The result is persisted to quiz_attempts
 *   for authenticated users and returned to the client for UI display.
 */

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/quiz')

const SubmitSchema = z.object({
  quizId:   UuidSchema,
  moduleId: UuidSchema,
  // answers: { questionId → selected option index (0–3) }
  answers:  z.record(UuidSchema, z.number().int().min(0).max(3)),
})

export interface QuizSubmitResult {
  error?:          string
  passed?:         boolean
  score?:          number        // percentage 0–100
  correctCount?:   number        // number of correct answers (for display)
  totalQuestions?: number
  correctAnswers?: Record<string, number>        // returned after submission for UI highlighting
  explanations?:   Record<string, string | null>
}

const MIN_PASS = 80

export async function submitQuizAnswers(input: {
  quizId:   string
  moduleId: string
  answers:  Record<string, number>
}): Promise<QuizSubmitResult> {
  const parsed = SubmitSchema.safeParse(input)
  if (!parsed.success) {
    return { error: 'Données invalides.' }
  }

  const { quizId, moduleId, answers } = parsed.data

  // Get current user — may be null in PILOT_MODE (anonymous access).
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Use admin client to fetch correct answers — bypasses RLS so the anon
  // branch of PILOT_MODE quiz_questions policy never exposes correct_answer
  // to the browser.
  const admin = createAdminClient()

  const [{ data: questions, error: qErr }, { data: quiz }] = await Promise.all([
    admin
      .from('quiz_questions')
      .select('id, correct_answer, explanation')
      .eq('quiz_id', quizId),
    admin
      .from('quizzes')
      .select('passing_score')
      .eq('id', quizId)
      .single(),
  ])

  if (qErr || !questions || questions.length === 0) {
    log.error({ quizId, error: qErr?.message }, 'Failed to load quiz questions for scoring')
    return { error: 'Quiz introuvable.' }
  }

  const passingThreshold = Math.max(quiz?.passing_score ?? MIN_PASS, MIN_PASS)

  // ── Server-side scoring ────────────────────────────────────────────────────
  let correctCount = 0
  const correctAnswers: Record<string, number> = {}
  const explanations: Record<string, string | null> = {}

  for (const q of questions) {
    correctAnswers[q.id] = q.correct_answer
    explanations[q.id]   = q.explanation
    if (answers[q.id] === q.correct_answer) correctCount++
  }

  const totalQuestions = questions.length
  const score  = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0
  const passed = score >= passingThreshold

  // ── Persist attempt — authenticated users only ─────────────────────────────
  if (user) {
    const { error: insertErr } = await admin
      .from('quiz_attempts')
      .insert({
        user_id:   user.id,
        quiz_id:   quizId,
        module_id: moduleId,
        answers,
        score,
        max_score: 100,
        passed,
      })

    if (insertErr) {
      // Log but don't fail the user experience — they still get their result.
      log.error({ userId: user.id, quizId, error: insertErr.message }, 'Failed to persist quiz attempt')
    } else {
      log.info({ userId: user.id, quizId, moduleId, score, passed }, 'Quiz attempt saved')
    }
  }

  return { passed, score, correctCount, totalQuestions, correctAnswers, explanations }
}
