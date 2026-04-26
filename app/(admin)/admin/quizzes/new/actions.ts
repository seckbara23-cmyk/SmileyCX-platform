'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export interface QuestionPayload {
  question: string
  options: [string, string, string, string]
  correct_answer: number
  explanation: string
  order_index: number
}

export async function createQuiz(formData: FormData) {
  await requirePlatformAdmin()

  const title    = (formData.get('title') as string | null)?.trim() ?? ''
  const moduleId = (formData.get('module_id') as string | null)?.trim() || null
  const lessonId = (formData.get('lesson_id') as string | null)?.trim() || null
  const qJson    = (formData.get('questions_json') as string | null) ?? '[]'

  if (!title)               return { error: 'Le titre est obligatoire.' }
  if (!moduleId && !lessonId) return { error: 'Sélectionnez un module ou une leçon.' }
  if (moduleId && lessonId) return { error: 'Sélectionnez soit un module soit une leçon, pas les deux.' }

  let questions: QuestionPayload[]
  try { questions = JSON.parse(qJson) } catch { return { error: 'Données de questions invalides.' } }

  if (!questions.length) return { error: 'Ajoutez au moins une question.' }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!q.question.trim()) return { error: `Question ${i + 1} : le texte est obligatoire.` }
    if (q.options.some(o => !o.trim())) return { error: `Question ${i + 1} : toutes les réponses sont obligatoires.` }
  }

  const supabase = createAdminClient()

  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .insert({ title, module_id: moduleId, lesson_id: lessonId })
    .select('id')
    .single()

  if (quizErr || !quiz) return { error: quizErr?.message ?? 'Erreur lors de la création du quiz.' }

  const rows = questions.map((q, i) => ({
    quiz_id:        quiz.id,
    question:       q.question.trim(),
    options:        q.options,
    correct_answer: q.correct_answer,
    explanation:    q.explanation?.trim() || null,
    order_index:    q.order_index ?? i,
  }))

  const { error: qqErr } = await supabase.from('quiz_questions').insert(rows)
  if (qqErr) {
    await supabase.from('quizzes').delete().eq('id', quiz.id)
    return { error: qqErr.message }
  }

  redirect(`/admin/quizzes/${quiz.id}`)
}
