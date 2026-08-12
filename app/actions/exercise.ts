'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { scoreExercise, type ExerciseScore } from '@/lib/exercises/scoring'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/exercise')

const UuidSchema = z.string().uuid()

const SubmitSchema = z.object({
  exerciseId: UuidSchema,
  placements: z.record(UuidSchema, UuidSchema), // itemId → selectedCategoryId
})

export type ExerciseSubmitResult = ExerciseScore

export async function submitExercise(
  input: { exerciseId: string; placements: Record<string, string> }
): Promise<{ result?: ExerciseSubmitResult; error?: string }> {
  const parsed = SubmitSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }

  const { exerciseId, placements } = parsed.data
  const supabase = await createClient()

  // XPA-6D. The answer key is read with the SERVICE ROLE, never the caller's
  // session. Migration 038 revoked `correct_category_id` from anon and
  // authenticated, so this is not a convenience — a session-client read here
  // now fails with 42501. Scoring is the trusted path; the key must not be
  // reachable by the role that submits the answers.
  const admin = createAdminClient()

  const { data: items, error: itemsErr } = await admin
    .from('exercise_items')
    .select('id, correct_category_id')
    .eq('exercise_id', exerciseId)

  if (itemsErr || !items) {
    log.error({ exerciseId, error: itemsErr?.message }, 'Failed to load exercise items')
    return { error: 'Erreur lors du chargement de l\'exercice.' }
  }

  const result: ExerciseSubmitResult = scoreExercise(items, placements)
  const { itemResults, score } = result

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
