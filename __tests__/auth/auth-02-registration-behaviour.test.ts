// @vitest-environment node
/**
 * AUTH-02 — BEHAVIOURAL registration boundary tests.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Every other guard protecting registration in this repository — including the
 * one AUTH-02 re-aimed in owner-auth.test.ts, and the whole of
 * security/registration.test.ts — is a SOURCE-PATTERN assertion. It reads the
 * file and matches a regex. That proves a string is present; it does not prove
 * the boundary refuses anything.
 *
 * The distinction is not academic. `expect(src).toMatch(/isCommercialHost/)`
 * passes just as happily if the call sits in dead code, if its result is
 * discarded, if the condition is inverted, or if an early return above it means
 * it never runs. A reviewer reading only that assertion would reasonably
 * believe the admin host is refused, and would have no evidence of it.
 *
 * So this file EXECUTES the registration action against both hosts and
 * observes what it actually does. It is deliberately narrow: it adds no
 * application change, mocks only the module boundaries the action reaches
 * through (admin client, rate limiter, CAPTCHA, email, audit), and asserts
 * three things a regex cannot:
 *
 *   1. On the admin host the action REFUSES and no user is created.
 *   2. On the commercial host it PROCEEDS — so test 1 is not passing because
 *      the action refuses everything.
 *   3. The account it creates is unprivileged, and registration touches no
 *      entitlement, enrollment or payment table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
// The REAL current versions. The action refuses a stale acceptance before it
// creates anything, so a hard-coded fixture here would silently test the
// version gate instead of the host gate.
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/versions'

// ── Mutable request host, read by the mocked next/headers ───────────────────
let host = ''

// ── Recorders ───────────────────────────────────────────────────────────────
const createUser = vi.fn()
const deleteUser = vi.fn(async () => ({ error: null }))
/** The verification link the action generates after the account exists. */
const generateLink = vi.fn(async () => ({
  data: { properties: { hashed_token: 'tok-behaviour' } },
  error: null,
}))
/** Every table the action touches, with the operation and payload. */
let touched: { table: string; op: string; payload?: unknown }[] = []

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-host': host, 'x-forwarded-for': '203.0.113.7' }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { createUser, deleteUser, generateLink } },
    from: (table: string) => ({
      upsert: async (payload: unknown) => { touched.push({ table, op: 'upsert', payload }); return { error: null } },
      insert: async (payload: unknown) => { touched.push({ table, op: 'insert', payload }); return { error: null } },
      update: async (payload: unknown) => { touched.push({ table, op: 'update', payload }); return { error: null } },
      delete: async () => { touched.push({ table, op: 'delete' }); return { error: null } },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }),
                     single:      async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/rate-limit', () => ({
  rateLimitDb: async () => ({ success: true, remaining: 5, resetAt: 0 }),
}))
vi.mock('@/lib/audit/log', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/security/captcha', () => ({
  verifyCaptcha: async () => ({ ok: true }),
  isCaptchaEnabled: () => false,
}))
// `dispatchVerificationEmail` reads `.success` off this, so the mock must
// return the real shape rather than undefined.
vi.mock('@/lib/email', () => ({
  sendVerificationEmail: vi.fn(async () => ({ success: true })),
}))

const VALID = {
  firstName: 'Ada',
  lastName:  'Lovelace',
  email:     'ada.lovelace@example.com',
  password:  'Correct-Horse-9-Battery',
  confirmPassword: 'Correct-Horse-9-Battery',
  acceptedTermsVersion:   TERMS_VERSION,
  acceptedPrivacyVersion: PRIVACY_VERSION,
}

/** The real action, imported after the mocks are in place. */
async function register(overrides: Partial<typeof VALID> = {}) {
  const { registerLearner } = await import('@/app/actions/auth')
  return registerLearner({ ...VALID, ...overrides })
}

beforeEach(() => {
  touched = []
  createUser.mockReset()
  createUser.mockResolvedValue({ data: { user: { id: 'u-behaviour-1' } }, error: null })
  deleteUser.mockClear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 behaviour · the admin host cannot register', () => {
  it('REFUSES on the admin host, and creates no user', async () => {
    host = 'smiley-cx-platform.vercel.app'
    const result = await register()
    expect(result.ok).toBe(false)
    expect(createUser, 'a user was created from the admin host').not.toHaveBeenCalled()
    expect(touched, 'the admin host reached the database').toEqual([])
  })

  it('refuses every admin-host spelling, including a preview deployment', async () => {
    for (const h of [
      'smiley-cx-platform.vercel.app',
      'SMILEY-CX-PLATFORM.VERCEL.APP:443',
      'some-random-preview.vercel.app',
      'smiley-cx-platform-git-main-x.vercel.app',
    ]) {
      host = h
      createUser.mockClear()
      const result = await register()
      expect(result.ok, `${h} was allowed to register`).toBe(false)
      expect(createUser, `${h} created a user`).not.toHaveBeenCalled()
    }
  })

  it('the refusal does not disclose whether the address exists', async () => {
    host = 'smiley-cx-platform.vercel.app'
    const result = await register()
    expect(result.message ?? '').not.toMatch(/exist|d(é|e)j(à|a)|already/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 behaviour · the commercial host CAN register', () => {
  it('PROCEEDS on the commercial host — so the refusal above is specific', async () => {
    // Without this, the admin-host test would pass even if the action were
    // broken in a way that refused everyone.
    host = 'www.xpclient-academy.com'
    const result = await register()
    expect(createUser, 'the commercial host could not create a user').toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('creates the auth user as UNCONFIRMED, so email verification is real', async () => {
    host = 'www.xpclient-academy.com'
    await register()
    const arg = createUser.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg, 'createUser was not called').toBeTruthy()
    expect(arg.email_confirm, 'the account was pre-confirmed, skipping verification').toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 behaviour · the account created is unprivileged', () => {
  it('writes platform_role "user" — not admin, and not anything from input', async () => {
    host = 'www.xpclient-academy.com'
    await register()
    const profile = touched.find(t => t.table === 'profiles')
    expect(profile, 'no profile was written').toBeTruthy()
    const payload = profile!.payload as Record<string, unknown>
    expect(payload.platform_role).toBe('user')
  })

  it('ignores a role smuggled through the input object', async () => {
    host = 'www.xpclient-academy.com'
    // The typed signature has no role field; this is what an attacker would
    // actually send over the wire to a server action.
    await register({ platform_role: 'admin', role: 'admin' } as unknown as Partial<typeof VALID>)
    const payload = touched.find(t => t.table === 'profiles')!.payload as Record<string, unknown>
    expect(payload.platform_role, 'a submitted role reached the profile').toBe('user')
    expect(payload.role, 'a submitted legacy role reached the profile').toBeUndefined()
  })

  it('records legal acceptance — registration is not completable without it', async () => {
    host = 'www.xpclient-academy.com'
    await register()
    expect(touched.map(t => t.table)).toContain('legal_acceptances')
  })

  it('touches NO entitlement, enrollment, payment or audit_log table', async () => {
    host = 'www.xpclient-academy.com'
    await register()
    const tables = [...new Set(touched.map(t => t.table))]
    for (const forbidden of ['entitlements', 'enrollments', 'payments', 'certificates']) {
      expect(tables, `registration wrote to ${forbidden}`).not.toContain(forbidden)
    }
    // The only tables registration may write.
    expect(tables.sort()).toEqual(['legal_acceptances', 'profiles'])
  })
})
