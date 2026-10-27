// @vitest-environment node
/**
 * XP-SEC-02 — the UAT isolation gate, driven as a real process.
 *
 * The gate is spawned rather than imported, because its whole job is to decide
 * an exit code from an environment. Testing it in-process would test a
 * different thing.
 *
 * ── WHY EVERY VARIABLE IS PINNED EXPLICITLY ───────────────────────────────
 *
 * The script loads `.env.local` itself, exactly as the other gates in
 * `scripts/security/` do. So DELETING a variable from the child environment
 * does not hide it — the script reads it back off disk, and on this machine
 * `.env.local` holds PRODUCTION credentials. Every test therefore pins an
 * explicit value for every variable the gate reads, because a real value
 * always wins over the file. This is the same trap that made the
 * AUTH-LAUNCH-B1 mailer gate pass locally and fail in CI.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'

const SCRIPT = 'scripts/security/verify-uat-isolation.mjs'
const PRODUCTION_REF = 'eqoqcxkdcxeosjqaafhs'
const UAT_REF = 'hosteduatprojectref1'

/** A Supabase-shaped JWT carrying a chosen project ref. Signature is irrelevant. */
function keyFor(ref: string, role: 'anon' | 'service_role'): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ iss: 'supabase', ref, role, iat: 1, exp: 9999999999 }),
    'signature-not-checked',
  ].join('.')
}

/**
 * A key as the LOCAL stack mints one: a JWT with no `ref`, because it is not
 * issued for a hosted project. The default fixture uses these, so the happy
 * path represents a genuine local run rather than a hosted project that
 * merely happens not to be production.
 */
function localKey(role: 'anon' | 'service_role'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ iss: 'supabase-demo', role, exp: 9999999999 }),
    'signature-not-checked',
  ].join('.')
}

/**
 * Every variable the gate reads, pinned to a safe local default. A test
 * overrides only what it is about.
 */
function isolatedEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL:            'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:       localKey('anon'),
    SUPABASE_SERVICE_ROLE_KEY:           localKey('service_role'),
    PAYTECH_MODE:                        '',
    PAYTECH_PROD_API_KEY:                '',
    PAYTECH_PROD_API_SECRET:             '',
    PAYTECH_ALLOW_PRODUCTION:            '',
    PAYDUNYA_MODE:                       '',
    RESEND_API_KEY:                      '',
    EMAIL_DRY_RUN:                       'true',
    ANTHROPIC_API_KEY:                   '',
    ELEVENLABS_API_KEY:                  '',
    NEXT_PUBLIC_AI_COACH_ENABLED:        'false',
    NEXT_PUBLIC_AI_COACH_CLAUDE_ENABLED: 'false',
    NEXT_PUBLIC_AI_VOICE_ENABLED:        'false',
    ...over,
  }
}

function runGate(over: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, ...isolatedEnv(over) },
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ code: code ?? -1, out }))
  })
}

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-SEC-02 · the gate refuses production identity', () => {
  it('passes a genuinely isolated local stack', async () => {
    const { code, out } = await runGate()
    expect(code, out).toBe(0)
    expect(out).toMatch(/UAT isolation verified/)
  })

  it('refuses when the URL names the production project', async () => {
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    })
    expect(code).toBe(1)
    expect(out).toMatch(/NEXT_PUBLIC_SUPABASE_URL belongs to the PRODUCTION/)
  })

  it('refuses production keys pasted beside a LOCAL url — the real mistake', async () => {
    // The URL looks isolated. The credentials are production. A URL-only check
    // would pass this and every request would still hit production.
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_URL:      'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keyFor(PRODUCTION_REF, 'anon'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY belongs to the PRODUCTION/)
  })

  it('refuses a production SERVICE-ROLE key beside a local url', async () => {
    const { code, out } = await runGate({
      SUPABASE_SERVICE_ROLE_KEY: keyFor(PRODUCTION_REF, 'service_role'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/SUPABASE_SERVICE_ROLE_KEY belongs to the PRODUCTION/)
  })

  it('refuses an unidentifiable, non-loopback target rather than guessing', async () => {
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_URL:      'https://unknown.example.com',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'not-a-jwt',
      SUPABASE_SERVICE_ROLE_KEY:     'not-a-jwt',
    })
    expect(code).toBe(1)
    expect(out).toMatch(/No Supabase project could be identified/)
  })
})

