import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { updateModule, deleteModule } from './actions'
import LessonEditor from './LessonEditor'

export const metadata: Metadata = { title: 'Admin — Modifier le module' }

export default async function AdminEditModulePage({
  params,
}: {
  params: { id: string }
}) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: mod } = await supabase
    .from('modules')
    .select('id, title, slug, description, order_index, course_id, courses(id, title)')
    .eq('id', params.id)
    .single()

  if (!mod) notFound()

  const { data: courses } = await supabase
    .from('courses')
    .select('id, title')
    .order('title')

  const { data: lessons } = await supabase
    .from('lessons')
    .select('id, title, slug, content, video_url, pdf_url, subtitle_url, video_object_path, pdf_object_path, subtitle_object_path, duration_minutes, order_index, is_preview')
    .eq('module_id', params.id)
    .order('order_index')

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <Link
        href="/admin/modules"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux modules
      </Link>

      <h1 className="text-xl font-extrabold text-gray-900">Modifier le module</h1>

      {/* Module metadata form */}
      <form action={updateModule} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">
        <input type="hidden" name="moduleId" value={mod.id} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="courseId" className="text-sm font-semibold text-gray-700">Formation</label>
          <select
            id="courseId"
            name="courseId"
            defaultValue={mod.course_id}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          >
            {(courses ?? []).map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="mod-title" className="text-sm font-semibold text-gray-700">Titre</label>
          <input
            id="mod-title"
            type="text"
            name="title"
            required
            defaultValue={mod.title}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="mod-slug" className="text-sm font-semibold text-gray-700">Slug</label>
          <input
            id="mod-slug"
            type="text"
            name="slug"
            required
            defaultValue={mod.slug}
            pattern="[a-z0-9-]+"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="mod-description" className="text-sm font-semibold text-gray-700">Description</label>
          <textarea
            id="mod-description"
            name="description"
            rows={3}
            defaultValue={mod.description ?? ''}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="mod-order" className="text-sm font-semibold text-gray-700">Ordre</label>
          <input
            id="mod-order"
            type="number"
            name="orderIndex"
            min={0}
            defaultValue={mod.order_index}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Enregistrer
          </button>
          <Link
            href="/admin/modules"
            className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Annuler
          </Link>
        </div>
      </form>

      {/* Lesson editor (client component) */}
      <LessonEditor
        moduleId={mod.id}
        initialLessons={lessons ?? []}
      />

      {/* Danger zone */}
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5">
        <h2 className="font-bold text-gray-800 text-sm mb-1">Zone de danger</h2>
        <p className="text-xs text-gray-400 mb-4">
          Supprimer ce module supprime aussi toutes ses leçons. Action irréversible.
        </p>
        <form action={deleteModule}>
          <input type="hidden" name="moduleId" value={mod.id} />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
          >
            Supprimer ce module
          </button>
        </form>
      </div>
    </div>
  )
}
