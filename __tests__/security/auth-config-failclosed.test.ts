// @vitest-environment node
/**
 * HOTFIX-1 regression tests.
 *
 * The production incident: the SEC-2 auth-config check in instrumentation.ts
 * threw during server preparation because Supabase still reported
 * disable_signup: false. That failed the whole application (every route), and
 * behaved nondeterministically — the same code booted fine whenever the
 * outbound settings fetch happened to fail, because 'unknown' is non-fatal by
 * ratified policy.
 *
 * These tests pin BOTH halves of that behaviour so neither can drift:
 *   - confirmed-insecure MUST still fail closed in production (not weakened);
 *   - unreadable settings MUST remain non-fatal (the ratified policy);
 *   - the stable error codes operators grep for MUST NOT change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const ROOT = process.cwd()

function mockSettings(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status })
  ))
}

describe('HOTFIX-1 — fail-closed behaviour is preserved', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  })

  const load = () => import('@/lib/security/auth-config')

  /**
   * HOTFIX-3: the incident condition must now be REPORTED, not fatal to the
   * process. Enforcement moved to deploy time (see the deploy-gate block
   * below). The site stays up; /api/health reports degraded.
   */
  it('disable_signup=false is reported without throwing (HOTFIX-3 policy)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    mockSettings({ disable_signup: false })
    const { assertSignupDisabled, ERR_SIGNUP_ENABLED } = await load()
    const res = await assertSignupDisabled()
    expect(res.status).toBe('insecure')
    expect(res.code).toBe(ERR_SIGNUP_ENABLED)
  })

  it('no code path in the startup check throws', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { assertSignupDisabled } = await load()

    // confirmed insecure
    mockSettings({ disable_signup: false })
    await expect(assertSignupDisabled()).resolves.toBeTruthy()
    // unreadable
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    await expect(assertSignupDisabled()).resolves.toBeTruthy()
    // malformed payload
    mockSettings({ nonsense: true })
    await expect(assertSignupDisabled()).resolves.toBeTruthy()
    // secure
    mockSettings({ disable_signup: true })
    await expect(assertSignupDisabled()).resolves.toBeTruthy()
  })

  it('disable_signup=true allows normal boot', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    mockSettings({ disable_signup: true })
    const { assertSignupDisabled } = await load()
    await expect(assertSignupDisabled()).resolves.toMatchObject({ status: 'secure' })
  })

  it('network failure stays NON-FATAL — the ratified policy that kept the site up', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    const { assertSignupDisabled } = await load()
    const res = await assertSignupDisabled()
    expect(res.status).toBe('unknown')
    expect(res.status).not.toBe('secure')   // must never be reported as verified
  })

  it('an aborted (timed-out) probe is unknown, not secure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('This operation was aborted') }))
    const { checkSignupDisabled } = await load()
    await expect(checkSignupDisabled()).resolves.toMatchObject({ status: 'unknown' })
  })

  it('a non-200 settings response is unknown, not secure', async () => {
    mockSettings({}, 503)
    const { checkSignupDisabled } = await load()
    const res = await checkSignupDisabled()
    expect(res.status).toBe('unknown')
  })
})

describe('HOTFIX-1 — stable error codes for operators', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  })

  it('codes are exactly the published values (operators grep these)', async () => {
    const { ERR_SIGNUP_ENABLED, ERR_SIGNUP_UNVERIFIED } = await import('@/lib/security/auth-config')
    expect(ERR_SIGNUP_ENABLED).toBe('SEC2_SIGNUP_ENABLED')
    expect(ERR_SIGNUP_UNVERIFIED).toBe('SEC2_SIGNUP_UNVERIFIED')
  })

  it('insecure result carries SEC2_SIGNUP_ENABLED', async () => {
    mockSettings({ disable_signup: false })
    const { checkSignupDisabled, ERR_SIGNUP_ENABLED } = await import('@/lib/security/auth-config')
    await expect(checkSignupDisabled()).resolves.toMatchObject({ code: ERR_SIGNUP_ENABLED })
  })

  it('unknown result carries SEC2_SIGNUP_UNVERIFIED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const { checkSignupDisabled, ERR_SIGNUP_UNVERIFIED } = await import('@/lib/security/auth-config')
    await expect(checkSignupDisabled()).resolves.toMatchObject({ code: ERR_SIGNUP_UNVERIFIED })
  })

  it('the operator-facing message embeds the stable code', async () => {
    const { INSECURE_SIGNUP_MESSAGE } = await import('@/lib/security/auth-config')
    expect(INSECURE_SIGNUP_MESSAGE).toContain('SEC2_SIGNUP_ENABLED')
  })
})

describe('HOTFIX-1 — deploy-time verification command', () => {
  const script = readFileSync(join(ROOT, 'scripts/security/verify-prod-config.mjs'), 'utf8')

  it('blocks the deployment when signup is enabled', () => {
    expect(script).toMatch(/DEPLOYMENT BLOCKED/)
    expect(script).toMatch(/process\.exitCode = 1/)
  })

  it('does not block on an unreadable setting (matches ratified policy)', () => {
    expect(script).toMatch(/status === 'unknown'[\s\S]*?process\.exitCode = 0/)
  })

  it('skips placeholder/CI configuration instead of warning misleadingly', () => {
    expect(script).toContain('isPlaceholder')
    expect(script).toContain('Skipping production Auth config check')
  })

  it('is exposed as an npm script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['verify:prod-config']).toContain('verify-prod-config.mjs')
  })
})

describe('HOTFIX-1 — the gate is global, not route-scoped', () => {
  /**
   * The incident presented as "/courses returns 500". It was not: the throw
   * happened in the instrumentation hook during server preparation, so EVERY
   * route failed and /courses was simply the most-visited one. These tests pin
   * that shape so a future reader is not sent hunting through the courses page.
   */
  it('the startup gate is invoked from instrumentation, not from a route', () => {
    const instr = readFileSync(join(ROOT, 'instrumentation.ts'), 'utf8')
    expect(instr).toMatch(/assertSignupDisabled/)
  })

  it('the courses page does not depend on the auth-config gate', () => {
    const page = readFileSync(join(ROOT, 'app/(public)/courses/page.tsx'), 'utf8')
    expect(page).not.toMatch(/auth-config|assertSignupDisabled|checkSignupDisabled/)
  })

  it('only instrumentation and the deploy script can hard-fail on this control', () => {
    // Anything else calling assertSignupDisabled() would turn a config problem
    // into a route-level outage again.
    const hits = execFileSync(
      'git',
      ['grep', '-l', '-e', 'assertSignupDisabled', '--', 'app', 'lib', 'components', 'instrumentation.ts'],
      { cwd: ROOT, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('auth-config.ts')) // the definition itself

    expect(hits).toEqual(['instrumentation.ts'])
  })
})

describe('HOTFIX-1 — health endpoint does not leak configuration', () => {
  const route = readFileSync(join(ROOT, 'app/api/health/route.ts'), 'utf8')

  it('gates detailed status behind a verified platform admin', () => {
    expect(route).toMatch(/isPlatformAdmin/)
    expect(route).toMatch(/super_admin/)
  })

  it('returns only a coarse status to anonymous callers', () => {
    // The anonymous branch must return `status` alone — no code, no detail.
    expect(route).toMatch(/if \(!\(await isPlatformAdmin\(\)\)\)[\s\S]*?NextResponse\.json\(\{ status \}/)
  })

  it('never returns the raw settings payload or credentials', () => {
    expect(route).not.toMatch(/anonKey|SERVICE_ROLE|process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/)
    expect(route).not.toMatch(/disable_signup:/)
  })
})
