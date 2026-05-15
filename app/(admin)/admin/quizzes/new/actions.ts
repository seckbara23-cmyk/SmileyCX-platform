'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const log = createLogger('admin/quiz-new')

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

type QuestionPayload =
  | {
      question_type:  'multiple_choice' | undefined
      question:       string
      options:        string[]
      correct_answer: number
      explanation:    string
      order_index:    number
    }
  | {
      question_type:   'multiple_answer'
      question:        string
      options:         string[]
      correct_indices: number[]
      explanation:     string
      order_index:     number
    }
  | {
      question_type:  'true_false'
      question:       string
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
  | {
      question_type:      'visual_choice'
      question:           string
      options:            string[]
      correct_answer:     number
      question_image_url: string
      explanation:        string
      order_index:        number
    }

function buildRow(quizId: string, q: QuestionPayload, fallbackIndex: number) {
  const base = {
    quiz_id:     quizId,
    question:    q.question.trim(),
    explanation: q.explanation?.trim() || null,
    order_index: q.order_index ?? fallbackIndex,
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

  // multiple_choice (default)
  return {
    ...base,
    question_type:      'multiple_choice' as const,
    options:            q.options,
    correct_answer:     q.correct_answer,
    drag_match_answers: null,
    question_image_url: null,
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
    } else if (q.question_type === 'multiple_answer') {
      if (!q.options || q.options.some(o => !o.trim()))
        return { error: `Question ${i + 1} : toutes les options sont obligatoires.` }
      if (!q.correct_indices || q.correct_indices.length === 0)
        return { error: `Question ${i + 1} : sélectionnez au moins une bonne réponse.` }
    } else if (q.question_type === 'true_false') {
      // no option validation needed — options are fixed ['Vrai','Faux']
    } else {
      // multiple_choice / visual_choice
      if (!q.options || q.options.some(o => !o.trim()))
        return { error: `Question ${i + 1} : toutes les réponses sont obligatoires.` }
    }
  }

  const supabase = createAdminClient()

  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .insert({
      title,
      module_id: lessonId ? null : moduleId,
      lesson_id: lessonId ?? null,
    })
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

  log.info({ quizId: quiz.id, questionCount: rows.length, moduleId, lessonId }, 'Quiz created')
  revalidatePath('/admin/quizzes')
  revalidatePath(`/admin/quizzes/${quiz.id}`)
  revalidatePath('/learn', 'layout')
  redirect(`/admin/quizzes/${quiz.id}`)
}
