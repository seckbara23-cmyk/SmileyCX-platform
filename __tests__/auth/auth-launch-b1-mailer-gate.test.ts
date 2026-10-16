// @vitest-environment node
/**
 * AUTH-LAUNCH-B1 — the mailer cannot fail silently on a live deployment.
 *
 * ── THE BLOCKER ───────────────────────────────────────────────────────────
 *
 * `lib/email` treats a MISSING key as dry-run:
 *
 *   DRY_RUN = process.env.EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY
 *
 * and the dry-run branch returns `{ success: true }` — the same value a real
 * send returns, with no `skipped` or `dryRun` field to tell them apart. A
 * production deployment with no key therefore: creates the account unconfirmed,
 * reports the verification email as sent, audits `verificationSent: true`, and
 * tells the learner to check an inbox nothing will arrive in. GoTrue then
 * refuses password sign-in for an unconfirmed user, so the account can never be
 * used. AUTH-UAT-01 raised this as blocker B1.
 *
 * ── WHY THESE TESTS MOCK THE PROVIDER, NOT THE MODULE ─────────────────────
 *
 * Before this file, the only test touching `lib/email` was
 * `auth-02-registration-behaviour.test.ts`, which does
 * `vi.mock('@/lib/email', …)` — it replaces the module wholesale and hard-codes
 * the ambiguous `{ success: true }`. So the dry-run masquerade, the provider
 * error branch, the exception branch and the sender header were covered by
 * nothing: `sendEmail` and `sendVerificationEmail` were never once invoked in
 * the repository.
 *
 * Here the seam is the `resend` PACKAGE. Everything inside `lib/email` — the
 * DRY_RUN predicate, the FROM resolution, both failure branches, the template
 * composition — is the real code under test.
 *
 * DRY_RUN and FROM are module-load-time constants, so every case sets the
 * environment, resets the module registry, and re-imports. No test sends mail:
 * the provider is a stub and is asserted on for call count.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { spawnSync, spawn } from 'child_process'
import { createServer } from 'node:http'
import { join } from 'path'

// ── the provider boundary, and nothing above it ────────────────────────────

interface SendCall { from: string; to: string; subject: string; html: string; text: string }

const provider = {
  calls: [] as SendCall[],
  /** What `resend.emails.send` resolves to, or throws. */
  result: { data: { id: 'msg_1' }, error: null } as unknown,
  throws: null as Error | null,
  /** Constructed with the API key — proves the key reaches the client. */
  constructedWith: [] as string[],
}

vi.mock('resend', () => ({
  Resend: class {
    constructor(key: string) { provider.constructedWith.push(key) }
    emails = {
      send: async (p: SendCall) => {
        provider.calls.push(p)
        if (provider.throws) throw provider.throws
        return provider.result
      },
    }
  },
}))

const ORIGINAL_ENV = { ...process.env }

/** Load the REAL module under a chosen environment. */
async function loadEmail(env: Record<string, string | undefined>) {
  for (const k of ['RESEND_API_KEY', 'EMAIL_DRY_RUN', 'EMAIL_FROM']) delete process.env[k]
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  return import('@/lib/email')
}

const VERIFY_DATA = { firstName: 'Awa', verifyUrl: 'https://www.xpclient-academy.com/auth/verify?token_hash=abc&type=signup' }

