import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { Dumbbell } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Exercices' }

export default async function AdminExercisesPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: exercises } = await supabase
    .from('exercises')
    .select(`
      id, title, exercise_type, is_published, order_index, created_at,
      lessons(id, title, modules(id, title, courses(id, title)))
    `)
    .order('created_at', { ascending: false })

  // Fetch item counts per exercise
  const exIds = (exercises ?? []).map(e => e.id)
  const { data: itemRows } = exIds.length
    ? await supabase.from('exercise_items').select('exercise_id').in('exercise_id', exIds)
    : { data: [] }

  const itemCountMap: Record<string, number> = {}
  for (const row of itemRows ?? []) {
    itemCountMap[row.exercise_id] = (itemCountMap[row.exercise_id] ?? 0) + 1
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Exercices</h1>
          <p className="text-sm text-gray-400 mt-0.5">{exercises?.length ?? 0} exercice{(exercises?.length ?? 0) !== 1 ? 's' : ''} au total</p>
        </div>
        <Link
          href="/admin/exercises/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          + Nouvel exercice
        </Link>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!exercises?.length ? (
          <div className="py-16 text-center text-gray-400">
            <Dumbbell className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Aucun exercice</p>
            <p className="text-xs mt-1 text-gray-300">Créez votre premier exercice pratique</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {/* Desktop header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_160px_160px_80px_60px_140px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Titre</span>
              <span>Formation</span>
              <span>Leçon</span>
              <span>Type</span>
              <span>Éléments</span>
              <span>Actions</span>
            </div>

            {(exercises ?? []).map(ex => {
              type LessonShape = { id: string; title: string; modules: { id: string; title: string; courses: { id: string; title: string } | null } | null } | null
              const lesson = ex.lessons as unknown as LessonShape
              const mod    = lesson?.modules ?? null
              const course = mod?.courses ?? null
              const nItems = itemCountMap[ex.id] ?? 0

              return (
                <div key={ex.id} className="hover:bg-gray-50/60 transition-colors">
                  {/* Desktop row */}
                  <div className="hidden sm:grid sm:grid-cols-[1fr_160px_160px_80px_60px_140px] gap-4 px-5 py-3.5 items-center">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-gray-800 truncate">{ex.title}</span>
                      {!ex.is_published && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-400">brouillon</span>
                      )}
                    </div>
                    <span className="text-sm text-gray-500 truncate">{course?.title ?? '—'}</span>
                    <span className="text-sm text-gray-400 truncate">{lesson?.title ?? '—'}</span>
                    <span className="text-xs text-gray-400 font-medium">Glisser-Déposer</span>
                    <span className="text-sm text-gray-400">{nItems}</span>
                    <div className="flex items-center gap-3">
                      <Link href={`/admin/exercises/${ex.id}`} className="text-xs text-primary font-semibold hover:underline">
                        Voir →
                      </Link>
                      <Link href={`/admin/exercises/${ex.id}/edit`} className="text-xs text-gray-400 font-semibold hover:text-gray-700 hover:underline">
                        Modifier
                      </Link>
                    </div>
                  </div>

                  {/* Mobile card */}
                  <div className="sm:hidden px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-800">{ex.title}</p>
                      {!ex.is_published && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-400">brouillon</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {course?.title ?? '—'} · {lesson?.title ?? '—'} · {nItems} élément{nItems !== 1 ? 's' : ''}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <Link href={`/admin/exercises/${ex.id}`} className="text-xs text-primary font-semibold">Voir →</Link>
                      <Link href={`/admin/exercises/${ex.id}/edit`} className="text-xs text-gray-400 font-semibold hover:text-gray-700">Modifier</Link>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
