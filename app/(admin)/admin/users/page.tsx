import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { Users, Plus, Shield, User } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Utilisateurs' }

export default async function AdminUsersPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: users } = await supabase
    .from('profiles')
    .select('id, email, full_name, platform_role, created_at')
    .order('created_at', { ascending: false })

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Utilisateurs</h1>
          <p className="text-sm text-gray-400 mt-0.5">{users?.length ?? 0} compte(s) sur la plateforme</p>
        </div>
        <Link
          href="/admin/users/new"
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> Nouveau
        </Link>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!users?.length ? (
          <div className="py-16 text-center text-gray-400">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Aucun utilisateur</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {/* Desktop header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_180px_130px_80px] gap-4 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Utilisateur</span>
              <span>Email</span>
              <span>Rôle plateforme</span>
              <span>Actions</span>
            </div>

            {(users ?? []).map(u => (
              <div key={u.id} className="hover:bg-gray-50/60 transition-colors">

                {/* Desktop row */}
                <div className="hidden sm:grid sm:grid-cols-[1fr_180px_130px_80px] gap-4 px-5 py-3.5 items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm font-medium text-gray-800 truncate">
                      {u.full_name || '—'}
                    </span>
                  </div>
                  <span className="text-sm text-gray-500 truncate">{u.email}</span>
                  <RoleBadge role={u.platform_role} />
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="text-xs text-primary font-semibold hover:underline"
                  >
                    Voir →
                  </Link>
                </div>

                {/* Mobile card */}
                <div className="sm:hidden px-4 py-3.5 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/60 to-secondary/60 flex items-center justify-center text-white text-sm font-bold shrink-0">
                    {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{u.full_name || u.email}</p>
                    <p className="text-xs text-gray-400 truncate">{u.email}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <RoleBadge role={u.platform_role} />
                    <Link href={`/admin/users/${u.id}`} className="text-xs text-primary font-semibold">
                      Voir →
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: string }) {
  if (role === 'super_admin') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-secondary/10 text-secondary-dark">
        <Shield className="w-3 h-3" /> Super Admin
      </span>
    )
  }
  if (role === 'consultant') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/10 text-primary">
        <User className="w-3 h-3" /> Consultant
      </span>
    )
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-500">
      Utilisateur
    </span>
  )
}
