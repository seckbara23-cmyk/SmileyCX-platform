import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnerSession } from '@/lib/auth/owner'
import { redirect } from 'next/navigation'
import type { Profile } from '@/types/cx'
import type { OrganizationMembership } from '@/types/cx'

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

// ── XPA-8 W2 ─────────────────────────────────────────────────────────────
//
// `getUserMemberships` and `requireOrgMembership` lived here and were used
// ONLY by the retired `/app/[orgSlug]` product. They are gone with it.
//
// `requireOrgMembership` is worth a note rather than a silent deletion: it
// read `organization_memberships` with no filter on `status`. After XPA-7
// added the PENDING/ACTIVE/REMOVED lifecycle that made it wrong — RLS lets a
// learner read their own membership row, so a REMOVED ex-employee would still
// have satisfied it and kept their organization access. Nothing else called
// it, so no caller inherited the bug, and the XPA-7 helpers (`is_org_member`,
// `has_org_role`) filter on ACTIVE in SQL. Deleting it removes the only
// membership check on the platform that ignored the lifecycle.

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
