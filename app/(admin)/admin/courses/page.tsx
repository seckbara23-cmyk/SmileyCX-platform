import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { Layers, Plus, Eye, EyeOff } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Formations' }

export default async function AdminCoursesPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: courses } = await supabase
    .from('courses')
    .select('id, slug, title, price, currency, is_published, is_free, level, duration_hours, created_at')
    .order('created_at', { ascending: false })

  // Get enrollment counts per course
  const courseIds = (courses ?? []).map(c => c.id)
  const { data: enrollCounts } = courseIds.length > 0
    ? await supabase
        .from('enrollments')
        .select('course_id')
        .in('course_id', courseIds)
        .eq('status', 'active')
    : { data: [] }

  const countMap: Record<string, number> = {}
  for (const e of enrollCounts ?? []) {
    countMap[e.course_id] = (countMap[e.course_id] ?? 0) + 1
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Formations</h1>
          <p className="text-sm text-gray-400 mt-0.5">{courses?.length ?? 0} formation(s)</p>
        </div>
        <Link
          href="/admin/courses/new"
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> Nouvelle
        </Link>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!courses?.length ? (
          <div className="py-16 text-center text-gray-400">
            <Layers className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm mb-3">Aucune formation</p>
            <Link href="/admin/courses/new" className="text-sm text-primary font-semibold hover:underline">
              Créer la première formation →
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            <div className="hidden sm:grid sm:grid-cols-[1fr_100px_80px_100px_80px_80px] gap-3 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Titre</span>
              <span>Prix</span>
              <span>Niveau</span>
              <span>Inscrits</span>
              <span>Statut</span>
              <span>Actions</span>
            </div>

            {(courses ?? []).map(c => (
              <div key={c.id} className="hover:bg-gray-50/60 transition-colors">
                {/* Desktop */}
                <div className="hidden sm:grid sm:grid-cols-[1fr_100px_80px_100px_80px_80px] gap-3 px-5 py-4 items-center">
                  <div>
                    <p className="text-sm font-semibold text-gray-800 truncate">{c.title}</p>
                    <p className="text-xs text-gray-400 font-mono">{c.slug}</p>
                  </div>
                  <span className="text-sm text-gray-600">
                    {c.is_free ? 'Gratuit' : `${Number(c.price).toLocaleString('fr-FR')} ${c.currency}`}
                  </span>
                  <span className="text-sm text-gray-500 capitalize">{c.level}</span>
                  <span className="text-sm font-medium text-gray-700">{countMap[c.id] ?? 0} élèves</span>
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    c.is_published
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}>
                    {c.is_published ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    {c.is_published ? 'Publié' : 'Brouillon'}
                  </span>
                  <Link href={`/admin/courses/${c.id}/edit`} className="text-xs text-primary font-semibold hover:underline">
                    Modifier →
                  </Link>
                </div>

                {/* Mobile */}
                <div className="sm:hidden px-4 py-4 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-800">{c.title}</p>
                    <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
                      c.is_published ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {c.is_published ? 'Publié' : 'Brouillon'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">
                    {c.is_free ? 'Gratuit' : `${Number(c.price).toLocaleString('fr-FR')} ${c.currency}`}
                    {' · '}{c.level}{' · '}{countMap[c.id] ?? 0} inscrits
                  </p>
                  <Link href={`/admin/courses/${c.id}/edit`} className="text-xs text-primary font-semibold">
                    Modifier →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
