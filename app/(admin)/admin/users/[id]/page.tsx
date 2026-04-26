import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, Shield, User, BookOpen, Trash2 } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { deleteUser } from './actions'

export const metadata: Metadata = { title: 'Admin — Utilisateur' }

export default async function AdminUserDetailPage({
  params,
}: {
  params: { id: string }
}) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: user } = await supabase
    .from('profiles')
    .select('id, email, full_name, platform_role, created_at')
    .eq('id', params.id)
    .single()

  if (!user) notFound()

  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('id, status, enrolled_at, courses(id, title, slug)')
    .eq('user_id', params.id)
    .order('enrolled_at', { ascending: false })

  // Lesson progress count per course
  const { data: progress } = await supabase
    .from('lesson_progress')
    .select('id, is_completed, lessons(id, modules(course_id))')
    .eq('user_id', params.id)

  // Group completed lessons by course_id
  const completedByCourse: Record<string, number> = {}
  const totalByCourse: Record<string, number> = {}
  for (const p of progress ?? []) {
    const lesson = p.lessons as unknown as { id: string; modules: { course_id: string } | null } | null
    const courseId = lesson?.modules?.course_id
    if (!courseId) continue
    totalByCourse[courseId] = (totalByCourse[courseId] ?? 0) + 1
    if (p.is_completed) {
      completedByCourse[courseId] = (completedByCourse[courseId] ?? 0) + 1
    }
  }

  const joinedDate = new Date(user.created_at).toLocaleDateString('fr-FR', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      {/* Back */}
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux utilisateurs
      </Link>

      {/* Profile card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-xl font-bold shrink-0">
              {(user.full_name || user.email || '?').charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-gray-900">{user.full_name || '—'}</h1>
              <p className="text-sm text-gray-500">{user.email}</p>
              <p className="text-xs text-gray-400 mt-0.5">Inscrit le {joinedDate}</p>
            </div>
          </div>
          <RoleBadge role={user.platform_role} />
        </div>
      </div>

      {/* Enrollments */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-gray-800 text-sm">Formations ({enrollments?.length ?? 0})</h2>
        </div>
        {!enrollments?.length ? (
          <div className="py-10 text-center text-sm text-gray-400">Aucune inscription</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {enrollments.map(e => {
              const course = e.courses as unknown as { id: string; title: string; slug: string } | null
              const completed = completedByCourse[course?.id ?? ''] ?? 0
              const total     = totalByCourse[course?.id ?? ''] ?? 0
              const pct       = total > 0 ? Math.round((completed / total) * 100) : 0
              return (
                <div key={e.id} className="px-5 py-3.5 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{course?.title ?? '—'}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Inscrit le {new Date(e.enrolled_at).toLocaleDateString('fr-FR')}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {/* Progress bar */}
                    <div className="hidden sm:flex flex-col items-end gap-1">
                      <p className="text-xs text-gray-500">{pct}% complété</p>
                      <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <StatusBadge status={e.status} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Danger zone — delete user */}
      <div className="bg-white rounded-2xl border border-red-100 shadow-sm p-5 sm:p-6">
        <h2 className="font-bold text-gray-800 text-sm mb-1 flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-red-500" /> Zone de danger
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Supprimer cet utilisateur supprime son compte Supabase Auth, son profil et toutes ses données.
          Cette action est irréversible.
        </p>
        <form action={deleteUser}>
          <input type="hidden" name="userId" value={user.id} />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
          >
            Supprimer cet utilisateur
          </button>
        </form>
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: string }) {
  if (role === 'super_admin') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-secondary/10 text-secondary-dark shrink-0">
        <Shield className="w-3 h-3" /> Super Admin
      </span>
    )
  }
  if (role === 'consultant') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/10 text-primary shrink-0">
        <User className="w-3 h-3" /> Consultant
      </span>
    )
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-500 shrink-0">
      Utilisateur
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:    'bg-green-100 text-green-700',
    expired:   'bg-gray-100 text-gray-500',
    suspended: 'bg-red-100 text-red-600',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  )
}