describe('XP-SEC-02 · the gate refuses live money and live mail', () => {
  it.each([
    ['PAYTECH_MODE=prod',            { PAYTECH_MODE: 'prod' },                     /live payment credentials/],
    ['PAYTECH_PROD_API_KEY set',     { PAYTECH_PROD_API_KEY: 'x' },                /PAYTECH_PROD_API_KEY is present/],
    ['PAYTECH_PROD_API_SECRET set',  { PAYTECH_PROD_API_SECRET: 'x' },             /PAYTECH_PROD_API_SECRET is present/],
    ['PAYTECH_ALLOW_PRODUCTION',     { PAYTECH_ALLOW_PRODUCTION: 'true' },         /production alone/],
    ['PAYDUNYA_MODE=live',           { PAYDUNYA_MODE: 'live' },                    /live payment credentials/],
  ])('refuses %s', async (_label, over, pattern) => {
    const { code, out } = await runGate(over as Record<string, string>)
    expect(code).toBe(1)
    expect(out).toMatch(pattern as RegExp)
  })

  it('refuses a live mailer', async () => {
    const { code, out } = await runGate({ RESEND_API_KEY: 'x', EMAIL_DRY_RUN: 'false' })
    expect(code).toBe(1)
    expect(out).toMatch(/would send real email/)
  })

  it('allows the mailer key when dry-run is on', async () => {
    const { code, out } = await runGate({ RESEND_API_KEY: 'x', EMAIL_DRY_RUN: 'true' })
    expect(code, out).toBe(0)
  })

  it.each([
    ['AI coach',  { ANTHROPIC_API_KEY: 'x', NEXT_PUBLIC_AI_COACH_ENABLED: 'true' }],
    ['AI claude', { ANTHROPIC_API_KEY: 'x', NEXT_PUBLIC_AI_COACH_CLAUDE_ENABLED: 'true' }],
    ['AI voice',  { ELEVENLABS_API_KEY: 'x', NEXT_PUBLIC_AI_VOICE_ENABLED: 'true' }],
  ])('refuses billable %s left enabled', async (_label, over) => {
    const { code, out } = await runGate(over as Record<string, string>)
    expect(code).toBe(1)
    expect(out).toMatch(/would spend real money/)
  })

  it('allows a billable key present but its feature disabled', async () => {
    const { code, out } = await runGate({
      ANTHROPIC_API_KEY: 'x', ELEVENLABS_API_KEY: 'x',
    })
    expect(code, out).toBe(0)
  })
})

describe('XP-SEC-02 · the gate never leaks a credential', () => {
  it('prints no key material, on success or on refusal', async () => {
    const anon = keyFor(PRODUCTION_REF, 'anon')
    const service = keyFor(PRODUCTION_REF, 'service_role')
    const { out } = await runGate({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
      SUPABASE_SERVICE_ROLE_KEY:     service,
      RESEND_API_KEY:                'resend-secret-value',
      ANTHROPIC_API_KEY:             'anthropic-secret-value',
    })
    for (const secret of [anon, service, 'resend-secret-value', 'anthropic-secret-value']) {
      expect(out).not.toContain(secret)
    }
  })

  it('the production ref is hard-coded, so configuration cannot disarm the gate', () => {
    const src = require('node:fs').readFileSync(SCRIPT, 'utf8') as string
    expect(src).toContain(`const PRODUCTION_PROJECT_REF = '${PRODUCTION_REF}'`)
    // It must not be read from the environment it is policing.
    expect(src).not.toMatch(/PRODUCTION_PROJECT_REF\s*=\s*(process\.env|env\[)/)
  })
})


// ═══════════════════════════════════════════════════════════════════════════
describe('XP-SEC-03 · a loopback URL demands local credentials', () => {
  /**
   * The production check alone leaves a gap: a key for some OTHER hosted
   * project — a colleague's, a staging one — beside a local URL would pass,
   * and every request would leave the machine.
   */
  const OTHER_HOSTED_REF = 'someotherprojectref1'

  it('refuses an anon key from another hosted project beside a local URL', async () => {
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_URL:      'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keyFor(OTHER_HOSTED_REF, 'anon'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/carries a hosted-project ref/)
    expect(out).toContain(OTHER_HOSTED_REF)
  })

  it('refuses a service-role key from another hosted project beside a local URL', async () => {
    const { code, out } = await runGate({
      SUPABASE_SERVICE_ROLE_KEY: keyFor(OTHER_HOSTED_REF, 'service_role'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/carries a hosted-project ref/)
  })

  it('still names PRODUCTION specifically, rather than the generic message', async () => {
    // The production rule must keep firing first and by name — the new check
    // must not have swallowed it into a vaguer error.
    const { code, out } = await runGate({
      SUPABASE_SERVICE_ROLE_KEY: keyFor(PRODUCTION_REF, 'service_role'),
    })
    expect(code).toBe(1)
    expect(out).toMatch(/SUPABASE_SERVICE_ROLE_KEY belongs to the PRODUCTION Supabase project/)
  })

  it('accepts keys with no ref claim, which is what a local stack mints', async () => {
    const noRef = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: 'supabase-demo', role: 'anon', exp: 9999999999 })).toString('base64url'),
      'sig',
    ].join('.')
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: noRef,
      SUPABASE_SERVICE_ROLE_KEY:     noRef.replace('anon', 'anon'),
    })
    expect(code, out).toBe(0)
  })

  it('leaves a hosted UAT project reachable when the URL is NOT loopback', async () => {
    // A future hosted UAT project is legitimate; the rule applies only to
    // loopback runs, so it must not block that path.
    const { code, out } = await runGate({
      NEXT_PUBLIC_SUPABASE_URL:      `https://${OTHER_HOSTED_REF}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: keyFor(OTHER_HOSTED_REF, 'anon'),
      SUPABASE_SERVICE_ROLE_KEY:     keyFor(OTHER_HOSTED_REF, 'service_role'),
    })
    expect(code, out).toBe(0)
  })
})
