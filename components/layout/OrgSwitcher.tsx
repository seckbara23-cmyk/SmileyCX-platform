'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, Building2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Organization, OrganizationMembership } from '@/types/cx'

interface OrgSwitcherProps {
  currentOrg: Organization
  memberships: OrganizationMembership[]
}

export function OrgSwitcher({ currentOrg, memberships }: OrgSwitcherProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  function switchOrg(slug: string) {
    setOpen(false)
    router.push(`/app/${slug}/dashboard`)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center shrink-0">
          <Building2 className="w-3.5 h-3.5 text-primary" />
        </div>
        <span className="text-sm font-semibold text-gray-800 max-w-[160px] truncate">
          {currentOrg.name}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" role="presentation" onClick={() => setOpen(false)} onKeyDown={e => e.key === 'Escape' && setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 bg-white border border-gray-100 rounded-xl shadow-lg z-40 py-1 overflow-hidden w-[min(256px,calc(100vw-1rem))]">
            <p className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              Your Organizations
            </p>
            {memberships.map(m => {
              const org = m.organization
              if (!org) return null
              const isActive = org.id === currentOrg.id
              return (
                <button
                  key={org.id}
                  onClick={() => switchOrg(org.slug)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors',
                    isActive ? 'bg-primary/5' : ''
                  )}
                >
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                    {org.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-sm font-medium truncate',
                      isActive ? 'text-primary' : 'text-gray-800'
                    )}>
                      {org.name}
                    </p>
                    <p className="text-[11px] text-gray-400 capitalize">{m.role.replace('_', ' ')}</p>
                  </div>
                  {isActive && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                </button>
              )
            })}
            <div className="border-t border-gray-50 mt-1 pt-1">
              <button
                onClick={() => { setOpen(false); router.push('/app/onboarding') }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
              >
                <Plus className="w-4 h-4" /> Create new organization
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
