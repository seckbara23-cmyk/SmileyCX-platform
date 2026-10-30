/**
 * PAY-2D-0 — payment integration hygiene.
 *
 * A hygiene slice is the easiest place to do quiet damage: it touches a
 * credential boundary, a type contract and three security guards, and none of
 * those changes is visible at runtime. So every change it makes is pinned here,
 * and so is every boundary it must NOT have moved.
 *
 * What this slice did:
 *
 *   1. DELETED lib/payments/index.ts. It exported `unlockEnrollment`, which
 *      granted an ENROLLMENT — an authority that grants nothing since XPA-6B
 *      (migration 037 made `entitlements` the sole access authority). It was
 *      imported by no module, and it named Stripe/Wave/Orange credentials that
 *      no code reads. Its real cost was not the dead code: BOTH repo-wide
 *      payment guards carried an explicit `continue` for this exact path, so
 *      the single-writer sweep had a hole shaped precisely like it.
 *   2. Removed those two carve-outs, so the guards now scan the whole surface.
 *   3. Added `import 'server-only'` to lib/supabase/admin.ts.
 *   4. Brought types/index.ts up to the 058/060 schema: seven payment statuses
 *      and the nine provider/reconciliation columns.
 *   5. Replaced the obsolete migration-003 reference in app/actions/payment.ts.
 *
 * What it must NOT have done: added any completion authority, caller, client,
 * route or flag change. Those assertions are the second half of this file and
 * matter more than the first.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const ADMIN   = 'lib/supabase/admin.ts'
const TYPES   = 'types/index.ts'
const ACTION  = 'app/actions/payment.ts'
const STUB    = 'lib/payments/index.ts'
const CONFIG  = 'lib/payments/paydunya-config.ts'

/** Comments blanked so prose cannot satisfy — or trip — an assertion. */
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
   .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))

