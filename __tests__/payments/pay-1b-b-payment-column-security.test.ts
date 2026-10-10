// @vitest-environment node
/**
 * PAY-LAUNCH-02D / PAY-1B(b) — migration 059, payment column SELECT security.
 *
 * ── WHAT 059 CLOSES ──────────────────────────────────────────────────────
 *
 * RLS decides ROWS, not COLUMNS. After 058 the browser roles still held
 * table-wide SELECT on public.payments, so a learner's `select('*')` returned
 * all 17 columns of their own rows — `metadata` and `provider_token` included.
 * 059 converts that into an explicit six-column allowlist for `authenticated`
 * and removes `anon`'s payment SELECT entirely.
 *
 * ── THE ALLOWLIST WAS MEASURED ───────────────────────────────────────────
 *
 * Five of the six are the fields the confirmation page renders. The sixth,
 * `course_id`, is NOT in the page's select string and is still REQUIRED:
 * PostgREST resolves the `courses(title)` embed by joining through it. Measured
 * on PostgreSQL 17 — with the other five granted and `course_id` withheld the
 * embed join fails 42501; with it granted the title comes back.
 *
 * `user_id` is deliberately withheld, which is safe for a reason also measured:
 * an RLS policy expression is not subject to the CALLER's column privileges, so
 * `payments_own` keeps filtering on `user_id` while no browser role can read
 * it. Both halves are asserted inside the migration.
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────
 *
 * This suite reads SOURCE TEXT: what 059 says, and that it says nothing else.
 * EFFECTIVE privilege is proven by the offline PGlite harness (PostgreSQL 17,
 * scratchpad, not committed), which rebuilds production's pre-058 state,
 * applies the real 058 and then the real 059 across seven worlds — including
 * three hostile ones: a pre-existing COLUMN grant on provider_token (which a
 * table-level revoke would not clear), a grant to PUBLIC (which revoking from
 * anon/authenticated would not reach), and a privilege INHERITED through role
 * membership (which no revoke can reach at all, and which 059 must therefore
 * detect and refuse).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/059_payment_column_select_security.sql'
const RAW = read(MIG)
/** Comments blanked, length preserved, so a comment cannot satisfy an assertion. */
const SQL = RAW.replace(/--[^\n]*/g, m => ' '.repeat(m.length))
/** Statements only: literals and quoted identifiers blanked too. */
const CODE = SQL.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""')
const FLAT = SQL.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const PAGE = 'app/(platform)/checkout/confirm/page.tsx'

/** The six columns 059 grants, and the eleven it withholds. */
const ALLOW = ['id', 'course_id', 'reference', 'amount', 'currency', 'status'] as const
const DENY = ['user_id', 'company_id', 'method', 'provider_reference', 'metadata',
              'created_at', 'completed_at', 'provider', 'provider_mode',
              'provider_token', 'entitlement_id'] as const
