'use server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Authenticate the platform admin.
 *
 * The username is mapped to the real admin email server-side using
 * ADMIN_USERNAME / ADMIN_EMAIL env vars — the email is never exposed to
 * the client, so the request travels as username + password only.
 */
export async function adminLogin(
  username: string,
  password: string,
): Promise<{ error: string } | { success: true }> {
  // ── Validate env config ──────────────────────────────────────────────
  const adminUsername = process.env.ADMIN_USERNAME
  const adminEmail    = process.env.ADMIN_EMAIL

  if (!adminUsername || !adminEmail) {
    return { error: 'Platform admin is not configured. Set ADMIN_USERNAME and ADMIN_EMAIL in .env.local.' }
  }

  // ── Username check (case-insensitive) ────────────────────────────────
  if (username.trim().toLowerCase() !== adminUsername.trim().toLowerCase()) {
    return { error: 'Invalid credentials.' }
  }

  // ── Authenticate with Supabase using the real admin email ────────────
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email:    adminEmail,
    password: password.trim(),
  })

  if (error || !data?.user) {
    return { error: 'Invalid credentials.' }
  }

  // ── Verify the account actually has super_admin platform role ─────────
  // Use the service role client so this query is never blocked by RLS,
  // regardless of the session cookie state within this server action.
  const adminClient = createAdminClient()
  const { data: profile } = await adminClient
    .from('profiles')
    .select('platform_role')
    .eq('id', data.user.id)
    .single()

  if (profile?.platform_role !== 'super_admin') {
    // Sign out and reject — this Supabase account is not the platform admin
    await supabase.auth.signOut()
    return { error: 'Account does not have platform admin access.' }
  }

  // ── Success ───────────────────────────────────────────────────────────
  return { success: true }
}
