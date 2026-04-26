'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, MessageSquare, Map, Zap, BarChart2,
  Settings, ChevronLeft, ChevronRight, Building2, X
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Organization, OrgRole } from '@/types/cx'

interface NavItem {
  label: string
  href: string
  icon: React.ElementType
  minRole?: OrgRole
}

function getNavItems(orgSlug: string): NavItem[] {
  return [
    { label: 'Dashboard',  href: `/app/${orgSlug}/dashboard`,   icon: LayoutDashboard },
    { label: 'Feedback',   href: `/app/${orgSlug}/feedback`,    icon: MessageSquare },
    { label: 'Journeys',   href: `/app/${orgSlug}/journeys`,    icon: Map },
    { label: 'Actions',    href: `/app/${orgSlug}/actions`,     icon: Zap },
    { label: 'Reports',    href: `/app/${orgSlug}/reports`,     icon: BarChart2 },
    { label: 'Settings',   href: `/app/${orgSlug}/settings`,    icon: Settings, minRole: 'org_admin' as OrgRole },
  ]
}

interface AppSidebarProps {
  org: Organization
  role: OrgRole
  collapsed?: boolean
  onToggle?: () => void
  onMobileClose?: () => void
}

export function AppSidebar({ org, role, collapsed = false, onToggle, onMobileClose }: AppSidebarProps) {
  const pathname  = usePathname()
  const navItems  = getNavItems(org.slug)

  const roleRanks: Record<OrgRole, number> = {
    org_admin: 5, cx_manager: 4, team_manager: 3, analyst: 2, viewer: 1,
  }

  const visibleItems = navItems.filter(item => {
    if (!item.minRole) return true
    return roleRanks[role] >= roleRanks[item.minRole]
  })

  return (
    <aside className={cn(
      'flex flex-col bg-[#0f1117] border-r border-white/[0.06] transition-all duration-300 h-full',
      // On desktop: collapses to icon-only; on mobile: always full-width sidebar
      collapsed ? 'w-[60px] md:w-[60px]' : 'w-64 md:w-56'
    )}>

      {/* Logo row */}
      <div className={cn(
        'flex items-center border-b border-white/[0.06] shrink-0',
        collapsed ? 'px-3 py-4 justify-center' : 'px-4 py-4 gap-2.5'
      )}>
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-white leading-tight truncate">
                Smiley<span className="text-secondary">CX</span>
              </p>
              <p className="text-[10px] text-white/40 leading-tight truncate">{org.name}</p>
            </div>
            {/* Close button — mobile only */}
            {onMobileClose && (
              <button
                onClick={onMobileClose}
                className="md:hidden ml-auto p-1 rounded text-white/30 hover:text-white/70 transition-colors"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 overflow-y-auto">
        {visibleItems.map(({ label, href, icon: Icon }) => {
          const isActive = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              onClick={onMobileClose}
              className={cn(
                'flex items-center gap-3 mx-2 px-2.5 py-2.5 rounded-lg text-sm font-medium transition-colors group',
                collapsed ? 'justify-center' : '',
                isActive
                  ? 'bg-primary/20 text-primary'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
              )}
            >
              <Icon className={cn(
                'w-[18px] h-[18px] shrink-0',
                isActive ? 'text-primary' : ''
              )} />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          )
        })}
      </nav>

      {/* Collapse toggle — desktop only */}
      {onToggle && (
        <button
          onClick={onToggle}
          className={cn(
            'hidden md:flex items-center justify-center border-t border-white/[0.06] py-3',
            'text-white/30 hover:text-white/60 transition-colors text-xs gap-1.5',
            collapsed ? '' : 'px-4'
          )}
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4" />
            : <><ChevronLeft className="w-4 h-4" /><span>Collapse</span></>
          }
        </button>
      )}
    </aside>
  )
}
