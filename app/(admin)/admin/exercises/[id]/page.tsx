import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { deleteExercise } from './actions'

export const metadata: Metadata = { title: 'Admin — Exercice' }

export default async function AdminExerciseDetailPage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: exercise } = await supabase
    .from('exercises')
    .select(`
      id, title, instructions, exercise_type, is_published, order_index, created_at,
      lessons(id, title, modules(id, title, courses(id, title)))
    `)
    .eq('id', params.id)
    .single()

  if (!exercise) notFound()

  const { data: categories } = await supabase
    .from('exercise_categories')
    .select('id, name, color, order_index')
    .eq('exercise_id', params.id)
    .order('order_index')

  const { data: items } = await supabase
    .from('exercise_items')
    .select('id, label, correct_category_id, order_index')
    .eq('exercise_id', params.id)
    .order('order_index')

  type LessonShape = { id: string; title: string; modules: { id: string; title: string; courses: { id: string; title: string } | null } | null } | null
  const lesson  = exercise.lessons as unknown as LessonShape
  const mod     = lesson?.modules ?? null
  const course  = mod?.courses ?? null
  const catMap  = Object.fromEntries((categories ?? []).map(c => [c.id, c]))

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link href="/admin/exercises"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Retour aux exercices
      </Link>

      {/* Header */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-extrabold text-gray-900">{exercise.title}</h1>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${exercise.is_published ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {exercise.is_published ? 'Publié' : 'Brouillon'}
              </span>
            </div>
            {exercise.instructions && (
              <p className="text-sm text-gray-500 mt-1">{exercise.instructions}</p>
            )}
            <p className="text-xs text-gray-300 mt-2">
              {course?.title ?? '—'}{mod ? ` › ${mod.title}` : ''}{lesson ? ` › ${lesson.title}` : ''}
            </p>
            <p className="text-xs text-gray-300 mt-0.5">
              Type : Glisser-Déposer · {categories?.length ?? 0} catégorie{(categories?.length ?? 0) !== 1 ? 's' : ''} · {items?.length ?? 0} élément{(items?.length ?? 0) !== 1 ? 's' : ''}
            </p>
          </div>
          <Link href={`/admin/exercises/${params.id}/edit`}
            className="shrink-0 px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            Modifier
          </Link>
        </div>
      </div>

      {/* Categories */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-bold text-gray-700">Catégories</h2>
        <div className="flex flex-wrap gap-2">
          {(categories ?? []).map(cat => (
            <span key={cat.id} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-100 text-sm text-gray-700 bg-gray-50">
              {cat.color && (
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
              )}
              {cat.name}
            </span>
          ))}
        </div>
      </div>

      {/* Items */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-bold text-gray-700">Éléments à classer</h2>
        <div className="divide-y divide-gray-50">
          {(items ?? []).map((item, idx) => {
            const correctCat = catMap[item.correct_category_id]
            return (
              <div key={item.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-500 text-xs w-5 shrink-0">{idx + 1}.</span>
                <span className="flex-1 text-gray-800">{item.label}</span>
                <span className="text-xs text-gray-400">→</span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-primary shrink-0">
                  {correctCat?.color && (
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: correctCat.color }} />
                  )}
                  {correctCat?.name ?? '—'}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Delete */}
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5">
        <h2 className="text-sm font-bold text-red-700 mb-1">Zone de danger</h2>
        <p className="text-xs text-gray-400 mb-4">La suppression est irréversible et efface toutes les données associées.</p>
        <form action={deleteExercise}>
          <input type="hidden" name="exerciseId" value={params.id} />
          <button type="submit"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-semibold hover:bg-red-100 transition-colors">
            <Trash2 className="w-4 h-4" /> Supprimer l&apos;exercice
          </button>
        </form>
      </div>
    </div>
  )
}
