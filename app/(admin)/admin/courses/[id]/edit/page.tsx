import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, BookOpen, Plus } from 'lucide-react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { updateCourse } from './actions'
import CourseCoverUpload from './CourseCoverUpload'
import DeleteCourseButton from './DeleteCourseButton'

export const metadata: Metadata = { title: 'Admin — Modifier une formation' }

interface Props { params: Promise<{ id: string }> }

export default async function AdminEditCoursePage({ params }: Props) {
  await requirePlatformAdmin()
  const { id } = await params
  const supabase = createAdminClient()

  const { data: course } = await supabase
    .from('courses')
    .select('*')
    .eq('id', id)
    .single()

  if (!course) notFound()

  // Load modules with lesson counts
  const { data: modules } = await supabase
    .from('modules')
    .select('id, title, order_index, lessons(id)')
    .eq('course_id', id)
    .order('order_index')

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <Link
        href="/admin/courses"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux formations
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-gray-900">Modifier la formation</h1>
          <p className="text-xs text-gray-400 font-mono mt-0.5">{course.slug}</p>
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
          course.is_published ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {course.is_published ? 'Publié' : 'Brouillon'}
        </span>
      </div>

      <form action={updateCourse} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">
        <input type="hidden" name="id" value={course.id} />

        {/* Cover image */}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-gray-700">Image de couverture</p>
          <CourseCoverUpload
            name="cover_url"
            initialUrl={(course as Record<string, unknown>).cover_url as string | null ?? null}
          />
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div className="sm:col-span-2 flex flex-col gap-1.5">
            <label htmlFor="course-title" className="text-sm font-semibold text-gray-700">Titre <span className="text-red-500">*</span></label>
            <input
              id="course-title"
              type="text"
              name="title"
              required
              defaultValue={course.title}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="course-level" className="text-sm font-semibold text-gray-700">Niveau</label>
            <select
              id="course-level"
              name="level"
              defaultValue={course.level}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
            >
              <option value="beginner">Débutant</option>
              <option value="intermediate">Intermédiaire</option>
              <option value="advanced">Avancé</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="course-duration" className="text-sm font-semibold text-gray-700">Durée (heures)</label>
            <input
              id="course-duration"
              type="number"
              name="duration_hours"
              min={1}
              defaultValue={course.duration_hours ?? 8}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>

          <div className="sm:col-span-2 flex flex-col gap-1.5">
            <label htmlFor="course-description" className="text-sm font-semibold text-gray-700">Description <span className="text-red-500">*</span></label>
            <textarea
              id="course-description"
              name="description"
              required
              rows={4}
              defaultValue={course.description}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none resize-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="course-price" className="text-sm font-semibold text-gray-700">Prix (FCFA)</label>
            <input
              id="course-price"
              type="number"
              name="price"
              min={0}
              step={500}
              defaultValue={Number(course.price)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 pt-2 border-t border-gray-100">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" name="is_free" defaultChecked={course.is_free} className="w-4 h-4 rounded accent-primary" />
            <span className="text-sm font-medium text-gray-700">Formation gratuite</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" name="is_published" defaultChecked={course.is_published} className="w-4 h-4 rounded accent-primary" />
            <span className="text-sm font-medium text-gray-700">Publiée (visible dans le catalogue)</span>
          </label>
        </div>

        <div className="pt-2 flex items-center gap-3">
          <button type="submit" className="px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors">
            Enregistrer
          </button>
          <Link href="/admin/courses" className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            Annuler
          </Link>
        </div>
      </form>

      {/* Modules section */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-bold text-gray-800 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" /> Modules ({modules?.length ?? 0})
          </h2>
          <Link
            href={`/admin/modules/new?courseId=${course.id}`}
            className="flex items-center gap-1 text-xs text-primary font-semibold hover:underline"
          >
            <Plus className="w-3.5 h-3.5" /> Ajouter
          </Link>
        </div>
        {!modules?.length ? (
          <p className="text-sm text-gray-400 text-center py-8">Aucun module — ajoutez-en un pour commencer.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {modules.map(m => {
              const lessonCount = Array.isArray(m.lessons) ? m.lessons.length : 0
              return (
                <div key={m.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="text-xs font-bold text-gray-300 w-5 shrink-0">{m.order_index}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{m.title}</p>
                    <p className="text-xs text-gray-400">{lessonCount} leçon(s)</p>
                  </div>
                  <Link href={`/admin/modules/${m.id}/edit`} className="text-xs text-primary font-semibold hover:underline shrink-0">
                    Modifier →
                  </Link>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="bg-red-50 border border-red-100 rounded-2xl p-5">
        <h3 className="text-sm font-bold text-red-700 mb-2">Zone dangereuse</h3>
        <p className="text-xs text-red-500 mb-4">
          Supprimer cette formation supprimera également tous ses modules, leçons, inscriptions et progressions. Cette action est irréversible.
        </p>
        <DeleteCourseButton courseId={course.id} courseTitle={course.title} />
      </div>
    </div>
  )
}
