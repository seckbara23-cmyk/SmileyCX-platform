import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { BookOpen, Plus } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Modules' }

export default async function AdminModulesPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: modules } = await supabase
    .from('modules')
    .select('id, title, order_index, created_at, courses(id, title, slug)')
    .order('created_at', { ascending: false })

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Modules</h1>
          <p className="text-sm text-gray-400 mt-0.5">{modules?.length ?? 0} module(s) au total</p>
        </div>
        <Link
          href="/admin/modules/new"
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> Nouveau
        </Link>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!modules?.length ? (
          <div className="py-16 text-center text-gray-400">
            <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Aucun module</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {/* Desktop header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_200px_80px_80px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Module</span>
              <span>Formation</span>
              <span>Ordre</span>
              <span>Actions</span>
            </div>

            {(modules ?? []).map(m => {
              const course = m.courses as unknown as { id: string; title: string; slug: string } | null
              return (
                <div key={m.id} className="hover:bg-gray-50/60 transition-colors">
                  {/* Desktop row */}
                  <div className="hidden sm:grid sm:grid-cols-[1fr_200px_80px_80px] gap-4 px-5 py-3.5 items-center">
                    <span className="text-sm font-medium text-gray-800 truncate">{m.title}</span>
                    <span className="text-sm text-gray-500 truncate">{course?.title ?? '—'}</span>
                    <span className="text-sm text-gray-400">{m.order_index}</span>
                    <Link
                      href={`/admin/modules/${m.id}/edit`}
                      className="text-xs text-primary font-semibold hover:underline"
                    >
                      Modifier →
                    </Link>
                  </div>

                  {/* Mobile card */}
                  <div className="sm:hidden px-4 py-3.5">
                    <p className="text-sm font-medium text-gray-800">{m.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{course?.title ?? '—'} · ordre {m.order_index}</p>
                    <Link href={`/admin/modules/${m.id}/edit`} className="text-xs text-primary font-semibold mt-1 inline-block">
                      Modifier →
                    </Link>
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
