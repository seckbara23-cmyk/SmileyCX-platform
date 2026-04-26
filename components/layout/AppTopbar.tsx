'use client'
import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, ChevronDown, LogOut, Menu, Settings, User, Shield } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils/cn'
import { OrgSwitcher } from './OrgSwitcher'
import type { Profile, Organization, OrganizationMembership, OrgRole } from '@/types/cx'
import { ORG_ROLE_LABELS } from '@/lib/permissions'

interface AppTopbarProps {
  profile: Profile
  org: Organization
  memberships: OrganizationMembership[]
  role: OrgRole
  onMenuToggle?: () => void
}

export function AppTopbar({ profile, org, memberships, role, onMenuToggle }: AppTopbarProps) {
  const router    = useRouter()
  const supabase  = createClient()
  const [menuOpen, setMenuOpen] = useState(false)

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = (profile.full_name || profile.email)
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <header className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-3 sm:px-5 shrink-0">

      {/* Left: hamburger (mobile) + org switcher */}
      <div className="flex items-center gap-1 min-w-0">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuToggle}
          className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-50 transition-colors shrink-0"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <OrgSwitcher currentOrg={org} memberships={memberships} />
      </div>

      {/* Right: notifications + profile */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">

        {/* Notification bell */}
        <button className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors">
          <Bell className="w-[18px] h-[18px]" />
        </button>

        {/* Profile dropdown */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="flex items-center gap-1.5 sm:gap-2 pl-1 pr-1.5 sm:pr-2 py-1 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white text-xs font-bold shrink-0">
              {initials}
            </div>
            <div className="hidden sm:block text-left max-w-[120px]">
              <p className="text-xs font-semibold text-gray-800 leading-tight truncate">
                {profile.full_name || profile.email.split('@')[0]}
              </p>
              <p className="text-[10px] text-gray-400 leading-tight">{ORG_ROLE_LABELS[role]}</p>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 hidden sm:block" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                role="presentation"
                onClick={() => setMenuOpen(false)}
                onKeyDown={e => e.key === 'Escape' && setMenuOpen(false)}
              />
              {/* Dropdown anchored right, max-width constrained so it never overflows viewport */}
              <div className="absolute right-0 top-full mt-1.5 bg-white border border-gray-100 rounded-xl shadow-lg z-40 py-1 overflow-hidden w-[min(208px,calc(100vw-1rem))]">
                <div className="px-3 py-2.5 border-b border-gray-50">
                  <p className="text-xs font-semibold text-gray-800 truncate">{profile.email}</p>
                  <p className="text-[11px] text-gray-400 truncate">{ORG_ROLE_LABELS[role]} · {org.name}</p>
                </div>
                <Link
                  href={`/app/${org.slug}/settings`}
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Settings className="w-4 h-4 text-gray-400 shrink-0" /> Settings
                </Link>
                {profile.platform_role === 'super_admin' && (
                  <Link
                    href="/admin"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <Shield className="w-4 h-4 text-gray-400 shrink-0" /> Admin Panel
                  </Link>
                )}
                <Link
                  href="/app/orgs"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <User className="w-4 h-4 text-gray-400 shrink-0" /> Switch Organization
                </Link>
                <div className="border-t border-gray-50 mt-1 pt-1">
                  <button
                    onClick={handleSignOut}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <LogOut className="w-4 h-4 shrink-0" /> Sign out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
