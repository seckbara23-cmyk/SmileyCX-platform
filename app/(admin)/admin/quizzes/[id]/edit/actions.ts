'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const log = createLogger('admin/quiz-edit')

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

type QuestionUpdate =
  | {
      id?:            string
      question_type:  'multiple_choice' | undefined
      question:       string
      options:        string[]
      correct_answer: number
      explanation:    string
      order_index:    number
    }
  | {
      id?:             string
      question_type:   'multiple_answer'
      question:        string
      options:         string[]
      correct_indices: number[]
      explanation:     string
      order_index:     number
    }
  | {
      id?:            string
      question_type:  'true_false'
      question:       string
      correct_answer: number
      explanation:    string
      order_index:    number
    }
  | {
      id?:           string
      question_type: 'drag_match'
      question:      string
      dm_categories: DragMatchCategory[]
      dm_items:      DragMatchItem[]
      explanation:   string
      order_index:   number
    }
  | {
      id?:                string
      question_type:      'visual_choice'
      question:           string
      options:            string[]
      correct_answer:     number
      question_image_url: string
      explanation:        string
      order_index:        number
    }

function buildRow(q: QuestionUpdate) {
  const base = {
    question:    q.question.trim(),
    explanation: q.explanation?.trim() || null,
    order_index: q.order_index,
  }

  if (q.question_type === 'drag_match') {
    return {
      ...base,
      question_type:      'drag_match' as const,
      options:            {
        categories: q.dm_categories.map(c    => ({ id: c.id, label: c.label.trim() })),
        items:      q.dm_items.map(item => ({ id: item.id, label: item.label.trim() })),
      },
      correct_answer:     null,
      drag_match_answers: Object.fromEntries(
        q.dm_items.map(item => [item.id, item.correctCategoryId])
      ),
      question_image_url: null,
    }
  }

  if (q.question_type === 'multiple_answer') {
    return {
      ...base,
      question_type:      'multiple_answer' as const,
      options:            q.options,
      correct_answer:     null,
      drag_match_answers: { correct_indices: q.correct_indices },
      question_image_url: null,
    }
  }

  if (q.question_type === 'true_false') {
    return {
      ...base,
      question_type:      'true_false' as const,
      options:            ['Vrai', 'Faux'],
      correct_answer:     q.correct_answer,
      drag_match_answers: null,
      question_image_url: null,
    }
  }

  if (q.question_type === 'visual_choice') {
    return {
      ...base,
      question_type:      'visual_choice' as const,
      options:            q.options,
      correct_answer:     q.correct_answer,
      drag_match_answers: null,
      question_image_url: q.question_image_url?.trim() || null,
    }
  }

  return {
    ...base,
    question_type:      'multiple_choice' as const,
    options:            q.options,
    correct_answer:     q.correct_answer,
    drag_match_answers: null,
    question_image_url: null,
  }
}

