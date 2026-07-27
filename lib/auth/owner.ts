import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { isOwnerEmail, ownerEmails } from '@/lib/auth/owner-email'
import type { User } from '@supabase/supabase-js'

// Re-exported so server code has a single import site for owner concerns.
export { isOwnerEmail, ownerEmails }

/**
 * Administrator authorization (CX-AUTH-1).
 *
 * The administration portal authorizes a small, explicitly configured
 * allowlist of addresses. There is no role hierarchy and no instructor tier —
 * deliberately. Authorization is a single question: is the authenticated
 * Supabase user on the allowlist?
 *
 * The allowlist lives in ADMIN_OWNER_EMAILS (comma-separated) and is read
 * server-side only. It is never hardcoded in application code and never sent
 * to the client.
 *
 * SECURITY NOTE — why this replaced the previous `scx_admin` cookie:
 * that cookie's value was the admin's raw user UUID, unsigned and
 * unverifiable, so possession of the UUID was equivalent to admin access and
 * logout could not revoke it (CX-AUTH-0 finding F-3). Authorization now
 * derives from a real Supabase session, which is signed, refreshable and
 * revocable. A forged cookie proves nothing.
 */

export interface OwnerSession {
  user: User
}

/**
 * Resolve the current session and verify it belongs to the owner.
 * Returns null for anonymous callers AND for authenticated non-owners.
 *
 * Non-redirecting: use in API route handlers, where the correct response is a
 * status code rather than a redirect.
 */
export async function getOwnerSession(): Promise<OwnerSession | null> {
  const supabase = await createClient()

  // getUser() validates the JWT against Supabase rather than trusting the
  // cookie contents. Do not substitute getSession() here — that reads the
  // cookie without verifying it.
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null
  if (!isOwnerEmail(user.email)) return null

  return { user }
}

/** True when an authenticated session exists but is not the owner. */
export async function isAuthenticatedNonOwner(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return !!user && !isOwnerEmail(user.email)
}
