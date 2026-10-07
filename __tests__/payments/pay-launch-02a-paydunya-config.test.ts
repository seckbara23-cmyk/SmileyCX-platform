// @vitest-environment node
/**
 * PAY-LAUNCH-02A — the PayDunya TEST/LIVE configuration boundary.
 *
 * ── WHY THIS SLICE EXISTS BEFORE ANY PAYMENT CODE ─────────────────────────
 *
 * The costly failure in a payment integration is not a bug in the checkout
 * call. It is a deployment that charges real money while everyone believes it is
 * in test mode, or one that silently stops charging because a credential went
 * missing. Both are configuration failures. So the boundary is built — and
 * tested — before anything can take a payment.
 *
 * Two layers, deliberately different:
 *
 *   RUNTIME   `resolvePaydunyaConfig()` refuses to resolve at all unless the
 *             mode is exactly 'test' or 'live' AND all three credentials for
 *             THAT mode are present. Names are built from the mode, so test
 *             mode is structurally unable to read a LIVE variable.
 *
 *   DEPLOY    `verify-prod-config.mjs` refuses the BUILD when LIVE credentials
 *             are merely PRESENT outside live mode. Presence is the risk: a key
 *             in the environment is one dashboard edit away from charging real
 *             money, whatever the flag says today.
 *
 * Every environment here is a plain object passed in, so no test mutates the
 * real `process.env` and none can leak a value into a snapshot.
 *
 * This slice adds no PayDunya client, no route and no schema. The payment
 * feature flag stays off, and the final describe pins that.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

// `server-only` has no resolvable module under vitest; the repository's other
// server-module suites shim it the same way. Its real effect — a build error if
// a client component imports this file — is asserted on the source text below.
vi.mock('server-only', () => ({}))

import {
  resolvePaydunyaConfig,
  paydunyaConfigError,
  describePaydunyaConfig,
  paydunyaEnvName,
  paydunyaEnvNames,
  paydunyaCredentialsPresent,
  PaydunyaConfigError,
  PAYDUNYA_MODES,
  type EnvLike,
} from '@/lib/payments/paydunya-config'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Obvious non-secrets. No real credential appears in this file. */
const T = { master: 'test-master-xxx', priv: 'test-private-xxx', tok: 'test-token-xxx' }
const L = { master: 'live-master-xxx', priv: 'live-private-xxx', tok: 'live-token-xxx' }

