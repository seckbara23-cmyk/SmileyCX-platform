'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

type QuestionUpdate =
  | {
      id?:           string
      question_type: 'multiple_choice' | undefined
      question:      string
      options:       [string, string, string, string]
      correct_answer: number
      explanation:   string
      order_index:   number
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

export async function updateQuiz(formData: FormData) {
  await requirePlatformAdmin()

  const quizId   = (formData.get('quiz_id')   as string | null)?.trim() ?? ''
  const title    = (formData.get('title')     as string | null)?.trim() ?? ''
  const moduleId = (formData.get('module_id') as string | null)?.trim() || null
  const lessonId = (formData.get('lesson_id') as string | null)?.trim() || null
  const qJson    = (formData.get('questions_json')  as string | null) ?? '[]'
  const delJson  = (formData.get('deleted_ids_json') as string | null) ?? '[]'

  if (!quizId)                return { error: 'ID du quiz manquant.' }
  if (!title)                 return { error: 'Le titre est obligatoire.' }
  if (!moduleId && !lessonId) return { error: 'Sélectionnez un module ou une leçon.' }
  if (moduleId  && lessonId)  return { error: 'Sélectionnez soit un module soit une leçon, pas les deux.' }

  let questions:  QuestionUpdate[]
  let deletedIds: string[]
  try {
    questions  = JSON.parse(qJson)
    deletedIds = JSON.parse(delJson)
  } catch {
    return { error: 'Données invalides.' }
  }

  if (!questions.length) return { error: 'Ajoutez au moins une question.' }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!q.question.trim()) return { error: `Question ${i + 1} : le texte est obligatoire.` }

    if (q.question_type === 'drag_match') {
      if (!q.dm_categories || q.dm_categories.length < 2) return { error: `Question ${i + 1} : au moins 2 catégories requises.` }
      if (q.dm_categories.some(c => !c.label.trim()))     return { error: `Question ${i + 1} : tous les labels de catégories sont obligatoires.` }
      if (!q.dm_items || q.dm_items.length < 2)           return { error: `Question ${i + 1} : au moins 2 éléments requis.` }
      if (q.dm_items.some(item => !item.label.trim()))     return { error: `Question ${i + 1} : tous les labels d'éléments sont obligatoires.` }
      if (q.dm_items.some(item => !item.correctCategoryId)) return { error: `Question ${i + 1} : chaque élément doit avoir une catégorie correcte.` }
    } else {
      if (q.options.some(o => !o.trim())) return { error: `Question ${i + 1} : toutes les réponses sont obligatoires.` }
    }
  }

  const supabase = createAdminClient()

  const { error: quizErr } = await supabase
    .from('quizzes')
    .update({ title, module_id: moduleId, lesson_id: lessonId })
    .eq('id', quizId)

  if (quizErr) return { error: quizErr.message }

  if (deletedIds.length > 0) {
    const { error: delErr } = await supabase.from('quiz_questions').delete().in('id', deletedIds)
    if (delErr) return { error: delErr.message }
  }

  function buildRow(q: QuestionUpdate, qId: string) {
    if (q.question_type === 'drag_match') {
      return {
        question:           q.question.trim(),
        question_type:      'drag_match',
        options:            { categories: q.dm_categories.map(c => ({ id: c.id, label: c.label.trim() })), items: q.dm_items.map(item => ({ id: item.id, label: item.label.trim() })) },
        correct_answer:     null,
        drag_match_answers: Object.fromEntries(q.dm_items.map(item => [item.id, item.correctCategoryId])),
        explanation:        q.explanation?.trim() || null,
        order_index:        q.order_index,
        ...(qId ? {} : { quiz_id: quizId }),
      }
    }
    return {
      question:           q.question.trim(),
      question_type:      'multiple_choice',
      options:            q.options,
      correct_answer:     q.correct_answer,
      drag_match_answers: null,
      explanation:        q.explanation?.trim() || null,
      order_index:        q.order_index,
      ...(qId ? {} : { quiz_id: quizId }),
    }
  }

  for (const q of questions.filter(q => q.id)) {
    const { error: uErr } = await supabase
      .from('quiz_questions')
      .update(buildRow(q, q.id!))
      .eq('id', q.id!)
    if (uErr) return { error: uErr.message }
  }

  const newRows = questions.filter(q => !q.id).map(q => ({
    quiz_id: quizId,
    ...buildRow(q, ''),
  }))

  if (newRows.length > 0) {
    const { error: iErr } = await supabase.from('quiz_questions').insert(newRows)
    if (iErr) return { error: iErr.message }
  }

  redirect(`/admin/quizzes/${quizId}`)
}
