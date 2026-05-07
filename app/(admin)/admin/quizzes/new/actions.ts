'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { redirect } from 'next/navigation'

const log = createLogger('admin/quiz-new')

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

type QuestionPayload =
  | {
      question_type:  'multiple_choice' | undefined
      question:       string
      options:        [string, string, string, string]
      correct_answer: number
      explanation:    string
      order_index:    number
    }
  | {
      question_type: 'drag_match'
      question:      string
      dm_categories: DragMatchCategory[]
      dm_items:      DragMatchItem[]
      explanation:   string
      order_index:   number
    }

function buildRow(quizId: string, q: QuestionPayload, fallbackIndex: number) {
  if (q.question_type === 'drag_match') {
    return {
      quiz_id:            quizId,
      question:           q.question.trim(),
      question_type:      'drag_match' as const,
      options:            {
        categories: q.dm_categories.map(c    => ({ id: c.id, label: c.label.trim() })),
        items:      q.dm_items.map(item => ({ id: item.id, label: item.label.trim() })),
      },
      correct_answer:     null,
      drag_match_answers: Object.fromEntries(
        q.dm_items.map(item => [item.id, item.correctCategoryId])
      ),
      explanation:        q.explanation?.trim() || null,
      order_index:        q.order_index ?? fallbackIndex,
    }
  }
  return {
    quiz_id:            quizId,
    question:           q.question.trim(),
    question_type:      'multiple_choice' as const,
    options:            q.options,
    correct_answer:     q.correct_answer,
    drag_match_answers: null,
    explanation:        q.explanation?.trim() || null,
    order_index:        q.order_index ?? fallbackIndex,
  }
}

export async function createQuiz(formData: FormData) {
  await requirePlatformAdmin()

  const title    = (formData.get('title')     as string | null)?.trim() ?? ''
  const moduleId = (formData.get('module_id') as string | null)?.trim() || null
  const lessonId = (formData.get('lesson_id') as string | null)?.trim() || null
  const qJson    = (formData.get('questions_json') as string | null) ?? '[]'

  if (!title)                 return { error: 'Le titre est obligatoire.' }
  if (!moduleId && !lessonId) return { error: 'Sélectionnez un module ou une leçon.' }
  if (moduleId  && lessonId)  return { error: 'Sélectionnez soit un module soit une leçon, pas les deux.' }

  let questions: QuestionPayload[]
  try {
    questions = JSON.parse(qJson)
  } catch (err) {
    log.error({ err }, 'Failed to parse questions_json')
    return { error: 'Données de questions invalides.' }
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
    } else {
      if (q.options.some(o => !o.trim()))
        return { error: `Question ${i + 1} : toutes les réponses sont obligatoires.` }
    }
  }

  const supabase = createAdminClient()

  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .insert({ title, module_id: moduleId, lesson_id: lessonId })
    .select('id')
    .single()

  if (quizErr || !quiz) {
    log.error({ error: quizErr?.message }, 'Failed to insert quiz row')
    return { error: quizErr?.message ?? 'Erreur lors de la création du quiz.' }
  }

  const rows = questions.map((q, i) => buildRow(quiz.id, q, i))

  const { error: qqErr } = await supabase.from('quiz_questions').insert(rows)
  if (qqErr) {
    log.error({ quizId: quiz.id, error: qqErr.message }, 'Failed to insert questions — rolling back quiz')
    await supabase.from('quizzes').delete().eq('id', quiz.id)
    return { error: qqErr.message }
  }

  log.info({ quizId: quiz.id, questionCount: rows.length }, 'Quiz created')
  redirect(`/admin/quizzes/${quiz.id}`)
}
