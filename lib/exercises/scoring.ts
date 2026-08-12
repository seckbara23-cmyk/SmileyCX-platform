/**
 * XPA-6D — authoritative exercise scoring.
 *
 * This logic used to live twice: once in `app/actions/exercise.ts` and once,
 * verbatim, inside `ExerciseBlock` — running in the browser against an answer
 * key the browser had been handed. The duplicate is gone. This module is the
 * single scoring path, it is server-only by construction (its caller reads the
 * key with the service role), and it exists as a separate unit so the
 * correct/incorrect behaviour can be tested without a database.
 *
 * The key is an INPUT here, never a lookup. Callers must supply it from a
 * trusted read; migration 038 revoked `correct_category_id` from `anon` and
 * `authenticated`, so a session-client caller cannot supply it at all.
 */

export interface ExerciseKeyItem {
  id: string
  correct_category_id: string
}

export interface ExerciseItemResult {
  correct: boolean
  correctCategoryId: string
}

export interface ExerciseScore {
  score: number
  correct: number
  total: number
  itemResults: Record<string, ExerciseItemResult>
}

/**
 * Grade a set of placements against the authoritative mapping.
 *
 * An item the learner never placed is simply incorrect — `undefined` never
 * equals a uuid — so a partial submission cannot score higher than a wrong one.
 */
export function scoreExercise(
  items: ExerciseKeyItem[],
  placements: Record<string, string>,
): ExerciseScore {
  const itemResults: Record<string, ExerciseItemResult> = {}
  let correct = 0

  for (const item of items) {
    const isCorrect = placements[item.id] === item.correct_category_id
    if (isCorrect) correct++
    itemResults[item.id] = { correct: isCorrect, correctCategoryId: item.correct_category_id }
  }

  const total = items.length
  return {
    score: total > 0 ? Math.round((correct / total) * 100) : 0,
    correct,
    total,
    itemResults,
  }
}
