// @vitest-environment node
/**
 * PAY-LAUNCH-02C / PAY-1B(a) — the safe payment read projection.
 *
 * ── WHY THIS SLICE EXISTED ────────────────────────────────────────────────
 *
 * RLS decides ROWS, not COLUMNS. `payments_own` confined the checkout
 * confirmation page to the caller's own payment rows, but `authenticated` held
 * table-wide SELECT, so `select('*')` returned every column of that row —
 * including the free-form `metadata` jsonb and `provider_token`. Migration 059
 * converted that into an explicit column allowlist excluding both, and
 * PAY-1B(a) made the page name its columns first so 059 could not break it.
 *
 * ── WHAT CHANGED IN XP-PAYTECH-04 ─────────────────────────────────────────
 *
 * `/checkout/confirm` was the end of the retired legacy flow. It no longer
 * reads a payment at all: it redirects to `/payment/success`, which reads the
 * signed-in learner's own orders through the service role with a named
 * projection. So the property PAY-1B(a) protected now holds more strongly:
 * there is NO browser-role payment reader anywhere in shipped code, and the
 * two columns 059 withholds can reach no browser by any route. This suite
 * asserts exactly that, plus 059's compatibility with every later migration.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const PAGE = 'app/(platform)/checkout/confirm/page.tsx'
const CODE = strip(read(PAGE))
const MIG058 = 'supabase/migrations/058_payment_provider_foundation.sql'

/** Every `.from('payments').select('…')` in a file, with its receiver. */
function paymentSelects(src: string): { recv: string; select: string }[] {
  const out: { recv: string; select: string }[] = []
  const re = /(\w+)\s*\.\s*from\(\s*'payments'\s*\)\s*(?:\n\s*)?\.\s*select\(\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push({ recv: m[1], select: m[2] })
  return out
}

// ── migration 058's own pinned post-apply column list ──────────────────────
const PAYMENTS_17 = (() => {
  const sql = read(MIG058)
  const candidates = [...sql.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
  return candidates.find(c => c.length === 17) ?? []
})()

/** What migration 059 withholds from the browser roles. */
const EXCLUDED_BY_059 = ['provider_token', 'metadata'] as const
const PLANNED_059_ALLOWLIST = PAYMENTS_17.filter(c => !(EXCLUDED_BY_059 as readonly string[]).includes(c))

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 1-2. the confirmation page reads no payment at all (XP-PAYTECH-04)', () => {
  it('058\'s pinned 17-column list was located (the basis for the 059 checks below)', () => {
    expect(PAYMENTS_17).toHaveLength(17)
    expect(PAYMENTS_17).toContain('provider_token')
    expect(PAYMENTS_17).toContain('metadata')
    expect(PLANNED_059_ALLOWLIST).toHaveLength(15)
  })

  it('1. no payment query of any kind remains on the page — wildcard or explicit', () => {
    expect(CODE).not.toMatch(/from\(\s*'payments'\s*\)/)
    expect(CODE).not.toMatch(/\.select\(/)
    expect(CODE).not.toMatch(/supabase|createClient|createAdminClient/)
  })

  it('2. it is a redirect to the honest status page, forwarding nothing', () => {
    const redirects = [...CODE.matchAll(/redirect\(([^)]*)\)/g)].map(m => m[1].trim())
    expect(redirects).toEqual(["'/payment/success'"])
    // The old `?payment=<id>` is not forwarded: /payment/success scopes by the
    // signed-in learner, never by an id from the URL.
    expect(CODE).not.toMatch(/searchParams|paymentId/)
  })

  it('3-4. provider_token and metadata cannot be read here by any route', () => {
    expect(CODE).not.toContain('provider_token')
    expect(CODE).not.toMatch(/payment\??\.metadata|data\??\.metadata/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 7-8. the page stays informational', () => {
  it('7. the page grants no entitlement and touches no enrollment', () => {
    for (const t of ['entitlements', 'enrollments', 'certificates']) {
      expect(CODE, `the confirmation page reads or writes ${t}`).not.toContain(t)
    }
    expect(CODE).not.toMatch(/has_course_access|my_course_access|resolveCourseAccess/)
  })

  it('8. the page modifies no payment status — it issues no write at all', () => {
    for (const w of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
      expect(CODE, `the confirmation page calls ${w}`).not.toContain(w)
    }
    expect(CODE).not.toContain('complete_payment')
    expect(CODE).not.toMatch(/'use server'/)
  })

  it('no redirect becomes payment authority', () => {
    expect(CODE).not.toMatch(/redirect\([^)]*learn/)
    expect(CODE).not.toMatch(/status|completed/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 9-10. compatibility with 058, 059 and every later migration', () => {
  it('058 still records the 059 specification PAY-1B(a) was built against', () => {
    const gates = read(MIG058)
    const note = gates.slice(gates.indexOf('GATES BEFORE PAYMENTS ARE ENABLED'))
    expect(note).toMatch(/PAY-1B\(a\)/)
    expect(note).toMatch(/EXCLUDE provider_token/)
    expect(note).toMatch(/EXCLUDE metadata/)
    expect(note).toMatch(/ONLY AFTER PAY-1B MAY PAY-2 WRITE provider_token/)
  })

  it('059 grants the browser roles neither withheld column; no later migration widens it', () => {
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
    expect(files.filter(f => parseInt(f, 10) > 58))
      .toEqual(['059_payment_column_select_security.sql', '060_payment_completion_contract.sql',
                '061_audit_log_privilege_hardening.sql', '062_atomic_payment_completion.sql',
                '063_payment_state_machine.sql', '064_payment_exceptions.sql'])
    const nums = files.map(f => /^(\d{3})_/.exec(f)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(64)

    const strip = (p: string) => read(p).replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    const m059 = strip('supabase/migrations/059_payment_column_select_security.sql')
    const granted = /grant select \(([\s\S]*?)\) on public\.payments to authenticated;/i
      .exec(m059)?.[1].split(',').map(s => s.trim()).filter(Boolean) ?? []
    expect(granted.length).toBeGreaterThan(0)
    for (const withheld of EXCLUDED_BY_059) expect(granted, `059 grants ${withheld}`).not.toContain(withheld)
    for (const c of granted) expect(PAYMENTS_17).toContain(c)

    // 060 issues no privilege statement.
    expect(strip('supabase/migrations/060_payment_completion_contract.sql').match(/^\s*(grant|revoke)\s/gim) ?? [])
      .toEqual([])
    // 061's are on audit_log only.
    for (const stmt of strip('supabase/migrations/061_audit_log_privilege_hardening.sql').match(/^\s*(grant|revoke)\s[\s\S]*?;/gim) ?? []) {
      expect(stmt, '061 changes a privilege on a table other than audit_log').toMatch(/on public\.audit_log\b/i)
    }
    // 062's are ON FUNCTION.
    for (const stmt of strip('supabase/migrations/062_atomic_payment_completion.sql').match(/^\s*(grant|revoke)\s[\s\S]*?;/gim) ?? []) {
      expect(stmt, '062 changes a table privilege').toMatch(/on function/i)
    }
    // XP-PAYTECH-04's 063: on its own marker table and its trigger function —
    // never on public.payments, so 059's browser allowlist is untouched.
    const m063 = strip('supabase/migrations/063_payment_state_machine.sql')
    const stmts063 = m063.match(/^\s*(grant|revoke)\s[\s\S]*?;/gim) ?? []
    expect(stmts063.length).toBeGreaterThan(0)
    for (const stmt of stmts063) {
      expect(stmt, '063 changes a privilege on public.payments')
        .toMatch(/on public\.payment_environment\b|on function public\.payments_transition_guard\(\)/i)
    }
    // XP-PAYTECH-05's 064: on its own table and functions — again never on
    // public.payments, so 059's browser allowlist is untouched.
    const stmts064 = strip('supabase/migrations/064_payment_exceptions.sql').match(/^\s*(grant|revoke)\s[\s\S]*?;/gim) ?? []
    expect(stmts064.length).toBeGreaterThan(0)
    for (const stmt of stmts064) {
      expect(stmt, '064 changes a privilege on public.payments')
        .toMatch(/on public\.payment_exceptions\b|on function public\.payment_exception/i)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · every payment reader, and which client it uses', () => {
  const SHIPPED = ['app', 'components', 'lib']

  function walk(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.next') continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full, acc)
      else if (/\.(ts|tsx)$/.test(e)) acc.push(full)
    }
    return acc
  }

  /** Map a receiver variable to the client factory that produced it. */
  function clientOf(src: string, recv: string): 'service' | 'browser' | 'unknown' {
    if (recv === 'createAdminClient') return 'service'   // createAdminClient().from('payments')
    if (new RegExp(`const\\s+${recv}\\s*=\\s*createAdminClient\\(`).test(src)) return 'service'
    if (new RegExp(`const\\s+${recv}\\s*=\\s*(await\\s+)?createClient\\(`).test(src)) return 'browser'
    return 'unknown'
  }

  const files = SHIPPED.flatMap(d => walk(join(ROOT, d)))
    .map(f => ({ file: f.slice(ROOT.length + 1).replace(/\\/g, '/'), src: readFileSync(f, 'utf8') }))
    .filter(x => /from\(\s*'payments'\s*\)/.test(x.src))

  /** A `.from('payments')` reached through `createAdminClient()` directly or a const bound to it. */
  const readers = files.flatMap(x => {
    const src = x.src.replace(/createAdminClient\(\)\s*\n?\s*\.from\(/g, 'createAdminClient.from(')
    return paymentSelects(src).map(s => ({ file: x.file, ...s, client: clientOf(x.src, s.recv) }))
  })

  it('NO browser-role payment reader exists anywhere in shipped code', () => {
    expect(readers.length, 'the reader scan found nothing — it is broken').toBeGreaterThanOrEqual(4)
    expect(readers.filter(r => r.client === 'browser').map(r => r.file)).toEqual([])
  })

  it('every payment reader is service-role and named, so 059 cannot break it', () => {
    for (const r of readers) {
      expect(r.client, `${r.file} reads payments through an unclassified client`).toBe('service')
      expect([
        'app/(admin)/admin/page.tsx', 'app/(admin)/admin/payments/page.tsx',
        'app/actions/paytech-checkout.ts',
        'app/api/payments/paytech/ipn/route.ts',
        'app/api/payments/paytech/reconcile/route.ts',
        'app/payment/success/page.tsx',
        'app/payment/cancel/page.tsx',
        'lib/payments/payment-completion.ts',
        'lib/payments/payment-exceptions.ts',
        'lib/payments/paytech-reconcile.ts',
      ], `${r.file} is an unreviewed payment reader`).toContain(r.file)
    }
  })

  it('no reader outside the admin surfaces pulls provider_token or metadata into a page', () => {
    for (const r of readers.filter(r => r.file.startsWith('app/payment/'))) {
      expect(r.select).not.toMatch(/\*|provider_token|metadata/)
    }
  })

  it('REPORTED, NOT CHANGED: the admin dashboard still reads payments with a wildcard', () => {
    // app/(admin)/admin/page.tsx pulls every column into the admin page's
    // server memory. Service-role, admin-only, and out of this slice's scope;
    // pinned so the finding cannot be silently lost.
    const admin = readers.filter(r => r.file === 'app/(admin)/admin/page.tsx')
    expect(admin.map(r => r.select).sort())
      .toEqual(['*', '*, profiles(full_name, email), courses(title)', 'amount'].sort())
  })
})
