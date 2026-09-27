'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { parseExercisePayload } from '@/lib/admin/exercise-payload'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const log = createLogger('admin/exercise-new')

export async function createExercise(formData: FormData) {
  await requirePlatformAdmin()

  const title        = (formData.get('title')        as string | null)?.trim() ?? ''
  const instructions = (formData.get('instructions') as string | null)?.trim() || null
  const lessonId     = (formData.get('lesson_id')    as string | null)?.trim() || null
  const isPublished  = formData.get('is_published') === 'true'
  const catJson      = (formData.get('categories_json') as string | null) ?? '[]'
  const itemJson     = (formData.get('items_json')       as string | null) ?? '[]'

  if (!title)    return { error: 'Le titre est obligatoire.' }
  if (!lessonId) return { error: 'Sélectionnez une leçon.' }

  // UAT-EXERCISE-CATEGORY-FK-01: every item must reference a category this
  // payload is actually inserting. Validated BEFORE the first write, so a
  // mismatch is a French sentence rather than a raw foreign-key violation.
  const parsed = parseExercisePayload(catJson, itemJson)
  if (!parsed.ok) return { error: parsed.error }
  const { categories, items } = parsed

  const supabase = createAdminClient()

  const { data: exercise, error: exErr } = await supabase
    .from('exercises')
    .insert({ title, instructions, lesson_id: lessonId, exercise_type: 'drag_match', is_published: isPublished })
    .select('id')
    .single()

  if (exErr || !exercise) {
    log.error({ error: exErr?.message }, 'Failed to insert exercise')
    return { error: exErr?.message ?? 'Erreur lors de la création.' }
  }

  // Insert categories (use client-side UUIDs so items can reference them)
  const catRows = categories.map((c, i) => ({
    id:          c.id,
    exercise_id: exercise.id,
    name:        c.name.trim(),
    color:       c.color || null,
    order_index: i,
  }))

  const { error: catErr } = await supabase.from('exercise_categories').insert(catRows)
  if (catErr) {
    log.error({ exerciseId: exercise.id, error: catErr.message }, 'Failed to insert categories — rolling back')
    await supabase.from('exercises').delete().eq('id', exercise.id)
    return { error: catErr.message }
  }

  const itemRows = items.map((item, i) => ({
    id:                  item.id,
    exercise_id:         exercise.id,
    label:               item.label.trim(),
    correct_category_id: item.correctCategoryId,
    order_index:         i,
  }))

  const { error: itemErr } = await supabase.from('exercise_items').insert(itemRows)
  if (itemErr) {
    log.error({ exerciseId: exercise.id, error: itemErr.message }, 'Failed to insert items — rolling back')
    await supabase.from('exercises').delete().eq('id', exercise.id)
    return { error: itemErr.message }
  }

  log.info({ exerciseId: exercise.id, lessonId, categories: catRows.length, items: itemRows.length }, 'Exercise created')
  revalidatePath('/admin/exercises')
  revalidatePath(`/admin/exercises/${exercise.id}`)
  revalidatePath('/learn', 'layout')
  redirect(`/admin/exercises/${exercise.id}`)
}