const TEST_SET: EnvLike = {
  PAYDUNYA_TEST_MASTER_KEY:  T.master,
  PAYDUNYA_TEST_PRIVATE_KEY: T.priv,
  PAYDUNYA_TEST_TOKEN:       T.tok,
}
const LIVE_SET: EnvLike = {
  PAYDUNYA_LIVE_MASTER_KEY:  L.master,
  PAYDUNYA_LIVE_PRIVATE_KEY: L.priv,
  PAYDUNYA_LIVE_TOKEN:       L.tok,
}

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-LAUNCH-02A — the resolver fails closed', () => {
  it('1. a missing mode fails — there is deliberately no default', () => {
    for (const env of [{}, { ...TEST_SET }, { PAYDUNYA_MODE: '', ...TEST_SET }, { PAYDUNYA_MODE: '   ', ...TEST_SET }]) {
      expect(() => resolvePaydunyaConfig(env)).toThrow(PaydunyaConfigError)
      expect(paydunyaConfigError(env)).toMatch(/PAYDUNYA_MODE is not set/)
    }
  })

  it('2. an invalid mode fails, and near-misses are NOT interpreted', () => {
    for (const mode of ['TEST', 'Test', 'live ', ' test', 'sandbox', 'prod', 'production', 'true', '1', 'testing']) {
      const env = { PAYDUNYA_MODE: mode, ...TEST_SET, ...LIVE_SET }
      expect(() => resolvePaydunyaConfig(env), `accepted mode ${JSON.stringify(mode)}`)
        .toThrow(PaydunyaConfigError)
    }
    // Only these two, exactly.
    expect([...PAYDUNYA_MODES]).toEqual(['test', 'live'])
  })

  it('3. TEST mode with a complete TEST set resolves', () => {
    const cfg = resolvePaydunyaConfig({ PAYDUNYA_MODE: 'test', ...TEST_SET })
    expect(cfg.mode).toBe('test')
    expect(cfg.isLive).toBe(false)
    expect(cfg.masterKey).toBe(T.master)
    expect(cfg.privateKey).toBe(T.priv)
    expect(cfg.token).toBe(T.tok)
  })

  it('4. TEST mode with ANY missing TEST credential fails, naming the variable', () => {
    for (const drop of Object.keys(TEST_SET)) {
      const env: EnvLike = { PAYDUNYA_MODE: 'test', ...TEST_SET }
      delete env[drop]
      expect(() => resolvePaydunyaConfig(env), `resolved without ${drop}`).toThrow(PaydunyaConfigError)
      expect(paydunyaConfigError(env)).toContain(drop)
    }
    // A blank string is not a credential.
    for (const blank of ['', '   ']) {
      const env = { PAYDUNYA_MODE: 'test', ...TEST_SET, PAYDUNYA_TEST_TOKEN: blank }
      expect(() => resolvePaydunyaConfig(env)).toThrow(PaydunyaConfigError)
    }
  })

  it('5. TEST mode never reads a LIVE credential, even when one is present', () => {
    // Only LIVE values exist — test mode must NOT fall back to them.
    const onlyLive = { PAYDUNYA_MODE: 'test', ...LIVE_SET }
    expect(() => resolvePaydunyaConfig(onlyLive)).toThrow(PaydunyaConfigError)
    expect(paydunyaConfigError(onlyLive)).toContain('PAYDUNYA_TEST_MASTER_KEY')

    // Both sets exist — the resolved credentials must be the TEST ones.
    const both = resolvePaydunyaConfig({ PAYDUNYA_MODE: 'test', ...TEST_SET, ...LIVE_SET })
    expect(both.masterKey).toBe(T.master)
    expect(both.privateKey).toBe(T.priv)
    expect(both.token).toBe(T.tok)
    for (const live of Object.values(L)) {
      expect(JSON.stringify([both.masterKey, both.privateKey, both.token]),
        'a LIVE value reached a TEST resolution').not.toContain(live)
    }
  })

  it('5b. LIVE mode symmetrically never reads a TEST credential', () => {
    const onlyTest = { PAYDUNYA_MODE: 'live', ...TEST_SET }
    expect(() => resolvePaydunyaConfig(onlyTest)).toThrow(PaydunyaConfigError)
    const both = resolvePaydunyaConfig({ PAYDUNYA_MODE: 'live', ...TEST_SET, ...LIVE_SET })
    expect(both.masterKey).toBe(L.master)
    expect(both.isLive).toBe(true)
  })

  it('7/8. LIVE mode without a complete LIVE set fails, including partial sets', () => {
    expect(() => resolvePaydunyaConfig({ PAYDUNYA_MODE: 'live' })).toThrow(PaydunyaConfigError)
    for (const keep of Object.keys(LIVE_SET)) {
      const env: EnvLike = { PAYDUNYA_MODE: 'live', [keep]: LIVE_SET[keep] }
      expect(() => resolvePaydunyaConfig(env), `resolved with only ${keep}`).toThrow(PaydunyaConfigError)
    }
    for (const drop of Object.keys(LIVE_SET)) {
      const env: EnvLike = { PAYDUNYA_MODE: 'live', ...LIVE_SET }
      delete env[drop]
      expect(() => resolvePaydunyaConfig(env), `resolved without ${drop}`).toThrow(PaydunyaConfigError)
    }
  })

  it('names are derived from the mode, never hand-written', () => {
    expect(paydunyaEnvName('test', 'PRIVATE_KEY')).toBe('PAYDUNYA_TEST_PRIVATE_KEY')
    expect(paydunyaEnvName('live', 'MASTER_KEY')).toBe('PAYDUNYA_LIVE_MASTER_KEY')
    expect(paydunyaEnvNames().sort()).toEqual([
      'PAYDUNYA_LIVE_MASTER_KEY', 'PAYDUNYA_LIVE_PRIVATE_KEY', 'PAYDUNYA_LIVE_TOKEN',
      'PAYDUNYA_MODE',
      'PAYDUNYA_TEST_MASTER_KEY', 'PAYDUNYA_TEST_PRIVATE_KEY', 'PAYDUNYA_TEST_TOKEN',
    ])
    expect(paydunyaCredentialsPresent('test', { PAYDUNYA_MODE: 'test', ...TEST_SET })).toBe(3)
    expect(paydunyaCredentialsPresent('live', { PAYDUNYA_MODE: 'test', ...TEST_SET })).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-LAUNCH-02A — a secret cannot leave by accident', () => {
  const cfg = () => resolvePaydunyaConfig({ PAYDUNYA_MODE: 'test', ...TEST_SET })

  it('the config redacts itself when logged, serialised or interpolated', () => {
    const c = cfg()
    expect(JSON.stringify(c)).not.toContain(T.priv)
    expect(JSON.stringify(c)).toContain('redacted')
    expect(String(c)).not.toContain(T.priv)
    expect(`${c}`).not.toContain(T.priv)
    expect(require('util').inspect(c)).not.toContain(T.priv)
  })

  it('no error message or diagnostic ever contains a value', () => {
    const envs: EnvLike[] = [
      {},
      { PAYDUNYA_MODE: 'nope', ...TEST_SET, ...LIVE_SET },
      { PAYDUNYA_MODE: 'test', PAYDUNYA_TEST_MASTER_KEY: T.master },
      { PAYDUNYA_MODE: 'live', ...LIVE_SET, PAYDUNYA_LIVE_TOKEN: undefined },
    ]
    for (const env of envs) {
      const msg = paydunyaConfigError(env) ?? ''
      const described = JSON.stringify(describePaydunyaConfig(env))
      for (const secret of [...Object.values(T), ...Object.values(L)]) {
        expect(msg, 'an error message leaked a value').not.toContain(secret)
        expect(described, 'a diagnostic leaked a value').not.toContain(secret)
      }
    }
  })

  it('describePaydunyaConfig reports presence only', () => {
    const d = describePaydunyaConfig({ PAYDUNYA_MODE: 'test', ...TEST_SET, ...LIVE_SET })
    expect(d).toEqual({ mode: 'test', valid: true, error: null, present: { test: 3, live: 3 } })
  })

  it('9. no PayDunya credential is exposed through NEXT_PUBLIC_', () => {
    // Source: nothing may read a public PayDunya variable.
    for (const f of ['lib/payments/paydunya-config.ts',
                     'scripts/security/verify-prod-config.mjs',
                     'scripts/security/check-bundle-secrets.mjs']) {
      expect(read(f), `${f} references a public PayDunya variable`)
        .not.toMatch(/NEXT_PUBLIC_[A-Z0-9_]*PAYDUNYA/)
    }
    // Repository-wide: no SHIPPED file may define or read one.
    //
    // `__tests__` is excluded on purpose — and only here. This suite names
    // `NEXT_PUBLIC_PAYDUNYA_TOKEN` once, in the negative case that proves the
    // deploy gate REJECTS it. Scanning itself would make this assertion
    // impossible to satisfy while that proof exists, so the scope is the code
    // that actually ships.
    let hits = ''
    try {
      hits = execFileSync('git', ['grep', '-lE', 'NEXT_PUBLIC_[A-Za-z0-9_]*PAYDUNYA',
        '--', 'app', 'components', 'lib', 'types', 'scripts', 'supabase', 'docs'],
        { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch { hits = '' }   // git grep exits 1 when nothing matches
    expect(hits, `public PayDunya variable found in shipped code: ${hits}`).toBe('')

    // And the real environment must not have one either.
    expect(Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_') && /PAYDUNYA/i.test(k)))
      .toEqual([])
  })

  it('10. the bundle scanner forbids every PayDunya variable', () => {
    const scanner = read('scripts/security/check-bundle-secrets.mjs')
    expect(scanner).toMatch(/PAYDUNYA_\(MODE\|TEST_\|LIVE_\)/)
    // Proof the pattern matches what it must, rather than merely existing.
    const re = /PAYDUNYA_(MODE|TEST_|LIVE_)/
    for (const name of paydunyaEnvNames()) expect(re.test(name), `scanner misses ${name}`).toBe(true)
  })

  it('the resolver is server-only by the repository mechanism', () => {
    const src = read('lib/payments/paydunya-config.ts')
    expect(src.startsWith("import 'server-only'")).toBe(true)
    // No PayDunya client, no network call in this slice.
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/paydunya\.com|https?:\/\//i)
    // The module must be the ONLY place a PayDunya variable is named.
    // `git grep` searches TRACKED files only and this module is new, so walk
    // the filesystem instead — otherwise the assertion passes vacuously.
    const { readdirSync, statSync } = require('fs') as typeof import('fs')
    const readers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name === '.next') continue
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(name)) continue
        if (/PAYDUNYA_[A-Z]/.test(read(rel))) readers.push(rel)
      }
    }
    for (const d of ['app', 'components', 'lib', 'types']) walk(d)
    expect(readers).toEqual(['lib/payments/paydunya-config.ts'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-LAUNCH-02A — the deploy gate refuses dangerous configurations', () => {
  const GATE = 'scripts/security/verify-prod-config.mjs'

  /** Run the real gate with a controlled environment. Returns code + output. */
  function runGate(env: Record<string, string>) {
    try {
      const out = execFileSync('node', [GATE], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.example.com' },
      })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it('6. PAYDUNYA_MODE=test with ANY live credential is REJECTED', () => {
    for (const [name, v] of Object.entries(LIVE_SET)) {
      const r = runGate({ PAYDUNYA_MODE: 'test', ...TEST_SET as Record<string, string>, [name]: v as string })
      expect(r.code, `gate accepted test mode with ${name}`).toBe(1)
      expect(r.out).toMatch(/PAYDUNYA_CONFIG|DEPLOYMENT BLOCKED/)
      expect(r.out).toContain(name)
      // The gate must name the variable, never its value.
      expect(r.out).not.toContain(v as string)
    }
  })

  it('a live credential is refused even when the mode is UNSET', () => {
    const r = runGate({ PAYDUNYA_LIVE_TOKEN: L.tok })
    expect(r.code).toBe(1)
    expect(r.out).toContain('PAYDUNYA_LIVE_TOKEN')
  })

  it('an invalid mode is rejected at deploy time', () => {
    const r = runGate({ PAYDUNYA_MODE: 'sandbox', ...TEST_SET as Record<string, string> })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/exactly 'test' or 'live'/)
  })

  it('a partial TEST set is rejected at deploy time', () => {
    const r = runGate({ PAYDUNYA_MODE: 'test', PAYDUNYA_TEST_MASTER_KEY: T.master })
    expect(r.code).toBe(1)
    expect(r.out).toContain('PAYDUNYA_TEST_PRIVATE_KEY')
    expect(r.out).toContain('PAYDUNYA_TEST_TOKEN')
  })

  it('a NEXT_PUBLIC_ PayDunya variable is rejected at deploy time', () => {
    const r = runGate({ NEXT_PUBLIC_PAYDUNYA_TOKEN: 'anything' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/exposed to the browser/)
  })

  it('the current repository configuration PASSES the gate', () => {
    // No PayDunya variable is set anywhere today, which is the valid state for
    // this slice: the boundary exists, payments do not.
    const r = runGate({})
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/PayDunya not configured/)
  })

  it('a complete TEST configuration PASSES, with no live credential present', () => {
    const r = runGate({ PAYDUNYA_MODE: 'test', ...TEST_SET as Record<string, string> })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/mode='test'/)
    expect(r.out).toMatch(/0 live credentials present/)
    for (const v of Object.values(T)) expect(r.out).not.toContain(v)
  })

  it('the PayDunya gate runs BEFORE the Supabase placeholder short-circuit', () => {
    // Otherwise the invariants would be skipped on CI and local builds, which is
    // where a stray live credential is most likely to appear.
    const src = read(GATE)
    expect(src.indexOf('PAYDUNYA_CONFIG')).toBeLessThan(src.indexOf('Skipping production Auth config check'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-LAUNCH-02A — scope guard: nothing else moved', () => {
  it('11. the payment feature flag is untouched and remains OFF', () => {
    const pilot = read('lib/pilot.ts')
    expect(pilot).toMatch(/PAYMENTS_ENABLED\s*=\s*\n?\s*process\.env\.NEXT_PUBLIC_PAYMENTS_ENABLED === 'true'/)
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      expect(read('.env.local')).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
    }
  })

  it('no migration was added by this slice', () => {
    const { readdirSync } = require('fs') as typeof import('fs')
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
    const nums = files.map(f => /^(\d{3})_/.exec(f)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums), 'a migration was added by a config-only slice').toBe(57)
    for (const n of ['058', '059']) expect(files.filter(f => f.startsWith(n))).toEqual([])
  })

  it('payment behaviour, schema and completion are untouched', () => {
    // PAY-1 and PAY-2 remain unstarted: no PayDunya client, route or IPN handler.
    expect(existsSync(join(ROOT, 'app/api/webhooks/paydunya'))).toBe(false)
    expect(existsSync(join(ROOT, 'lib/payments/paydunya-client.ts'))).toBe(false)
    // The existing action still creates only a pending record, server-priced.
    const action = read('app/actions/payment.ts')
    expect(action).toMatch(/if \(!PAYMENTS_ENABLED\)/)
    expect(action).toMatch(/status:\s+'pending'/)
    expect(action).not.toMatch(/PAYDUNYA|entitlement/i)
    // The confirm page still grants nothing.
    const confirm = read('app/(platform)/checkout/confirm/page.tsx')
    expect(confirm).not.toMatch(/\.insert\(|\.update\(|complete_payment|entitlement/i)
  })

  it('the pre-existing Stripe/Wave/Orange variables are recorded as debt, not removed', () => {
    // Deliberate: unrelated environment cleanup must not ride along in a
    // payment-configuration gate. They remain unreferenced by any code.
    // They survive only as prose inside `lib/payments/index.ts`, a stub module
    // that is imported nowhere and reads no environment variable at all. The
    // invariant that matters is that no CODE reads them.
    const stub = read('lib/payments/index.ts')
    expect(stub).toMatch(/PILOT MODE: No real payment gateways are wired yet/)
    expect(stub.match(/process\.env/g), 'the stub started reading the environment').toBeNull()
    for (const name of ['STRIPE_SECRET_KEY', 'WAVE_API_KEY', 'ORANGE_MONEY_CLIENT_SECRET']) {
      expect(stub, `${name} is read as code, not documented`)
        .not.toMatch(new RegExp(`process\.env\.${name}|process\.env\[['\"]${name}`))
    }
    // And the stub must not have gained a grant path: it still only TODOs an
    // enrollment, which under XPA-6B authorizes nothing anyway.
    expect(stub).not.toMatch(/\.from\(['\"]entitlements['\"]\)/)
  })
})
