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

function toMCOptions(opts: unknown): string[] {
  if (!Array.isArray(opts)) return ['', '', '', '']
  const arr = opts as unknown[]
  if (arr.length === 4) return arr.map(v => String(v ?? ''))
  const out = ['', '', '', '']
  arr.forEach((v, i) => { if (i < 4) out[i] = String(v ?? '') })
  return out
}

export default async function AdminEditQuizPage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: quiz } = await supabase
    .from('quizzes')
    .select('id, title, module_id, lesson_id, course_id, modules(id, course_id), lessons(id, module_id)')
    .eq('id', params.id)
    .single()

  if (!quiz) notFound()

  const { data: rawQuestions } = await supabase
    .from('quiz_questions')
    .select('id, question, question_type, options, correct_answer, drag_match_answers, explanation, order_index, question_image_url')
    .eq('quiz_id', params.id)
    .order('order_index')

  const { data: rawCourses } = await supabase
    .from('courses')
    .select('id, title, modules(id, title, order_index, lessons(id, title, order_index))')
    .eq('is_published', true)
    .order('title')

  const mod = quiz.modules as unknown as { id: string; course_id: string } | null
  const les = quiz.lessons as unknown as { id: string; module_id: string } | null
  const isFinalExam = !!(quiz as Record<string, unknown>).course_id

  let initialCourseId = ''
  if (isFinalExam) {
    initialCourseId = (quiz as Record<string, unknown>).course_id as string
  } else if (mod) {
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

    if (qType === 'multiple_answer') {
      const dma = (q.drag_match_answers ?? {}) as { correct_indices?: number[] }
      return {
        id:              q.id,
        order_index:     q.order_index,
        question_type:   'multiple_answer' as const,
        question:        q.question,
        options:         toMCOptions(q.options),
        correct_indices: dma.correct_indices ?? [],
        explanation:     (q.explanation as string | null) ?? '',
      }
    }

    if (qType === 'true_false') {
      return {
        id:             q.id,
        order_index:    q.order_index,
        question_type:  'true_false' as const,
        question:       q.question,
        correct_answer: (q.correct_answer as number | null) ?? 0,
        explanation:    (q.explanation as string | null) ?? '',
      }
    }

    if (qType === 'visual_choice') {
      return {
        id:                  q.id,
        order_index:         q.order_index,
        question_type:       'visual_choice' as const,
        question:            q.question,
        options:             toMCOptions(q.options),
        correct_answer:      (q.correct_answer as number | null) ?? 0,
        question_image_url:  (q as Record<string, unknown>).question_image_url as string ?? '',
        explanation:         (q.explanation as string | null) ?? '',
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
        initialIsFinal={isFinalExam}
        initialQuestions={questions}
        courses={courses}
      />
    </div>
  )
}
