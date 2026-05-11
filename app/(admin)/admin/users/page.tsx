import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { Users, Shield, User, BookOpen, Award, GraduationCap } from 'lucide-react'
import UserSearchBar from './UserSearchBar'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Utilisateurs' }

interface PageProps {
  searchParams?: { q?: string }
}

function RoleBadge({ role }: { role: string }) {
  if (role === 'super_admin')
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-secondary/10 text-secondary-dark shrink-0"><Shield className="w-3 h-3" /> Admin</span>
  if (role === 'consultant')
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/10 text-primary shrink-0"><User className="w-3 h-3" /> Consultant</span>
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-500 shrink-0">Utilisateur</span>
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()
  const q = searchParams?.q?.trim().toLowerCase() ?? ''

  // Fetch all data in parallel
  const [
    { data: allUsers },
    { data: allEnrollments },
    { data: allCerts },
    { data: progressRows },
  ] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, platform_role, created_at').order('created_at', { ascending: false }),
    supabase.from('enrollments').select('user_id, status').eq('status', 'active'),
    supabase.from('certificates').select('user_id'),
    supabase.from('course_progress_view').select('user_id, percentage'),
  ])

  // Aggregate per user
  const enrollCountByUser: Record<string, number> = {}
  for (const e of allEnrollments ?? []) {
    enrollCountByUser[e.user_id] = (enrollCountByUser[e.user_id] ?? 0) + 1
  }

  const certCountByUser: Record<string, number> = {}
  for (const c of allCerts ?? []) {
    certCountByUser[c.user_id] = (certCountByUser[c.user_id] ?? 0) + 1
  }

  const completedByUser: Record<string, number> = {}
  for (const p of progressRows ?? []) {
    if ((p.percentage as number) >= 100) {
      completedByUser[p.user_id] = (completedByUser[p.user_id] ?? 0) + 1
    }
  }

  // Filter by search
  const users = (allUsers ?? []).filter(u => {
    if (!q) return true
    return (
      u.full_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q)
    )
  })

  const learnerCount = (allUsers ?? []).filter(u => u.platform_role === 'user' || !u.platform_role).length

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Utilisateurs</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {allUsers?.length ?? 0} compte{(allUsers?.length ?? 0) !== 1 ? 's' : ''} ·{' '}
            {learnerCount} apprenant{learnerCount !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/admin/users/new"
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
        >
          + Nouveau
        </Link>
      </div>

      {/* Search */}
      <UserSearchBar defaultValue={searchParams?.q ?? ''} />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {users.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Aucun utilisateur trouvé</p>
          </div>
        ) : (
          <>
            {/* Desktop header */}
            <div className="hidden lg:grid lg:grid-cols-[1fr_180px_90px_80px_80px_80px_80px] gap-3 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100">
              <span>Utilisateur</span>
              <span>Email</span>
              <span>Rôle</span>
              <span className="text-center">Inscrits</span>
              <span className="text-center">Terminés</span>
              <span className="text-center">Certifs</span>
              <span>Actions</span>
            </div>

            <div className="divide-y divide-gray-50">
              {users.map(u => {
                const enrolled  = enrollCountByUser[u.id]  ?? 0
                const completed = completedByUser[u.id]    ?? 0
                const certs     = certCountByUser[u.id]    ?? 0

                return (
                  <div key={u.id} className="hover:bg-gray-50/60 transition-colors">

                    {/* Desktop row */}
                    <div className="hidden lg:grid lg:grid-cols-[1fr_180px_90px_80px_80px_80px_80px] gap-3 px-5 py-3.5 items-center">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-xs font-bold shrink-0">
                          {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{u.full_name || '—'}</p>
                          <p className="text-xs text-gray-400">{new Date(u.created_at).toLocaleDateString('fr-FR')}</p>
                        </div>
                      </div>
                      <span className="text-sm text-gray-500 truncate">{u.email}</span>
                      <div><RoleBadge role={u.platform_role} /></div>
                      <div className="text-center">
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-sm font-bold ${enrolled > 0 ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-gray-400'}`}>
                          {enrolled}
                        </span>
                      </div>
                      <div className="text-center">
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-sm font-bold ${completed > 0 ? 'bg-success/10 text-success' : 'bg-gray-100 text-gray-400'}`}>
                          {completed}
                        </span>
                      </div>
                      <div className="text-center">
                        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-sm font-bold ${certs > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-400'}`}>
                          {certs}
                        </span>
                      </div>
                      <Link href={`/admin/users/${u.id}`} className="text-xs text-primary font-semibold hover:underline">
                        Voir →
                      </Link>
                    </div>

                    {/* Mobile card */}
                    <div className="lg:hidden px-4 py-3.5 flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{u.full_name || u.email}</p>
                        <p className="text-xs text-gray-400 truncate">{u.email}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-gray-400">{enrolled} inscrit{enrolled !== 1 ? 's' : ''}</span>
                          <span className="text-gray-300">·</span>
                          <span className="text-xs text-success">{completed} terminé{completed !== 1 ? 's' : ''}</span>
                          <span className="text-gray-300">·</span>
                          <span className="text-xs text-amber-600">{certs} cert{certs !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <RoleBadge role={u.platform_role} />
                        <Link href={`/admin/users/${u.id}`} className="text-xs text-primary font-semibold">Voir →</Link>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