/** 058's post-apply shape, taken from 058's own pinned list. */
const PAYMENTS_17 = (() => {
  const sql = read('supabase/migrations/058_payment_provider_foundation.sql')
  const c = [...sql.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
  return c.find(x => x.length === 17) ?? []
})()

/** The `grant select (…) to authenticated` column list, parsed out of 059. */
const GRANTED = (() => {
  const m = /grant select \(([\s\S]*?)\) on public\.payments to authenticated;/i.exec(SQL)
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []
})()

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(b) — 059 exists, alone, as one transaction that writes nothing', () => {
  it('059 is exactly this migration, and nothing sits above it', () => {
    const f = readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql'))
    expect(f.filter(x => x.startsWith('059'))).toEqual(['059_payment_column_select_security.sql'])
    expect(f.filter(x => parseInt(x, 10) > 59)).toEqual([])
    expect(f.filter(x => x.startsWith('046'))).toEqual([])
    expect(f.filter(x => x.startsWith('051'))).toEqual([])
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(59)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('058 — the migration 059 is written against — is byte-identical', () => {
    const blob = (p: string) =>
      execFileSync('git', ['hash-object', p], { cwd: ROOT, encoding: 'utf8' }).trim()
    expect(blob('supabase/migrations/058_payment_provider_foundation.sql'))
      .toBe('7b6e2a0bca7aeaedf1f87ac9bc3c3d4aa9464305')
    expect(PAYMENTS_17).toHaveLength(17)
  })

  it('runs as ONE repeatable-read transaction and emits no unobservable output', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(CODE.match(/(^|\s)begin;/g)).toBeNull()
    expect(count(CODE, 'commit;')).toBe(1)
    expect(CODE.indexOf('begin isolation level repeatable read;')).toBeLessThan(CODE.indexOf('commit;'))
    // The Supabase SQL editor does not display NOTICE, so anything worth
    // knowing must be an exception that stops the apply.
    expect(count(SQL, 'raise notice')).toBe(0)
    expect(count(SQL, 'raise exception')).toBeGreaterThanOrEqual(20)
  })

  it('writes NO table and creates no object', () => {
    expect(CODE).not.toMatch(/\binsert\s+into\b/i)
    expect(CODE).not.toMatch(/\bupdate\s+[\w.]+\s+set\b/i)
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i)
    expect(CODE).not.toMatch(/\btruncate\b/i)
    expect(CODE).not.toMatch(/create\s+(or\s+replace\s+)?(function|view|trigger)/i)
    expect(CODE).not.toMatch(/alter\s+table/i)        // no schema change at all
    expect(CODE).not.toMatch(/drop\s+(table|column|constraint|index)/i)
    // The one table it creates is the temp snapshot, which cannot outlive COMMIT.
    const tables = CODE.match(/create\s+(temp\s+)?table[\s\S]*?\bas\b/gi) ?? []
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatch(/create temp table pay_1b_059_before on commit drop as/i)
  })

  it('touches NO policy — 058\'s row ownership and write denials are left alone', () => {
    expect(CODE, '059 must not create a policy').not.toMatch(/create\s+policy/i)
    expect(CODE, '059 must not drop a policy').not.toMatch(/drop\s+policy/i)
    expect(CODE, '059 must not alter a policy').not.toMatch(/alter\s+policy/i)
    expect(CODE).not.toMatch(/enable\s+row\s+level\s+security/i)
    expect(CODE).not.toMatch(/disable\s+row\s+level\s+security/i)
  })

  it('every grant and revoke is on public.payments, and SELECT is the only privilege moved', () => {
    // Exactly two: one `revoke all` (which clears both layers) and one
    // column-scoped grant. The redundant per-column revoke the first draft
    // carried is gone — see the breadth test below.
    const stmts = CODE.match(/^[ \t]*(grant|revoke)[\s\S]*?;/gim) ?? []
    expect(stmts).toHaveLength(2)
    for (const s of stmts) {
      expect(s, `not scoped to payments: ${s.slice(0, 60)}`).toMatch(/on public\.payments\b/i)
    }
    // No write privilege is granted or revoked by name.
    for (const s of stmts) {
      expect(s, `moves a write privilege: ${s.slice(0, 70)}`)
        .not.toMatch(/\b(insert|update|delete|truncate|trigger|references)\b/i)
    }
    expect(CODE, 'never GRANT ALL').not.toMatch(/grant\s+all\b/i)
    expect(CODE, 'nothing is granted TO public').not.toMatch(/grant[\s\S]{0,120}\bto\s+public\b/i)
  })

  it('the final verification block is the LAST statement before COMMIT', () => {
    const body = RAW.slice(0, RAW.indexOf('\ncommit;') + 1)
    const last = body.lastIndexOf('$do$;')
    expect(last).toBeGreaterThan(0)
    expect(body.slice(last + '$do$;'.length).replace(/--[^\n]*/g, '').trim()).toBe('')
  })

  it('it carries a guarded, documented rollback', () => {
    const tail = RAW.slice(RAW.lastIndexOf('-- ROLLBACK'))
    expect(tail).toMatch(/-- begin;/)
    expect(tail).toMatch(/-- commit;/)
    expect(tail, 'the rollback must refuse while a token exists').toMatch(/carry a provider_token/)
    expect(tail).toMatch(/grant select on public\.payments to anon, authenticated/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(b) — the allowlist', () => {
  it('grants exactly the six measured columns to `authenticated`', () => {
    expect(GRANTED.sort()).toEqual([...ALLOW].sort())
    expect(GRANTED).toHaveLength(6)
  })

  it('provider_token and metadata are excluded', () => {
    expect(GRANTED).not.toContain('provider_token')
    expect(GRANTED).not.toContain('metadata')
    expect(SQL).toMatch(/provider_token.*is still readable by authenticated|is still readable by authenticated/)
    // Asserted inside the migration, not merely omitted from the grant.
    expect(SQL).toMatch(/has_column_privilege\('authenticated', 'public\.payments', 'provider_token', 'SELECT'\)/)
    expect(SQL).toMatch(/has_column_privilege\('authenticated', 'public\.payments', 'metadata', 'SELECT'\)/)
  })

  it('course_id IS granted, because the courses(title) embed joins through it', () => {
    expect(GRANTED).toContain('course_id')
    expect(SQL).toMatch(/cannot read payments\.course_id/)
    expect(SQL).toMatch(/courses\(title\) embed/)
  })

  it('user_id is NOT granted, and RLS is asserted to keep filtering on it anyway', () => {
    expect(GRANTED).not.toContain('user_id')
    expect(SQL).toMatch(/payments_own no longer scopes SELECT by user_id/)
    expect(SQL).toMatch(/pg_get_expr\(polqual, polrelid\) like '%user_id%'/)
  })

  it('all 17 columns are classified — six granted, eleven withheld, none forgotten', () => {
    expect([...ALLOW, ...DENY].sort()).toEqual([...PAYMENTS_17].sort())
    expect(ALLOW.length + DENY.length).toBe(17)
    // The migration makes the same check against the live table.
    expect(SQL).toMatch(/but this migration classified/)
    expect(SQL).toMatch(/the classification names column\(s\) that do not exist/)
  })

  it('the allowlist is enumerated explicitly, never computed', () => {
    // 038/055 pattern: a column added later is unreadable until someone grants
    // it deliberately.
    const grant = /grant select \([\s\S]*?\) on public\.payments to authenticated;/i.exec(SQL)?.[0] ?? ''
    expect(grant).toBeTruthy()
    for (const c of ALLOW) expect(grant).toMatch(new RegExp(`\\b${c}\\b`))
    // The COLUMN LIST — not the statement, which naturally contains the word
    // "select" — must be bare identifiers: no subquery, no catalogue lookup, no
    // dynamic SQL building the list at apply time.
    expect(GRANTED.length).toBeGreaterThan(0)
    for (const c of GRANTED) {
      expect(c, `not a bare column name: ${JSON.stringify(c)}`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
    const inside = /grant select \(([\s\S]*?)\) on public\.payments/i.exec(SQL)?.[1] ?? ''
    expect(inside, 'the grant list is computed rather than enumerated')
      .not.toMatch(/\b(select|from|pg_attribute|format|execute|union)\b/i)
    // Nor is any grant assembled through dynamic SQL anywhere in the file.
    expect(CODE, 'no dynamic GRANT/REVOKE').not.toMatch(/execute\s+(format|'|")/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(b) — both privilege layers, and PUBLIC', () => {
  it('ONE revoke of ALL clears the table privilege and every column grant', () => {
    // MEASURED, and the opposite of this suite's first draft: a table-level
    // REVOKE of a privilege also removes that privilege's COLUMN grants
    // (`revoke all` and `revoke select` both clear a `grant select (col)`;
    // `revoke update` does not). So one statement is sufficient, and an
    // explicit per-column revoke would be redundant rather than load-bearing.
    expect(SQL).toMatch(/revoke all on public\.payments from public, anon, authenticated;/i)
    // It must stay `all` (or at least `select`): revoking some other privilege
    // would leave a stray column SELECT in place.
    const revokes = SQL.match(/^[ \t]*revoke[\s\S]*?;/gim) ?? []
    expect(revokes).toHaveLength(1)
    expect(revokes[0]).toMatch(/revoke all\b/i)
    expect(revokes[0], 'a revoke of a non-SELECT privilege would not clear column SELECT')
      .not.toMatch(/revoke\s+(update|insert|delete|references|trigger)\b/i)
  })

  it('the revoke reaches PUBLIC, which a role-scoped revoke would not', () => {
    for (const m of SQL.match(/revoke[\s\S]*?on public\.payments from ([^;]+);/gi) ?? []) {
      expect(m, `a revoke that misses PUBLIC: ${m.slice(0, 70)}`).toMatch(/from public, anon, authenticated/i)
    }
    expect(SQL).toMatch(/grants privilege\(s\) to PUBLIC/)
    expect(SQL).toMatch(/aclexplode/)
  })

  it('the revoke precedes the grant, so the allowlist is not immediately cleared', () => {
    const revoke = CODE.indexOf('revoke all on public.payments')
    const grant = CODE.search(/grant select \(/i)
    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(revoke, 'revoking after granting would wipe the allowlist').toBeLessThan(grant)
  })

  it('an inherited privilege is DETECTED rather than wrongly assumed revocable', () => {
    // No revoke can remove a privilege held by a role that `authenticated` is a
    // member of. 059 cannot fix that, so it must refuse and say where to look.
    expect(SQL).toMatch(/INHERITED privilege/)
    expect(SQL).toMatch(/pg_has_role\('authenticated', r\.oid, 'USAGE'\)/)
    expect(SQL).toMatch(/Revoke there, or remove the membership/)
  })

  it('asserts EFFECTIVE privilege, not the GRANT statements it just issued', () => {
    // has_column_privilege accounts for privileges reaching a role through
    // role membership — which reading the GRANTs would miss entirely.
    expect(SQL).toMatch(/has_column_privilege/)
    expect(SQL).toMatch(/has_any_column_privilege\('anon', 'public\.payments', 'SELECT'\)/)
    expect(SQL).toMatch(/effective privilege, so check role membership as well as direct grants/)
    // And when it cannot fix an inherited grant, it names where it came from.
    expect(SQL).toMatch(/pg_has_role\('authenticated', r\.oid, 'USAGE'\)/)
    expect(SQL).toMatch(/INHERITED privilege/)
  })

  it('anon loses payment SELECT entirely', () => {
    expect(GRANTED).not.toContain('anon')
    expect(SQL, 'nothing may be granted to anon').not.toMatch(/grant[\s\S]{0,120}to anon\b/i)
    expect(SQL).toMatch(/anon can still read payment column\(s\)/)
    expect(SQL).toMatch(/anon still holds table-level SELECT/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(b) — it fails closed on unexpected production state', () => {
  it('refuses unless 058\'s SCHEMA is present', () => {
    expect(SQL).toContain(`'${[...PAYMENTS_17].sort().join(',')}'`)
    expect(SQL).toMatch(/the seventeen columns migration 058 produced/)
    expect(SQL).toMatch(/row level security is NOT enabled/)
  })

  it('refuses unless 058\'s SECURITY state is present', () => {
    // Both browser roles must still hold table SELECT (what 059 withdraws)...
    expect(SQL).toMatch(/does not hold table-level SELECT on public\.payments/)
    expect(SQL).toMatch(/is 059 already applied/)
    // ...and hold no write privilege (what 058 withdrew).
    expect(SQL).toMatch(/058''s write withdrawal is not in place/)
    // ...and 058's four policies must all be present.
    for (const p of ['payments_own', 'payments_insert_service',
                     'payments_no_browser_update', 'payments_no_browser_delete']) {
      expect(SQL, `${p} is not required by the preflight`).toContain(`'${p}'`)
    }
    expect(SQL).toMatch(/this is not the policy set 058 left behind/)
    // ...and the resulting policy set is pinned exactly.
    expect(SQL).toContain("'payments_insert_service/a/P payments_no_browser_delete/d/R payments_no_browser_update/w/R payments_own/r/P'")
  })

  it('REFUSES if any provider_token already exists — the sequencing gate', () => {
    expect(SQL).toMatch(/where provider_token is not null/)
    expect(SQL).toMatch(/already carry a provider_token/)
    expect(SQL).toMatch(/Re-plan the sequence rather than applying 059 now/)
    // Restated at the end of the transaction.
    const at = RAW.indexOf('══ 3. NOT ONE PAYMENT ROW WAS WRITTEN')
    expect(at).toBeGreaterThan(0)
    expect(SQL.slice(at)).toMatch(/acquired a provider_token during this transaction/)
  })

  it('preserves service-role reconciliation authority, columns included', () => {
    expect(SQL).toMatch(/to_regrole\('service_role'\)/)
    expect(SQL).toMatch(/service_role lost % on public\.payments/)
    expect(SQL).toMatch(/service_role lost SELECT on payments\.% — reconciliation needs every column/)
    expect(CODE, 'service_role must never be revoked from').not.toMatch(/revoke[\s\S]{0,90}service_role/i)
  })

  it('proves no payment row was written, in the last block', () => {
    expect(SQL).toMatch(/payments_md5/)
    expect(SQL).toMatch(/payment row data changed/)
    expect(SQL).toMatch(/the payment count changed from % to %/)
    // The fingerprint names all 17 columns explicitly.
    for (const c of PAYMENTS_17) expect(SQL, `${c} missing from the fingerprint`).toMatch(new RegExp(`p\\.${c}\\b`))
  })

  it('introduces no PayDunya integration and does not create the completion authority', () => {
    expect(RAW).not.toMatch(/PAYDUNYA_(MODE|TEST_|LIVE_)/)
    expect(RAW).not.toMatch(/MASTER_KEY|PRIVATE_KEY/)
    expect(RAW).not.toMatch(/https?:\/\//)
    expect(RAW).not.toMatch(/paydunya\.com/i)
    expect(CODE).not.toMatch(/create\s+(or\s+replace\s+)?function[\s\S]{0,80}complete_payment/i)
    expect(SQL).toMatch(/complete_payment\(text,text\)'\) is not null/)
  })

  it('changes no entitlement, enrollment, certificate or price — it names none of them', () => {
    for (const t of ['entitlements', 'enrollments', 'certificates', 'lesson_progress',
                     'quiz_attempts', 'course_codes', 'has_course_access', 'my_course_access']) {
      expect(CODE, `059 references ${t}`).not.toContain(t)
    }
    // `courses` appears only as prose about the embed, never as a statement.
    expect(CODE, '059 must not touch public.courses').not.toMatch(/on public\.courses\b/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1B(b) — compatibility with the already-deployed reader', () => {
  const PAGE_SRC = read(PAGE)
  const projection = /\.select\('([^']*)'\)/.exec(PAGE_SRC)?.[1] ?? ''
  const parts = (() => {
    const out: string[] = []
    let depth = 0, cur = ''
    for (const ch of projection) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  })()
  const pageColumns = parts.filter(p => !p.includes('('))
  const pageEmbeds = parts.filter(p => p.includes('('))

  it('PAY-1B(a) is deployed: the reader is an explicit projection', () => {
    expect(projection).toBe('id, reference, amount, currency, status, courses(title)')
    expect(PAGE_SRC).not.toMatch(/\.select\('\*/)
  })

  it('every column the deployed page selects is in the allowlist', () => {
    for (const c of pageColumns) {
      expect(GRANTED, `the deployed page selects ${c}, which 059 would withhold → 42501`).toContain(c)
    }
    expect(pageColumns.sort()).toEqual(['amount', 'currency', 'id', 'reference', 'status'])
  })

  it('the embed\'s join column is in the allowlist even though the page never names it', () => {
    // THE DEFECT THIS CATCHES: `courses(title)` needs payments.course_id, so an
    // allowlist built only from the select string would break the page.
    expect(pageEmbeds).toEqual(['courses(title)'])
    expect(GRANTED, 'courses(title) joins through course_id, which must be granted').toContain('course_id')
  })

  it('the allowlist is the page\'s needs and nothing more', () => {
    const needed = new Set([...pageColumns, 'course_id'])
    expect([...GRANTED].sort()).toEqual([...needed].sort())
  })

  it('the confirmation page is still the ONLY browser-role payment reader', () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      if (!existsSync(dir)) return acc
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === '.next') continue
        const full = join(dir, e)
        if (statSync(full).isDirectory()) walk(full, acc)
        else if (/\.(ts|tsx)$/.test(e)) acc.push(full)
      }
      return acc
    }
    const browser: string[] = []
    for (const f of ['app', 'components', 'lib'].flatMap(d => walk(join(ROOT, d)))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(\w+)\s*\.\s*from\(\s*'payments'\s*\)/g)) {
        const recv = m[1]
        const isService = new RegExp(`const\\s+${recv}\\s*=\\s*createAdminClient\\(`).test(src)
        const isBrowser = new RegExp(`const\\s+${recv}\\s*=\\s*(await\\s+)?createClient\\(`).test(src)
        expect(isService || isBrowser, `unclassifiable payment reader in ${f}`).toBe(true)
        if (isBrowser) browser.push(f.slice(ROOT.length + 1).replace(/\\/g, '/'))
      }
    }
    expect(browser).toEqual([PAGE])
  })

  it('059 records the rollout precondition and what remains after it', () => {
    const note = RAW.slice(RAW.indexOf('OPERATOR STEP'))
    expect(note).toMatch(/PRECONDITION, already satisfied/)
    expect(note).toMatch(/9308938/)
    expect(note).toMatch(/id, reference, amount, currency, status, courses\(title\)/)
    expect(note, 'the operator must know what breaks if 1B(a) is rolled back').toMatch(/42501/)
    expect(note).toMatch(/SEC-4/)
    expect(note).toMatch(/PAID-LAUNCH BLOCKER/)
    expect(note).toMatch(/N-3/)
    expect(note, 'PAY-2 may now write tokens').toMatch(/PAY-2 may now write\s*\n?--\s*provider_token/)
  })
})
