import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Progression des apprenants' }

export default async function AdminProgressPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  // Get all enrollments with progress summary using the view
  const { data: progressRows } = await supabase
    .from('course_progress_view')
    .select('user_id, course_id, total_lessons, completed_lessons, percentage')
    .order('percentage', { ascending: false })
    .limit(100)

  // Enrich with user + course names
  const userIds   = Array.from(new Set((progressRows ?? []).map(r => r.user_id)))
  const courseIds = Array.from(new Set((progressRows ?? []).map(r => r.course_id)))

  const [{ data: users }, { data: courses }] = await Promise.all([
    userIds.length > 0
      ? supabase.from('profiles').select('id, full_name, email').in('id', userIds)
      : Promise.resolve({ data: [] }),
    courseIds.length > 0
      ? supabase.from('courses').select('id, title').in('id', courseIds)
      : Promise.resolve({ data: [] }),
  ])

  const userMap: Record<string, { full_name: string | null; email: string }> = {}
  for (const u of users ?? []) userMap[u.id] = u

  const courseMap: Record<string, string> = {}
  for (const c of courses ?? []) courseMap[c.id] = c.title

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Progression des apprenants</h1>
        <p className="text-sm text-gray-400 mt-0.5">{progressRows?.length ?? 0} progression(s) enregistrée(s)</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!progressRows?.length ? (
          <p className="text-sm text-gray-400 text-center py-16">Aucune progression pour l&apos;instant.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_180px_80px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Apprenant</span>
              <span>Formation</span>
              <span>Progression</span>
              <span>%</span>
            </div>
            {(progressRows ?? []).map(r => {
              const u = userMap[r.user_id]
              return (
                <div key={`${r.user_id}-${r.course_id}`} className="hover:bg-gray-50/50 transition-colors">
                  <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_180px_80px] gap-4 px-5 py-3.5 items-center">
                    <div>
                      <p className="text-sm font-medium text-gray-800 truncate">{u?.full_name || u?.email || '—'}</p>
                      <p className="text-xs text-gray-400 truncate">{u?.email}</p>
                    </div>
                    <span className="text-sm text-gray-600 truncate">{courseMap[r.course_id] || '—'}</span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${Number(r.percentage) === 100 ? 'bg-green-500' : 'bg-primary'}`}
                          style={{ width: `${r.percentage}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 shrink-0">{r.completed_lessons}/{r.total_lessons}</span>
                    </div>
                    <span className={`text-sm font-bold ${Number(r.percentage) === 100 ? 'text-green-600' : 'text-gray-700'}`}>
                      {r.percentage}%
                    </span>
                  </div>

                  {/* Mobile */}
                  <div className="sm:hidden px-4 py-3.5">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{u?.full_name || u?.email}</p>
                        <p className="text-xs text-gray-400">{courseMap[r.course_id]}</p>
                      </div>
                      <span className={`text-sm font-bold ${Number(r.percentage) === 100 ? 'text-green-600' : 'text-gray-700'}`}>
                        {r.percentage}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${Number(r.percentage) === 100 ? 'bg-green-500' : 'bg-primary'}`}
                        style={{ width: `${r.percentage}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-1">{r.completed_lessons} / {r.total_lessons} leçons</p>
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
