/**
 * XP-PAYTECH-P2 — the restricted pilot checkout: policy, deploy gate, and every
 * purchase entry point.
 *
 * The journeys themselves (listed, unlisted, anonymous, forged action calls, packs,
 * settlement after the pilot closes) run on a real PostgreSQL engine in
 * `xp-paytech-ready-01-integration.test.ts`, describe "XP-PAYTECH-P2". This file
 * pins the rules those journeys rely on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  checkoutAudienceConfig,
  audienceAdmits,
  parsePilotUserIds,
  PAYTECH_PILOT_MAX_USERS,
} from '@/lib/payments/checkout-audience'
import {
  paytechCheckoutAvailability,
  paytechCheckoutAvailabilityFor,
  paytechProcessingAvailability,
  providerFlagNames,
} from '@/lib/payments/providers'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(relative(ROOT, p)))
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p).replace(/\\/g, '/'))
  }
  return out
}

const A = '10000000-0000-4000-8000-00000000000a'
const B = '10000000-0000-4000-8000-00000000000b'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)

/** A test-mode deployment where checkout is otherwise fully open. */
const OPEN = { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'k', PAYTECH_TEST_API_SECRET: 's', PAYTECH_CHECKOUT_ENABLED: 'true' }
/** Production, live mode, both approvals given. */
const LIVE = { VERCEL_ENV: 'production', PAYTECH_MODE: 'prod', PAYTECH_PROD_API_KEY: 'k', PAYTECH_PROD_API_SECRET: 's',
  PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true' }

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-P2 · the audience fails closed', () => {
  it('absent, blank or any word but exactly pilot/public: unusable', () => {
    for (const v of [undefined, '', '  ', 'PILOT', 'Public', 'all', 'true', 'pilot,public', 'publique']) {
      const c = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: v, PAYTECH_PILOT_USER_IDS: v === 'PILOT' ? A : '' })
      expect(c.audience, String(v)).toBeNull()
      expect(c.error, String(v)).toMatch(/PAYTECH_CHECKOUT_AUDIENCE/)
      expect(audienceAdmits(c, A)).toBe(false)
    }
  })

  it('pilot needs 1 to 5 distinct, well-formed ids; anything else admits nobody', () => {
    const bad = ['', ' ', ',', `${A},`, `,${A}`, `${A},,${B}`, 'not-a-uuid', `${A},${A}`, `${A},${A.toUpperCase()}`,
      ids(PAYTECH_PILOT_MAX_USERS + 1).join(','), `${A};${B}`, `{${A}}`]
    for (const list of bad) {
      const c = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: list })
      expect(c.error, list).not.toBeNull()
      expect(audienceAdmits(c, A), list).toBe(false)
    }
    expect(PAYTECH_PILOT_MAX_USERS).toBe(5)
    const five = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: ` ${ids(5).join(' , ')} ` })
    expect(five.error).toBeNull()
    expect(five.pilotUserIds).toHaveLength(5)
  })

  it('pilot admits exactly the listed session ids, case-insensitively, and never a missing session', () => {
    const c = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: A.toUpperCase() })
    expect(audienceAdmits(c, A)).toBe(true)
    expect(audienceAdmits(c, B)).toBe(false)
    expect(audienceAdmits(c, null)).toBe(false)
    expect(audienceAdmits(c, '')).toBe(false)
    expect(audienceAdmits(c, `${A},${B}`)).toBe(false)
  })

  it('public admits everyone the other checks admit, but never with a pilot list still set', () => {
    expect(audienceAdmits(checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'public' }), B)).toBe(true)
    const stale = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'public', PAYTECH_PILOT_USER_IDS: A })
    expect(stale.error).toMatch(/Clear the pilot list/)
    expect(audienceAdmits(stale, A)).toBe(false)
  })

  it('a malformed list closes checkout whatever the audience', () => {
    for (const audience of ['pilot', 'public']) {
      expect(checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: audience, PAYTECH_PILOT_USER_IDS: ids(6).join(',') }).error)
        .toMatch(/at most 5/)
    }
  })

  it('error messages name variables and counts, never an id', () => {
    for (const list of [ids(6).join(','), `${A},${A}`, `${A},nope`]) {
      const e = checkoutAudienceConfig({ PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: list }).error!
      expect(e).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
      expect(e).not.toContain('nope')
    }
    expect(parsePilotUserIds(undefined)).toEqual({ ids: [], error: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-P2 · the audience narrows checkout and never widens it', () => {
  it('missing or invalid audience: the deployment-level switch itself reports closed', () => {
    expect(paytechCheckoutAvailability(OPEN).available).toBe(false)
    expect(paytechCheckoutAvailability(OPEN).blockedBy).toMatch(/PAYTECH_CHECKOUT_AUDIENCE/)
    expect(paytechCheckoutAvailability({ ...OPEN, PAYTECH_CHECKOUT_AUDIENCE: 'pilot' }).available).toBe(false)
    expect(paytechCheckoutAvailability({ ...OPEN, PAYTECH_CHECKOUT_AUDIENCE: 'public' }).available).toBe(true)
  })

  it('a listed pilot user cannot bypass PAYTECH_CHECKOUT_ENABLED', () => {
    const env = { ...OPEN, PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: A }
    expect(paytechCheckoutAvailabilityFor(A, env).available).toBe(true)
    for (const v of [undefined, '', 'false', 'TRUE', '1']) {
      expect(paytechCheckoutAvailabilityFor(A, { ...env, PAYTECH_CHECKOUT_ENABLED: v }).available, String(v)).toBe(false)
    }
  })

  it('a listed pilot user cannot bypass PAYTECH_ALLOW_PRODUCTION, the credentials or the mode', () => {
    const env = { ...LIVE, PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: A }
    expect(paytechCheckoutAvailabilityFor(A, env).available).toBe(true)
    expect(paytechCheckoutAvailabilityFor(B, env).available).toBe(false)
    expect(paytechCheckoutAvailabilityFor(null, env).available).toBe(false)
    expect(paytechCheckoutAvailabilityFor(A, { ...env, PAYTECH_ALLOW_PRODUCTION: '' }).available).toBe(false)
    expect(paytechCheckoutAvailabilityFor(A, { ...env, PAYTECH_PROD_API_SECRET: '' }).available).toBe(false)
    expect(paytechCheckoutAvailabilityFor(A, { ...env, PAYTECH_MODE: 'test' }).available).toBe(false)
  })

  it('production credentials stay refused in a preview, listed or public', () => {
    for (const audience of [{ PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: A }, { PAYTECH_CHECKOUT_AUDIENCE: 'public' }]) {
      expect(paytechCheckoutAvailabilityFor(A, { ...LIVE, ...audience, VERCEL_ENV: 'preview' }).available).toBe(false)
      expect(paytechProcessingAvailability({ ...LIVE, ...audience, VERCEL_ENV: 'preview' }).available).toBe(false)
    }
  })

  it('settlement processing does not depend on the audience at all', () => {
    for (const extra of [{}, { PAYTECH_CHECKOUT_AUDIENCE: 'nonsense' }, { PAYTECH_PILOT_USER_IDS: ids(9).join(',') },
      { PAYTECH_CHECKOUT_ENABLED: '' }]) {
      expect(paytechProcessingAvailability({ ...LIVE, ...extra }).available, JSON.stringify(extra)).toBe(true)
    }
  })

  it('both variables are recognised provider flags, and neither is a NEXT_PUBLIC_ name', () => {
    expect(providerFlagNames()).toEqual(expect.arrayContaining(['PAYTECH_CHECKOUT_AUDIENCE', 'PAYTECH_PILOT_USER_IDS']))
    for (const f of [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib'), 'middleware.ts']) {
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(AUDIENCE|PILOT_USER)/)
    }
    expect(read('lib/payments/checkout-audience.ts')).toMatch(/^import 'server-only'/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-P2 · every entry point asks the same per-user policy', () => {
  const action = stripComments(read('app/actions/paytech-checkout.ts'))

  it('both actions check the SESSION user before the database guard, any read, or PayTech', () => {
    for (const fn of ['startPaytechCheckout', 'startPaytechPackCheckout']) {
      const start = action.indexOf(`export async function ${fn}(`)
      const body = action.slice(start, action.indexOf('\nexport async function', start + 10) > 0
        ? action.indexOf('\nexport async function', start + 10) : undefined)
      const session = body.indexOf('if (!user) return { error: MSG.signIn }')
      const policy = body.indexOf('if (!audienceAllows(user.id, ')
      expect(session, fn).toBeGreaterThan(0)
      expect(policy, fn).toBeGreaterThan(session)
      for (const later of ['paymentDatabaseAuthority()', 'createAdminClient()', 'resolveCourseAccessById(', 'loadPackForCheckout(', 'openAttempt(']) {
        const at = body.indexOf(later)
        if (at >= 0) expect(at, `${fn}: ${later} runs before the audience check`).toBeGreaterThan(policy)
      }
    }
    // The helper takes the id it is given by the action — the session's — and nothing from the input.
    expect(action).toMatch(/function audienceAllows\(userId: string, product: 'course' \| 'pack'\): boolean \{\s*const policy = paytechCheckoutAvailabilityFor\(userId\)/)
    expect(action).not.toMatch(/input\??\.(audience|userId|user_id|pilot)/)
  })

  it('the five purchase pages ask paytechCheckoutAvailabilityFor with the server session, never the bare switch', () => {
    const pages: [string, RegExp][] = [
      ['app/(public)/courses/[slug]/page.tsx', /paytechCheckoutAvailabilityFor\(user\?\.id \?\? null\)\.available/],
      ['app/(public)/packs/[code]/page.tsx', /paytechCheckoutAvailabilityFor\(user\?\.id \?\? null\)\.available/],
      ['app/(platform)/checkout/page.tsx', /paytechCheckoutAvailabilityFor\(user\.id\)\.available/],
      ['app/(platform)/checkout/PackCheckout.tsx', /paytechCheckoutAvailabilityFor\(user\.id\)\.available/],
      ['app/payment/cancel/page.tsx', /paytechCheckoutAvailabilityFor\(user\.id\)\.available/],
    ]
    for (const [file, re] of pages) {
      const code = stripComments(read(file))
      expect(code, file).toMatch(re)
      expect(code, file).toMatch(/supabase\.auth\.getUser\(\)/)
      expect(code, `${file} still reads the bare switch`).not.toMatch(/paytechCheckoutAvailability\(\)/)
    }
  })

  it('no other module asks the bare switch, so no new surface can skip the audience', () => {
    const callers = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')]
      .filter(f => /paytechCheckoutAvailability\(/.test(stripComments(read(f))))
      .sort()
    // providers.ts defines it and builds the per-user answer on it; the action's step 1
    // is the deployment check that runs before the session is even read.
    expect(callers).toEqual(['app/actions/paytech-checkout.ts', 'lib/payments/providers.ts'])
    // The other deployment-level helpers answer "available" for a valid pilot, whoever asks.
    // Nothing outside providers.ts may use them to decide what a learner is offered.
    const deploymentLevel = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')]
      .filter(f => f !== 'lib/payments/providers.ts')
      .filter(f => /\b(availableProviders|providerAvailability|describeProviders)\(/.test(stripComments(read(f))))
    expect(deploymentLevel).toEqual([])
  })

  it('the only chargeable PayTech request is still made by the checkout action', () => {
    const callers = [...sourceFiles('app'), ...sourceFiles('lib')]
      .filter(f => f !== 'lib/payments/paytech-client.ts')
      .filter(f => /\brequestPayment\(/.test(stripComments(read(f))))
    expect(callers).toEqual(['app/actions/paytech-checkout.ts'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-PAYTECH-P2 · the deploy gate', () => {
  const MAILER = { RESEND_API_KEY: 're_harness', EMAIL_FROM: 'noreply@xpclient-academy.com' }
  const PROD = { ...MAILER, VERCEL_ENV: 'production', PAYTECH_MODE: 'prod', PAYTECH_PROD_API_KEY: 'k',
    PAYTECH_PROD_API_SECRET: 's', CRON_SECRET: 'cron-harness-0123456789' }
  function gate(env: Record<string, string>) {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(PAYTECH|PAYDUNYA|CRON_SECRET|VERCEL_ENV|NEXT_PUBLIC_SUPABASE|RESEND|EMAIL_)/.test(k)) clean[k] = v
    }
    const cwd = mkdtempSync(join(tmpdir(), 'xp-paytech-p2-gate-'))
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/security/verify-prod-config.mjs')], {
      cwd, env: { ...clean, ...env }, encoding: 'utf8',
    })
    rmSync(cwd, { recursive: true, force: true })
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
  }

  it("today's production (processing only, no audience) still passes", () => {
    const r = gate(PROD)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/mode='prod' for production, checkout disabled/)
  })

  it('checkout enabled without an audience, or with an invalid one, is refused', () => {
    const on = { ...PROD, PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true' }
    expect(gate(on).code).toBe(1)
    expect(gate(on).out).toMatch(/PAYTECH_CHECKOUT_AUDIENCE is not set/)
    for (const v of ['PILOT', 'everyone', 'Public']) expect(gate({ ...on, PAYTECH_CHECKOUT_AUDIENCE: v }).code, v).toBe(1)
  })

  it('pilot: refused with an empty, malformed, duplicated or six-id list; passes with one id and prints no id', () => {
    const on = { ...PROD, PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true', PAYTECH_CHECKOUT_AUDIENCE: 'pilot' }
    expect(gate(on).code).toBe(1)
    for (const list of [`${A},`, 'nope', `${A},${A}`, ids(6).join(',')]) {
      expect(gate({ ...on, PAYTECH_PILOT_USER_IDS: list }).code, list).toBe(1)
    }
    const ok = gate({ ...on, PAYTECH_PILOT_USER_IDS: A })
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/checkout enabled for the pilot \(1 user\)/)
    expect(ok.out).not.toContain(A)
    const five = gate({ ...on, PAYTECH_PILOT_USER_IDS: ids(5).join(',') })
    expect(five.code).toBe(0)
    for (const id of ids(5)) expect(five.out).not.toContain(id)
  })

  // By design the gate is STRICTER than the runtime while checkout is off: a broken
  // audience or list only keeps checkout closed at runtime, but it blocks the build,
  // so a misconfiguration is fixed before anyone turns checkout on.
  it('a bad list is refused even while checkout is off; public with a list is refused', () => {
    expect(gate({ ...PROD, PAYTECH_PILOT_USER_IDS: ids(6).join(',') }).code).toBe(1)
    expect(gate({ ...PROD, PAYTECH_CHECKOUT_AUDIENCE: 'public', PAYTECH_PILOT_USER_IDS: A }).code).toBe(1)
    expect(gate({ ...PROD, PAYTECH_CHECKOUT_AUDIENCE: 'public', PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true' }).out)
      .toMatch(/checkout enabled for the public/)
  })

  it('a NEXT_PUBLIC_ pilot or audience variable is refused as a leak', () => {
    expect(gate({ ...PROD, NEXT_PUBLIC_PAYTECH_PILOT_USER_IDS: A }).code).toBe(1)
    expect(gate({ ...PROD, NEXT_PUBLIC_PAYTECH_CHECKOUT_AUDIENCE: 'public' }).code).toBe(1)
  })

  it('production credentials outside production are still refused, whatever the audience', () => {
    const preview = { ...PROD, VERCEL_ENV: 'preview', PAYTECH_CHECKOUT_AUDIENCE: 'pilot', PAYTECH_PILOT_USER_IDS: A }
    expect(gate(preview).code).toBe(1)
  })

  it('the gate and the runtime agree on every audience/list combination', () => {
    const audiences = [undefined, '', 'pilot', 'public', 'PILOT']
    const lists = [undefined, '', A, `${A},${B}`, `${A},`, `${A},${A}`, ids(5).join(','), ids(6).join(','), 'nope']
    for (const audience of audiences) {
      for (const list of lists) {
        const extra: Record<string, string> = {}
        if (audience !== undefined) extra.PAYTECH_CHECKOUT_AUDIENCE = audience
        if (list !== undefined) extra.PAYTECH_PILOT_USER_IDS = list
        const runtimeOpen = checkoutAudienceConfig(extra).error === null
        const g = gate({ ...PROD, PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true', ...extra })
        expect(g.code === 0, `audience=${audience} list=${list}`).toBe(runtimeOpen)
      }
    }
  }, 60_000)
})
