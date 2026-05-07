import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import EditQuizForm from './EditQuizForm'

export const metadata: Metadata = { title: 'Admin — Modifier un quiz' }

type RawLesson = { id: string; title: string; order_index: number }
type RawModule = { id: string; title: string; order_index: number; lessons: RawLesson[] }

function toMCOptions(opts: unknown): [string, string, string, string] {
  const arr = Array.isArray(opts) ? opts : []
  return [String(arr[0] ?? ''), String(arr[1] ?? ''), String(arr[2] ?? ''), String(arr[3] ?? '')]
}

export default async function AdminEditQuizPage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: quiz } = await supabase
    .from('quizzes')
    .select('id, title, module_id, lesson_id, modules(id, course_id), lessons(id, module_id)')
    .eq('id', params.id)
    .single()

  if (!quiz) notFound()

  const { data: rawQuestions } = await supabase
    .from('quiz_questions')
    .select('id, question, question_type, options, correct_answer, drag_match_answers, explanation, order_index')
    .eq('quiz_id', params.id)
    .order('order_index')

  const { data: rawCourses } = await supabase
    .from('courses')
    .select('id, title, modules(id, title, order_index, lessons(id, title, order_index))')
    .eq('is_published', true)
    .order('title')

  const mod = quiz.modules as unknown as { id: string; course_id: string } | null
  const les = quiz.lessons as unknown as { id: string; module_id: string } | null

  let initialCourseId = ''
  if (mod) {
    initialCourseId = mod.course_id
  } else if (les) {
    for (const c of rawCourses ?? []) {
      const mods = c.modules as unknown as Array<{ id: string }>
      if (mods.some(m => m.id === les.module_id)) {
        initialCourseId = c.id
        break
      }
    }
  }

  const questions = (rawQuestions ?? []).map(q => {
    const qType = (q.question_type as string | null) ?? 'multiple_choice'

    if (qType === 'drag_match') {
      const opts = (q.options ?? {}) as { categories?: { id: string; label: string }[]; items?: { id: string; label: string }[] }
      const dmAnswers = (q.drag_match_answers ?? {}) as Record<string, string>
      return {
        id:            q.id,
        order_index:   q.order_index,
        question_type: 'drag_match' as const,
        question:      q.question,
        explanation:   (q.explanation as string | null) ?? '',
        dm_categories: opts.categories ?? [],
        dm_items:      (opts.items ?? []).map(item => ({
          id:                item.id,
          label:             item.label,
          correctCategoryId: dmAnswers[item.id] ?? '',
        })),
      }
    }

    return {
      id:             q.id,
      order_index:    q.order_index,
      question_type:  'multiple_choice' as const,
      question:       q.question,
      options:        toMCOptions(q.options),
      correct_answer: (q.correct_answer as number | null) ?? 0,
      explanation:    (q.explanation as string | null) ?? '',
    }
  })

  const courses = (rawCourses ?? []).map(c => ({
    id:      c.id,
    title:   c.title,
    modules: (c.modules as unknown as RawModule[]) ?? [],
  }))

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link
        href={`/admin/quizzes/${params.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour au quiz
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-gray-900">Modifier le quiz</h1>
        <p className="text-sm text-gray-400 mt-0.5">{quiz.title}</p>
      </div>

      <EditQuizForm
        quizId={quiz.id}
        initialTitle={quiz.title}
        initialCourseId={initialCourseId}
        initialModuleId={quiz.module_id ?? ''}
        initialLessonId={quiz.lesson_id ?? ''}
        initialQuestions={questions}
        courses={courses}
      />
    </div>
  )
}
