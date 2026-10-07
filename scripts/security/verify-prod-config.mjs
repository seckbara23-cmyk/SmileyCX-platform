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

import { readFileSync, existsSync } from 'node:fs'

const ERR_SIGNUP_ENABLED    = 'SEC2_SIGNUP_ENABLED'
const ERR_SIGNUP_UNVERIFIED = 'SEC2_SIGNUP_UNVERIFIED'

/**
 * Load .env.local when present.
 *
 * Next.js loads .env.local itself, but plain `npm run verify:prod-config` does
 * not — so without this the script saw no credentials, reported "Skipping",
 * and exited 0. An enforcement gate that silently passes is worse than no gate.
 * On Vercel there is no .env.local and the platform populates process.env
 * directly, so this is a no-op there. Real environment variables always win.
 */
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    const key = t.slice(0, i).trim()
    if (process.env[key] === undefined) {
      process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
}

// ══ PayDunya configuration gate (PAY-LAUNCH-02A) ═══════════════════════════
//
// Deliberately placed BEFORE the Supabase placeholder short-circuit below. That
// check exits 0 when no real project is configured, which is right for an
// outbound probe but would silently skip these invariants on CI and local
// builds — exactly the environments where a stray LIVE credential is most
// likely to be introduced. These checks read only variable names and presence,
// never a value, so they are always safe to run and never depend on a network.
//
// INVARIANT FOR THE CURRENT TEST PHASE: LIVE PayDunya credentials must not be
// present at all. Absence is the control; a mode flag alone is not, because a
// flag can be flipped by one dashboard edit while the keys sit there waiting.
{
  const MODES = ['test', 'live']
  const SUFFIXES = ['MASTER_KEY', 'PRIVATE_KEY', 'TOKEN']
  const nameFor = (mode, suffix) => `PAYDUNYA_${mode.toUpperCase()}_${suffix}`
  const present = name => {
    const v = process.env[name]
    return typeof v === 'string' && v.trim().length > 0
  }
  const names = mode => SUFFIXES.map(s => nameFor(mode, s))
  const countPresent = mode => names(mode).filter(present).length

  const failures = []
  const rawMode = process.env.PAYDUNYA_MODE
  const mode = typeof rawMode === 'string' ? rawMode.trim() : undefined
  const configured = mode !== undefined && mode.length > 0

  // 1. A PayDunya credential must never be exposed to the browser.
  const publicLeaks = Object.keys(process.env).filter(
    k => k.startsWith('NEXT_PUBLIC_') && /PAYDUNYA/i.test(k),
  )
  if (publicLeaks.length > 0) {
    failures.push(
      `PayDunya variables exposed to the browser: ${publicLeaks.join(', ')}.\n` +
      '    A NEXT_PUBLIC_ variable is inlined into the client bundle. Rename to a\n' +
      '    server-only name and rotate the credential — treat it as compromised.',
    )
  }

  // 2. Invalid mode. Not configured at all is fine: payments are not live yet.
  if (configured && !MODES.includes(mode)) {
    failures.push(
      `PAYDUNYA_MODE must be exactly 'test' or 'live'.\n` +
      '    Refusing to interpret the configured value. There is no default.',
    )
  }

  // 3. The selected mode needs all three of ITS credentials.
  if (configured && MODES.includes(mode)) {
    const missing = names(mode).filter(n => !present(n))
    if (missing.length > 0) {
      failures.push(
        `PAYDUNYA_MODE='${mode}' but ${missing.length} of 3 credentials for that mode\n` +
        `    are missing: ${missing.join(', ')}.\n` +
        '    A partial credential set is never usable.',
      )
    }
  }

  // 4. THE TEST-PHASE INVARIANT: a LIVE credential may exist ONLY when the mode
  //    is explicitly 'live'. That covers PAYDUNYA_MODE='test' and an unset mode
  //    alike — a live key sitting in the environment is one dashboard edit away
  //    from charging real money, whatever the flag currently says, so its mere
  //    PRESENCE is refused rather than its use.
  const liveCount = countPresent('live')
  if (mode !== 'live' && liveCount > 0) {
    failures.push(
      `LIVE PayDunya credentials are present while PAYDUNYA_MODE is ` +
      `${configured ? `'${mode}'` : 'unset'}: ${names('live').filter(present).join(', ')}.\n` +
      '    CX Academy is in the PayDunya TEST phase. Remove them until LIVE\n' +
      '    activation is approved — presence alone is the risk, not use.',
    )
  }

  if (failures.length > 0) {
    console.error('\n✗ [PAYDUNYA_CONFIG] DEPLOYMENT BLOCKED\n')
    for (const f of failures) console.error(`  • ${f}\n`)
    console.error(
      '  Reference: PAY-LAUNCH-01 architecture audit (TEST → LIVE separation).\n' +
      '  No PayDunya value is ever printed by this gate.\n',
    )
    process.exit(1)
  }

  if (!configured) {
    console.log('• PayDunya not configured (PAYDUNYA_MODE unset) — payments inactive, nothing to verify.')
  } else {
    console.log(`✓ PayDunya configuration verified: mode='${mode}', ${countPresent(mode)}/3 credentials for that mode, 0 live credentials present.`)
  }
}

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
