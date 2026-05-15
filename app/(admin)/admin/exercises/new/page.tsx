import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import NewExerciseForm from './NewExerciseForm'

export const metadata: Metadata = { title: 'Admin — Nouvel exercice' }

export default async function NewExercisePage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: courses } = await supabase
    .from('courses')
    .select('id, title, modules(id, title, order_index, lessons(id, title, order_index))')
    .order('title')

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <Link href="/admin/exercises"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Retour aux exercices
      </Link>

      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Nouvel exercice</h1>
        <p className="text-sm text-gray-400 mt-0.5">Type : Glisser-Déposer</p>
      </div>

      <NewExerciseForm courses={(courses ?? []) as Parameters<typeof NewExerciseForm>[0]['courses']} />
    </div>
  )
}
