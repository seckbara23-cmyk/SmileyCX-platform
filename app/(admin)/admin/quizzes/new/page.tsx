import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import NewQuizForm from './NewQuizForm'

export const metadata: Metadata = { title: 'Admin — Nouveau quiz' }

export default async function AdminNewQuizPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: raw } = await supabase
    .from('courses')
    .select('id, title, modules(id, title, order_index, lessons(id, title, order_index))')
    .eq('is_published', true)
    .order('title')

  type RawLesson = { id: string; title: string; order_index: number }
  type RawModule = { id: string; title: string; order_index: number; lessons: RawLesson[] }

  const courses = (raw ?? []).map(c => ({
    id:      c.id,
    title:   c.title,
    modules: (c.modules as unknown as RawModule[]) ?? [],
  }))

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link
        href="/admin/quizzes"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux quiz
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-gray-900">Nouveau quiz</h1>
        <p className="text-sm text-gray-400 mt-0.5">Créez un quiz et attachez-le à un module ou une leçon.</p>
      </div>

      <NewQuizForm courses={courses} />
    </div>
  )
}
