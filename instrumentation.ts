/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * SEC-2 §2 / HOTFIX-3: validate the external Supabase Auth configuration at
 * startup and report it. The platform is invite-only; running with
 * `disable_signup: false` would silently re-open the exact hole that produced
 * the SEC-1 incident.
 *
 * THIS HOOK MUST NEVER THROW.
 *
 * Anything thrown here fails Next.js server *preparation*, which takes down
 * every route in the application — not just the one being requested. That is
 * exactly what happened in HOTFIX-1 and HOTFIX-2, where a configuration
 * mistake presented as "/courses returns 500" and a nonexistent slug returned
 * 500 instead of 404.
 *
 * Enforcement lives at deploy time instead (scripts/security/verify-prod-config.mjs),
 * where it is deterministic and blocks the build before it can ship. Here we
 * observe and report: fatal log with a stable code, and /api/health reports
 * `degraded`. See lib/security/auth-config.ts for the full rationale.
 */
export async function register() {
  // Only the Node.js server runtime performs the check; the edge runtime does
  // not boot the app and would repeat the probe on every invocation.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    const { assertSignupDisabled } = await import('@/lib/security/auth-config')
    await assertSignupDisabled()
  } catch (e) {
    // assertSignupDisabled() is already non-throwing by contract. This catch is
    // a structural backstop so that no future change here — or a failure to
    // even load the module — can ever brick server preparation again.
    console.error(
      '[SEC2_STARTUP_CHECK_FAILED] Auth configuration check did not complete; continuing to serve.',
      (e as Error)?.message
    )
  }
}
