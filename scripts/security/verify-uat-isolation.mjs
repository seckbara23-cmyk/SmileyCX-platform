#!/usr/bin/env node
/**
 * UAT isolation gate — XP-SEC-02 Phase 3.
 *
 * Refuses to let a local or UAT run start if it can reach production, or spend
 * real money, or send real email.
 *
 * ── WHY A URL CHECK IS NOT ENOUGH ─────────────────────────────────────────
 *
 * The obvious check is "is NEXT_PUBLIC_SUPABASE_URL pointing at production?".
 * That misses the mistake people actually make: pointing the URL at a local
 * stack while pasting the PRODUCTION anon and service-role keys next to it,
 * because those were already in the clipboard. The URL then looks isolated and
 * every request still carries production credentials.
 *
 * Supabase keys are JWTs whose payload carries a `ref` claim naming the
 * project they belong to. So this gate reads the project ref from THREE
 * independent places and refuses if ANY of them names production:
 *
 *      the URL hostname  ·  the anon key's `ref`  ·  the service key's `ref`
 *
 * The claim is read, never verified — we are not authenticating a token, we
 * are asking which project a credential belongs to. No key value is ever
 * printed, logged or compared against a stored secret.
 *
 * ── WHAT ELSE IT REFUSES ──────────────────────────────────────────────────
 *
 * Isolation is not only about the database. A UAT run must not move money or
 * reach a real inbox either, so live payment credentials, live outbound email
 * and enabled billable AI integrations are all refusals.
 *
 * Usage:  npm run verify:uat-isolation
 * Exit 0 = isolated, safe to run UAT.  Exit 1 = refused, with the reason.
 */

import { readFileSync, existsSync } from 'node:fs'

/**
 * The production Supabase project. Hard-coded on purpose: a gate that reads
 * the thing it is guarding against from configuration can be disarmed by
 * editing that configuration.
 */
const PRODUCTION_PROJECT_REF = 'eqoqcxkdcxeosjqaafhs'

// ── .env.local, as the other gates in this directory load it ───────────────
// Next.js loads it itself; a plain `npm run` does not. Real environment
// variables always win, so CI and Vercel are unaffected.
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    const [, key, raw] = m
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.trim().replace(/^['"]|['"]$/g, '')
  }
}

const env = process.env
const failures = []
const notes = []