function sourceFiles(dirs: readonly string[] = ['app', 'components', 'lib', 'types']): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries
    try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) { walk(p); continue }
      if (/\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  dirs.forEach(walk)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 1. the obsolete stub is gone, and nothing reached for it', () => {
  it('lib/payments/index.ts no longer exists', () => {
    expect(existsSync(join(ROOT, STUB))).toBe(false)
  })

  it('lib/payments contains only the authorised modules', () => {
    // Still pinned EXACTLY, so an unreviewed module appearing here fails. The
    // set grew once, in XP-PAYTECH-01: a second provider's credential boundary,
    // transport and IPN verification, plus the shared completion chokepoint and
    // provider selection.
    const files = readdirSync(join(ROOT, 'lib/payments')).sort()
    expect(files).toEqual([
      'paydunya-client.ts',
      'paydunya-config.ts',
      'payment-completion.ts',
      'payment-database-guard.ts',
      'paytech-callbacks.ts',
      'paytech-client.ts',
      'paytech-config.ts',
      'paytech-ipn.ts',
      'paytech-reconcile.ts',
      'paytech-settlement-contract.ts',
      'providers.ts',
      'purchase-eligibility.ts',
    ])
  })

  it('no module imports @/lib/payments by any spelling', () => {
    const importers = sourceFiles().filter(f =>
      /from\s+['"](@\/lib\/payments|[^'"]*\/lib\/payments)['"]|require\(\s*['"][^'"]*lib\/payments['"]\s*\)/
        .test(read(f)))
    expect(importers, `imported by: ${importers.join(', ')}`).toEqual([])
  })

  it('none of the deleted exports is referenced anywhere', () => {
    // If any of these reappears, something resurrected the wrong authority.
    const GONE = ['unlockEnrollment', 'initiateOrangeMoney', 'verifyOrangeMoney',
                  'initiateWave', 'verifyWave', 'initiateStripe', 'initiatePayment',
                  'PaymentInitParams', 'PaymentInitResult', 'PaymentVerifyResult'] as const
    const hits: string[] = []
    for (const f of sourceFiles()) {
      const src = stripTs(read(f))
      for (const sym of GONE) if (new RegExp(`\\b${sym}\\b`).test(src)) hits.push(`${f}:${sym}`)
    }
    expect(hits, `resurrected symbols: ${hits.join(', ')}`).toEqual([])
  })

  it('the legacy gateway credentials are read by no code at all', () => {
    // They remain in .env.local as recorded debt. The invariant is that no CODE
    // reads them — asserted across the tree, not against one file's contents.
    const LEGACY = ['STRIPE_SECRET_KEY', 'WAVE_API_KEY', 'ORANGE_MONEY_CLIENT_SECRET',
                    'ORANGE_MONEY_CLIENT_ID', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'] as const
    const readers: string[] = []
    for (const f of sourceFiles()) {
      const src = read(f)
      for (const name of LEGACY) {
        if (new RegExp(`process\\.env\\.${name}\\b|process\\.env\\[\\s*['"\`]${name}`).test(src)) {
          readers.push(`${f}:${name}`)
        }
      }
    }
    expect(readers, `now read by: ${readers.join(', ')}`).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 2. the guards carry no carve-out any more', () => {
  const GUARDS = [
    '__tests__/payments/pay-2c-0-legacy-activation-disabled.test.ts',
    '__tests__/payments/pay-2b-payment-completion-contract.test.ts',
  ] as const

  it('neither repo-wide guard skips lib/payments/index.ts', () => {
    for (const g of GUARDS) {
      // Comments blanked: both guards now QUOTE the carve-out they removed, in
      // prose, to explain the change. Only executable code counts.
      const code = stripTs(read(g))
      expect(code, `${g} still excludes the stub path from its sweep`)
        .not.toMatch(/(continue|\|\|)[^\n]*lib\/payments\/index\.ts|lib\/payments\/index\.ts[^\n]*continue/)
    }
  })

  it('both guards assert the stub has not returned', () => {
    for (const g of GUARDS) {
      expect(stripTs(read(g)), `${g} does not notice if the stub reappears`)
        .toMatch(/existsSync\([^)]*lib\/payments\/index\.ts'\)\)?,?[\s\S]{0,120}toBe\(false\)/)
    }
  })

  it('the single-writer sweep still names exactly the two legitimate enrollment writers', () => {
    // The property the deleted carve-out was hiding. Proven here directly, not
    // just in the guard that used to exclude the stub.
    const writers: string[] = []
    for (const f of sourceFiles(['app', 'components', 'lib'])) {
      const code = stripTs(read(f))
      for (const m of code.matchAll(/from\(\s*['"]enrollments['"]\s*\)/g)) {
        if (/\.(update|upsert|insert|delete)\(/.test(code.slice(m.index!, m.index! + 300))) {
          writers.push(f)
        }
      }
    }
    expect([...new Set(writers)].sort())
      .toEqual(['app/actions/enrollment.ts', 'app/actions/entitlements.ts'])
  })

  it('exactly one module writes entitlements, and it is the audited admin path', () => {
    const granters: string[] = []
    for (const f of sourceFiles(['app', 'components', 'lib'])) {
      const code = stripTs(read(f))
      for (const m of code.matchAll(/from\(\s*['"]entitlements['"]\s*\)/g)) {
        if (/\.(update|upsert|insert|delete)\(/.test(code.slice(m.index!, m.index! + 300))) {
          granters.push(f)
        }
      }
    }
    expect([...new Set(granters)].sort()).toEqual(['app/actions/entitlements.ts'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 3. the service-role client is server-only by mechanism', () => {
  it("lib/supabase/admin.ts declares import 'server-only' as its first statement", () => {
    const lines = read(ADMIN).split('\n').filter(l => l.trim().length > 0)
    expect(lines[0].trim()).toBe("import 'server-only'")
  })

  it('every importer of the admin client is a server module', () => {
    const importers = sourceFiles().filter(f =>
      /from\s+['"](@\/lib\/supabase\/admin|[^'"]*\/lib\/supabase\/admin)['"]/.test(read(f)))
    expect(importers.length).toBeGreaterThan(0)
    const clientSide = importers.filter(f => /^\s*['"]use client['"]/.test(read(f)))
    expect(clientSide, `client components importing the service-role client: ${clientSide.join(', ')}`)
      .toEqual([])
  })

  it('the service-role key is read by this module alone', () => {
    const readers = sourceFiles().filter(f =>
      /process\.env\.SUPABASE_SERVICE_ROLE_KEY|process\.env\[\s*['"`]SUPABASE_SERVICE_ROLE_KEY/
        .test(read(f)))
    expect(readers).toEqual([ADMIN])
  })

  it('the credential boundary it sits beside is still server-only too', () => {
    expect(read(CONFIG).split('\n')[0].trim()).toBe("import 'server-only'")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 4. the payment type contract matches 058 and 060', () => {
  const SRC = read(TYPES)

  it('PaymentStatus lists exactly the seven states 060 installed', () => {
    const m = /export type PaymentStatus\s*=([\s\S]*?)(?=\n\/\*\*|\nexport )/.exec(SRC)
    expect(m, 'PaymentStatus is no longer where this test looks').toBeTruthy()
    const states = [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(states).toEqual(['cancelled', 'completed', 'expired', 'failed',
                            'pending', 'processing', 'refunded'])
  })

  it('the seven states are exactly what the migration CHECK admits', () => {
    // Parsed from the migration, not retyped, so a divergence fails here.
    const mig = read('supabase/migrations/060_payment_completion_contract.sql')
    const chk = /add constraint payments_status_valid\s*\n\s*check \(status in \(([\s\S]*?)\)\);/
      .exec(mig)
    expect(chk, 'the 060 status CHECK is no longer where this test looks').toBeTruthy()
    const dbStates = [...chk![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    const m = /export type PaymentStatus\s*=([\s\S]*?)(?=\n\/\*\*|\nexport )/.exec(SRC)
    const tsStates = [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(tsStates).toEqual(dbStates)
  })

  it('PaymentMethod is unchanged — the aggregator is not a method', () => {
    const m = /export type PaymentMethod\s*=([^\n]*)/.exec(SRC)
    const methods = [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(methods).toEqual(['card', 'orange_money', 'wave'])
    expect(methods, "'paydunya' is a provider, never a method").not.toContain('paydunya')
  })

  it('Payment carries every column 058 and 060 added, each nullable', () => {
    const body = /export interface Payment \{([\s\S]*?)\n\}/.exec(SRC)
    expect(body, 'the Payment interface moved').toBeTruthy()
    for (const col of ['provider', 'provider_mode', 'provider_token', 'entitlement_id',
                       'failure_reason', 'last_ipn_at']) {
      expect(body![1], `Payment is missing ${col}`).toMatch(new RegExp(`\\b${col}\\b`))
      expect(body![1], `${col} must be nullable, as the database has it`)
        .toMatch(new RegExp(`\\b${col}\\s*:[^\\n]*\\| null`))
    }
  })

  it('the pre-existing fields keep exactly their old contracts', () => {
    // Widening must not weaken. These were non-null before and stay non-null.
    const body = /export interface Payment \{([\s\S]*?)\n\}/.exec(SRC)![1]
    for (const [field, type] of [['id', 'string'], ['user_id', 'string'],
                                 ['course_id', 'string'], ['amount', 'number'],
                                 ['currency', 'string'], ['reference', 'string'],
                                 ['created_at', 'string']] as const) {
      expect(body, `${field} changed type or became nullable`)
        .toMatch(new RegExp(`\\b${field}\\s*:\\s*${type}\\s*\\n`))
    }
    // And the two that were already nullable still are.
    for (const field of ['provider_reference', 'completed_at']) {
      expect(body).toMatch(new RegExp(`\\b${field}\\s*:[^\\n]*\\| null`))
    }
  })

  it('Payment matches the nineteen columns the database actually has', () => {
    const body = /export interface Payment \{([\s\S]*?)\n\}/.exec(SRC)![1]
    const fields = [...stripTs(body).matchAll(/^\s{2}(\w+)\s*[?:]/gm)].map(m => m[1]).sort()
    expect(fields).toEqual([
      'amount', 'completed_at', 'course_id', 'created_at', 'currency', 'entitlement_id',
      'failure_reason', 'id', 'last_ipn_at', 'metadata', 'method', 'provider',
      'provider_mode', 'provider_reference', 'provider_token', 'reference', 'status',
      'user_id',
    ].sort())
    // company_id is the nineteenth database column and is deliberately absent
    // from this interface, exactly as it was before this slice.
    expect(fields).not.toContain('company_id')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 5. the obsolete migration-003 reference is corrected', () => {
  const SRC = read(ACTION)

  it('migration 003 is no longer cited as the completion path', () => {
    expect(SRC).not.toMatch(/complete_payment\(\)\s*SQL\s*fn/)
    expect(SRC).not.toMatch(/Add \/api\/webhooks\/\[provider\] handlers/)
  })

  it('the comment states that 062 is the sole authority and this action cannot complete', () => {
    // XP-PAYTECH-04 retired this action into a refusal. Its comment now says
    // so, and says where payment starts instead.
    expect(SRC).toMatch(/RETIRED by XP-PAYTECH-04/)
    expect(SRC).toMatch(/NOTHING IS IMPORTED/)
    expect(SRC).toMatch(/paytech-checkout\.ts/)
    expect(SRC).not.toMatch(/003_payment_readiness/)
  })

  it('and the action still, in fact, cannot complete a payment', () => {
    // Prose is not a control. The code must agree with it.
    const code = stripTs(SRC)
    expect(code, 'the action gained an RPC call').not.toMatch(/\.rpc\(/)
    expect(code, 'the action writes entitlements').not.toMatch(/from\(\s*['"]entitlements['"]\s*\)/)
    expect(code, 'the action writes enrollments').not.toMatch(/from\(\s*['"]enrollments['"]\s*\)/)
    expect(code, 'the action writes audit rows').not.toMatch(/from\(\s*['"]audit_log['"]\s*\)/)
    expect(code, "the action marks something completed").not.toMatch(/'completed'/)
    expect(code, 'the action sets a completion timestamp').not.toMatch(/completed_at/)
    // XP-PAYTECH-04: it performs no write at all now — stronger than the
    // single pending insert this used to pin.
    const writes = [...code.matchAll(/\.(insert|upsert|update|delete)\(/g)].map(m => m[1])
    expect(writes).toEqual([])
    expect(code).not.toMatch(/^\s*import\s/m)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2D-0 · 6. the fail-closed boundaries this slice must not have moved', () => {
  it('complete_payment has EXACTLY ONE caller, and it is the designated chokepoint', () => {
    // This guard used to require zero callers, because no trusted caller
    // existed. XP-PAYTECH-01 built one, so the invariant becomes migration
    // 062's obligation 5 — exactly one module may call the authority — which is
    // strictly stronger than "none", since it also forbids a SECOND caller
    // appearing beside the reviewed one.
    const callers: string[] = []
    for (const f of sourceFiles()) {
      if (/\.rpc\(\s*['"]complete_payment['"]/.test(stripTs(read(f)))) callers.push(f)
    }
    expect(callers, `complete_payment is called by: ${callers.join(', ')}`)
      .toEqual(['lib/payments/payment-completion.ts'])
  })

  it('exactly ONE notification handler exists, and it is the reviewed PayTech IPN', () => {
    // This required zero notification receivers before XP-PAYTECH-01. One now
    // exists. Pinning it EXACTLY keeps the original protection: a second,
    // unreviewed endpoint that could receive a payment notification still
    // fails this test.
    const routes = sourceFiles(['app']).filter(f => /\/route\.tsx?$/.test(f))
    const payment = routes
      .filter(r => /webhook|callback|ipn|paydunya|paytech|payment/i.test(r))
      // app/auth/callback/route.ts is Supabase AUTH, unrelated to payments.
      .filter(r => !r.startsWith('app/auth/'))
    // XP-PAYTECH-04 added the reconciliation sweep. It is NOT a notification
    // receiver — it asks the provider, it is never told — and it authenticates
    // every call with CRON_SECRET in constant time. Both are pinned by name, so
    // a third payment-ish route still fails.
    expect(payment, `payment-ish routes: ${payment.join(', ')}`)
      .toEqual(['app/api/payments/paytech/ipn/route.ts', 'app/api/payments/paytech/reconcile/route.ts'])
    const sweep = read('app/api/payments/paytech/reconcile/route.ts')
    expect(sweep).toMatch(/CRON_SECRET/)
    expect(sweep).toMatch(/timingSafeEqual/)
    expect(sweep).not.toMatch(/export async function POST/)

    expect(existsSync(join(ROOT, 'app/api/webhooks'))).toBe(false)
    // The completion module has its reviewed name; a stray `completion.ts`
    // would be an unreviewed second authority.
    expect(existsSync(join(ROOT, 'lib/payments/completion.ts'))).toBe(false)

    // The PayDunya transport still has no caller: this slice added a provider
    // beside it without activating it.
    const callers = sourceFiles().filter(f =>
      /from\s+['"][^'"]*paydunya-client['"]/.test(read(f)))
    expect(callers, `the PayDunya transport is now called by: ${callers.join(', ')}`).toEqual([])
  })

  it('provider endpoints appear ONLY in the authorised transport module', () => {
    const TRANSPORT = 'lib/payments/paydunya-client.ts'
    const hits: string[] = []
    for (const f of sourceFiles()) {
      if (f === TRANSPORT) continue
      if (/app\.paydunya\.com|checkout-invoice/i.test(stripTs(read(f)))) hits.push(f)
    }
    expect(hits, `provider endpoints referenced by: ${hits.join(', ')}`).toEqual([])
    // The exemption is only meaningful while that module stays transport-only.
    const t = stripTs(read(TRANSPORT))
    expect(t, 'the transport module reached for a database client')
      .not.toMatch(/@\/lib\/supabase|createAdminClient/)
    expect(t, 'the transport module called an RPC').not.toMatch(/\.rpc\(/)
  })

  it('the payment feature flag and platform mode are untouched and still off', () => {
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      const env = read('.env.local')
      expect(env).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
      expect(env, 'PLATFORM_MODE left pilot').toMatch(/^NEXT_PUBLIC_PLATFORM_MODE\s*=\s*pilot/m)
      expect(env, 'a PayDunya credential appeared').not.toMatch(/^PAYDUNYA_/m)
    }
    // The flag still requires an exact 'true', so an absent variable is false.
    expect(read('lib/pilot.ts')).toMatch(/NEXT_PUBLIC_PAYMENTS_ENABLED\s*===\s*'true'/)
  })

  it('this slice added no migration, and 062 is untouched', () => {
    const migs = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    // XP-PAYTECH-04 authored 063 (the payment state machine); it is admitted by name.
    expect(migs).toHaveLength(61)
    expect(migs).toContain('063_payment_state_machine.sql')
    expect(migs.filter(f => /^06[3-9]|^0[7-9]\d|^[1-9]\d\d/.test(f) && f !== '063_payment_state_machine.sql'),
      'a migration was added').toEqual([])
    // 062's byte identity, as released.
    const { createHash } = require('crypto') as typeof import('crypto')
    const raw = readFileSync(join(ROOT, 'supabase/migrations/062_atomic_payment_completion.sql'))
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('899cd3832573383b20df4dc09003f702a860c4ccb4651caead1a0bee817f31bb')
  })

  it('checkout behaviour is unchanged by this slice', () => {
    // The checkout rework is PAY-2D-4 and is explicitly out of scope here.
    const page = read('app/(platform)/checkout/page.tsx')
    // ENR-01C-b removed the `if (PILOT_MODE)` branch this used to pin, which
    // redirected every caller into /learn without consulting the access gate.
    // That assertion only marked the branch's EXISTENCE, so re-aiming it at the
    // property the branch violated is strictly stronger than restating it: this
    // slice must not reintroduce a lesson redirect from checkout.
    expect(page, 'checkout redirects into /learn again').not.toContain('redirect(`/learn/')
    // XP-PAYTECH-04 is that checkout rework. The gate is server-side and the
    // only control redirects to PayTech; the card-collecting selector is gone.
    expect(page).toMatch(/if \(!paytechCheckoutAvailability\(\)\.available\)/)
    const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(pageCode, 'the NEXT_PUBLIC flag is read again').not.toMatch(/PAYMENTS_ENABLED/)
    expect(existsSync(join(ROOT, 'components/payment/PaymentMethodSelector.tsx'))).toBe(false)
    const button = read('components/payment/PaytechCheckoutButton.tsx')
    expect(button).toMatch(/startPaytechCheckout\(\{ courseId \}\)/)
    expect(button, 'the button started talking to PayDunya')
      .not.toMatch(/app\.paydunya\.com|response_text|invoice_url/)
  })
})
