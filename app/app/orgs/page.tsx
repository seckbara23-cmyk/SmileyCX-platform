import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAuth, getUserMemberships } from '@/lib/auth/session'
import { Building2, Plus, ChevronRight } from 'lucide-react'
import { ORG_ROLE_LABELS } from '@/lib/permissions'
import type { OrgRole } from '@/types/cx'

export default async function OrgsPage() {
  const profile = await requireAuth()
  const memberships = await getUserMemberships(profile.id)

  if (memberships.length === 0) redirect('/app/onboarding')

  // If only one org, go straight there
  if (memberships.length === 1 && memberships[0].organization) {
    redirect(`/app/${memberships[0].organization.slug}/dashboard`)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-2xl font-extrabold text-gray-900">
            Smiley<span className="text-[#ff7b54]">CX</span>
          </p>
          <h1 className="text-xl font-bold text-gray-800 mt-4">Select your organization</h1>
          <p className="text-sm text-gray-400 mt-1">Choose the workspace you want to open</p>
        </div>

        <div className="flex flex-col gap-3">
          {memberships.map(m => {
            const org = m.organization
            if (!org) return null
            return (
              <Link
                key={org.id}
                href={`/app/${org.slug}/dashboard`}
                className="flex items-center gap-4 bg-white border border-gray-100 rounded-xl p-4 hover:border-[#4a6de5]/40 hover:shadow-sm transition-all group"
              >
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#4a6de5]/20 to-[#ff7b54]/20 flex items-center justify-center text-lg font-bold text-[#4a6de5] shrink-0">
                  {org.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{org.name}</p>
                  <p className="text-xs text-gray-400">
                    {ORG_ROLE_LABELS[m.role as OrgRole]} · {org.plan}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-[#4a6de5] transition-colors shrink-0" />
              </Link>
            )
          })}

          <Link
            href="/app/onboarding"
            className="flex items-center gap-4 border-2 border-dashed border-gray-200 rounded-xl p-4 text-gray-400 hover:border-[#4a6de5]/40 hover:text-[#4a6de5] transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-gray-50 flex items-center justify-center shrink-0">
              <Plus className="w-5 h-5" />
            </div>
            <span className="text-sm font-medium">Create new organization</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
