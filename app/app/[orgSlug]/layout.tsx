import { requireAuth, getUserMemberships, requireOrgMembership } from '@/lib/auth/session'
import { AppShellClient } from '@/components/layout/AppShellClient'

interface LayoutProps {
  children: React.ReactNode
  params: { orgSlug: string }
}

export default async function OrgLayout({ children, params }: LayoutProps) {
  const profile = await requireAuth()
  const [memberships, { org, membership }] = await Promise.all([
    getUserMemberships(profile.id),
    requireOrgMembership(profile.id, params.orgSlug),
  ])

  return (
    <AppShellClient
      profile={profile}
      org={org}
      memberships={memberships}
      role={membership.role}
    >
      {children}
    </AppShellClient>
  )
}
