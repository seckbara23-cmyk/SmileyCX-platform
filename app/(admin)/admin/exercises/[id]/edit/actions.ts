'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const log = createLogger('admin/exercise-edit')

interface CategoryPayload {
  id:          string
  name:        string
  color:       string
  order_index: number
}

interface ItemPayload {
  id:                string
  label:             string
  correctCategoryId: string
  order_index:       number
}

export async function updateExercise(formData: FormData) {
  await requirePlatformAdmin()

  const exerciseId   = (formData.get('exercise_id')   as string | null)?.trim() ?? ''
  const title        = (formData.get('title')          as string | null)?.trim() ?? ''
  const instructions = (formData.get('instructions')   as string | null)?.trim() || null
  const lessonId     = (formData.get('lesson_id')      as string | null)?.trim() || null
  const isPublished  = formData.get('is_published') === 'true'
  const catJson      = (formData.get('categories_json') as string | null) ?? '[]'
  const itemJson     = (formData.get('items_json')       as string | null) ?? '[]'

  if (!exerciseId) return { error: 'ID manquant.' }
  if (!title)      return { error: 'Le titre est obligatoire.' }
  if (!lessonId)   return { error: 'Sélectionnez une leçon.' }

  let categories: CategoryPayload[]
  let items:      ItemPayload[]
  try {
    categories = JSON.parse(catJson)
    items      = JSON.parse(itemJson)
  } catch {
    return { error: 'Données invalides.' }
  }

  if (categories.length < 2)                          return { error: 'Au moins 2 catégories sont requises.' }
  if (categories.some(c => !c.name.trim()))           return { error: 'Tous les noms de catégories sont obligatoires.' }
  if (items.length < 2)                               return { error: 'Au moins 2 éléments sont requis.' }
  if (items.some(i => !i.label.trim()))               return { error: 'Tous les labels d\'éléments sont obligatoires.' }
  if (items.some(i => !i.correctCategoryId))          return { error: 'Chaque élément doit avoir une catégorie correcte.' }

  const supabase = createAdminClient()

  // Update exercise metadata
  const { error: exErr } = await supabase
    .from('exercises')
    .update({ title, instructions, lesson_id: lessonId, is_published: isPublished })
    .eq('id', exerciseId)

  if (exErr) {
    log.error({ exerciseId, error: exErr.message }, 'Failed to update exercise metadata')
    return { error: exErr.message }
  }

  // Full replace: delete items first (references categories), then categories, then re-insert
  const { error: delItemErr } = await supabase
    .from('exercise_items')
    .delete()
    .eq('exercise_id', exerciseId)

  if (delItemErr) {
    log.error({ exerciseId, error: delItemErr.message }, 'Failed to delete exercise items')
    return { error: delItemErr.message }
  }

  const { error: delCatErr } = await supabase
    .from('exercise_categories')
    .delete()
    .eq('exercise_id', exerciseId)

  if (delCatErr) {
    log.error({ exerciseId, error: delCatErr.message }, 'Failed to delete exercise categories')
    return { error: delCatErr.message }
  }

  const catRows = categories.map((c, i) => ({
    id:          c.id,
    exercise_id: exerciseId,
    name:        c.name.trim(),
    color:       c.color || null,
    order_index: i,
  }))

  const { error: catErr } = await supabase.from('exercise_categories').insert(catRows)
  if (catErr) {
    log.error({ exerciseId, error: catErr.message }, 'Failed to re-insert categories')
    return { error: catErr.message }
  }

  const itemRows = items.map((item, i) => ({
    id:                  item.id,
    exercise_id:         exerciseId,
    label:               item.label.trim(),
    correct_category_id: item.correctCategoryId,
    order_index:         i,
  }))

  const { error: itemErr } = await supabase.from('exercise_items').insert(itemRows)
  if (itemErr) {
    log.error({ exerciseId, error: itemErr.message }, 'Failed to re-insert items')
    return { error: itemErr.message }
  }

  log.info({ exerciseId, lessonId, categories: catRows.length, items: itemRows.length }, 'Exercise updated')
  revalidatePath('/admin/exercises')
  revalidatePath(`/admin/exercises/${exerciseId}`)
  revalidatePath('/learn', 'layout')
  redirect(`/admin/exercises/${exerciseId}`)
}
