'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/exercise')

const UuidSchema = z.string().uuid()

const SubmitSchema = z.object({
  exerciseId: UuidSchema,
  placements: z.record(UuidSchema, UuidSchema), // itemId → selectedCategoryId
})

export interface ExerciseSubmitResult {
  score:       number
  correct:     number
  total:       number
  itemResults: Record<string, { correct: boolean; correctCategoryId: string }>
}

export async function submitExercise(
  input: { exerciseId: string; placements: Record<string, string> }
): Promise<{ result?: ExerciseSubmitResult; error?: string }> {
  const parsed = SubmitSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }

  const { exerciseId, placements } = parsed.data
  const supabase = await createClient()

  const { data: items, error: itemsErr } = await supabase
    .from('exercise_items')
    .select('id, correct_category_id')
    .eq('exercise_id', exerciseId)

  if (itemsErr || !items) {
    log.error({ exerciseId, error: itemsErr?.message }, 'Failed to load exercise items')
    return { error: 'Erreur lors du chargement de l\'exercice.' }
  }

  const itemResults: Record<string, { correct: boolean; correctCategoryId: string }> = {}
  let correctCount = 0

  for (const item of items) {
    const placed    = placements[item.id]
    const isCorrect = placed === item.correct_category_id
    if (isCorrect) correctCount++
    itemResults[item.id] = { correct: isCorrect, correctCategoryId: item.correct_category_id }
  }

  const total  = items.length
  const score  = total > 0 ? Math.round((correctCount / total) * 100) : 0
  const result: ExerciseSubmitResult = { score, correct: correctCount, total, itemResults }

  // Persist if authenticated (silently skipped for pilot/anon users)
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const { data: submission, error: subErr } = await supabase
      .from('exercise_submissions')
      .insert({ exercise_id: exerciseId, user_id: user.id, score, completed: true })
      .select('id')
      .single()

    if (subErr || !submission) {
      log.error({ exerciseId, userId: user.id, error: subErr?.message }, 'Failed to insert submission')
    } else {
      const answers = items.map(item => ({
        submission_id:        submission.id,
        exercise_item_id:     item.id,
        selected_category_id: placements[item.id] ?? null,
        is_correct:           itemResults[item.id].correct,
      }))
      const { error: ansErr } = await supabase.from('exercise_answers').insert(answers)
      if (ansErr) {
        log.error({ submissionId: submission.id, error: ansErr.message }, 'Failed to insert exercise answers')
      }
    }
  }

  return { result }
}
