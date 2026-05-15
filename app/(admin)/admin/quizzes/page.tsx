import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Quiz' }

export default async function AdminQuizzesPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: quizzes } = await supabase
    .from('quizzes')
    .select(`
      id, title, created_at,
      modules(id, title, courses(id, title)),
      lessons(id, title),
      courses(id, title)
    `)
    .order('created_at', { ascending: false })

  // Fetch question counts
  const quizIds = (quizzes ?? []).map(q => q.id)
  const { data: qCounts } = quizIds.length
    ? await supabase
        .from('quiz_questions')
        .select('quiz_id')
        .in('quiz_id', quizIds)
    : { data: [] }

  const countMap: Record<string, number> = {}
  for (const row of qCounts ?? []) {
    countMap[row.quiz_id] = (countMap[row.quiz_id] ?? 0) + 1
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Quiz</h1>
          <p className="text-sm text-gray-400 mt-0.5">{quizzes?.length ?? 0} quiz au total</p>
        </div>
        <Link
          href="/admin/quizzes/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          + Nouveau quiz
        </Link>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!quizzes?.length ? (
          <div className="py-16 text-center text-gray-400">
            <FileQuestion className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Aucun quiz</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {/* Desktop header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_180px_120px_60px_140px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Titre</span>
              <span>Formation</span>
              <span>Module / Leçon</span>
              <span>Q.</span>
              <span>Actions</span>
            </div>

            {(quizzes ?? []).map(q => {
              const mod        = q.modules as unknown as { id: string; title: string; courses: { title: string } | null } | null
              const lesson     = q.lessons as unknown as { id: string; title: string } | null
              const finalCourse = (q as Record<string, unknown>).courses as { id: string; title: string } | null
              const isFinal    = !!finalCourse && !mod && !lesson
              const context    = isFinal ? '⭐ Examen final' : (mod?.title ?? lesson?.title ?? '—')
              const course     = isFinal ? (finalCourse?.title ?? '—') : (mod?.courses?.title ?? '—')
              const nQ = countMap[q.id] ?? 0
              return (
                <div key={q.id} className="hover:bg-gray-50/60 transition-colors">
                  {/* Desktop row */}
                  <div className="hidden sm:grid sm:grid-cols-[1fr_180px_120px_60px_140px] gap-4 px-5 py-3.5 items-center">
                    <span className="text-sm font-medium text-gray-800 truncate">{q.title}</span>
                    <span className="text-sm text-gray-500 truncate">{course}</span>
                    <span className="text-sm text-gray-400 truncate">{context}</span>
                    <span className="text-sm text-gray-400">{nQ}</span>
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/admin/quizzes/${q.id}`}
                        className="text-xs text-primary font-semibold hover:underline"
                      >
                        Voir →
                      </Link>
                      <Link
                        href={`/admin/quizzes/${q.id}/edit`}
                        className="text-xs text-gray-400 font-semibold hover:text-gray-700 hover:underline"
                      >
                        Modifier
                      </Link>
                    </div>
                  </div>

                  {/* Mobile card */}
                  <div className="sm:hidden px-4 py-3.5">
                    <p className="text-sm font-medium text-gray-800">{q.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{course} · {context} · {nQ} question{nQ !== 1 ? 's' : ''}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <Link href={`/admin/quizzes/${q.id}`} className="text-xs text-primary font-semibold">
                        Voir →
                      </Link>
                      <Link href={`/admin/quizzes/${q.id}/edit`} className="text-xs text-gray-400 font-semibold hover:text-gray-700">
                        Modifier
                      </Link>
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
