import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import EditExerciseForm from './EditExerciseForm'

export const metadata: Metadata = { title: 'Admin — Modifier exercice' }

export default async function EditExercisePage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const [{ data: exercise }, { data: categories }, { data: items }, { data: courses }] = await Promise.all([
    supabase
      .from('exercises')
      .select('id, title, instructions, is_published, lesson_id, lessons(id, title, modules(id, title, courses(id, title)))')
      .eq('id', params.id)
      .single(),
    supabase
      .from('exercise_categories')
      .select('id, name, color, order_index')
      .eq('exercise_id', params.id)
      .order('order_index'),
    supabase
      .from('exercise_items')
      .select('id, label, correct_category_id, order_index')
      .eq('exercise_id', params.id)
      .order('order_index'),
    supabase
      .from('courses')
      .select('id, title, modules(id, title, order_index, lessons(id, title, order_index))')
      .order('title'),
  ])

  if (!exercise) notFound()

  type LessonShape = { id: string; title: string; modules: { id: string; title: string; courses: { id: string; title: string } | null } | null } | null
  const lesson  = exercise.lessons as unknown as LessonShape
  const mod     = lesson?.modules ?? null
  const course  = mod?.courses ?? null

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link href={`/admin/exercises/${params.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Retour à l&apos;exercice
      </Link>

      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Modifier l&apos;exercice</h1>
        <p className="text-sm text-gray-400 mt-0.5">{exercise.title}</p>
      </div>

      <EditExerciseForm
        exerciseId={params.id}
        initialTitle={exercise.title}
        initialInstructions={exercise.instructions ?? ''}
        initialCourseId={course?.id ?? ''}
        initialModuleId={mod?.id ?? ''}
        initialLessonId={exercise.lesson_id ?? ''}
        initialIsPublished={exercise.is_published}
        initialCategories={(categories ?? []).map(c => ({ id: c.id, name: c.name, color: c.color ?? '' }))}
        initialItems={(items ?? []).map(i => ({ id: i.id, label: i.label, correctCategoryId: i.correct_category_id }))}
        courses={(courses ?? []) as Parameters<typeof EditExerciseForm>[0]['courses']}
      />
    </div>
  )
}
