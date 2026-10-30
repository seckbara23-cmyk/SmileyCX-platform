// @vitest-environment node
/**
 * XP-PAYTECH-04 — production-readiness facts that need no database. The
 * database-level evidence lives in `xp-paytech-ready-01-integration.test.ts`.
 *
 * Everything runs against the real modules. The only stubs are `fetch`, the
 * admin Supabase client for the admin page render, and the admin session guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, join(ROOT, rel)).replace(/\\/g, '/'))
  }
  return out
}
const APP_SOURCES = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')]

const H = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  /** How the exception table answers: normally, with an error, or as a HEAD request on a missing table. */
  exceptionTable: 'ok' as 'ok' | 'error' | 'missing_head',
}))
vi.mock('@/lib/auth/session', () => ({ requirePlatformAdmin: async () => ({ id: 'admin' }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let completedOnly = false
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain, in: () => chain, is: () => chain, not: () => chain,
        eq: (c: string, v: string) => { if (c === 'status' && v === 'completed') completedOnly = true; return chain },
        then: (res: (_v: unknown) => unknown) => Promise.resolve(
          table === 'payment_exceptions' && H.exceptionTable === 'error'
            ? { data: null, error: { message: 'relation does not exist' }, count: null }
            : table === 'payment_exceptions' && H.exceptionTable === 'missing_head'
              ? { data: null, error: null, count: null }
              : table === 'payment_exceptions'
                ? { data: [], error: null, count: 0 }
                : { data: completedOnly ? H.rows.filter(r => r.status === 'completed') : H.rows, error: null },
        ).then(res),
      }
      return chain
    },
  }),
}))

// The first import of the server action pulls in the Supabase SSR client.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

