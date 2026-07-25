#!/usr/bin/env node
/**
 * Deploy-time production configuration gate (HOTFIX-1, SEC-2 §2).
 *
 * WHY THIS EXISTS
 * The SEC-2 runtime check lives in instrumentation.ts and throws during server
 * start when public signup is open. That is correct policy but a poor place to
 * discover the problem: it turns an operator configuration mistake into a
 * whole-application 500, and — because it depends on an outbound fetch during
 * cold start — it is nondeterministic. In the HOTFIX-1 incident the identical
 * deployment failed closed when the fetch succeeded and booted normally when the
 * fetch timed out.
 *
 * Checking at DEPLOY time instead is strictly better:
 *   - deterministic: the build either passes or fails, once, with clear output;
 *   - fail-closed in the strongest sense: an insecure build never goes live, and
 *     Vercel keeps serving the previous good deployment instead of 500ing;
 *   - diagnosable: the operator sees the reason in the build log immediately.
 *
 * This does NOT replace the runtime check (which still catches a setting flipped
 * after deployment). It front-runs it.
 *
 * Usage:  npm run verify:prod-config
 * Exit 0 = safe to deploy, exit 1 = confirmed insecure, do not deploy.
 *
 * Policy on an unreadable setting matches the ratified SEC-2 policy: warn
 * loudly, do not block. A transient network fault must not stop a deployment.
 */

const ERR_SIGNUP_ENABLED    = 'SEC2_SIGNUP_ENABLED'
const ERR_SIGNUP_UNVERIFIED = 'SEC2_SIGNUP_UNVERIFIED'

const url     = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// Placeholder credentials are used by CI and local builds; there is no real
// project to interrogate, so skip rather than emit a misleading warning.
const isPlaceholder =
  !url || !anonKey || /placeholder|example\.com|localhost/i.test(url)

if (isPlaceholder) {
  console.log('• Skipping production Auth config check (no real Supabase project configured).')
  process.exit(0)
}

/**
 * Probe the setting. Returns 'secure' | 'insecure' | 'unknown'.
 * The timer is always cleared before returning so no libuv handle is still
 * closing when the process exits (exiting mid-flight aborts on Windows).
 */
async function probe() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return { status: 'unknown', detail: `settings endpoint returned ${res.status}` }

    const body = await res.json()
    if (typeof body.disable_signup !== 'boolean') {
      return { status: 'unknown', detail: 'payload did not include disable_signup' }
    }
    return body.disable_signup ? { status: 'secure' } : { status: 'insecure' }
  } catch (e) {
    return { status: 'unknown', detail: e.message }
  } finally {
    clearTimeout(timer)
  }
}

const result = await probe()

if (result.status === 'unknown') {
  console.warn(`⚠ [${ERR_SIGNUP_UNVERIFIED}] Could not verify disable_signup (${result.detail}). Check the Supabase Dashboard manually.`)
  // Ratified SEC-2 policy: an unreadable setting warns, it does not block.
  process.exitCode = 0
} else if (result.status === 'secure') {
  console.log('✓ Auth configuration verified: public self-registration is disabled.')
  process.exitCode = 0
} else {
  console.error(
    `\n✗ [${ERR_SIGNUP_ENABLED}] DEPLOYMENT BLOCKED\n\n` +
    '  Public self-registration is ENABLED on this Supabase project\n' +
    '  (auth settings report disable_signup: false).\n\n' +
    '  XP Client Academy is invite-only: accounts must be provisioned by an\n' +
    '  administrator. Deploying in this state would leave anyone able to create\n' +
    '  an account by calling the Supabase Auth API directly.\n\n' +
    '  Fix (operator action, Supabase Dashboard — cannot be done from code):\n' +
    '    Authentication → Sign In / Providers → Email →\n' +
    '    turn OFF "Allow new users to sign up", then redeploy.\n\n' +
    '  Verify with:\n' +
    '    curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup\n' +
    '    → must print true\n\n' +
    '  Reference: docs/security/sec-2-remediation.md (production checklist)\n'
  )
  process.exitCode = 1
}
