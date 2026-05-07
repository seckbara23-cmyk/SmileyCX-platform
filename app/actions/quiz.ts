'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/quiz')

const MCAnswerSchema = z.number().int().min(0).max(3)
const DMAnswerSchema = z.record(z.string().uuid(), z.string().uuid())

const SubmitSchema = z.object({
  quizId:   UuidSchema,
  moduleId: UuidSchema,
  answers:  z.record(UuidSchema, z.union([MCAnswerSchema, DMAnswerSchema])),
})

export interface QuizSubmitResult {
  error?:              string
  passed?:             boolean
  score?:              number
  correctCount?:       number
  totalQuestions?:     number
  correctAnswers?:     Record<string, number>               // MC: questionId → correct option index
  dragMatchAnswers?:   Record<string, Record<string, string>> // DM: questionId → {itemId: categoryId}
  explanations?:       Record<string, string | null>
}

const MIN_PASS = 80

export async function submitQuizAnswers(input: {
  quizId:   string
  moduleId: string
  answers:  Record<string, number | Record<string, string>>
}): Promise<QuizSubmitResult> {
  const parsed = SubmitSchema.safeParse(input)
  if (!parsed.success) {
    return { error: 'Données invalides.' }
  }

  const { quizId, moduleId, answers } = parsed.data

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const admin = createAdminClient()

  const [{ data: questions, error: qErr }, { data: quiz }] = await Promise.all([
    admin
      .from('quiz_questions')
      .select('id, question_type, correct_answer, drag_match_answers, explanation')
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
  const correctAnswers:   Record<string, number>               = {}
  const dragMatchAnswers: Record<string, Record<string, string>> = {}
  const explanations:     Record<string, string | null>        = {}

  for (const q of questions) {
    explanations[q.id] = q.explanation as string | null

    if (q.question_type === 'drag_match') {
      const dmCorrect = q.drag_match_answers as Record<string, string> | null
      if (!dmCorrect) continue

      dragMatchAnswers[q.id] = dmCorrect

      const userAnswer = answers[q.id]
      if (typeof userAnswer !== 'object' || userAnswer === null) continue

      const placements = userAnswer as Record<string, string>
      const allCorrect = Object.entries(dmCorrect).every(
        ([itemId, correctCatId]) => placements[itemId] === correctCatId
      )
      if (allCorrect) correctCount++
    } else {
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
      log.error({ userId: user.id, quizId, error: insertErr.message }, 'Failed to persist quiz attempt')
    } else {
      log.info({ userId: user.id, quizId, moduleId, score, passed }, 'Quiz attempt saved')
    }
  }

  return { passed, score, correctCount, totalQuestions, correctAnswers, dragMatchAnswers, explanations }
}