// ═══════════════════════════════════════════════════════════════════════════
describe('READY-C1 FIXED — PayTech is the checkout journey', () => {
  it('the checkout page renders the PayTech button, which calls startPaytechCheckout()', () => {
    const page = stripComments(read('app/(platform)/checkout/page.tsx'))
    expect(page).toMatch(/import PaytechCheckoutButton from '@\/components\/payment\/PaytechCheckoutButton'/)
    expect(page).toMatch(/<PaytechCheckoutButton courseId=/)
    const button = stripComments(read('components/payment/PaytechCheckoutButton.tsx'))
    expect(button).toMatch(/startPaytechCheckout\(\{ courseId \}\)/)
    expect(button).toMatch(/window\.location\.assign\(destination\)/)
  })

  it('startPaytechCheckout() has exactly one caller: the button', () => {
    const callers = APP_SOURCES
      .filter(f => f !== 'app/actions/paytech-checkout.ts')
      .filter(f => /startPaytechCheckout/.test(stripComments(read(f))))
    expect(callers).toEqual(['components/payment/PaytechCheckoutButton.tsx'])
  })

  it('the page and the course CTA are gated by the SAME server-side availability', () => {
    expect(stripComments(read('app/(platform)/checkout/page.tsx')))
      .toMatch(/if \(!paytechCheckoutAvailability\(\)\.available\)/)
    expect(stripComments(read('app/(public)/courses/[slug]/page.tsx')))
      .toMatch(/paidPurchaseAvailable = paytechCheckoutAvailability\(\)\.available && !isFree/)
  })

  it('the legacy dead end is gone: the confirm page redirects, the legacy action refuses', () => {
    expect(stripComments(read('app/(platform)/checkout/confirm/page.tsx'))).toMatch(/redirect\('\/payment\/success'\)/)
    const action = stripComments(read('app/actions/payment.ts'))
    expect(action).not.toMatch(/\.insert\(|from\(|import /)
  })
})

describe('READY-C2 FIXED — XP Client Academy collects no card data (safeguard 7)', () => {
  it('the card-number/CVV selector is deleted, and nothing references it', () => {
    expect(existsSync(join(ROOT, 'components/payment/PaymentMethodSelector.tsx'))).toBe(false)
    const refs = APP_SOURCES.filter(f => /PaymentMethodSelector/.test(stripComments(read(f))))
    expect(refs).toEqual([])
  })

  it('no shipped page or component renders a card, CVV, expiry or phone input', () => {
    for (const f of APP_SOURCES.filter(f => f.endsWith('.tsx'))) {
      const src = read(f)
      expect(src, `${f} renders a card field`).not.toMatch(/Numéro de carte|label="CVV"|placeholder="MM\/AA"|1234 5678 9012 3456/)
    }
    expect(read('components/payment/PaytechCheckoutButton.tsx')).not.toMatch(/<input|<Input/)
  })

  it('the browser flag that used to switch the card form on is retired', () => {
    const pilot = stripComments(read('lib/pilot.ts'))
    expect(pilot).not.toMatch(/PAYMENTS_ENABLED/)
    for (const f of APP_SOURCES) {
      expect(stripComments(read(f)), `${f} reads the retired flag`).not.toMatch(/NEXT_PUBLIC_PAYMENTS_ENABLED|\bPAYMENTS_ENABLED\b/)
    }
  })

  it('the legacy action can no longer accept card or phone metadata', () => {
    expect(stripComments(read('app/actions/payment.ts'))).not.toMatch(/metadata|phone|cardholder/)
  })
})

describe('PayDunya is a library with no route and no caller', () => {
  it('no PayDunya route; nothing outside lib/payments imports its client', () => {
    expect(existsSync(join(ROOT, 'app/api/payments/paydunya'))).toBe(false)
    const importers = APP_SOURCES
      .filter(f => !f.startsWith('lib/payments/'))
      .filter(f => /paydunya-client/.test(stripComments(read(f))))
    expect(importers).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('READY-E1 FIXED — test and live belong to different environments', () => {
  const T = { PAYTECH_TEST_API_KEY: 'k', PAYTECH_TEST_API_SECRET: 's' }
  const L = { PAYTECH_PROD_API_KEY: 'k', PAYTECH_PROD_API_SECRET: 's' }

  it('production REFUSES PAYTECH_MODE=test, even with ALLOW_PRODUCTION', async () => {
    const { paytechCheckoutAvailability, paytechProcessingAvailability } = await import('@/lib/payments/providers')
    const env = { ...T, VERCEL_ENV: 'production', PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true', PAYTECH_MODE: 'test' }
    expect(paytechCheckoutAvailability(env).available).toBe(false)
    expect(paytechProcessingAvailability(env).available).toBe(false)
  })

  it('a preview REFUSES PAYTECH_MODE=prod', async () => {
    const { paytechCheckoutAvailability, paytechProcessingAvailability } = await import('@/lib/payments/providers')
    const env = { ...L, VERCEL_ENV: 'preview', PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_MODE: 'prod' }
    expect(paytechCheckoutAvailability(env).available).toBe(false)
    expect(paytechProcessingAvailability(env).available).toBe(false)
  })

  it('production in live mode needs the second approval for NEW sales — but not to process existing ones', async () => {
    const { paytechCheckoutAvailability, paytechProcessingAvailability } = await import('@/lib/payments/providers')
    const env = { ...L, VERCEL_ENV: 'production', PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_MODE: 'prod' }
    expect(paytechCheckoutAvailability(env).available).toBe(false)
    expect(paytechCheckoutAvailability({ ...env, PAYTECH_ALLOW_PRODUCTION: 'true' }).available).toBe(true)
    expect(paytechProcessingAvailability(env).available).toBe(true)
  })

  it('the database refuses a test completion in a live database (migration 063)', () => {
    const m = read('supabase/migrations/063_payment_state_machine.sql')
    expect(m).toMatch(/'test_payment_in_live_database'/)
    expect(m).toMatch(/values \('live', /)
    expect(m).toMatch(/revoke all on public\.payment_environment from public, anon, authenticated, service_role;/)
  })

  describe('the Vercel deploy gate now has a PayTech section', () => {
    const MAILER = { RESEND_API_KEY: 're_harness', EMAIL_FROM: 'noreply@xpclient-academy.com' }
    function gate(env: Record<string, string>) {
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !/^(PAYTECH|PAYDUNYA|CRON_SECRET|VERCEL_ENV|NEXT_PUBLIC_SUPABASE|RESEND|EMAIL_)/.test(k)) clean[k] = v
      }
      // Run from an EMPTY directory: the gate loads `.env.local` from its cwd,
      // and a developer's real values must never reach this test — nor let the
      // gate's Supabase probe call a real project.
      const cwd = mkdtempSync(join(tmpdir(), 'xp-paytech-04-gate-'))
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/security/verify-prod-config.mjs')], {
        cwd, env: { ...clean, ...env }, encoding: 'utf8',
      })
      rmSync(cwd, { recursive: true, force: true })
      return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
    }

    it('blocks test mode or test keys in production', () => {
      const r = gate({ ...MAILER, VERCEL_ENV: 'production', PAYTECH_MODE: 'test', ...T })
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/PAYTECH_CONFIG\] DEPLOYMENT BLOCKED/)
      expect(r.out).not.toMatch(/=k\b|=s\b/)
    })

    it('blocks live mode or live keys outside production', () => {
      expect(gate({ VERCEL_ENV: 'preview', PAYTECH_MODE: 'prod', ...L }).code).toBe(1)
      expect(gate({ VERCEL_ENV: 'preview', ...L }).code).toBe(1)
      expect(gate({ VERCEL_ENV: 'preview', PAYTECH_ALLOW_PRODUCTION: 'true' }).code).toBe(1)
    })

    it('blocks a browser-exposed PayTech variable and a callback pin in production', () => {
      expect(gate({ NEXT_PUBLIC_PAYTECH_KEY: 'x' }).code).toBe(1)
      expect(gate({ ...MAILER, VERCEL_ENV: 'production', PAYTECH_MODE: 'prod', ...L, CRON_SECRET: 'c'.repeat(32),
        PAYTECH_CALLBACK_BASE_URL: 'https://x.vercel.app' }).code).toBe(1)
    })

    it('blocks production PayTech without the reconciliation secret', () => {
      expect(gate({ ...MAILER, VERCEL_ENV: 'production', PAYTECH_MODE: 'prod', ...L }).code).toBe(1)
    })

    it('passes a correct production configuration, and an unconfigured one', () => {
      const ok = gate({ ...MAILER, VERCEL_ENV: 'production', PAYTECH_MODE: 'prod', ...L, CRON_SECRET: 'c'.repeat(32) })
      expect(ok.code, ok.out).toBe(0)
      expect(ok.out).toMatch(/PayTech configuration verified: mode='prod' for production/)
      expect(gate({ VERCEL_ENV: 'preview' }).code).toBe(0)
    })
  })

  it('production IGNORES a callback pin (READY-E3)', async () => {
    const { paytechCallbackBaseUrl } = await import('@/lib/payments/paytech-callbacks')
    expect(paytechCallbackBaseUrl({ VERCEL_ENV: 'production', PAYTECH_CALLBACK_BASE_URL: 'https://some-preview.vercel.app' }))
      .toBe('https://www.xpclient-academy.com')
    expect(paytechCallbackBaseUrl({ VERCEL_ENV: 'preview', VERCEL_URL: 'xp-abc.vercel.app' })).toBe('https://xp-abc.vercel.app')
  })
})

describe('preview hosts do not serve a learner checkout', () => {
  it('*.vercel.app is the admin host; only the IPN and the sweep are public there', async () => {
    const { isAdminHost, isAdminHostPublicPath } = await import('@/lib/hosts')
    expect(isAdminHost('xp-preview-abc.vercel.app')).toBe(true)
    expect(isAdminHostPublicPath('/api/payments/paytech/ipn')).toBe(true)
    expect(isAdminHostPublicPath('/api/payments/paytech/reconcile')).toBe(true)
    for (const p of ['/checkout', '/payment/success', '/payment/cancel']) {
      expect(isAdminHostPublicPath(p), p).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('READY-P1 FIXED — settlement is read through a confirmed contract only (safeguard 3)', () => {
  const FIXTURE = {
    confirmedBy: 'TEST FIXTURE — not a PayTech statement',
    request: { method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' },
    successPath: 'success', statusPath: 'payment.status',
    paid: ['completed'], failed: ['failed'], cancelled: ['canceled'], pending: ['pending'],
    amountPath: null, currencyPath: null, referencePath: null,
  } as const
  const env = { PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'k', PAYTECH_TEST_API_SECRET: 's' }
  const target = { token: 'tokABCDEFGH123', refCommand: 'SCX-1' }

  async function settle(body: unknown, contract: unknown = FIXTURE) {
    const spy = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const { confirmPaymentStatus } = await import('@/lib/payments/paytech-client')
    const r = await confirmPaymentStatus(target, { env, fetchImpl: spy as unknown as typeof fetch, contract: contract as never })
    return { r, calls: spy.mock.calls.length }
  }

  it('the contract in force is null: PayTech has not documented its status response', async () => {
    const { PAYTECH_SETTLEMENT_CONTRACT } = await import('@/lib/payments/paytech-settlement-contract')
    expect(PAYTECH_SETTLEMENT_CONTRACT).toBeNull()
  })

  it('with no contract, nothing is inferred and no request is made', async () => {
    const { r, calls } = await settle({ success: 1, status: 'success', type_event: 'sale_complete' }, null)
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'contract_unconfirmed' })
    expect(calls).toBe(0)
  })

  it('a top-level request "success" never outranks the payment status', async () => {
    expect((await settle({ success: 1, status: 'success', payment: { status: 'pending' } })).r.outcome).toBe('pending')
  })

  it('every guessed word of the old allow-list is now unknown unless the contract lists it', async () => {
    for (const word of ['success', 'paid', 'complete', 'sale_complete']) {
      expect((await settle({ success: 1, payment: { status: word } })).r, word)
        .toMatchObject({ outcome: 'unknown', reason: 'status_unrecognised' })
    }
  })

  it('"failed" is its own outcome now, not "cancelled"', async () => {
    expect((await settle({ success: 1, payment: { status: 'failed' } })).r.outcome).toBe('failed')
  })

  it('a contract that is internally inconsistent is refused, not obeyed', async () => {
    const bad = { ...FIXTURE, cancelled: ['completed'] }
    expect((await settle({ success: 1, payment: { status: 'completed' } }, bad)).r)
      .toMatchObject({ outcome: 'unknown', reason: 'contract_invalid' })
  })

  it('the old guessing reader is gone', () => {
    const src = read('lib/payments/paytech-client.ts')
    expect(src).not.toMatch(/PAID_TOKENS|readStatusToken|STATUS_FIELDS/)
  })
})

describe('READY-P2 FIXED — unresolved payments are retried and reconciled', () => {
  it('transient refusals are retryable', async () => {
    const { isRetryable } = await import('@/lib/payments/payment-completion')
    expect(['entitlement_race', 'unknown_error', 'status_not_completable', 'payment_not_found'].map(isRetryable))
      .toEqual([true, true, false, false])
  })

  it('a daily sweep is scheduled, authenticated and public on the cron host', () => {
    const cron = JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] }
    expect(cron.crons).toEqual([{ path: '/api/payments/paytech/reconcile', schedule: '0 5 * * *' }])
    const route = read('app/api/payments/paytech/reconcile/route.ts')
    expect(route).toMatch(/timingSafeEqual/)
    expect(route).toMatch(/CRON_SECRET/)
  })

  it('the IPN answers 503 for every unresolved outcome', () => {
    const route = stripComments(read('app/api/payments/paytech/ipn/route.ts'))
    expect(route).toMatch(/case 'unknown':\s+return retry\(/)
    expect(route).toMatch(/result\.retryable \? retry\(/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('READY-A1 FIXED — the admin payment view tells the truth', () => {
  it('every status has its own label; test-mode sales are not revenue; provider fields shown', async () => {
    const row = (over: Record<string, unknown>) => ({
      id: String(Math.random()), amount: 45000, currency: 'XOF', method: 'card', reference: 'SCX-A',
      provider: 'paytech', provider_mode: 'live', failure_reason: null, last_ipn_at: null,
      created_at: '2026-10-01T00:00:00Z', completed_at: null,
      profiles: { full_name: 'A', email: 'a@x' }, courses: { title: 'C' }, ...over,
    })
    H.rows = [
      row({ status: 'cancelled' }), row({ status: 'expired' }), row({ status: 'refunded' }),
      row({ status: 'completed', provider_mode: 'test', completed_at: '2026-10-01T00:00:00Z' }),
      row({ status: 'completed', provider_mode: 'live', amount: 30000, completed_at: '2026-10-01T00:00:00Z' }),
      row({ status: 'processing', failure_reason: 'settlement_unknown:contract_unconfirmed' }),
    ]
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { default: AdminPaymentsPage } = await import('@/app/(admin)/admin/payments/page')
    const html = renderToStaticMarkup(await AdminPaymentsPage({}))
    expect(html.match(/>Annulé</g)?.length).toBe(1)
    expect(html.match(/>Expiré</g)?.length).toBe(1)
    expect(html.match(/>Remboursé</g)?.length).toBe(1)
    expect(html).toMatch(/30\s000 FCFA/)            // live sale only
    expect(html).toMatch(/1 paiement\(s\) de test exclu\(s\)/)
    expect(html).toMatch(/TEST/)
    expect(html).toMatch(/settlement_unknown:contract_unconfirmed/)
    expect(html).toMatch(/Vérifier auprès de PayTech/)
    expect(html).not.toMatch(/PayDunya/)
  })
})

describe('READY-D1 FIXED — the code\'s documentation matches the code', () => {
  it('no module still claims PayTech has no verification endpoint', () => {
    for (const f of ['lib/payments/paytech-client.ts', 'lib/payments/paytech-ipn.ts', 'lib/payments/payment-completion.ts']) {
      const src = read(f)
      expect(src, f).not.toMatch(/NO SERVER-TO-SERVER VERIFICATION EXISTS|NO VERIFICATION ENDPOINT|PARTIALLY UNSATISFIABLE/)
    }
  })

  it('the chokepoint cites the test that actually guards it', () => {
    const src = read('lib/payments/payment-completion.ts')
    expect(src).not.toMatch(/xp-paytech-01-completion-chokepoint\.test\.ts/)
    expect(existsSync(join(ROOT, '__tests__/payments/xp-paytech-01-checkout.test.ts'))).toBe(true)
  })

  it('the failure page no longer promises that nothing was debited', () => {
    expect(read('app/payment/success/page.tsx')).not.toMatch(/Aucun montant n&apos;a été débité/)
  })
})

describe('DATABASE GUARD — the structure that keeps every payment write behind it', () => {
  it('only the chokepoint and the checkout action write to payments', () => {
    const writers = APP_SOURCES.filter(f => /\.from\(\s*'payments'\s*\)\s*\.(insert|update|upsert|delete)\b/.test(read(f)))
    expect(writers.map(f => f.replace(/\\/g, '/')).sort()).toEqual(['app/actions/paytech-checkout.ts', 'lib/payments/payment-completion.ts'])
  })

  it('complete_payment and every status write in the chokepoint ask first', () => {
    const src = stripComments(read('lib/payments/payment-completion.ts'))
    for (const fn of ['completeVerifiedPayment', 'touchIpnReceipt', 'recordSettlementNote', 'recordTerminalFailure', 'closeUnopenedAttempt', 'closeAttemptAfterManualReconciliation']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      const guard = body.indexOf('paymentDatabaseAuthority()')
      const write = body.search(/createAdminClient\(\)/)
      expect(guard, `${fn} has no guard`).toBeGreaterThan(-1)
      expect(guard, `${fn} reaches the client before the guard`).toBeLessThan(write)
    }
  })

  it('checkout asks before its first write', () => {
    const src = stripComments(read('app/actions/paytech-checkout.ts'))
    expect(src.indexOf('paymentDatabaseAuthority()')).toBeGreaterThan(-1)
    expect(src.indexOf('paymentDatabaseAuthority()')).toBeLessThan(src.indexOf('.insert('))
    expect(src.indexOf('paymentDatabaseAuthority()')).toBeLessThan(src.indexOf('closeUnopenedAttempt({'))
  })

  it('the admin actions ask before the rate limit and before the audit row', () => {
    const src = stripComments(read('app/(admin)/admin/payments/reconcile-actions.ts'))
    for (const fn of ['verifyPaytechPayment', 'closeUnpaidPaytechPayment']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      const guard = body.indexOf('paymentDatabaseAuthority()')
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(body.indexOf('rateLimitDb('))
      expect(guard).toBeLessThan(body.indexOf('logAuditEvent('))
    }
  })

  it('the IPN and the sweep ask before they touch a payment', () => {
    for (const f of ['app/api/payments/paytech/ipn/route.ts', 'app/api/payments/paytech/reconcile/route.ts']) {
      const src = stripComments(read(f))
      expect(src.indexOf('paymentDatabaseAuthority()'), f).toBeGreaterThan(-1)
      expect(src.indexOf('paymentDatabaseAuthority()'), f).toBeLessThan(src.indexOf(".from('payments')"))
    }
  })

  it('the IPN still authenticates before reading anything', () => {
    const src = stripComments(read('app/api/payments/paytech/ipn/route.ts'))
    expect(src.indexOf('verifySharedSecretOnly(payload')).toBeLessThan(src.indexOf('paymentDatabaseAuthority()'))
  })
})

describe('vercel.json — this branch does not create a preview deployment', () => {
  // Delete this block together with the two vercel.json keys, in a commit on
  // main AFTER the merge. Removing them on the branch would itself deploy it.
  const BRANCH = 'feat/xp-paytech-04-checkout-reconciliation'
  const config = JSON.parse(read('vercel.json')) as {
    git: { deploymentEnabled: Record<string, boolean> }
    ignoreCommand: string
    crons: { path: string; schedule: string }[]
  }
  const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0
  const exitFor = (ref: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.VERCEL_GIT_COMMIT_REF
    if (ref !== undefined) env.VERCEL_GIT_COMMIT_REF = ref
    return spawnSync('sh', ['-c', config.ignoreCommand], { env }).status
  }

  it('disables automatic deployment for exactly this one branch', () => {
    expect(config.git.deploymentEnabled).toEqual({ [BRANCH]: false })
  })

  it('can never disable main, and is not a blanket switch', () => {
    expect(config.git.deploymentEnabled.main).toBeUndefined()
    expect(typeof config.git.deploymentEnabled).toBe('object')
  })

  it('the second layer names the same branch and fits Vercel\'s limit', () => {
    expect(config.ignoreCommand).toContain(`"${BRANCH}"`)
    expect(config.ignoreCommand.length).toBeLessThanOrEqual(256)
  })

  it.skipIf(!hasSh)('the second layer skips this branch and builds everything else', () => {
    expect(exitFor(BRANCH), 'exit 0 means Vercel skips the build').toBe(0)
    expect(exitFor('main'), 'exit 1 means Vercel builds').toBe(1)
    expect(exitFor('feat/anything-else')).toBe(1)
    expect(exitFor(undefined), 'a deployment with no git ref still builds').toBe(1)
    expect(exitFor('')).toBe(1)
  })

  it('still declares the sweep', () => {
    expect(config.crons).toEqual([{ path: '/api/payments/paytech/reconcile', schedule: '0 5 * * *' }])
  })
})

describe('XP-PAYTECH-05 — the exception workflow cannot complete, grant or refund', () => {
  const MODULE = stripComments(read('lib/payments/payment-exceptions.ts'))
  const ACTIONS = stripComments(read('app/(admin)/admin/payments/exception-actions.ts'))
  const SQL = read('supabase/migrations/064_payment_exceptions.sql').replace(/--[^\n]*/g, '')

  it('the module never completes a payment and never writes access', () => {
    expect(MODULE).not.toMatch(/complete_payment/)
    expect(MODULE).not.toMatch(/from\('(entitlements|enrollments)'\)\s*\.(insert|update|upsert|delete)/)
    expect(ACTIONS).not.toMatch(/complete_payment/)
    expect(ACTIONS).not.toMatch(/from\('(entitlements|enrollments|payments)'\)/)
  })

  it('migration 064 writes no access and calls no completion', () => {
    expect(SQL).not.toMatch(/(insert\s+into|update|delete\s+from|truncate)\s+(table\s+)?public\.(entitlements|enrollments)\b/i)
    expect(SQL).not.toMatch(/(perform|select|:=)\s+public\.complete_payment\s*\(/i)
    // Outside the self-test's scratch rows, the only payment writes are the two moves 063 permits.
    const raw = read('supabase/migrations/064_payment_exceptions.sql')
    const live = raw.slice(raw.indexOf('══ 1. THE RECORD'), raw.indexOf('══ 6. SELF-TEST')).replace(/--[^\n]*/g, '')
    expect(live.match(/update\s+public\.payments\b[^;]*;/gi)).toEqual([
      "update public.payments set status = 'failed', failure_reason = 'exception_refund_confirmed' where id = v_pay.id;",
      "update public.payments set status = 'refunded' where id = v_pay.id;",
    ])
    expect(live).not.toMatch(/(insert\s+into|delete\s+from)\s+public\.payments\b/i)
  })

  it('the application holds no write on the exception table, and the module writes only through functions', () => {
    const live = SQL.slice(SQL.indexOf('create table public.payment_exceptions'))
    expect(live).toMatch(/revoke all on public\.payment_exceptions from public, anon, authenticated, service_role;\s*grant select on public\.payment_exceptions to service_role;/)
    expect(MODULE).not.toMatch(/from\('payment_exceptions'\)\s*\.(insert|update|upsert|delete)/)
  })

  it('no shipped code can ask a provider for a refund', () => {
    for (const f of APP_SOURCES) {
      expect(stripComments(read(f)), f).not.toMatch(/refund-payment|\/payment\/refund/)
    }
  })

  it('only the exception module calls the exception functions', () => {
    for (const f of APP_SOURCES) {
      if (f === 'lib/payments/payment-exceptions.ts') continue
      expect(stripComments(read(f)), f).not.toMatch(/rpc\(\s*['"]payment_exception/)
    }
  })

  it('each action checks the administrator, then the database, before anything else', () => {
    const names = [...ACTIONS.matchAll(/export async function (\w+)/g)].map(m => m[1]).sort()
    expect(names).toEqual([
      'acknowledgeExceptionReport', 'confirmExceptionReceipt', 'dismissException', 'recheckException',
      'recordExceptionAccess', 'recordExceptionRefund', 'requireExceptionRefund',
      'withdrawExceptionReceipt', 'withdrawExceptionRefund',
    ])
    for (const body of [
      ACTIONS.slice(ACTIONS.indexOf('async function decision(')),
      ACTIONS.slice(ACTIONS.indexOf('export async function recordExceptionRefund(')),
      ACTIONS.slice(ACTIONS.indexOf('export async function recheckException(')),
    ]) {
      const admin = body.indexOf('requirePlatformAdmin()')
      const guard = body.indexOf('paymentDatabaseAuthority()')
      expect(admin).toBeGreaterThan(-1)
      expect(admin).toBeLessThan(guard)
      expect(guard).toBeLessThan(body.indexOf('rateLimitDb('))
    }
  })

  it('every write in the module first asks the database guard', () => {
    for (const fn of ['reportPaymentException', 'sendPendingExceptionAlerts', 'escalateStaleWatching', 'decidePaymentException', 'recordPaymentExceptionRefund']) {
      const body = MODULE.slice(MODULE.indexOf(`export async function ${fn}(`))
      expect(body.indexOf('paymentDatabaseAuthority()'), fn).toBeGreaterThan(-1)
      expect(body.indexOf('paymentDatabaseAuthority()'), fn).toBeLessThan(body.indexOf('createAdminClient()'))
    }
  })

  it('vercel.json keeps both protections for this branch', () => {
    const config = JSON.parse(read('vercel.json')) as { git: { deploymentEnabled: Record<string, boolean> }; ignoreCommand: string }
    expect(config.git.deploymentEnabled).toEqual({ 'feat/xp-paytech-04-checkout-reconciliation': false })
    expect(config.ignoreCommand).toContain('feat/xp-paytech-04-checkout-reconciliation')
  })
})

describe('XP-PAYTECH-05 — the alert carries the reference and nothing else', () => {
  it('in both formats, and escapes what it prints', async () => {
    const { paymentExceptionEmailHtml, paymentExceptionEmailText } = await import('@/lib/email/templates/payment-exception')
    expect(paymentExceptionEmailText({ reference: 'SCX-REF-1' })).toContain('SCX-REF-1')
    expect(paymentExceptionEmailHtml({ reference: 'SCX-REF-1' })).toContain('SCX-REF-1')
    expect(paymentExceptionEmailHtml({ reference: '<b>x' })).not.toContain('<b>x')
    expect(Object.keys({ reference: '' } satisfies import('@/lib/email/templates/payment-exception').PaymentExceptionEmailData)).toEqual(['reference'])
  })

  it('says what the alert does, without claiming a state it cannot know', async () => {
    const { paymentExceptionEmailText, paymentExceptionEmailHtml } = await import('@/lib/email/templates/payment-exception')
    // The record may concern a completed payment, where access HAS been granted.
    for (const out of [paymentExceptionEmailText({ reference: 'R' }), paymentExceptionEmailHtml({ reference: 'R' })]) {
      expect(out).toMatch(/Cette alerte n'accorde aucun accès et n'effectue aucun remboursement/)
      expect(out).not.toMatch(/Aucun accès n'a été accordé/)
    }
  })

  it('a dry run reports that it delivered nothing, so an alert stays due', async () => {
    vi.stubEnv('EMAIL_DRY_RUN', 'true')
    vi.resetModules()
    const { sendPaymentExceptionAlert } = await import('@/lib/email')
    expect(await sendPaymentExceptionAlert('owner@example.test', { reference: 'R' })).toEqual({ success: true, dryRun: true })
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})

describe('XP-PAYTECH-05 — the admin queue', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    id: '30000000-0000-4000-8000-000000000001', paymentId: '40000000-0000-4000-8000-000000000001',
    state: 'open', firstSignal: 'paid_hint', lastSignal: 'paid_hint', detail: null, reportCount: 2,
    firstReportedAt: '2026-10-01T00:00:00Z', lastReportedAt: '2026-10-02T00:00:00Z',
    paymentReceived: 'reported', accessState: 'not_granted', refundState: 'not_assessed',
    refundExternalReference: null, refundAmount: null, refundCurrency: null, refundConfirmedAt: null,
    resolution: null, resolvedAt: null, alertSentAt: null, postSettlementReportAt: null,
    payment: { reference: 'SCX-REF-1', status: 'expired', amount: 45000, currency: 'XOF', providerMode: 'live' },
    learner: { name: 'Awa', email: 'awa@example.test' }, courseTitle: 'Fondamentaux',
    accessLive: false, otherCompletedReference: null, ...over,
  })
  const render = async (exceptions: unknown) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { default: ExceptionQueue } = await import('@/app/(admin)/admin/payments/ExceptionQueue')
    return renderToStaticMarkup(ExceptionQueue({ exceptions: exceptions as never }))
  }

  it('shows the four facts apart', async () => {
    const html = await render([view({ paymentReceived: 'confirmed_by_provider', refundState: 'required', accessLive: true })])
    for (const label of ['Paiement reçu', 'Accès accordé', 'Remboursement requis', 'Remboursement confirmé']) expect(html).toContain(label)
    expect(html).toContain('Confirmé par PayTech')
    expect(html).toContain('Accès actif, autre origine')
  })

  it('an unproven report offers a check and a dismissal, and no refund or access', async () => {
    const html = await render([view()])
    expect(html).toContain('Signalé, non prouvé')
    expect(html).toContain('Confirmer la réception des fonds')
    expect(html).toContain('Classer : rien à rembourser')
    expect(html).not.toContain('Un remboursement est nécessaire')
    expect(html).not.toContain('Enregistrer le remboursement effectué')
    expect(html).not.toContain('L’accès a été accordé pour ce paiement')
  })

  it('confirmed money can no longer be dismissed on a closed payment', async () => {
    const html = await render([view({ paymentReceived: 'confirmed_by_operator' })])
    expect(html).not.toContain('Classer : rien à rembourser')
    expect(html).not.toContain('Confirmer la réception des fonds')
    expect(html).toContain('Un remboursement est nécessaire')
    expect(html).toContain('L’accès a été accordé pour ce paiement')
    expect(html).toContain('Ceci n’accorde rien')
  })

  it('a completed payment under question can be cleared, and has no access decision', async () => {
    const html = await render([view({
      paymentReceived: 'confirmed_by_provider', lastSignal: 'cancel_hint',
      payment: { reference: 'SCX-REF-1', status: 'completed', amount: 45000, currency: 'XOF', providerMode: 'live' },
    })])
    expect(html).toContain('Classer : rien à rembourser')
    expect(html).toContain('ce paiement reste valable')
    expect(html).not.toContain('L’accès a été accordé pour ce paiement')
  })

  it('a required refund offers the record form, which says it happened elsewhere', async () => {
    const html = await render([view({ paymentReceived: 'confirmed_by_operator', refundState: 'required' })])
    expect(html).toContain('Enregistrer le remboursement effectué')
    expect(html).toContain('confirmé en dehors de la plateforme')
    expect(html).not.toContain('Un remboursement est nécessaire')
    expect(html).toContain('Annuler la décision de remboursement')
    // Only a full refund can be recorded until a policy exists.
    expect(html).not.toContain('partiel')
    expect(html).not.toContain('name="partial"')
  })

  it('an administrator can withdraw their own confirmation, and not PayTech\'s', async () => {
    expect(await render([view({ paymentReceived: 'confirmed_by_operator' })])).toContain('Annuler ma confirmation de réception')
    expect(await render([view({ paymentReceived: 'confirmed_by_provider' })])).not.toContain('Annuler ma confirmation de réception')
    expect(await render([view({ paymentReceived: 'confirmed_by_operator', refundState: 'required' })])).not.toContain('Annuler ma confirmation de réception')
  })

  it('names an unproven report for what it is', async () => {
    const html = await render([view({ lastSignal: 'unverified_report', paymentReceived: 'not_established', detail: 'ipn_signature_mismatch' })])
    expect(html).toContain('signature n’a pas pu être vérifiée')
    expect(html).toContain('Non établi')
  })

  it('a resolved record offers nothing and shows the refund', async () => {
    const html = await render([view({
      state: 'resolved', resolution: 'refund_confirmed', refundState: 'confirmed', paymentReceived: 'confirmed_by_operator',
      refundExternalReference: 'PT-REFUND-0001', refundAmount: 45000, refundCurrency: 'XOF', refundConfirmedAt: '2026-10-03T00:00:00Z',
      resolvedAt: '2026-10-03T00:00:00Z',
    })])
    expect(html).toContain('PT-REFUND-0001')
    expect(html).not.toContain('Vérifier à nouveau')
    expect(html).not.toContain('<form')
  })

  it('a paid report after settlement is unmissable, and its only action changes no settled fact', async () => {
    const html = await render([view({
      state: 'resolved', resolution: 'refund_confirmed', refundState: 'confirmed', paymentReceived: 'confirmed_by_operator',
      refundExternalReference: 'PT-REFUND-0001', refundAmount: 45000, refundCurrency: 'XOF', refundConfirmedAt: '2026-10-03T00:00:00Z',
      resolvedAt: '2026-10-03T00:00:00Z', postSettlementReportAt: '2026-10-04T00:00:00Z',
    })])
    expect(html).toContain('un second paiement réel')
    expect(html).toContain('Marquer ce signalement comme vérifié')
    expect(html).not.toContain('Vérifier à nouveau')
    expect(html).not.toContain('Enregistrer le remboursement effectué')
  })

  it('flags a possible double payment', async () => {
    expect(await render([view({ otherCompletedReference: 'SCX-OTHER' })])).toMatch(/Paiement possible en double[\s\S]*SCX-OTHER/)
  })

  it('an unreadable queue never looks like an empty one', async () => {
    expect(await render(null)).toMatch(/n’a pas pu être lue/)
    expect(await render([])).toContain('Aucune anomalie ouverte')
  })

  it('is a server component, and the page authorises before it reads', () => {
    expect(read('app/(admin)/admin/payments/ExceptionQueue.tsx')).not.toMatch(/['"]use client['"]/)
    const page = stripComments(read('app/(admin)/admin/payments/page.tsx'))
    expect(page.indexOf('requirePlatformAdmin()')).toBeLessThan(page.indexOf('countOpenPaymentExceptions()'))
    const dashboard = stripComments(read('app/(admin)/admin/page.tsx'))
    expect(dashboard.indexOf('requirePlatformAdmin()')).toBeLessThan(dashboard.indexOf('countOpenPaymentExceptions()'))
  })

  describe('the payments page before migration 064 is applied', () => {
    const page = async (searchParams?: Record<string, string>) => {
      H.rows = []
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { default: AdminPaymentsPage } = await import('@/app/(admin)/admin/payments/page')
      return renderToStaticMarkup(await AdminPaymentsPage(searchParams ? { searchParams: Promise.resolve(searchParams) } : {}))
    }
    const anomalies = (html: string) => /Anomalies \(([^)]*)\)/.exec(html.replace(/<!-- -->/g, ''))?.[1]
    afterEach(() => { H.exceptionTable = 'ok' })

    it('shows a real zero only when the table answered zero', async () => {
      expect(anomalies(await page())).toBe('0')
    })

    it.each(['error', 'missing_head'] as const)('on %s it still renders, and says it does not know', async (mode) => {
      H.exceptionTable = mode
      expect(anomalies(await page())).toBe('?')
    })

    it('the queue says it could not be read, rather than looking empty', async () => {
      H.exceptionTable = 'error'
      expect(await page({ filter: 'exceptions' })).toMatch(/n’a pas pu être lue/)
    })
  })

  it('a refusal the page has no words for is still shown', async () => {
    H.rows = []
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { default: AdminPaymentsPage } = await import('@/app/(admin)/admin/payments/page')
    const html = renderToStaticMarkup(await AdminPaymentsPage({ searchParams: Promise.resolve({ notice: 'exception_refused_unknown_error' }) }))
    expect(html).toContain('Décision refusée')
    const plain = renderToStaticMarkup(await AdminPaymentsPage({ searchParams: Promise.resolve({ notice: 'not_a_real_notice' }) }))
    expect(plain).not.toContain('Décision refusée')
  })
})

describe('XP-PAYTECH-05 — the public documents', () => {
  const PUBLIC = [
    'docs/payments/XP-PAYTECH-05-LATE-PAID-EXCEPTIONS.md',
    'docs/payments/XP-PAYTECH-04-PULL-REQUEST.md',
    'docs/payments/XP-PAYTECH-READY-01-SUMMARY.md',
    'supabase/migrations/064_payment_exceptions.sql',
    'lib/payments/payment-exceptions.ts',
    'app/(admin)/admin/payments/exception-actions.ts',
    'app/(admin)/admin/payments/ExceptionQueue.tsx',
    'lib/email/templates/payment-exception.ts',
  ]

  it('no longer call F4 mitigated, and name it a blocker', () => {
    const summary = read('docs/payments/XP-PAYTECH-READY-01-SUMMARY.md')
    const f4 = summary.split('\n').find(l => l.startsWith('| F4 |'))!
    expect(f4).not.toMatch(/mitigated/i)
    expect(f4).toMatch(/Open: mandatory blocker/)
    const pr = read('docs/payments/XP-PAYTECH-04-PULL-REQUEST.md')
    const before = pr.slice(pr.indexOf('## 10. Before live payments'), pr.indexOf('## 11. Known limitations'))
    expect(before).toMatch(/Late paid notifications \(F4\) are mandatory/)
    expect(before).toMatch(/refund policy/)
  })

  it('state that nothing here is live or proven with the provider', () => {
    const doc = read('docs/payments/XP-PAYTECH-05-LATE-PAID-EXCEPTIONS.md')
    expect(doc).toMatch(/Not live/)
    expect(doc).toMatch(/has not been applied to any hosted database/)
    expect(doc).toMatch(/cannot be detected until the settlement contract is confirmed/)
  })

  it('disclose no infrastructure identifier or private record', () => {
    const FORBIDDEN = [
      /[a-z]{20}\.supabase\.co/, /\bprj_[A-Za-z0-9]/, /\bteam_[A-Za-z0-9]/, /vercel\.app/,
      /C:\\/, /same database/i, /shares? (one|a) database/i,
    ]
    // Digests, on purpose. A list of the private identifiers would itself publish
    // them, and this repository is public. Each word of each file is hashed and
    // compared, so this file can be scanned along with everything else.
    const PRIVATE_WORDS = new Set([
      'c263ecbbabde04b0425376024da146da48eeb6a927a24f7628d641cb330fe189',
      '29243a205260ab94b838664a4eb018ce0f2ba4a851d44b2d5fd24c766596e605',
      '2eda8fde4af3d9017965b8e10a63d524514df5066a11f3df649763fbdf9128b2',
      '377edee54d4c27c9e10e3bc0d6308552c056c2de0b6e2b09498b247b9f7b04a5',
      '5136e3864eff6f5dd498f29ec864fd1ca6a97932da2d7f49ceccfb10475dd0b7',
      'd5f19b52b6b2ffcda7c214694f4de26001a4b06e1f9bed76777ab48ce24d35de',
    ])
    // Runs of words too, so that a private path or address is caught whatever joins it.
    const PRIVATE_PHRASES = new Set([
      'b8fd7d3f577893bb668f40713df37181e30ec493ec83a22bcf125048de907ab4',
      'bb279daed3f1741b1ec28d2400e037288d414f6bfebb3525a748acd3548c8391',
    ])
    const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
    const digest = (w: string) => createHash('sha256').update(w).digest('hex')
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap(name => {
      const rel = `${dir}/${name}`
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel]
    })
    const SCANNED = [...new Set([
      ...PUBLIC,
      ...walk('docs/payments'),
      ...walk('lib/payments'),
      ...walk('app/(admin)/admin/payments'),
      ...walk('app/api/payments'),
      '__tests__/payments/xp-paytech-ready-01-integration.test.ts',
      '__tests__/payments/xp-paytech-ready-01-readiness.test.ts',
    ])]
    for (const f of SCANNED) {
      const src = read(f)
      for (const re of PUBLIC.includes(f) ? FORBIDDEN : [FORBIDDEN[0], FORBIDDEN[1], FORBIDDEN[2]]) {
        expect(src, `${f} matches ${re}`).not.toMatch(re)
      }
      const ws = words(src)
      const unique = [...new Set(ws)]
      // A commit hash may be quoted in full: compare its short form as well.
      const hit = unique.find(w => PRIVATE_WORDS.has(digest(w)) || (/^[0-9a-f]{8,40}$/.test(w) && PRIVATE_WORDS.has(digest(w.slice(0, 7)))))
      expect(hit === undefined, `${f} contains a private identifier`).toBe(true)
      const pairs = ws.flatMap((w, i) => [`${w} ${ws[i + 1] ?? ''}`, `${w} ${ws[i + 1] ?? ''} ${ws[i + 2] ?? ''}`])
      expect(pairs.some(p => PRIVATE_PHRASES.has(digest(p))), `${f} contains a private path or address`).toBe(false)
    }
  })
})
