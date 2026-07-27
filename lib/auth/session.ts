import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnerSession } from '@/lib/auth/owner'
import { redirect } from 'next/navigation'
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

/**
 * Require the administration-portal owner (CX-AUTH-1).
 *
 * Called by all 41 admin page and server-action entry points, so it is the
 * single choke point for administration authorization. Server-side only —
 * never rely on middleware alone, because server actions can be invoked
 * directly without ever rendering the page that hosts them.
 *
 * Replaces the previous `scx_admin` cookie check. That cookie's value was the
 * admin's raw user UUID with no signature, so anyone who obtained or guessed
 * the value held permanent, unrevocable admin access (CX-AUTH-0 finding F-3).
 * Authorization now requires a verified Supabase session whose email is on the
 * ADMIN_OWNER_EMAILS allowlist. A forged cookie carries no session and is
 * rejected.
 */
export async function requirePlatformAdmin(): Promise<Profile> {
  const session = await getOwnerSession()

  if (!session) {
    // Identical redirect for anonymous and authenticated-non-owner callers:
    // never disclose whether an address is the owner. Non-owners are signed
    // out by the middleware boundary before reaching here.
    redirect('/login?error=forbidden')
  }

  // Profile row is still the return contract for existing callers. Read it with
  // the service client so a restrictive RLS policy cannot mask an owner who is
  // legitimately authenticated.
  const { data: profile } = await createAdminClient()
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single()

  if (!profile) {
    // Authenticated as the owner but no profile row: provisioning is incomplete.
    // Fail closed rather than fabricating one.
    console.error('[requirePlatformAdmin] Owner authenticated but profile row missing:', session.user.id)
    redirect('/login?error=forbidden')
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