/** Trimmed value, or null when absent or blank. */
function val(name) {
  const v = env[name]
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** The project ref inside a Supabase JWT, or null. Reads a claim; verifies nothing. */
function refFromKey(key) {
  if (!key) return null
  const parts = key.split('.')
  if (parts.length !== 3) return null
  try {
    const pad = '='.repeat((4 - (parts[1].length % 4)) % 4)
    const claims = JSON.parse(
      Buffer.from(parts[1] + pad, 'base64url').toString('utf8'),
    )
    return typeof claims?.ref === 'string' ? claims.ref : null
  } catch {
    return null
  }
}

/** The project ref in a Supabase URL hostname, or null. */
function refFromUrl(raw) {
  if (!raw) return null
  try {
    const host = new URL(raw).hostname
    const m = /^([a-z0-9]{16,})\.supabase\.(co|in)$/i.exec(host)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function isLoopback(raw) {
  if (!raw) return false
  try {
    const h = new URL(raw).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

// ── 1. production project identity, from three independent sources ─────────

const url = val('NEXT_PUBLIC_SUPABASE_URL')
const sources = [
  ['NEXT_PUBLIC_SUPABASE_URL',      refFromUrl(url)],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', refFromKey(val('NEXT_PUBLIC_SUPABASE_ANON_KEY'))],
  ['SUPABASE_SERVICE_ROLE_KEY',     refFromKey(val('SUPABASE_SERVICE_ROLE_KEY'))],
]

for (const [name, ref] of sources) {
  if (ref === null) continue
  if (ref === PRODUCTION_PROJECT_REF) {
    failures.push(
      `${name} belongs to the PRODUCTION Supabase project (${PRODUCTION_PROJECT_REF}). `
      + 'A UAT run must not be able to reach production.',
    )
  } else {
    notes.push(`${name} → project '${ref}' (not production)`)
  }
}

if (sources.every(([, ref]) => ref === null) && !isLoopback(url)) {
  failures.push(
    'No Supabase project could be identified from the URL or either key. '
    + 'Refusing rather than guessing: an unidentifiable target may be production.',
  )
}

/**
 * A loopback URL must be paired with LOCAL credentials — XP-SEC-03.
 *
 * The check above only catches the PRODUCTION project. That leaves a gap: a
 * key belonging to some OTHER hosted project — a colleague's, a staging one,
 * a former client's — sitting beside a local URL would pass, and every
 * request would leave the machine.
 *
 * A `ref` claim names a hosted Supabase project. Keys minted by the local CLI
 * stack are not issued for a hosted project, so a credential carrying a `ref`
 * has no business in a loopback run whichever project it names. Refusing is
 * therefore strictly safer than the production-only rule, and it does not
 * weaken it: the production check above still fires first and by name.
 *
 * ⚠ ASSUMPTION TO CONFIRM ON FIRST LOCAL START: that CLI-minted local keys
 * carry no `ref` claim. It could not be verified here because Docker is not
 * installed, so the stack has never run. If a legitimate local key does carry
 * one, this refuses and the message below says exactly what to do — a false
 * refusal that is visible and fixable, rather than a silent allow.
 */
if (isLoopback(url)) {
  for (const [name, ref] of sources) {
    if (name === 'NEXT_PUBLIC_SUPABASE_URL') continue
    if (ref !== null && ref !== PRODUCTION_PROJECT_REF) {
      failures.push(
        `${name} carries a hosted-project ref ('${ref}') while the URL is loopback. `
        + 'A local run must use the keys printed by `supabase status`. If a genuine '
        + 'local key does carry a ref, record it in LOCAL_PROJECT_REFS in this gate '
        + 'rather than removing this check.',
      )
    }
  }
}

/**
 * Refs that are known-good for a local stack. Empty until a real local start
 * proves one is needed — see the assumption above. Production can never be
 * added here: the check that rejects it runs first and is unconditional.
 */
const LOCAL_PROJECT_REFS = new Set()
void LOCAL_PROJECT_REFS

if (url && !isLoopback(url) && refFromUrl(url) !== PRODUCTION_PROJECT_REF) {
  notes.push(
    'NEXT_PUBLIC_SUPABASE_URL is not a loopback address. That is correct for a '
    + 'hosted UAT project and wrong for the local stack — confirm which you intend.',
  )
}

// ── 2. live payment credentials ────────────────────────────────────────────

if (val('PAYTECH_MODE') === 'prod') {
  failures.push("PAYTECH_MODE is 'prod'. A UAT run must never use live payment credentials.")
}
for (const name of ['PAYTECH_PROD_API_KEY', 'PAYTECH_PROD_API_SECRET']) {
  if (val(name)) failures.push(`${name} is present. Live PayTech credentials must not exist in UAT.`)
}
if (val('PAYTECH_ALLOW_PRODUCTION') === 'true') {
  failures.push("PAYTECH_ALLOW_PRODUCTION is 'true'. That flag belongs to production alone.")
}
if (val('PAYDUNYA_MODE') === 'live') {
  failures.push("PAYDUNYA_MODE is 'live'. A UAT run must never use live payment credentials.")
}

// ── 3. outbound email ──────────────────────────────────────────────────────

if (val('RESEND_API_KEY') && val('EMAIL_DRY_RUN') !== 'true') {
  failures.push(
    'RESEND_API_KEY is set and EMAIL_DRY_RUN is not \'true\', so a UAT run would send '
    + 'real email. Set EMAIL_DRY_RUN=true, or remove the key.',
  )
}

// ── 4. billable AI integrations ────────────────────────────────────────────

for (const [key, flag] of [
  ['ANTHROPIC_API_KEY',  'NEXT_PUBLIC_AI_COACH_ENABLED'],
  ['ANTHROPIC_API_KEY',  'NEXT_PUBLIC_AI_COACH_CLAUDE_ENABLED'],
  ['ELEVENLABS_API_KEY', 'NEXT_PUBLIC_AI_VOICE_ENABLED'],
]) {
  if (val(key) && val(flag) === 'true') {
    failures.push(
      `${key} is present and ${flag} is 'true', so a UAT run would spend real money `
      + `against that account. Disable ${flag} for UAT, or remove the key.`,
    )
  }
}

// ── report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('\n✗ [UAT_ISOLATION] REFUSED — this environment is not isolated\n')
  for (const f of failures) console.error(`  • ${f}\n`)
  console.error(
    '  Nothing was run. Fix the configuration above, or run against the local\n'
    + '  Supabase stack. See docs/security/xp-sec-02-local-uat.md.\n',
  )
  process.exit(1)
}

console.log('✓ UAT isolation verified — no production project identifier, no live')
console.log('  payment credentials, no outbound email, no billable AI integration.')
for (const n of notes) console.log(`  • ${n}`)
process.exit(0)
