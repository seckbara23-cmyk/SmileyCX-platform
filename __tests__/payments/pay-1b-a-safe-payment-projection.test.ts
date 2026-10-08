// @vitest-environment node
/**
 * PAY-LAUNCH-02C / PAY-1B(a) — the safe payment read projection.
 *
 * ── WHY THIS SLICE EXISTS, AND WHY IT IS APPLICATION-ONLY ─────────────────
 *
 * RLS decides ROWS, not COLUMNS. `payments_own` confines the checkout
 * confirmation page to the caller's own payment rows, but `authenticated`
 * holds table-wide SELECT, so `select('*')` returned EVERY column of that row.
 * After migration 058 that is 17 columns including the free-form `metadata`
 * jsonb and `provider_token`, which PAY-2 will start writing.
 *
 * Migration 059 converts that table-wide SELECT into an explicit column
 * allowlist excluding both. Under column-level grants `select('*')` FAILS with
 * 42501 rather than narrowing — 055 says so in its own section 1 — so the
 * application must name its columns BEFORE 059 lands, or 059 breaks this page
 * the moment PLATFORM_MODE leaves 'pilot'. That ordering is the whole content
 * of PAY-1B(a): one projection, no database change.
 *
 * ── WHAT THIS SUITE PROVES ────────────────────────────────────────────────
 *
 * It reads source text, which is the right authority for a projection: the
 * question is what the page ASKS FOR, and that is a property of the file. The
 * projection is additionally validated against migration 058's OWN pinned
 * 17-column list — so if the two ever disagree, this fails rather than
 * discovering it at 42501 time — and against the allowlist 059 is specified to
 * grant, so the ordering guarantee is checked and not merely intended.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const PAGE = 'app/(platform)/checkout/confirm/page.tsx'
const SRC = read(PAGE)
/** Comments blanked, so a comment can never satisfy an assertion. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const MIG058 = 'supabase/migrations/058_payment_provider_foundation.sql'

/** Every `.from('payments').select('…')` in a file, with its receiver. */
function paymentSelects(src: string): { recv: string; select: string }[] {
  const out: { recv: string; select: string }[] = []
  const re = /(\w+)\s*\.\s*from\(\s*'payments'\s*\)\s*(?:\n\s*)?\.\s*select\(\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push({ recv: m[1], select: m[2] })
  return out
}

/** Split a PostgREST select list at top level, so `courses(title)` stays whole. */
function splitSelect(sel: string): string[] {
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' ; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const selects = paymentSelects(CODE)
const PARTS = selects.length === 1 ? splitSelect(selects[0].select) : []
/** Plain payment columns (not an embedded relation). */
const COLUMNS = PARTS.filter(p => !p.includes('('))
/** Embedded relations, e.g. `courses(title)`. */
const EMBEDS = PARTS.filter(p => p.includes('('))

// ── migration 058's own pinned post-apply column list ──────────────────────
const PAYMENTS_17 = (() => {
  const sql = read(MIG058)
  const candidates = [...sql.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
  return candidates.find(c => c.length === 17) ?? []
})()

/** What migration 059 is specified to withhold from the browser roles. */
const EXCLUDED_BY_059 = ['provider_token', 'metadata'] as const
const PLANNED_059_ALLOWLIST = PAYMENTS_17.filter(c => !(EXCLUDED_BY_059 as readonly string[]).includes(c))

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 1-2. the payment reader is explicit, not a wildcard', () => {
  it('058\'s pinned 17-column list was located (the basis for every check below)', () => {
    expect(PAYMENTS_17).toHaveLength(17)
    expect(PAYMENTS_17).toContain('provider_token')
    expect(PAYMENTS_17).toContain('metadata')
    expect(PLANNED_059_ALLOWLIST).toHaveLength(15)
  })

  it('1. no select(\'*\') remains in the payment confirmation reader', () => {
    expect(selects, 'expected exactly one payment select on this page').toHaveLength(1)
    expect(selects[0].select, 'the projection still contains a wildcard').not.toMatch(/\*/)
    expect(CODE).not.toMatch(/\.select\(\s*'\*/)
    // Nor the older form it replaced.
    expect(CODE).not.toContain("'*, courses(title, slug)'")
  })

  it('2. the projection is an explicit list of named columns', () => {
    expect(COLUMNS.length).toBeGreaterThan(0)
    for (const c of COLUMNS) {
      expect(c, `not a bare column name: ${JSON.stringify(c)}`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
    // No renames, casts or embedded wildcards hiding a wide read.
    for (const p of PARTS) expect(p).not.toMatch(/\*|:|->/)
    expect(selects[0].select).toBe('id, reference, amount, currency, status, courses(title)')
  })

  it('exactly ONE payment query — no second reader was introduced', () => {
    expect((CODE.match(/from\(\s*'payments'\s*\)/g) ?? [])).toHaveLength(1)
    expect((CODE.match(/\.single\(\)/g) ?? [])).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 3-5. what is excluded, and what is retained', () => {
  it('3. provider_token is excluded', () => {
    expect(COLUMNS).not.toContain('provider_token')
    expect(selects[0].select).not.toContain('provider_token')
    // And the page never reads it by any route.
    expect(CODE).not.toContain('provider_token')
  })

  it('4. metadata is excluded', () => {
    expect(COLUMNS).not.toContain('metadata')
    expect(selects[0].select).not.toContain('metadata')
    // Scoped to the payment object: this page legitimately exports Next's own
    // route `metadata`, which has nothing to do with payments.metadata.
    expect(CODE, 'the page reads metadata off the payment').not.toMatch(/payment\??\.metadata/)
    expect(CODE).not.toMatch(/data\??\.metadata/)
    // Every lowercase `metadata` on the page is the Next route export — stated
    // as a property rather than a count, so it stays true if the file grows.
    expect(CODE).toMatch(/export const metadata: Metadata/)
    const lines = CODE.split('\n').filter(l => /\bmetadata\b/.test(l))
    for (const l of lines) {
      expect(l.trim(), `a non-route-export use of metadata: ${l.trim()}`)
        .toMatch(/^export const metadata: Metadata/)
    }
  })

  it('no other reconciliation or provider field is pulled in', () => {
    for (const c of ['provider', 'provider_mode', 'provider_reference', 'entitlement_id',
                     'company_id', 'user_id', 'created_at', 'completed_at', 'method']) {
      expect(COLUMNS, `${c} is not required for rendering`).not.toContain(c)
    }
  })

  it('5. every field the page renders is still selected', () => {
    // Derived from the page itself: each `payment.<field>` it dereferences.
    const used = [...new Set([...CODE.matchAll(/payment\??\.([a-z_]+)/g)].map(m => m[1]))].sort()
    expect(used, 'the page reads a field this test does not know about')
      .toEqual(['amount', 'currency', 'reference', 'status'])
    for (const f of used) expect(COLUMNS, `${f} is rendered but not selected`).toContain(f)
    // Plus the row identity, which the caller already supplied in the URL.
    expect(COLUMNS).toContain('id')
    expect(COLUMNS).toEqual(['id', 'reference', 'amount', 'currency', 'status'])
  })

  it('the course relation is preserved, projecting only the title it renders', () => {
    expect(EMBEDS).toEqual(['courses(title)'])
    // The title is still read off a SINGLE embedded object. The `unknown` hop
    // is a static-inference gap, not a shape change: supabase-js types a
    // many-to-one embed as an array without generated `Database` types, while
    // PostgREST returns one object (verified GET-only against the live
    // database). The fallback courseName makes a wrong guess cosmetic.
    expect(CODE).toMatch(/\(data\.courses as unknown as \{ title: string \}\)\.title/)
    expect(CODE).toMatch(/if \(data\?\.courses\)/)
    expect(CODE).toMatch(/let courseName = 'Votre formation XP Client'/)
    // `slug` was selected and never read; it is gone.
    expect(selects[0].select).not.toContain('slug')
    expect(CODE).not.toContain('slug')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 6. rendering behaviour is unchanged', () => {
  it('the three presentation branches still derive from status alone', () => {
    expect(CODE).toMatch(/const status = payment\?\.status/)
    expect(CODE).toMatch(/const isConfirmed = status === 'completed'/)
    expect(CODE).toMatch(/const isFailed = status === 'failed'/)
    expect(CODE).toMatch(/const isPending = status === 'pending' \|\| status === 'processing'/)
  })

  it('the receipt block still renders reference, amount+currency and status', () => {
    expect(CODE).toMatch(/\{payment\.reference\}/)
    expect(CODE).toMatch(/formatPrice\(payment\.amount, payment\.currency\)/)
    expect(CODE).toMatch(/\{payment\.status\}/)
    // It is still gated on the payment existing at all.
    expect(CODE).toMatch(/\{payment && \(/)
  })

  it('the course name, titles and navigation are untouched', () => {
    expect(CODE).toMatch(/let courseName = 'Votre formation XP Client'/)
    expect(SRC).toContain('Paiement confirmé !')
    expect(SRC).toContain('Le paiement a échoué')
    expect(SRC).toContain('Paiement en attente')
    expect(CODE).toMatch(/href="\/dashboard"/)
    expect(CODE).toMatch(/href="\/courses"/)
    expect(SRC).toContain('CONTACT_EMAIL')
  })

  it('the pilot short-circuit and the authenticated read path are unchanged', () => {
    expect(CODE).toMatch(/if \(FREE_ACCESS_MODE\) redirect\('\/dashboard'\)/)
    // The USER's client — ownership comes from RLS, not from a filter the page
    // could forget. PAY-1 preserved `payments_own` precisely so this keeps working.
    expect(CODE).toMatch(/from '@\/lib\/supabase\/server'/)
    expect(CODE).not.toMatch(/createAdminClient|service_role/)
    expect(CODE).toMatch(/\.eq\('id', paymentId\)/)
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
    // The only redirect is the pilot short-circuit. Nothing routes on status,
    // so a learner cannot turn a URL into an access decision here.
    const redirects = [...CODE.matchAll(/redirect\(([^)]*)\)/g)].map(m => m[1].trim())
    expect(redirects).toEqual(["'/dashboard'"])
    expect(CODE).not.toMatch(/if \(isConfirmed\)[\s\S]{0,40}redirect/)
    expect(CODE).not.toMatch(/redirect\([^)]*learn/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · 9-10. compatibility with 058 today and 059 next', () => {
  it('9. every selected column exists in the table migration 058 produced', () => {
    for (const c of COLUMNS) {
      expect(PAYMENTS_17, `${c} is not a column of public.payments after 058`).toContain(c)
    }
  })

  it('10. the projection is a subset of the allowlist 059 is specified to grant', () => {
    for (const c of COLUMNS) {
      expect(PLANNED_059_ALLOWLIST, `${c} would be withheld by 059 — this page would 42501`)
        .toContain(c)
    }
    // The two 059 withholds are exactly the two this projection drops.
    for (const c of EXCLUDED_BY_059) {
      expect(PLANNED_059_ALLOWLIST).not.toContain(c)
      expect(COLUMNS).not.toContain(c)
    }
  })

  it('058 still records the 059 specification this projection was built against', () => {
    const gates = read(MIG058)
    const note = gates.slice(gates.indexOf('GATES BEFORE PAYMENTS ARE ENABLED'))
    expect(note).toMatch(/PAY-1B\(a\)/)
    expect(note).toMatch(/EXCLUDE provider_token/)
    expect(note).toMatch(/EXCLUDE metadata/)
    expect(note).toMatch(/ONLY AFTER PAY-1B MAY PAY-2 WRITE provider_token/)
  })

  it('this slice changed no migration: 058 is intact and 059 does not exist', () => {
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
    expect(files.filter(f => f.startsWith('059'))).toEqual([])
    expect(files.filter(f => parseInt(f, 10) > 58)).toEqual([])
    expect(files.filter(f => f.startsWith('058'))).toEqual(['058_payment_provider_foundation.sql'])
    const nums = files.map(f => /^(\d{3})_/.exec(f)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(58)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(a) · every other payment reader, and which client it uses', () => {
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
    if (new RegExp(`const\\s+${recv}\\s*=\\s*createAdminClient\\(`).test(src)) return 'service'
    if (new RegExp(`const\\s+${recv}\\s*=\\s*(await\\s+)?createClient\\(`).test(src)) return 'browser'
    return 'unknown'
  }

  const readers = SHIPPED.flatMap(d => walk(join(ROOT, d)))
    .map(f => ({ file: f.slice(ROOT.length + 1).replace(/\\/g, '/'), src: readFileSync(f, 'utf8') }))
    .filter(x => /from\(\s*'payments'\s*\)/.test(x.src))
    .flatMap(x => paymentSelects(x.src).map(s => ({ file: x.file, ...s, client: clientOf(x.src, s.recv) })))

  it('the confirmation page is the ONLY browser-role payment reader, and it is now explicit', () => {
    const browser = readers.filter(r => r.client === 'browser')
    expect(browser.map(r => r.file)).toEqual([PAGE])
    expect(browser[0].select).toBe('id, reference, amount, currency, status, courses(title)')
    expect(readers.every(r => r.client !== 'unknown'),
      `a payment reader's client could not be classified: ${readers.filter(r => r.client === 'unknown').map(r => r.file).join(', ')}`).toBe(true)
  })

  it('every remaining payment reader is service-role, so 059 cannot break it', () => {
    // 059 revokes and re-grants for anon and authenticated only. service_role
    // keeps full access, so a `select('*')` there is unaffected by the
    // allowlist — it is reported as hygiene, not as a 059 blocker.
    const service = readers.filter(r => r.client === 'service')
    expect(service.length).toBeGreaterThanOrEqual(4)
    for (const r of service) {
      expect(['app/(admin)/admin/page.tsx', 'app/(admin)/admin/payments/page.tsx',
              'app/(admin)/admin/payments/actions.ts', 'app/actions/payment.ts'])
        .toContain(r.file)
    }
  })

  it('REPORTED, NOT CHANGED: the admin dashboard still reads payments with a wildcard', () => {
    // app/(admin)/admin/page.tsx pulls every column — including provider_token
    // and metadata — into the admin page's server memory for its five most
    // recent completed payments. Service-role, so unaffected by 059 and not a
    // blocker; narrowing it needs its own authorization. Pinned here so the
    // finding cannot be silently lost, and so this test fails if someone
    // "fixes" it without a slice.
    const admin = readers.filter(r => r.file === 'app/(admin)/admin/page.tsx')
    expect(admin.map(r => r.select).sort())
      .toEqual(['*', '*, profiles(full_name, email), courses(title)', 'amount'].sort())
    expect(admin.every(r => r.client === 'service')).toBe(true)
  })
})
