// @vitest-environment node
/**
 * PAY-2C-0 — the legacy admin payment-activation path is disabled.
 *
 * ── THE FINDING ───────────────────────────────────────────────────────────
 *
 * `activateEnrollment` set `payments.status = 'completed'` and then upserted a
 * row into `enrollments`. Since XPA-6B (migration 037) an enrollment authorizes
 * NOTHING — `has_course_access()` reads `entitlements` alone. So the action
 * marked a payment PAID and granted the learner no access at all. It was also
 * non-atomic (two unguarded statements), and it never checked that
 * `payments.user_id` / `payments.course_id` were non-NULL, though both are
 * nullable.
 *
 * It was the ONLY code path in the repository that wrote
 * `payments.status = 'completed'`.
 *
 * ── WHAT THIS SUITE PROVES, AND WHAT IT CANNOT ────────────────────────────
 *
 * It reads SOURCE TEXT. That is the right instrument for "no code path exists",
 * which is a property of the repository rather than of a running database — and
 * it is the only instrument available for a server action, which cannot be
 * invoked from a unit test without a Next request scope, an authenticated admin
 * session and a live database.
 *
 * What it therefore CANNOT prove: that a POST to the deployed action id is
 * refused in production. That needs an authenticated admin session against the
 * deployed app and belongs to the post-deploy check. What makes the source
 * reading sufficient meanwhile is that the action constructs NO Supabase client
 * of any kind, so there is no reachable statement that could write — asserted
 * below rather than asserted of itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const ACTION = 'app/(admin)/admin/payments/actions.ts'
const PAGE   = 'app/(admin)/admin/payments/page.tsx'
const SRC_DIRS = ['app', 'components', 'lib'] as const

/** Every tracked .ts/.tsx source file under the shipped directories. */
function sourceFiles(): string[] {
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
  SRC_DIRS.forEach(walk)
  return out
}
/** Comments blanked, length preserved, so prose cannot satisfy an assertion. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
   .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C-0 — the action refuses and cannot write', () => {
  const raw = read(ACTION)
  const code = strip(raw)

  it('still exists as a server action, so a stale invocation meets a refusal', () => {
    // Deleting the export would also deny the write, but with a framework error
    // and no record of why. An explicit refusal is deliberate and testable.
    expect(raw.split('\n')[0]).toBe("'use server'")
    expect(code).toMatch(/export async function activateEnrollment\s*\(/)
  })

  it('refuses every caller: it throws and returns nothing', () => {
    expect(code).toMatch(/throw new Error\(/)
    // The refusal is the only outcome — there is no branch that proceeds.
    expect(code).not.toMatch(/\breturn\b(?!\s*;?\s*$)/)
  })

  it('checks administrator authorization BEFORE the refusal', () => {
    // A non-admin must be refused as a non-admin — redirected, learning nothing
    // about payment features. Ordering is the assertion, not mere presence.
    const authAt = code.indexOf('requirePlatformAdmin()')
    const throwAt = code.indexOf('throw new Error(')
    expect(authAt).toBeGreaterThan(0)
    expect(throwAt).toBeGreaterThan(0)
    expect(authAt, 'the refusal must come after the admin check').toBeLessThan(throwAt)
  })

  it('constructs NO Supabase client, so no write is reachable from it', () => {
    // This is what makes a source-text proof sufficient here.
    expect(code).not.toContain('createAdminClient')
    expect(code).not.toContain('createClient')
    expect(code).not.toContain('supabase')
    expect(code).not.toContain('SERVICE_ROLE')
  })

  it('names no table and performs no mutation', () => {
    for (const t of ['payments', 'entitlements', 'enrollments', 'audit_log', 'profiles']) {
      expect(code, `the disabled action still names ${t}`).not.toContain(t)
    }
    for (const verb of ['.update(', '.upsert(', '.insert(', '.delete(', '.rpc(']) {
      expect(code, `the disabled action still calls ${verb}`).not.toContain(verb)
    }
    expect(code).not.toContain('completed')
    expect(code).not.toContain('revalidatePath')
  })

  it('explains itself in French to the administrator who used the button', () => {
    expect(raw).toMatch(/PayDunya/)
    expect(raw).toMatch(/désactivée|indisponible/i)
    // It must point somewhere useful rather than just refusing.
    expect(raw).toMatch(/Accès/)
  })

  it('does not become a different grant path', () => {
    // The tempting "fix" is to insert an entitlement here instead. That would
    // recreate the same defect with the opposite sign: a human recording an
    // INDIVIDUAL_PURCHASE that no payment system produced.
    expect(code).not.toContain('INDIVIDUAL_PURCHASE')
    expect(code).not.toContain('MANUAL_ADMIN')
    expect(code).not.toContain('complete_payment')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C-0 — the admin interface offers no activation control', () => {
  const raw = read(PAGE)
  const code = strip(raw)

  it('the page no longer imports or renders the action', () => {
    expect(code).not.toContain('activateEnrollment')
    expect(code).not.toMatch(/from\s+'\.\/actions'/)
    // No form at all on this page: a form is how the action was reachable.
    expect(code).not.toContain('<form')
    expect(code).not.toContain('type="submit"')
    expect(code).not.toContain('name="paymentId"')
  })

  it('both call sites are gone — desktop and mobile', () => {
    // The action was rendered TWICE. Removing one and missing the other would
    // leave the control live on phones, which is where Marieme works.
    expect(code.match(/activateEnrollment/g) ?? []).toEqual([])
    // No interactive element survives anywhere on the page. "Activer" may still
    // appear as PROSE in the explanation (« Activer » a été retiré), so the
    // assertion is about a rendered LABEL — a JSX text node that is the word
    // itself — not about the string appearing at all.
    expect(code).not.toMatch(/>\s*Activer\s*</)
    expect(code).not.toContain('<button')
    expect(code).not.toContain('onClick')
  })

  it('tells the administrator, in French, why it is gone and what to use', () => {
    expect(raw).toMatch(/Activation manuelle des paiements indisponible/)
    expect(raw).toMatch(/PayDunya/)
    expect(raw).toMatch(/Admin → Accès/)
    // The honest reason, not a vague "coming soon": the learner got nothing.
    expect(raw).toMatch(/sans accorder le droit d&apos;accès|n&apos;obtenait rien/)
  })

  it('payment VIEWING is preserved — the page still lists and totals', () => {
    expect(code).toContain("from('payments')")
    expect(code).toContain('.select(')
    expect(code).toContain('totalRevenue')
    expect(code).toContain('requirePlatformAdmin()')
    // Still read-only: every payments call on this page is a select.
    const calls = [...code.matchAll(/from\(\s*['"]payments['"]\s*\)/g)]
    expect(calls.length, 'the page no longer reads payments at all').toBeGreaterThan(0)
    for (const m of calls) {
      const window = code.slice(m.index!, m.index! + 250)
      expect(window, 'the listing page mutates payments')
        .not.toMatch(/\.(update|upsert|insert|delete)\(/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C-0 — repository-wide: no unauthorized payment-completion writer', () => {
  /**
   * The standing assertion. Any future file that marks a payment completed
   * fails here, in CI, instead of shipping a payment that grants no access.
   */
  it('NOTHING in app/, components/ or lib/ writes payments.status = completed', () => {
    const offenders: string[] = []
    for (const f of sourceFiles()) {
      const code = strip(read(f))
      // Each payments call, with the window of code that follows it.
      for (const m of code.matchAll(/from\(\s*['"]payments['"]\s*\)/g)) {
        const window = code.slice(m.index!, m.index! + 400)
        const mutates = /\.(update|upsert|insert)\(/.test(window)
        const completes = /['"]completed['"]/.test(window) || /completed_at/.test(window)
        if (mutates && completes) offenders.push(`${f} @${m.index}`)
      }
    }
    expect(offenders, `payment-completion writer(s) found: ${offenders.join(', ')}`).toEqual([])
  })

  it('the ONLY payments mutation anywhere is the pending-intent insert', () => {
    const mutators: string[] = []
    for (const f of sourceFiles()) {
      const code = strip(read(f))
      for (const m of code.matchAll(/from\(\s*['"]payments['"]\s*\)/g)) {
        const window = code.slice(m.index!, m.index! + 400)
        if (/\.(update|upsert|insert|delete)\(/.test(window)) mutators.push(f)
      }
    }
    expect([...new Set(mutators)].sort()).toEqual(['app/actions/payment.ts'])
    // ...and that one creates an intent, never a completion.
    const pay = strip(read('app/actions/payment.ts'))
    expect(pay).toContain("status:             'pending'")
    expect(pay).not.toMatch(/status:\s*['"]completed['"]/)
    expect(pay).not.toContain('completed_at')
    // It is still gated, and still takes the price from the server.
    expect(pay).toContain('PAYMENTS_ENABLED')
    expect(pay).toContain('course.price')
  })

  it('no completion authority exists yet — in SQL or in application code', () => {
    // PAY-2C creates it. Until then, nothing may call or define it.
    for (const f of sourceFiles()) {
      expect(strip(read(f)), `${f} references complete_payment`)
        .not.toContain('complete_payment')
    }

    // ── migration 003 is the ONE known exception, and must stay the only one ──
    //
    // 003_payment_readiness.sql DEFINES complete_payment() at line 25 and was
    // NEVER APPLIED — verified against production: no such RPC exists, and
    // neither do its webhook_id / payment_intent_id / updated_at columns. 058's
    // operator note records the discovery and withdraws it: its body sets
    // `updated_at`, which this table does not have, so it would not even run.
    //
    // It is left in place as history rather than deleted, so this assertion
    // names it explicitly instead of weakening the pattern — and proves no
    // SECOND definition has appeared in any migration that IS applied.
    const WITHDRAWN = '003_payment_readiness.sql'
    const defines: string[] = []
    const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'))
      .filter(f => f.endsWith('.sql'))
    for (const m of migrations) {
      const sql = read(`supabase/migrations/${m}`).replace(/--[^\n]*/g, '')
      if (/create\s+(or replace\s+)?function\s+\S*complete\S*payment/i.test(sql)) defines.push(m)
    }
    expect(defines, 'a completion function appeared outside withdrawn 003').toEqual([WITHDRAWN])
    // 003 stays withdrawn: nothing in the repository re-applies or references it.
    for (const f of sourceFiles()) {
      expect(read(f), `${f} references withdrawn migration 003`).not.toContain(WITHDRAWN)
    }
  })

  it('this fix added NO migration; 060 remains the highest', () => {
    const f = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(x => x.endsWith('.sql'))
    expect(f.filter(x => x.startsWith('060'))).toEqual(['060_payment_completion_contract.sql'])
    expect(f.filter(x => parseInt(x, 10) > 60), 'a migration above 060 appeared').toEqual([])
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(60)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C-0 — learner access authority is untouched', () => {
  it('entitlements remain the sole authority, and this fix adds no writer', () => {
    // The whole point of the finding: enrollments authorize nothing.
    const m037 = read('supabase/migrations/037_entitlements.sql')
    expect(m037).toMatch(/Enrollment does not authorize access \(Q-L\)/)
    expect(m037).toMatch(/from public\.entitlements ent/)

    const writers: string[] = []
    for (const f of sourceFiles()) {
      const code = strip(read(f))
      for (const m of code.matchAll(/from\(\s*['"]entitlements['"]\s*\)/g)) {
        const window = code.slice(m.index!, m.index! + 300)
        if (/\.(update|upsert|insert|delete)\(/.test(window)) writers.push(f)
      }
    }
    // Exactly the pre-existing admin grant path — this slice adds nobody.
    expect([...new Set(writers)].sort()).toEqual(['app/actions/entitlements.ts'])
  })

  it('the admin grant path still refuses to assert a purchase', () => {
    // A human must not record an INDIVIDUAL_PURCHASE no payment system made.
    // The allowlist lives in lib/entitlements/index.ts and is parsed from
    // there rather than retyped, so a change to it fails here.
    const allow = /ADMIN_SELECTABLE_SOURCES[^=]*=\s*\[([^\]]*)\]/
      .exec(strip(read('lib/entitlements/index.ts')))
    expect(allow, 'ADMIN_SELECTABLE_SOURCES is no longer where this test looks').toBeTruthy()
    const sources = allow![1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect(sources.length).toBeGreaterThan(0)
    expect(sources, 'INDIVIDUAL_PURCHASE became admin-selectable').not.toContain('INDIVIDUAL_PURCHASE')
    // ...and the action still enforces that allowlist behind an admin check.
    const src = read('app/actions/entitlements.ts')
    expect(src).toContain('ADMIN_SELECTABLE_SOURCES')
    expect(src).toContain('requirePlatformAdmin')
  })

  it('enrollment writers are unchanged, and none of them completes a payment', () => {
    const writers: string[] = []
    for (const f of sourceFiles()) {
      const code = strip(read(f))
      for (const m of code.matchAll(/from\(\s*['"]enrollments['"]\s*\)/g)) {
        const window = code.slice(m.index!, m.index! + 300)
        if (/\.(update|upsert|insert|delete)\(/.test(window)) writers.push(f)
      }
    }
    // The admin payments action is NO LONGER among them.
    const set = [...new Set(writers)].sort()
    expect(set).toEqual(['app/actions/enrollment.ts', 'app/actions/entitlements.ts'])
    expect(set).not.toContain(ACTION)
  })

  it('the legacy unimported payment stub is still unimported', () => {
    // N1. lib/payments/index.ts still exports unlockEnrollment, which grants the
    // wrong authority. Deleting it is a separate slice; it must not become live.
    const importers: string[] = []
    for (const f of sourceFiles()) {
      if (f === 'lib/payments/index.ts') continue
      if (/from\s+['"](@\/lib\/payments|[^'"]*\/lib\/payments)['"]/.test(read(f))) importers.push(f)
    }
    expect(importers, `lib/payments is now imported by: ${importers.join(', ')}`).toEqual([])
  })
})
