import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  LayoutDashboard, BookOpen, Users, CreditCard, Award,
  FileQuestion, LogOut, ExternalLink, Layers, TrendingUp, GraduationCap,
} from 'lucide-react'

const ADMIN_NAV = [
  { href: '/admin',                label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/admin/users',          label: 'Utilisateurs',    icon: Users },
  { href: '/admin/courses',        label: 'Formations',      icon: Layers },
  { href: '/admin/modules',        label: 'Modules',         icon: BookOpen },
  { href: '/admin/quizzes',        label: 'Quiz',            icon: FileQuestion },
  { href: '/admin/progress',       label: 'Progression',     icon: TrendingUp },
  { href: '/admin/enrollments',    label: 'Inscriptions',    icon: Award },
  { href: '/admin/certificates',   label: 'Certificats',     icon: GraduationCap },
  { href: '/admin/payments',       label: 'Paiements',       icon: CreditCard },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // ── Auth: verify scx_admin cookie (set by /api/admin/login) ─────────
  const cookieStore = await cookies()
  const adminUserId = cookieStore.get('scx_admin')?.value
  if (!adminUserId) redirect('/admin/login')

  // ── SECURITY: verify platform_role via service client (bypasses RLS) ─
  const { data: profile } = await createAdminClient()
    .from('profiles')
    .select('platform_role, full_name, email')
    .eq('id', adminUserId)
    .single()

  if (!profile || profile.platform_role !== 'super_admin') {
    redirect('/admin/login')
  }

  const displayName = profile.full_name || profile.email || 'Admin'

  return (
    <div className="flex h-[100dvh] bg-light overflow-hidden">

      {/* ── Sidebar ───────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 bg-[#0f1117] text-white flex flex-col overflow-y-auto">

        {/* Logo */}
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <p className="text-lg font-extrabold text-white">
            Smiley<span className="text-secondary">CX</span>
          </p>
          <p className="text-[11px] text-white/40 mt-0.5 font-semibold uppercase tracking-wider">
            Administration
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-0.5">
          {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-white/60 hover:text-white hover:bg-white/[0.07] transition-colors"
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-white/[0.06] space-y-1">
          <Link
            href="/app/orgs"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" /> App
          </Link>
          <form action="/api/admin/signout" method="POST">
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-white/40 hover:text-red-400 transition-colors text-left"
            >
              <LogOut className="w-3.5 h-3.5" /> Déconnexion
            </button>
          </form>
          <p className="px-3 pt-1 text-[10px] text-white/20 truncate">{displayName}</p>
        </div>
      </aside>

      {/* ── Main ──────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto bg-[#f8f9fc]">
        {children}
      </main>
    </div>
  )
}