beforeEach(() => {
  provider.calls = []
  provider.constructedWith = []
  provider.result = { data: { id: 'msg_1' }, error: null }
  provider.throws = null
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-LAUNCH-B1 · 1. lib/email, real code, provider stubbed', () => {
  it('MISSING API KEY → dry run: nothing is sent, yet success is reported', async () => {
    // This is the defect itself, pinned. The gate in section 2 is what prevents
    // this configuration reaching a live deployment; the behaviour here is
    // deliberate for local development and must not change silently.
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: undefined })
    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(provider.calls, 'the provider was called without a key').toHaveLength(0)
    expect(provider.constructedWith).toHaveLength(0)
    expect(r.success, 'dry run no longer reports success — the gate assumes it does').toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('EXPLICIT dry run → nothing is sent even when a key is present', async () => {
    const { sendVerificationEmail } = await loadEmail({
      RESEND_API_KEY: 'test-key-not-a-real-credential', EMAIL_DRY_RUN: 'true',
    })
    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(provider.calls).toHaveLength(0)
    expect(r.success).toBe(true)
  })

  it("EMAIL_DRY_RUN must be the literal 'true' — anything else sends", async () => {
    const { sendVerificationEmail } = await loadEmail({
      RESEND_API_KEY: 'test-key-not-a-real-credential', EMAIL_DRY_RUN: 'false',
    })
    await sendVerificationEmail('learner@example.com', VERIFY_DATA)
    expect(provider.calls, "'false' was treated as dry-run").toHaveLength(1)
  })

  it('SUCCESSFUL provider response → one send, success reported', async () => {
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: 'test-key-not-a-real-credential' })
    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(provider.calls).toHaveLength(1)
    expect(r).toEqual({ success: true })
  })

  it('PROVIDER REJECTION → failure is reported, not swallowed', async () => {
    provider.result = { data: null, error: { message: 'Domain is not verified' } }
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: 'test-key-not-a-real-credential' })
    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(provider.calls).toHaveLength(1)
    expect(r.success, 'a rejected send reported success').toBe(false)
    expect(r.error).toBe('Domain is not verified')
  })

  it('PROVIDER EXCEPTION → caught, failure reported, no throw escapes', async () => {
    provider.throws = new Error('socket hang up')
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: 'test-key-not-a-real-credential' })

    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('a failure NEVER echoes the credential', async () => {
    const SECRET = 'test-key-sentinel-must-not-leak'
    provider.throws = new Error(`auth failed for ${SECRET}`)
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: SECRET })
    const r = await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(r.success).toBe(false)
    expect(JSON.stringify(r), 'the API key reached the caller').not.toContain(SECRET)
  })

  it('MISSING sender config → the built-in fallback is used, and it is a real address', async () => {
    const { sendVerificationEmail } = await loadEmail({
      RESEND_API_KEY: 'test-key-not-a-real-credential', EMAIL_FROM: undefined,
    })
    await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].from, 'no sender was supplied to the provider').toBeTruthy()
    expect(provider.calls[0].from).toMatch(/<[^@\s]+@[^@\s]+\.[a-z]{2,}>/i)
  })

  it('EMAIL_FROM, when set, overrides the fallback', async () => {
    const { sendVerificationEmail } = await loadEmail({
      RESEND_API_KEY: 'test-key-not-a-real-credential',
      EMAIL_FROM: 'XP Client Academy <noreply@xpclient-academy.com>',
    })
    await sendVerificationEmail('learner@example.com', VERIFY_DATA)
    expect(provider.calls[0].from).toBe('XP Client Academy <noreply@xpclient-academy.com>')
  })

  it('VERIFICATION EMAIL generation: the link is carried into both bodies', async () => {
    const { sendVerificationEmail } = await loadEmail({ RESEND_API_KEY: 'test-key-not-a-real-credential' })
    await sendVerificationEmail('learner@example.com', VERIFY_DATA)

    const c = provider.calls[0]
    expect(c.to).toBe('learner@example.com')
    expect(c.subject).toMatch(/Confirmez votre adresse email/)
    expect(c.html, 'the verify link is missing from the HTML body').toContain(VERIFY_DATA.verifyUrl)
    expect(c.text, 'the verify link is missing from the text body').toContain(VERIFY_DATA.verifyUrl)
    expect(c.html).toContain(VERIFY_DATA.firstName)
    // The learner must never be shown an internal hostname.
    for (const body of [c.html, c.text]) {
      expect(body).not.toMatch(/vercel\.app|localhost/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The deploy gate, exercised as a real child process over an env matrix.
// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-LAUNCH-B1 · 2. the production configuration gate', () => {
  const SCRIPT = join(process.cwd(), 'scripts/security/verify-prod-config.mjs')

  /**
   * Every variable the gate reads, pinned to a neutral value.
   *
   * WHY THESE ARE SET AND NOT DELETED — this is exactly what broke CI run
   * 38950773617. The gate loads `.env.local` for any key still `undefined`, so
   * deleting NEXT_PUBLIC_SUPABASE_URL does NOT make the project unconfigured
   * on a developer machine: the loader puts the real URL straight back. Locally
   * the gate therefore probed the live Supabase project over the network and
   * printed "public self-registration is disabled"; in CI, where ci.yml pins
   * placeholder credentials and no .env.local exists, it printed the skip line
   * instead. The suite was asserting an ambient outcome, and the two
   * environments disagreed.
   *
   * An explicit value wins, because the loader skips any key that is already
   * defined — '' included. So every row below declares its own world, and no
   * row reaches the network unless it says so.
   */
  const NEUTRAL: NodeJS.ProcessEnv = {
    // No real project: the Auth probe must announce a skip, not reach out.
    NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
    // Payments inactive, and no LIVE credential anywhere near the build.
    PAYDUNYA_MODE: '',
    PAYDUNYA_TEST_MASTER_KEY: '', PAYDUNYA_TEST_PRIVATE_KEY: '', PAYDUNYA_TEST_TOKEN: '',
    PAYDUNYA_LIVE_MASTER_KEY: '', PAYDUNYA_LIVE_PRIVATE_KEY: '', PAYDUNYA_LIVE_TOKEN: '',
  }

  /** The ambient environment, stripped of anything that could decide a row. */
  function baseEnv(): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env }
    for (const k of ['VERCEL_ENV', 'RESEND_API_KEY', 'EMAIL_DRY_RUN', 'EMAIL_FROM']) delete base[k]
    // A PayDunya variable exposed to the browser is refused by NAME, so for
    // those the key must be absent rather than blank.
    for (const k of Object.keys(base)) {
      if (k.startsWith('NEXT_PUBLIC_') && /PAYDUNYA/i.test(k)) delete base[k]
    }
    return { ...base, ...NEUTRAL }
  }

  /**
   * Run the real gate with a controlled environment.
   *
   * `spawnSync` rather than `execFileSync`: the sender notice is a
   * `console.warn`, so it lands on stderr, and execFileSync returns only
   * stdout when the child exits 0 — which hid that notice entirely. Both
   * streams are needed because the gate reports on both.
   */
  function gate(env: NodeJS.ProcessEnv): { code: number; out: string } {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...baseEnv(), ...env }, encoding: 'utf8',
    })
    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  /**
   * The same gate, run without blocking this process.
   *
   * Required by every row that points NEXT_PUBLIC_SUPABASE_URL at the fixture
   * below: `spawnSync` blocks this event loop, so the fixture server could
   * never answer the child's request and the probe would time out into
   * SEC2_SIGNUP_UNVERIFIED for every case alike — the tests would agree with
   * each other while measuring nothing.
   */
  function gateAsync(env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [SCRIPT], { env: { ...baseEnv(), ...env } })
      let out = ''
      child.stdout.on('data', d => { out += String(d) })
      child.stderr.on('data', d => { out += String(d) })
      child.on('close', code => resolve({ code: code ?? 1, out }))
    })
  }

  /**
   * A stand-in for `GET /auth/v1/settings`, so the signup cases are decided by
   * this test rather than by whatever the real project reports today.
   *
   * 127.0.0.1, never `localhost`: the gate's placeholder predicate is
   * /placeholder|example\.com|localhost/i, so a localhost URL would be
   * classified as "no real project" and skipped before the probe ran.
   */
  let server: ReturnType<typeof createServer> | null = null

  async function closeFixture() {
    if (!server) return
    const s = server
    server = null
    await new Promise<void>(r => s.close(() => r()))
  }

  async function supabaseFixture(payload: unknown, status = 200): Promise<NodeJS.ProcessEnv> {
    await closeFixture()
    server = createServer((req, res) => {
      if (!req.url?.startsWith('/auth/v1/settings')) { res.writeHead(404); res.end(); return }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    const s = server
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
    const addr = s.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    return {
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon-key',
    }
  }

  afterAll(closeFixture)

  const KEY = 'test-key-not-a-real-credential'
  const SENDER = 'XP Client Academy <noreply@example.com>'
  /** A mailer configuration the gate is satisfied with, for the rows below. */
  const MAILER_OK: NodeJS.ProcessEnv = { VERCEL_ENV: 'production', RESEND_API_KEY: KEY, EMAIL_FROM: SENDER }

  // ── it must NOT block anything that is not a live deployment ──────────────

  it('a local developer build with no key is NOT blocked', () => {
    const r = gate({})
    expect(r.code, 'the gate broke local development').toBe(0)
    expect(r.out).toMatch(/Mailer gate not enforced/)
  })

  it('a CI build with no key is NOT blocked', () => {
    expect(gate({ CI: 'true' }).code).toBe(0)
  })

  for (const env of ['preview', 'development']) {
    it(`a ${env} deployment with no key is NOT blocked`, () => {
      // Previews serve on *.vercel.app, which isAdminHost treats as internal,
      // so registerLearner refuses the host before creating anything.
      const r = gate({ VERCEL_ENV: env })
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/not enforced/)
    })
  }

  it('a preview deployment with dry-run ON is NOT blocked', () => {
    expect(gate({ VERCEL_ENV: 'preview', EMAIL_DRY_RUN: 'true' }).code).toBe(0)
  })

  // ── it MUST block a live deployment whose mailer is unavailable ───────────

  it('PRODUCTION with no key is BLOCKED', () => {
    const r = gate({ VERCEL_ENV: 'production' })
    expect(r.code, 'a production build with no mailer was allowed through').toBe(1)
    expect(r.out).toMatch(/MAILER_UNAVAILABLE/)
    expect(r.out).toMatch(/RESEND_API_KEY is missing or blank/)
  })

  it('PRODUCTION with a BLANK key is BLOCKED', () => {
    expect(gate({ VERCEL_ENV: 'production', RESEND_API_KEY: '   ' }).code).toBe(1)
  })

  it('PRODUCTION with EMAIL_DRY_RUN=true is BLOCKED even with a key', () => {
    const r = gate({ VERCEL_ENV: 'production', RESEND_API_KEY: KEY, EMAIL_DRY_RUN: 'true' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/EMAIL_DRY_RUN is set to 'true'/)
  })

  it('PRODUCTION with BOTH faults reports BOTH, not just the first', () => {
    const r = gate({ VERCEL_ENV: 'production', EMAIL_DRY_RUN: 'true' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/RESEND_API_KEY is missing/)
    expect(r.out).toMatch(/EMAIL_DRY_RUN is set/)
  })

  // ── it must PASS only on a valid live configuration ──────────────────────

  it('PRODUCTION with key and sender PASSES', () => {
    const r = gate({ VERCEL_ENV: 'production', RESEND_API_KEY: KEY, EMAIL_FROM: SENDER })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Mailer configuration verified/)
  })

  it('PRODUCTION with a key but no sender PASSES with a warning, not a block', () => {
    // EMAIL_FROM has a deliberate fallback (decision register Q-D), and a wrong
    // sender fails LOUDLY — Resend errors, the send returns success:false, and
    // verificationSent:false is audited. Unlike a missing key, it is visible.
    const r = gate({ VERCEL_ENV: 'production', RESEND_API_KEY: KEY })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/MAILER_SENDER_DEFAULT/)
  })

  it("EMAIL_DRY_RUN='false' in production is accepted", () => {
    expect(gate({ VERCEL_ENV: 'production', RESEND_API_KEY: KEY, EMAIL_FROM: SENDER, EMAIL_DRY_RUN: 'false' }).code).toBe(0)
  })

  // ── it must not have displaced the checks that were already there ────────

  it('an UNCONFIGURED Supabase project produces the explicit skip, and still passes', async () => {
    // This is what CI actually runs: ci.yml pins placeholder Supabase
    // credentials, so there is no project to interrogate. The gate must say so
    // rather than claim a verified setting, and must still exit 0.
    const r = await gateAsync(MAILER_OK)
    expect(r.out, 'the mailer gate stopped reporting').toMatch(/Mailer configuration verified/)
    expect(r.out, 'the PayDunya gate stopped reporting').toMatch(/PayDunya not configured/)
    expect(r.out, 'the Auth check neither ran nor announced a skip')
      .toMatch(/Skipping production Auth config check/)
    expect(r.out, 'a skipped probe claimed a verified setting')
      .not.toMatch(/self-registration is disabled/)
    expect(r.code).toBe(0)
  })

  it('a CONFIGURED project with signup CLOSED exercises the real signup check', async () => {
    const fixture = await supabaseFixture({ disable_signup: true })
    const r = await gateAsync({ ...MAILER_OK, ...fixture })
    expect(r.out).toMatch(/Mailer configuration verified/)
    expect(r.out, 'the probe was skipped instead of run')
      .not.toMatch(/Skipping production Auth config check/)
    expect(r.out, 'the signup check stopped reporting')
      .toMatch(/Auth configuration verified: public self-registration is disabled/)
    expect(r.code).toBe(0)
  })

  it('a CONFIGURED project with signup OPEN is still BLOCKED, mailer notwithstanding', async () => {
    // The point of the row: a satisfied mailer gate must not buy a pass on
    // SEC-2. The mailer block runs first and exits 0 on its own terms, so the
    // only thing stopping this build is the check that was already there.
    const fixture = await supabaseFixture({ disable_signup: false })
    const r = await gateAsync({ ...MAILER_OK, ...fixture })
    expect(r.out, 'the mailer gate did not pass, so this proves nothing')
      .toMatch(/Mailer configuration verified/)
    expect(r.out).toMatch(/SEC2_SIGNUP_ENABLED/)
    expect(r.code, 'an open Supabase signup endpoint was allowed through').toBe(1)
  })

  it('an UNREADABLE setting warns and does not block (ratified SEC-2 policy)', async () => {
    const fixture = await supabaseFixture({ disable_signup: 'yes' }) // not a boolean
    const r = await gateAsync({ ...MAILER_OK, ...fixture })
    expect(r.out).toMatch(/SEC2_SIGNUP_UNVERIFIED/)
    expect(r.out, 'an unreadable setting was reported as secure')
      .not.toMatch(/self-registration is disabled/)
    expect(r.code, 'a transient read failure blocked a deployment').toBe(0)
  })

  it('a PayDunya violation still BLOCKS when the mailer is perfectly configured', () => {
    const r = gate({ ...MAILER_OK, PAYDUNYA_LIVE_MASTER_KEY: 'live-credential-sentinel' })
    expect(r.out, 'the mailer gate did not pass, so this proves nothing')
      .toMatch(/Mailer configuration verified/)
    expect(r.out).toMatch(/PAYDUNYA_CONFIG/)
    expect(r.code, 'a LIVE PayDunya credential was allowed through').toBe(1)
  })

  it('the gate never prints a credential value', () => {
    const SENTINEL = 'test-key-sentinel-must-not-leak'
    for (const env of [
      { VERCEL_ENV: 'production', RESEND_API_KEY: SENTINEL, EMAIL_FROM: SENDER },
      { VERCEL_ENV: 'production', RESEND_API_KEY: SENTINEL, EMAIL_DRY_RUN: 'true' },
      { VERCEL_ENV: 'preview', RESEND_API_KEY: SENTINEL },
    ]) {
      expect(gate(env).out, 'the gate echoed the key').not.toContain(SENTINEL)
    }
  })
})
