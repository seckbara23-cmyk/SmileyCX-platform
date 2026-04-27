import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import type { Profile } from '@/types/cx'
import type { OrganizationMembership, Organization } from '@/types/cx'

// ── Get the current authenticated user profile ────────────────────────────────
// Redirects to /login if not authenticated
export async function requireAuth(): Promise<Profile> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')
  return profile as Profile
}

// ── Get current user's org memberships ───────────────────────────────────────
export async function getUserMemberships(userId: string): Promise<OrganizationMembership[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('organization_memberships')
    .select('*, organization:organizations(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  return (data ?? []) as OrganizationMembership[]
}

// ── Require org membership — redirects if not a member ───────────────────────
export async function requireOrgMembership(
  userId: string,
  orgSlug: string
): Promise<{ org: Organization; membership: OrganizationMembership }> {
  const supabase = await createClient()

  const { data: org } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', orgSlug)
    .single()

  if (!org) redirect('/app/orgs')

  const { data: membership } = await supabase
    .from('organization_memberships')
    .select('*')
    .eq('org_id', org.id)
    .eq('user_id', userId)
    .single()

  if (!membership) redirect('/app/orgs')

  return { org: org as Organization, membership: membership as OrganizationMembership }
}

// ── Require platform admin role — uses scx_admin cookie (bypasses Supabase session) ──
export async function requirePlatformAdmin(): Promise<Profile> {
  const cookieStore = await cookies()
  const adminUserId = cookieStore.get('scx_admin')?.value
  if (!adminUserId) {
    console.warn('[requirePlatformAdmin] No scx_admin cookie — redirecting to login')
    redirect('/admin/login')
  }

  const { data: profile, error: profileErr } = await createAdminClient()
    .from('profiles')
    .select('*')
    .eq('id', adminUserId)
    .single()

  if (profileErr) {
    console.error('[requirePlatformAdmin] Profile fetch error:', profileErr.message, '| userId:', adminUserId)
    redirect('/admin/login')
  }

  const platformRole = (profile?.platform_role as string | null)?.trim()
  if (!profile || platformRole !== 'super_admin') {
    console.error(
      '[requirePlatformAdmin] Access denied — userId:', adminUserId,
      '| platform_role:', JSON.stringify(profile?.platform_role),
      '| trimmed:', JSON.stringify(platformRole)
    )
    redirect('/admin/login')
  }
  return profile as Profile
}

// ── Get full session context (profile + memberships) ─────────────────────────
export async function getSessionContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const [profileRes, membershipsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase
      .from('organization_memberships')
      .select('*, organization:organizations(*)')
      .eq('user_id', user.id),
  ])

  return {
    user,
    profile: profileRes.data as Profile | null,
    memberships: (membershipsRes.data ?? []) as OrganizationMembership[],
  }
}