export async function updateQuiz(formData: FormData) {
  await requirePlatformAdmin()

  const quizId   = (formData.get('quiz_id')   as string | null)?.trim() ?? ''
  const title    = (formData.get('title')     as string | null)?.trim() ?? ''
  const moduleId = (formData.get('module_id') as string | null)?.trim() || null
  const lessonId = (formData.get('lesson_id') as string | null)?.trim() || null
  const qJson    = (formData.get('questions_json')   as string | null) ?? '[]'
  const delJson  = (formData.get('deleted_ids_json') as string | null) ?? '[]'

  if (!quizId)                return { error: 'ID du quiz manquant.' }
  if (!title)                 return { error: 'Le titre est obligatoire.' }
  if (!moduleId && !lessonId) return { error: 'Sélectionnez un module ou une leçon.' }

  let resolvedModuleId = moduleId
  if (!moduleId && lessonId) {
    const supabaseEarly = createAdminClient()
    const { data: lessonRow } = await supabaseEarly
      .from('lessons')
      .select('module_id')
      .eq('id', lessonId)
      .single()
    if (!lessonRow?.module_id) return { error: 'Leçon introuvable ou sans module associé.' }
    resolvedModuleId = lessonRow.module_id
    log.info({ quizId, lessonId, resolvedModuleId }, 'Resolved module_id from lesson')
  }

  let questions:  QuestionUpdate[]
  let deletedIds: string[]
  try {
    questions  = JSON.parse(qJson)
    deletedIds = JSON.parse(delJson)
  } catch (err) {
    log.error({ quizId, err }, 'Failed to parse questions_json or deleted_ids_json')
    return { error: 'Données invalides.' }
  }

  if (!questions.length) return { error: 'Ajoutez au moins une question.' }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!q.question.trim()) return { error: `Question ${i + 1} : le texte est obligatoire.` }

    if (q.question_type === 'drag_match') {
      if (!q.dm_categories || q.dm_categories.length < 2)
        return { error: `Question ${i + 1} : au moins 2 catégories requises.` }
      if (q.dm_categories.some(c => !c.label.trim()))
        return { error: `Question ${i + 1} : tous les labels de catégories sont obligatoires.` }
      if (!q.dm_items || q.dm_items.length < 2)
        return { error: `Question ${i + 1} : au moins 2 éléments requis.` }
      if (q.dm_items.some(item => !item.label.trim()))
        return { error: `Question ${i + 1} : tous les labels d'éléments sont obligatoires.` }
      if (q.dm_items.some(item => !item.correctCategoryId))
        return { error: `Question ${i + 1} : chaque élément doit avoir une catégorie correcte.` }
    } else if (q.question_type === 'multiple_answer') {
      if (!q.options || q.options.some(o => !o.trim()))
        return { error: `Question ${i + 1} : toutes les options sont obligatoires.` }
      if (!q.correct_indices || q.correct_indices.length === 0)
        return { error: `Question ${i + 1} : sélectionnez au moins une bonne réponse.` }
    } else if (q.question_type === 'true_false') {
      // no option validation
    } else {
      if (!q.options || q.options.some(o => !o.trim()))
        return { error: `Question ${i + 1} : toutes les réponses sont obligatoires.` }
    }
  }

  const supabase = createAdminClient()

  const { error: quizErr } = await supabase
    .from('quizzes')
    .update({ title, module_id: resolvedModuleId, lesson_id: lessonId })
    .eq('id', quizId)

  if (quizErr) {
    log.error({ quizId, error: quizErr.message }, 'Failed to update quiz metadata')
    return { error: quizErr.message }
  }

  if (deletedIds.length > 0) {
    const { error: delErr } = await supabase
      .from('quiz_questions')
      .delete()
      .in('id', deletedIds)
    if (delErr) {
      log.error({ quizId, deletedIds, error: delErr.message }, 'Failed to delete questions')
      return { error: delErr.message }
    }
  }

  for (const q of questions.filter(q => q.id)) {
    const { error: uErr } = await supabase
      .from('quiz_questions')
      .update(buildRow(q))
      .eq('id', q.id!)
    if (uErr) {
      log.error({ quizId, questionId: q.id, type: q.question_type, error: uErr.message }, 'Failed to update question')
      return { error: uErr.message }
    }
  }

  const newQuestions = questions.filter(q => !q.id)
  if (newQuestions.length > 0) {
    const newRows = newQuestions.map(q => ({ quiz_id: quizId, ...buildRow(q) }))
    const { error: iErr } = await supabase.from('quiz_questions').insert(newRows)
    if (iErr) {
      log.error({ quizId, count: newRows.length, error: iErr.message }, 'Failed to insert new questions')
      return { error: iErr.message }
    }
  }

  log.info({ quizId, updated: questions.filter(q => q.id).length, inserted: newQuestions.length, deleted: deletedIds.length, moduleId: resolvedModuleId }, 'Quiz updated')
  revalidatePath('/admin/quizzes')
  revalidatePath(`/admin/quizzes/${quizId}`)
  revalidatePath('/learn', 'layout')
  redirect(`/admin/quizzes/${quizId}`)
}
