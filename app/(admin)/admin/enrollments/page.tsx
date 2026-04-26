import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Inscriptions' }

export default async function AdminEnrollmentsPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('id, status, enrolled_at, expires_at, profiles(full_name, email), courses(title, slug)')
    .order('enrolled_at', { ascending: false })
    .limit(100)

  const statusColor: Record<string, string> = {
    active:    'bg-green-100 text-green-700',
    expired:   'bg-yellow-100 text-yellow-700',
    suspended: 'bg-red-100 text-red-600',
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Inscriptions</h1>
        <p className="text-sm text-gray-400 mt-0.5">{enrollments?.length ?? 0} inscription(s)</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!enrollments?.length ? (
          <p className="text-sm text-gray-400 text-center py-16">Aucune inscription pour l&apos;instant.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_100px_120px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Apprenant</span>
              <span>Formation</span>
              <span>Statut</span>
              <span>Inscrit le</span>
            </div>

            {enrollments.map(e => {
              const user   = e.profiles as unknown as { full_name: string | null; email: string } | null
              const course = e.courses  as unknown as { title: string; slug: string } | null
              return (
                <div key={e.id} className="hover:bg-gray-50/60 transition-colors">
                  <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_100px_120px] gap-4 px-5 py-3.5 items-center">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{user?.full_name || user?.email || '—'}</p>
                      <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                    </div>
                    <span className="text-sm text-gray-600 truncate">{course?.title || '—'}</span>
                    <span className={`inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full ${statusColor[e.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {e.status === 'active' ? 'Actif' : e.status === 'expired' ? 'Expiré' : 'Suspendu'}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(e.enrolled_at).toLocaleDateString('fr-FR')}
                    </span>
                  </div>

                  {/* Mobile */}
                  <div className="sm:hidden px-4 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{user?.full_name || user?.email}</p>
                        <p className="text-xs text-gray-400">{course?.title}</p>
                      </div>
                      <span className={`shrink-0 text-xs font-semibold px-2.5 py-0.5 rounded-full ${statusColor[e.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {e.status === 'active' ? 'Actif' : e.status === 'expired' ? 'Expiré' : 'Suspendu'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(e.enrolled_at).toLocaleDateString('fr-FR')}
                    </p>
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
