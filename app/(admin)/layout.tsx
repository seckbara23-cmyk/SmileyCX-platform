import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnerSession } from '@/lib/auth/owner'
import { isAdminHost, resolveHost } from '@/lib/hosts'
import {
  LayoutDashboard, BookOpen, Users, CreditCard, Award,
  FileQuestion, LogOut, ExternalLink, Layers, TrendingUp, GraduationCap, MessageSquare, Dumbbell,
} from 'lucide-react'

/**
 * Nav paths are relative to the admin root (CX-AUTH-2).
 *
 * On the private portal host they render clean — `/users` — because middleware
 * rewrites the portal path space into /admin. On the public host they are
 * prefixed back to `/admin/users`, where the admin UI still lives. Same pages
 * either way; only the visible URL differs.
 */
const ADMIN_NAV = [
  { href: '',               label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/users',         label: 'Utilisateurs',    icon: Users },
  { href: '/courses',       label: 'Formations',      icon: Layers },
  { href: '/modules',       label: 'Modules',         icon: BookOpen },
  { href: '/quizzes',       label: 'Quiz',            icon: FileQuestion },
  { href: '/exercises',     label: 'Exercices',       icon: Dumbbell },
  { href: '/progress',      label: 'Progression',     icon: TrendingUp },
  { href: '/enrollments',   label: 'Inscriptions',    icon: Award },
  { href: '/certificates',  label: 'Certificats',     icon: GraduationCap },
  { href: '/feedback',      label: 'Retours pilote',  icon: MessageSquare },
  { href: '/payments',      label: 'Paiements',       icon: CreditCard },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // ── Auth: verified Supabase session belonging to the configured owner ──
  // (CX-AUTH-1). Replaces the previous unsigned `scx_admin` cookie, whose
  // value was the admin's raw user UUID — possession alone granted access and
  // logout could not revoke it. Every admin PAGE and ACTION additionally calls
  // requirePlatformAdmin(); the middleware host boundary is not relied upon.
  const session = await getOwnerSession()
  if (!session) redirect('/login?error=forbidden')

  // Service client so a restrictive RLS policy cannot hide a legitimately
  // authenticated owner's own profile row.
  const { data: profile } = await createAdminClient()
    .from('profiles')
    .select('full_name, email')
    .eq('id', session.user.id)
    .single()

  const displayName = profile?.full_name || profile?.email || session.user.email || 'Admin'

  // CX-AUTH-2: on the private portal the dashboard lives at the host root, so
  // links carry no /admin prefix. On the public host they still need it.
  const navBase = isAdminHost(resolveHost(await headers())) ? '' : '/admin'

  return (
    <div className="flex h-[100dvh] bg-light overflow-hidden">

      {/* ── Sidebar ───────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 bg-[#0f1117] text-white flex flex-col overflow-y-auto">

        {/* Logo */}
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <p className="text-lg font-extrabold text-white">
            XP<span className="text-secondary"> Client</span>
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
              href={`${navBase}${href}` || '/'}
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
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-white/40 hover:text-red-400 transition-colors text-left"
            >
              <LogOut className="w-3.5 h-3.5" /> Déconnexion
            </button>
          </form>
          <p className="px-3 pt-1 text-[10px] text-white/20 truncate">{displayName}</p>
          <p className="px-3 pb-1 text-[9px] text-white/15 truncate">
            by Teranga Technologies
          </p>
        </div>
      </aside>

      {/* ── Main ──────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto bg-[#f8f9fc]">
        {children}
      </main>
    </div>
  )
}
