'use client'
import { useState } from 'react'
import { AppSidebar } from './AppSidebar'
import { AppTopbar } from './AppTopbar'
import type { Organization, OrganizationMembership, Profile, OrgRole } from '@/types/cx'

interface AppShellClientProps {
  children: React.ReactNode
  profile: Profile
  org: Organization
  memberships: OrganizationMembership[]
  role: OrgRole
}

export function AppShellClient({ children, profile, org, memberships, role }: AppShellClientProps) {
  const [collapsed,   setCollapsed]   = useState(false)
  const [mobileOpen,  setMobileOpen]  = useState(false)

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-gray-50">

      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — always in DOM; transforms off-screen on mobile when closed */}
      <div className={`
        fixed inset-y-0 left-0 z-40 md:relative md:z-auto md:inset-auto
        transition-transform duration-300 ease-in-out shrink-0
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <AppSidebar
          org={org}
          role={role}
          collapsed={collapsed}
          onToggle={() => setCollapsed(c => !c)}
          onMobileClose={() => setMobileOpen(false)}
        />
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <AppTopbar
          profile={profile}
          org={org}
          memberships={memberships}
          role={role}
          onMenuToggle={() => setMobileOpen(o => !o)}
        />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
