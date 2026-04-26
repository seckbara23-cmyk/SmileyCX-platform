import { requireAuth, requireOrgMembership } from '@/lib/auth/session'
import { getOrgMembers } from '@/lib/queries/organizations'
import { canManageOrg, ORG_ROLE_LABELS } from '@/lib/permissions'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { redirect } from 'next/navigation'
import { Users, Building2, Crown } from 'lucide-react'
import type { OrgRole } from '@/types/cx'

interface PageProps {
  params: { orgSlug: string }
}

export default async function SettingsPage({ params }: PageProps) {
  const profile = await requireAuth()
  const { org, membership } = await requireOrgMembership(profile.id, params.orgSlug)

  if (!canManageOrg(membership.role as OrgRole)) {
    redirect(`/app/${params.orgSlug}/dashboard`)
  }

  const members = await getOrgMembers(org.id)

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-extrabold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-400 mt-0.5">Manage your organization and team</p>
      </div>

      {/* Org info */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-5">
        <div className="flex items-center gap-3 mb-2">
          <Building2 className="w-5 h-5 text-gray-400" />
          <h2 className="font-bold text-gray-800">Organization</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</p>
            <p className="text-sm font-medium text-gray-900 mt-1">{org.name}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Slug</p>
            <p className="text-sm font-mono text-gray-600 mt-1">{org.slug}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan</p>
            <div className="mt-1">
              <StatusBadge status={org.plan} />
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Industry</p>
            <p className="text-sm text-gray-600 mt-1 capitalize">{org.industry ?? '—'}</p>
          </div>
        </div>
      </div>

      {/* Team members */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-50">
          <Users className="w-5 h-5 text-gray-400" />
          <h2 className="font-bold text-gray-800">Team Members</h2>
          <span className="ml-auto text-xs text-gray-400">{members.length} member{members.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="divide-y divide-gray-50">
          {members.map(m => {
            const memberProfile = m.profile as { id: string; full_name: string | null; email: string } | undefined
            const name = memberProfile?.full_name || memberProfile?.email || 'Unknown'
            const initials = name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()
            const isCurrentUser = m.user_id === profile.id
            return (
              <div key={m.id} className="flex items-center gap-4 px-6 py-4">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#4a6de5]/20 to-[#ff7b54]/20 flex items-center justify-center text-sm font-bold text-[#4a6de5] shrink-0">
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                    {isCurrentUser && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">You</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 truncate">{memberProfile?.email}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {m.role === 'org_admin' && <Crown className="w-3.5 h-3.5 text-yellow-500" />}
                  <span className="text-xs font-medium text-gray-600">
                    {ORG_ROLE_LABELS[m.role as OrgRole]}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
