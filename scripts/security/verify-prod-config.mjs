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

// ══ Mailer configuration gate (AUTH-LAUNCH-B1) ═══════════════════════
//
// WHY THIS EXISTS
// `lib/email` treats a MISSING mailer key as dry-run:
//
//   DRY_RUN = process.env.EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY
//
// and the dry-run branch returns `{ success: true }` — the same value a real
// send returns. There is no `skipped` or `dryRun` field to tell them apart, so a
// production deployment with no key does this, silently:
//
//   registerLearner -> createUser(email_confirm: false)   account is unconfirmed
//                   -> dispatchVerificationEmail -> true  nothing was sent
//                   -> audit verificationSent: true       the log asserts success
//                   -> learner told to check their inbox  nothing will arrive
//
// GoTrue then refuses password sign-in for an unconfirmed user, so every
// registration produces an account that can never be used, and the only trace
// is one log.info line. AUTH-UAT-01 raised this as blocker B1.
//
// WHY A DEPLOY-TIME GATE, AND WHY `VERCEL_ENV`
//
// Public registration is NOT feature-flagged here. Supabase's `disable_signup`
// stays true permanently — that closes Supabase's OWN endpoint, not ours — and
// AUTH-02 made `/signup` reachable in every PLATFORM_MODE. So "is public signup
// enabled" is always yes, and the only question left is "is this the deployment
// real learners reach".
//
// NODE_ENV cannot answer that: `next build` sets it to 'production' for a local
// build and a preview build alike, so gating on it would fail `npm run build` on
// any developer machine without a mail key. VERCEL_ENV can: the platform sets
// it to production | preview | development, and it is absent locally and in CI.
//
// Preview deployments are deliberately NOT gated. They serve on *.vercel.app,
// which `isAdminHost` treats as the internal host, and `registerLearner` refuses
// a non-commercial host before creating anything — so a preview cannot register
// a learner and does not need a mailer. That is a boundary, not a gap.
//
// Reads variable PRESENCE only, never a value. No network.
{
  const present = name => {
    const v = process.env[name]
    return typeof v === 'string' && v.trim().length > 0
  }

  const isLiveDeployment = process.env.VERCEL_ENV === 'production'
  const hasKey    = present('RESEND_API_KEY')
  const dryRunOn  = process.env.EMAIL_DRY_RUN === 'true'
  const hasSender = present('EMAIL_FROM')

  const mailerFailures = []

  if (isLiveDeployment) {
    if (!hasKey) {
      mailerFailures.push(
        'RESEND_API_KEY is missing or blank.\n' +
        '    lib/email falls back to DRY RUN when the key is absent and still\n' +
        '    reports success, so every public registration would produce an\n' +
        '    account that can never be activated. Set RESEND_API_KEY in the\n' +
        '    Vercel Production environment.',
      )
    }
    if (dryRunOn) {
      mailerFailures.push(
        "EMAIL_DRY_RUN is set to 'true' on a production deployment.\n" +
        '    Verification email would be logged and discarded. Remove the\n' +
        '    variable, or set it to any other value, for Production.',
      )
    }
  }

  if (mailerFailures.length > 0) {
    console.error('\n✗ [MAILER_UNAVAILABLE] DEPLOYMENT BLOCKED\n')
    for (const f of mailerFailures) console.error(`  • ${f}\n`)
    console.error(
      '  Public registration is always enabled in this application, so a live\n' +
      '  deployment without a working mailer strands every learner it attracts.\n' +
      '  This gate checks variable PRESENCE only and never reads a value.\n',
    )
    process.exit(1)
  }

  if (!isLiveDeployment) {
    console.log(
      `• Mailer gate not enforced (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}) — ` +
      `local, CI and preview builds are exempt; key ${hasKey ? 'present' : 'absent'}.`,
    )
  } else if (!hasSender) {
    // Not a blocker: EMAIL_FROM has a deliberate fallback (decision register
    // Q-D) and a wrong sender fails LOUDLY — Resend returns an error, the send
    // returns { success: false }, and `verificationSent: false` is audited.
    // Unlike a missing key, that failure is visible. Warn, do not block.
    console.warn(
      '⚠ [MAILER_SENDER_DEFAULT] EMAIL_FROM is unset; lib/email will use its\n' +
      '  built-in sender. Resend only delivers from a domain it has verified —\n' +
      '  confirm that domain is verified, or set EMAIL_FROM to one that is.',
    )
    console.log('✓ Mailer configuration verified: key present, dry-run off.')
  } else {
    console.log('✓ Mailer configuration verified: key present, dry-run off, sender set.')
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

// ══ PayTech configuration gate (XP-PAYTECH-04) ═════════════════════════════
//
// The application refuses a PayTech mode that does not belong to its
// environment (lib/payments/providers.ts). This gate refuses the same
// configuration ONE STEP EARLIER — before it is ever built — and checks what
// the runtime cannot see: variables that merely sit there waiting. Like the
// PayDunya gate above it reads names and presence only, never a value, and
// needs no network, so it always runs.
//
//   production  (VERCEL_ENV=production):
//     * PAYTECH_MODE, when set, is 'prod'; no PAYTECH_TEST_* credential exists;
//     * no PAYTECH_CALLBACK_BASE_URL — production notifications go to the
//       canonical domain only (XP-PAYTECH-READY-01 E3);
//     * CRON_SECRET is set whenever PayTech is configured, or the
//       reconciliation sweep refuses to run and nothing reconciles.
//   everywhere else (preview, development, CI, local):
//     * PAYTECH_MODE is never 'prod'; no PAYTECH_PROD_* credential exists;
//       PAYTECH_ALLOW_PRODUCTION is not 'true'. Live money there would be a real
//       sale from an unreviewed build.
//     * a PAYTECH_CALLBACK_BASE_URL pin is absolute HTTPS and is not the
//       production domain.
//   always:
//     * no NEXT_PUBLIC_ variable names PayTech or the cron secret;
//     * the selected mode has both of its credentials;
//     * PAYTECH_CHECKOUT_ENABLED=true only with a mode set.
//   retired, reported but not blocking:
//     * PAYTECH_ENABLED (replaced by PAYTECH_CHECKOUT_ENABLED) and
//       NEXT_PUBLIC_PAYMENTS_ENABLED (no longer read by anything).
{
  const env = process.env
  const isProduction = (env.VERCEL_ENV ?? '').trim() === 'production'
  const present = name => typeof env[name] === 'string' && env[name].trim().length > 0
  const nameFor = (mode, suffix) => `PAYTECH_${mode.toUpperCase()}_${suffix}`
  const SUFFIXES = ['API_KEY', 'API_SECRET']
  const PRODUCTION_HOSTS = ['www.xpclient-academy.com', 'xpclient-academy.com']

  const failures = []
  const notes = []
  const rawMode = env.PAYTECH_MODE
  const mode = typeof rawMode === 'string' ? rawMode.trim() : ''
  const configured = mode.length > 0

  const publicLeaks = Object.keys(env).filter(
    k => k.startsWith('NEXT_PUBLIC_') && /PAYTECH|CRON_SECRET/i.test(k),
  )
  if (publicLeaks.length > 0) {
    failures.push(
      `PayTech or cron variables exposed to the browser: ${publicLeaks.join(', ')}.\n` +
      '    A NEXT_PUBLIC_ variable is inlined into the client bundle. Rename it and\n' +
      '    rotate the credential — treat it as compromised.',
    )
  }

  if (configured && !['test', 'prod'].includes(mode)) {
    failures.push("PAYTECH_MODE must be exactly 'test' or 'prod'. There is no default.")
  }

  if (configured && ['test', 'prod'].includes(mode)) {
    const missing = SUFFIXES.map(s => nameFor(mode, s)).filter(n => !present(n))
    if (missing.length > 0) {
      failures.push(
        `PAYTECH_MODE='${mode}' but ${missing.length} of 2 credentials for that mode are missing: ${missing.join(', ')}.`,
      )
    }
  }

  if (isProduction) {
    if (configured && mode !== 'prod') {
      failures.push(
        "This is production and PAYTECH_MODE is not 'prod'. PayTech's test mode debits\n" +
        '    100–150 CFA whatever the price and must not serve the public.',
      )
    }
    const testKeys = SUFFIXES.map(s => nameFor('test', s)).filter(present)
    if (testKeys.length > 0) {
      failures.push(`Test PayTech credentials are present in production: ${testKeys.join(', ')}. Remove them.`)
    }
    if (present('PAYTECH_CALLBACK_BASE_URL')) {
      failures.push(
        'PAYTECH_CALLBACK_BASE_URL is set in production. Production notifications must reach\n' +
        '    the canonical domain; the pin is for non-production deployments only.',
      )
    }
    if (configured && !present('CRON_SECRET')) {
      failures.push(
        'PayTech is configured in production but CRON_SECRET is not set: the reconciliation\n' +
        '    sweep would refuse to run, and a payment whose notification is lost would never settle.',
      )
    }
  } else {
    if (mode === 'prod') {
      failures.push(
        "PAYTECH_MODE='prod' outside production:\n" +
        '    live money taken there is a real sale from an unreviewed deployment.',
      )
    }
    const prodKeys = SUFFIXES.map(s => nameFor('prod', s)).filter(present)
    if (prodKeys.length > 0) {
      failures.push(`Live PayTech credentials are present outside production: ${prodKeys.join(', ')}. Remove them.`)
    }
    if ((env.PAYTECH_ALLOW_PRODUCTION ?? '').trim() === 'true') {
      failures.push("PAYTECH_ALLOW_PRODUCTION='true' outside production. That approval belongs to production alone.")
    }
    if (present('PAYTECH_CALLBACK_BASE_URL')) {
      let u = null
      try { u = new URL(env.PAYTECH_CALLBACK_BASE_URL.trim()) } catch { /* reported below */ }
      if (!u || u.protocol !== 'https:') {
        failures.push('PAYTECH_CALLBACK_BASE_URL must be an absolute https:// URL.')
      } else if (PRODUCTION_HOSTS.includes(u.hostname)) {
        failures.push(
          'PAYTECH_CALLBACK_BASE_URL points at the production domain from a non-production\n' +
          '    deployment: sandbox notifications would be delivered to production.',
        )
      }
    }
  }

  if ((env.PAYTECH_CHECKOUT_ENABLED ?? '').trim() === 'true' && !configured) {
    failures.push("PAYTECH_CHECKOUT_ENABLED='true' but PAYTECH_MODE is not set: checkout would offer a provider that cannot work.")
  }

  if (present('PAYTECH_ENABLED')) {
    notes.push('PAYTECH_ENABLED is set but no longer read (replaced by PAYTECH_CHECKOUT_ENABLED). Remove it.')
  }
  if (present('NEXT_PUBLIC_PAYMENTS_ENABLED')) {
    notes.push('NEXT_PUBLIC_PAYMENTS_ENABLED is set but no longer read: payment availability is decided on the server. Remove it.')
  }

  if (failures.length > 0) {
    console.error('\n✗ [PAYTECH_CONFIG] DEPLOYMENT BLOCKED\n')
    for (const f of failures) console.error(`  • ${f}\n`)
    console.error(
      '  Reference: XP-PAYTECH-04 (test/live separation, safeguard 4).\n' +
      '  No PayTech value is ever printed by this gate.\n',
    )
    process.exit(1)
  }
  for (const n of notes) console.warn(`⚠ [PAYTECH_CONFIG] ${n}`)

  if (!configured) {
    process.stdout.write('• PayTech not configured (PAYTECH_MODE unset) — PayTech inactive, nothing to verify.\n')
  } else {
    process.stdout.write(
      `✓ PayTech configuration verified: mode='${mode}' for ${isProduction ? 'production' : 'a non-production deployment'}, ` +
      `checkout ${(env.PAYTECH_CHECKOUT_ENABLED ?? '').trim() === 'true' ? 'enabled' : 'disabled'}.\n`,
    )
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
    "  Supabase's own signup endpoint is OPEN on this project\n" +
    '  (auth settings report disable_signup: false).\n\n' +
    '  AUTH-02: still a blocker, but NOT because registration is closed.\n' +
    '  Public student registration IS open and free. It runs through the\n' +
    '  server-owned registerLearner action, behind validation, a CAPTCHA seam,\n' +
    '  per-IP and per-email rate limits, versioned legal acceptance, auditing\n' +
    '  and server-side role assignment. Leaving /auth/v1/signup open lets\n' +
    '  anyone create an account by calling the Supabase Auth API directly,\n' +
    '  bypassing every one of those controls. That path is what SEC-1 was.\n\n' +
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
