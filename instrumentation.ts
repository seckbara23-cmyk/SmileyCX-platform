/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * SEC-2 §2: validate the external Supabase Auth configuration at startup and
 * fail loudly if public self-registration is still enabled. The platform is
 * invite-only; running with `disable_signup: false` would silently re-open the
 * exact hole that produced the SEC-1 incident.
 *
 * assertSignupDisabled() throws only when the setting is CONFIRMED insecure and
 * NODE_ENV is production. An unreachable settings endpoint is logged at error
 * level but does not prevent boot (see lib/security/auth-config.ts for why).
 */
export async function register() {
  // Only the Node.js server runtime performs the check; the edge runtime does
  // not boot the app and would repeat the probe on every invocation.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertSignupDisabled } = await import('@/lib/security/auth-config')
  await assertSignupDisabled()
}
