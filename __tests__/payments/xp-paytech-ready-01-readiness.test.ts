// @vitest-environment node
/**
 * XP-PAYTECH-04 — production-readiness facts that need no database. The
 * database-level evidence lives in `xp-paytech-ready-01-integration.test.ts`.
 *
 * Everything runs against the real modules. The only stubs are `fetch`, the
 * admin Supabase client for the admin page render, and the admin session guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const H = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))
vi.mock('@/lib/auth/session', () => ({ requirePlatformAdmin: async () => ({ id: 'admin' }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let completedOnly = false
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain,
        eq: (c: string, v: string) => { if (c === 'status' && v === 'completed') completedOnly = true; return chain },
        then: (res: (_v: unknown) => unknown) => Promise.resolve({
          data: completedOnly ? H.rows.filter(r => r.status === 'completed') : H.rows, error: null,
        }).then(res),
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
