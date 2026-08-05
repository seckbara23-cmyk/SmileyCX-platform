import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import Link from 'next/link'
import { Users, BookOpen, CreditCard, Award, TrendingUp, ArrowRight } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Tableau de bord' }

export default async function AdminDashboardPage() {
  // XPA-6A: this page was the ONE admin entry point relying solely on the
  // route-group layout for authorization, while itself using the service-role
  // client to read user counts, payment totals and recent learner emails.
  //
  // The layout guard is real and did run, so this was not an open door — but
  // "every entry point checks for itself" is the invariant the other 40+ admin
  // pages and actions hold, and an invariant with one exception is one nobody
  // can rely on. It also means the privileged queries below no longer execute
  // at all for an unauthorized caller.
  await requirePlatformAdmin()

  const supabase = createAdminClient()

  const [
    { count: userCount },
    { count: courseCount },
    { count: enrollCount },
    { count: payCount },
    { data: recentPayments },
    { data: recentUsers },
  ] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('courses').select('*', { count: 'exact', head: true }).eq('is_published', true),
    supabase.from('enrollments').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase.from('payments').select('*, profiles(full_name, email), courses(title)')
      .eq('status', 'completed').order('created_at', { ascending: false }).limit(5),
    supabase.from('profiles').select('id, full_name, email, platform_role, created_at').order('created_at', { ascending: false }).limit(5),
  ])

  // Revenue (simplified — sum of completed payments)
  const { data: revData } = await supabase.from('payments').select('amount').eq('status', 'completed')
  const totalRevenue = revData?.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0) ?? 0

  const stats = [
    { icon: Users,      label: 'Utilisateurs',     value: userCount ?? 0,                     color: 'text-primary bg-primary/10',    href: '/admin/users' },
    { icon: BookOpen,   label: 'Formations actives',value: courseCount ?? 0,                   color: 'text-secondary bg-secondary/10', href: '/admin/courses' },
    { icon: TrendingUp, label: 'Inscriptions',      value: enrollCount ?? 0,                   color: 'text-success bg-success/10',    href: '/admin/users' },
    { icon: CreditCard, label: 'Revenus (FCFA)',    value: totalRevenue.toLocaleString('fr-FR'), color: 'text-warning bg-warning/10',  href: '/admin/payments' },
  ]

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-dark">Tableau de bord</h1>
          <p className="text-cx-gray text-sm">Vue d&apos;ensemble de la plateforme XP Client Academy</p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map(({ icon: Icon, label, value, color, href }) => (
          <Link key={label} href={href} className="cx-card p-5 hover:shadow-md transition-shadow">
            <div className={`w-10 h-10 rounded-cx flex items-center justify-center mb-3 ${color}`}>
              <Icon className="w-5 h-5" />
            </div>
            <p className="text-2xl font-extrabold text-dark">{value}</p>
            <p className="text-xs text-cx-gray mt-0.5">{label}</p>
          </Link>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Recent payments */}
        <div className="cx-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-dark">Derniers paiements</h2>
            <Link href="/admin/payments" className="text-xs text-primary hover:underline flex items-center gap-1">
              Voir tout <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {(recentPayments ?? []).length === 0 ? (
            <p className="text-sm text-cx-gray py-4 text-center">Aucun paiement pour l&apos;instant</p>
          ) : (
            <div className="flex flex-col gap-3">
              {(recentPayments ?? []).map((p: {
                id: string
                amount: number
                currency: string
                method: string
                created_at: string
                profiles: { full_name: string | null; email: string } | null
                courses: { title: string } | null
              }) => (
                <div key={p.id} className="flex items-center gap-3 py-2 border-b border-black/[0.05] last:border-0">
                  <div className="w-8 h-8 rounded-full bg-success/10 flex items-center justify-center text-success text-sm">
                    ✓
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-dark truncate">
                      {p.profiles?.full_name || p.profiles?.email}
                    </p>
                    <p className="text-xs text-cx-gray truncate">{p.courses?.title}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-dark">
                      {p.amount.toLocaleString('fr-FR')} FCFA
                    </p>
                    <p className="text-xs text-cx-gray capitalize">{p.method.replace('_', ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent users */}
        <div className="cx-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-dark">Nouveaux utilisateurs</h2>
            <Link href="/admin/users" className="text-xs text-primary hover:underline flex items-center gap-1">
              Voir tout <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {(recentUsers ?? []).length === 0 ? (
            <p className="text-sm text-cx-gray py-4 text-center">Aucun utilisateur pour l&apos;instant</p>
          ) : (
            <div className="flex flex-col gap-3">
              {(recentUsers ?? []).map((u: {
                id: string
                full_name: string | null
                email: string
                platform_role: string
                created_at: string
              }) => (
                <div key={u.id} className="flex items-center gap-3 py-2 border-b border-black/[0.05] last:border-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {(u.full_name || u.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-dark truncate">
                      {u.full_name || u.email}
                    </p>
                    <p className="text-xs text-cx-gray">{u.email}</p>
                  </div>
                  <span className={`cx-badge text-[11px] ${u.platform_role === 'super_admin' ? 'bg-secondary/10 text-secondary-dark' : u.platform_role === 'consultant' ? 'bg-primary/10 text-primary' : 'bg-light text-cx-gray'}`}>
                    {u.platform_role === 'super_admin' ? 'Admin' : u.platform_role === 'consultant' ? 'Consultant' : 'Utilisateur'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="mt-6 cx-card p-5">
        <h2 className="font-bold text-dark mb-4">Actions rapides</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/admin/courses/new" className="px-4 py-2.5 bg-secondary text-white text-sm font-semibold rounded-cx hover:bg-secondary-dark transition-colors">
            + Nouvelle formation
          </Link>
          <Link href="/admin/modules/new" className="px-4 py-2.5 bg-light text-dark text-sm font-semibold rounded-cx hover:bg-light/70 transition-colors">
            + Nouveau module
          </Link>
          <Link href="/admin/users" className="px-4 py-2.5 bg-light text-dark text-sm font-semibold rounded-cx hover:bg-light/70 transition-colors">
            Gérer les utilisateurs
          </Link>
          <Link href="/admin/enrollments" className="px-4 py-2.5 bg-light text-dark text-sm font-semibold rounded-cx hover:bg-light/70 transition-colors">
            Voir les inscriptions
          </Link>
        </div>
      </div>
    </div>
  )
}
