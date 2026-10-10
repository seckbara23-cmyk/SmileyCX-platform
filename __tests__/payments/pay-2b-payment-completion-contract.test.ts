// @vitest-environment node
/**
 * PAY-2B — migration 060, the payment completion contract.
 *
 * ── WHAT 060 ADDS ────────────────────────────────────────────────────────
 *
 *   status vocabulary  5 -> 7, adding 'cancelled' and 'expired'
 *   + failure_reason   text        why a payment did not succeed
 *   + last_ipn_at      timestamptz when the provider last notified us
 *   + unique index     payments_provider_token_unique (provider_token)
 *                      WHERE provider_token IS NOT NULL
 *
 * It creates NO function, changes NO policy, issues NO grant or revoke, and
 * writes NO payment row. complete_payment() remains PAY-2C.
 *
 * ── WHAT PROVES WHAT (the A/B/C split) ───────────────────────────────────
 *
 * An assertion belongs INSIDE the migration only if its outcome depends on the
 * production database at apply time. Everything that depends only on the file's
 * own text belongs here. So this suite reads SOURCE TEXT: what 060 says, that
 * it says nothing else, and that what it says agrees with 058, 059 and the
 * deployed confirmation page.
 *
 * EFFECTIVE privilege, real constraint behaviour and real index behaviour are
 * proven by the offline PGlite harness (PostgreSQL 17, scratchpad, not
 * committed), which rebuilds production's pre-058 state, applies the real 058,
 * 059 and 060 across twelve worlds — 206 checks — including nine hostile ones:
 * a provider_token already written, 059 absent, an inherited TABLE SELECT, a
 * stray column grant, the status CHECK under a different NAME (which 060 must
 * still handle, because it discovers the name rather than guessing it), the
 * CHECK with the wrong vocabulary, TWO status CHECKs, complete_payment()
 * already present, a re-apply, and SELECT granted to PUBLIC.
 *
 * ── THE ONE THING ONLY THIS SUITE CAN PROVE ──────────────────────────────
 *
 * An apply-time assertion proves nothing about statements that run AFTER it.
 * During 058 a mutant slipped a `create function` between the final
 * verification block and COMMIT and passed every assertion in the file. That
 * class of defect is invisible to the database and visible only in the text, so
 * the "nothing follows the final verification block" test below is load-bearing
 * rather than decorative.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/060_payment_completion_contract.sql'
const RAW = read(MIG)
/** Comments blanked, LENGTH PRESERVED, so RAW offsets still map into SQL. */
const SQL = RAW.replace(/--[^\n]*/g, m => ' '.repeat(m.length))
/** Statements only: literals and quoted identifiers blanked too. */
const CODE = SQL.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""')
const FLAT = SQL.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const PAGE = 'app/(platform)/checkout/confirm/page.tsx'

const NEW_COLUMNS = ['failure_reason', 'last_ipn_at'] as const
const OLD_STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded'] as const
const NEW_STATUSES = ['cancelled', 'expired'] as const
const SEVEN = [...OLD_STATUSES, ...NEW_STATUSES]
/** The five states that must stay OUTSIDE 058's in-flight predicate. */
const TERMINAL = ['completed', 'failed', 'refunded', 'cancelled', 'expired'] as const
/** 059's six-column allowlist, parsed from 059 itself rather than retyped. */
const ALLOW_059 = (() => {
  const sql = read('supabase/migrations/059_payment_column_select_security.sql')
    .replace(/--[^\n]*/g, '')
  const m = /grant select \(([\s\S]*?)\) on public\.payments to authenticated;/i.exec(sql)
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []
})()
/** 058's post-apply shape, taken from 058's own pinned 17-column string. */
const PAYMENTS_17 = (() => {
  const sql = read('supabase/migrations/058_payment_provider_foundation.sql')
  const c = [...sql.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
  return c.find(x => x.length === 17) ?? []
})()
/** 060's own pinned 19-column string, parsed the same way. */
const PAYMENTS_19 = (() => {
  const c = [...SQL.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
  return c.find(x => x.length === 19) ?? []
})()

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — 060 exists, alone, as one transaction', () => {
  it('060 is exactly this migration, and nothing sits above it', () => {
    const f = readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql'))
    expect(f.filter(x => x.startsWith('060'))).toEqual(['060_payment_completion_contract.sql'])
    const above = f.filter(x => /^0*(0[6-9][1-9]|0[7-9]\d|1\d\d)_/.test(x))
    expect(above, `migrations above 060 exist: ${above.join(', ')}`).toEqual([])
  })

  it('058 and 059 are unchanged by this slice', () => {
    // 060 is forward-only. If a predecessor were edited, 060's preflight would
    // be asserting a shape its own repository no longer describes.
    const m058 = read('supabase/migrations/058_payment_provider_foundation.sql')
    const m059 = read('supabase/migrations/059_payment_column_select_security.sql')
    expect(PAYMENTS_17).toHaveLength(17)
    expect(ALLOW_059).toEqual(['id', 'course_id', 'reference', 'amount', 'currency', 'status'])
    // 059 still carries exactly the two privilege statements it shipped with.
    // Statement-initial only: "grant" also occurs inside 059's own error text.
    const stmts059 = m059.replace(/--[^\n]*/g, '').split('\n')
      .filter(l => /^\s*(grant|revoke)\s/i.test(l))
      .map(l => l.trim().split(/\s+/)[0].toLowerCase())
    expect(stmts059).toEqual(['revoke', 'grant'])
    // 058 still carries the in-flight index whose predicate 060 depends on.
    expect(m058).toContain('payments_one_inflight_intent_per_course')
  })

  it('it is ONE transaction: a single begin, a single commit, REPEATABLE READ', () => {
    expect(count(CODE, 'begin isolation level repeatable read;')).toBe(1)
    // `begin` also opens every DO block, so count only statement-initial ones.
    expect((SQL.match(/^begin[ ;]/gm) ?? []).length).toBe(1)
    expect((SQL.match(/^commit;$/gm) ?? []).length).toBe(1)
    expect(SQL.indexOf('begin isolation')).toBeLessThan(SQL.lastIndexOf('commit;'))
    expect(CODE).not.toContain('rollback')
  })

  it('it emits no RAISE NOTICE — the Supabase SQL editor does not display them', () => {
    // Comment-masked: the operator note mentions NOTICE in prose, deliberately.
    expect(SQL.toLowerCase()).not.toContain('raise notice')
    expect(SQL.toLowerCase()).not.toContain('raise warning')
    expect(SQL.toLowerCase()).not.toContain('raise info')
  })

  it('the file carries an operator step and a guarded, fully commented rollback', () => {
    expect(RAW).toContain('OPERATOR STEP — NOT APPLIED AT AUTHORING TIME')
    const rb = RAW.slice(RAW.indexOf('-- ROLLBACK'))
    expect(rb).toContain('-- begin;')
    expect(rb).toContain('-- commit;')
    // Every line of the rollback is a comment: it must never execute on apply.
    const live = rb.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'))
    expect(live, `executable lines inside the rollback: ${live.join(' | ')}`).toEqual([])
    // It refuses rather than destroying data that depends on the new contract.
    expect(rb).toContain('rely on the new contract')
    for (const s of NEW_STATUSES) expect(rb).toContain(`'${s}'`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — what 060 adds, and nothing more', () => {
  it('adds exactly two columns, both nullable, neither with a default', () => {
    const add = /alter table public\.payments\n\s+add column[\s\S]*?;/.exec(SQL)?.[0] ?? ''
    expect(add).toBeTruthy()
    for (const c of NEW_COLUMNS) expect(add).toContain(c)
    expect(add).toContain('failure_reason text')
    expect(add).toContain('last_ipn_at    timestamptz')
    // A default or NOT NULL would rewrite or reject every existing row.
    expect(add.toLowerCase()).not.toContain('default')
    expect(add.toLowerCase()).not.toContain('not null')
    expect(count(CODE, 'add column')).toBe(2)
    // No other column is added, and none is dropped or retyped.
    expect(CODE).not.toContain('drop column')
    expect(CODE).not.toContain('alter column')
    for (const c of ['webhook_id', 'payment_intent_id', 'updated_at']) {
      // Migration 003's columns stay withdrawn — provider_token is the replay key.
      expect(CODE, `003's ${c} must not reappear`).not.toContain(c)
    }
  })

  it('both new columns are documented as server-only, never granted', () => {
    for (const c of NEW_COLUMNS) {
      const cm = new RegExp(`comment on column public\\.payments\\.${c} is[\\s\\S]*?;`).exec(RAW)?.[0]
      expect(cm, `${c} has no comment`).toBeTruthy()
      expect(cm).toMatch(/NOT granted to any browser role/)
    }
  })

  it('replaces the status CHECK with exactly seven values, written out in full', () => {
    const add = /add constraint payments_status_valid\s*\n\s*check \(status in \(([\s\S]*?)\)\);/.exec(SQL)
    expect(add, 'the new CHECK is not a literal seven-value list').toBeTruthy()
    const values = add![1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
    expect(values.sort()).toEqual([...SEVEN].sort())
    expect(values).toHaveLength(7)
    // Exactly one CHECK is added, and it is named (an inline CHECK would be
    // auto-named, which is the very provenance problem 060 exists to navigate).
    expect(count(CODE, 'add constraint')).toBe(1)
    expect(count(CODE, 'check (')).toBe(1)
  })

  it('DISCOVERS the old constraint name instead of guessing it', () => {
    // Production's payments carries company_id, a column no migration here
    // creates, so its constraint names are not this repository's to assume.
    expect(CODE).toContain('execute format(')
    expect(FLAT).toMatch(/execute format\('alter table public\.payments drop constraint %I', v_name\)/)
    // The ONLY drop constraint is the dynamic one: no hardcoded name anywhere.
    expect(count(CODE, 'drop constraint')).toBe(0)
    expect(SQL).not.toMatch(/drop constraint (if exists )?payments_status_check/)
    // Discovery is by SHAPE: a single-column CHECK whose one column is status.
    expect(FLAT).toMatch(/c\.contype = 'c'\s*and c\.conkey = array\[\(select a\.attnum/)
    // ...and it is counted before it is read, because `select into` is not strict.
    expect(FLAT).toMatch(/single-column CHECK constraint\(s\) on status; this migration replaces exactly one/)
  })

  it('adds the replay key as a PARTIAL UNIQUE index on provider_token', () => {
    const idx = /create unique index payments_provider_token_unique[\s\S]*?;/.exec(SQL)?.[0] ?? ''
    expect(idx).toBeTruthy()
    expect(idx).toContain('on public.payments (provider_token)')
    // PARTIAL: every existing row has a NULL token and NULLs must stay distinct.
    expect(idx).toContain('where provider_token is not null')
    expect(count(CODE, 'create unique index')).toBe(1)
    expect(count(CODE, 'create index')).toBe(0)
    const cm = /comment on index public\.payments_provider_token_unique is[\s\S]*?;/.exec(RAW)?.[0]
    expect(cm).toBeTruthy()
    // The reason it must be the DATABASE and not a handler: the IPN hash is not
    // a signature over the payload, so a replay passes the provider's own check.
    expect(cm).toMatch(/SHA-512 of the master key/)
  })

  it('does not touch 058 artifacts it must preserve', () => {
    expect(CODE).not.toContain('drop index')
    expect(CODE).not.toContain('drop policy')
    expect(CODE).not.toContain('create policy')
    expect(CODE).not.toContain('alter policy')
    expect(CODE).not.toContain('drop constraint payments_provider_mode')
    // 058's in-flight index is only ever READ, never redefined.
    // SQL, not CODE: every mention is inside a string literal, which CODE blanks.
    expect(count(SQL, 'payments_one_inflight_intent_per_course')).toBeGreaterThan(0)
    expect(SQL).not.toMatch(/create (unique )?index payments_one_inflight/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — 060 issues no privilege statement at all', () => {
  it('there is no grant and no revoke in the executable SQL', () => {
    // 059's allowlist is ASSERTED by 060, never re-issued. Re-granting would
    // mask the very failure the new-column audit exists to detect.
    const stmts = SQL.split('\n').filter(l => /^\s*(grant|revoke)\s/i.test(l))
    expect(stmts, `privilege statements found: ${stmts.join(' | ')}`).toEqual([])
    expect(CODE).not.toMatch(/\bgrant\b/i)
    expect(CODE).not.toMatch(/\brevoke\b/i)
  })

  it('neither new column is named in any allowlist-shaped construct', () => {
    // The six-column allowlist appears in 060 only as the thing it asserts is
    // UNCHANGED. If a new column were added to it, the browser would gain a
    // reconciliation field.
    const allowArrays = [...SQL.matchAll(/v_allow\s+constant text\[\] := array\[([^\]]*)\]/g)]
    expect(allowArrays.length).toBeGreaterThan(0)
    for (const a of allowArrays) {
      const cols = a[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
      expect(cols).toEqual(ALLOW_059)
      for (const c of NEW_COLUMNS) expect(cols).not.toContain(c)
    }
  })

  it('the new-column grant audit asserts BOTH browser roles cannot read BOTH columns', () => {
    // 060 is the first real test of 059's fail-closed claim: a column-level
    // grant does not extend to a column added after it. The claim is VERIFIED
    // here rather than trusted, so this assertion must exist in the file.
    const newArr = /v_new\s+constant text\[\] := array\[([^\]]*)\]/.exec(SQL)
    expect(newArr, 'the audit has no v_new array').toBeTruthy()
    expect(newArr![1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))).toEqual([...NEW_COLUMNS])
    expect(FLAT).toMatch(
      /foreach v_col in array v_new loop\s*foreach v_role in array array\['anon', 'authenticated'\] loop\s*if has_column_privilege\(v_role, 'public\.payments', v_col, 'SELECT'\) then/)
    expect(FLAT).toMatch(/can read the NEW column payments\.% — a column-level grant was extended/)
    // ...and that service_role, which holds a TABLE grant, DID pick them up.
    expect(FLAT).toMatch(/service_role cannot read the new column payments\.%/)
  })

  it('privilege is asserted EFFECTIVELY, which is what accounts for inheritance', () => {
    // Reading GRANT statements proves nothing: has_*_privilege is the only test
    // that accounts for role membership and PUBLIC.
    expect(count(CODE, 'has_column_privilege(')).toBeGreaterThanOrEqual(6)
    expect(count(CODE, 'has_table_privilege(')).toBeGreaterThanOrEqual(6)
    expect(count(CODE, 'has_any_column_privilege(')).toBeGreaterThanOrEqual(2)
    // PUBLIC is checked at BOTH layers, via relacl and attacl.
    expect(CODE).toContain('aclexplode')
    expect(SQL).toContain('aclexplode(c.relacl)')
    expect(SQL).toContain('aclexplode(a.attacl)')
    // A privilege reaching authenticated is diagnosed by SOURCE, because the
    // remedy differs: PUBLIC is revoked from PUBLIC, inheritance at its origin.
    expect(FLAT).toMatch(/PUBLIC \(granted to every role; revoke from PUBLIC, not from authenticated\)/)
    expect(FLAT).toMatch(/INHERITED via role membership from: /)
    expect(CODE).toContain('pg_has_role(')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — the preflight fails closed on unexpected production state', () => {
  it('it refuses a re-apply BEFORE it complains about the column shape', () => {
    // These ran in the other order at first, which made the re-apply guard
    // unreachable: a second apply reported "payments has nineteen columns;
    // written against seventeen" instead of "already applied". Harness world K
    // found it. The most specific diagnosis must come first.
    const reapply = SQL.indexOf('already exist; refusing to re-apply')
    const shape = SQL.indexOf('this migration was written against the seventeen columns')
    expect(reapply).toBeGreaterThan(0)
    expect(shape).toBeGreaterThan(0)
    expect(reapply, 're-apply guard must precede the shape check').toBeLessThan(shape)
  })

  it('it pins the 17 columns it was written against, matching 058 exactly', () => {
    const pinned = (() => {
      const c = [...SQL.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
      return c.find(x => x.length === 17) ?? []
    })()
    expect(pinned).toEqual([...PAYMENTS_17].sort())
    expect(pinned).toHaveLength(17)
  })

  it('it pins the 19 columns it produces: the same 17 plus exactly the 2 new ones', () => {
    expect(PAYMENTS_19).toHaveLength(19)
    expect(PAYMENTS_19).toEqual([...PAYMENTS_17, ...NEW_COLUMNS].sort())
    // Derived from 058's list, not retyped — so if 058's shape ever changed,
    // this fails in CI rather than as a mid-apply exception in production.
    expect(PAYMENTS_19.filter(c => !PAYMENTS_17.includes(c))).toEqual([...NEW_COLUMNS].sort())
  })

  it('it refuses unless 059 is actually in effect', () => {
    expect(FLAT).toMatch(/authenticated holds TABLE-level SELECT on public\.payments, so 059 is not in effect/)
    expect(FLAT).toMatch(/Adding columns now would hand them over automatically/)
    // Doubled apostrophes: inside a SQL literal, 059's is written 059''s.
    expect(FLAT).toMatch(/059''s six-column allowlist is not in place/)
    expect(FLAT).toMatch(/authenticated can read column\(s\) outside 059''s allowlist/)
    expect(FLAT).toMatch(/anon can still read public\.payments; 059 is not in effect/)
  })

  it('it refuses unless the status vocabulary is exactly the five it widens', () => {
    for (const s of OLD_STATUSES) expect(SQL).toContain(`'${s}'`)
    expect(FLAT).toMatch(/payments\.status CHECK does not admit ''%''/)
    expect(FLAT).toMatch(/CHECK names % distinct value\(s\), expected exactly the 5 this migration widens/)
    // Vocabulary is counted, not merely spot-checked, so a SIXTH unexpected
    // value is caught rather than silently dropped by the replacement.
    expect(CODE).toContain('regexp_matches(')
    expect(count(CODE, 'count(distinct parts[1])')).toBe(2)
  })

  it('it refuses data that the new contract could not hold', () => {
    // The sequencing gate: zero provider_tokens before PAY-2C writes the first.
    expect(FLAT).toMatch(/payment row\(s\) already carry a provider_token/)
    expect(FLAT).toMatch(/zero tokens before PAY-2C/)
    // ...duplicates, so the index failure is legible rather than a bare 23505...
    expect(FLAT).toMatch(/provider_token value\(s\) are duplicated/)
    // ...and no row outside the seven states the replacement CHECK will admit.
    expect(FLAT).toMatch(/payment row\(s\) carry a status outside the seven/)
    for (const s of SEVEN) {
      expect(SQL, `the data check must enumerate '${s}'`).toContain(`'${s}'`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — what 060 asserts it did NOT change', () => {
  it('the in-flight predicate must still exclude every terminal state', () => {
    // This is what makes 'expired' useful: expiring a dead intent frees the
    // one-live-intent slot, so a learner who abandoned a checkout can retry.
    const arr = /v_terminal constant text\[\] := array\[([^\]]*)\]/.exec(SQL)
    expect(arr, 'no v_terminal array').toBeTruthy()
    expect(arr![1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort())
      .toEqual([...TERMINAL].sort())
    expect(FLAT).toMatch(/the in-flight predicate now includes the TERMINAL state ''%'', which would block retry/)
    expect(FLAT).toMatch(/the in-flight predicate no longer covers pending and processing/)
    // Both new states are terminal, so both must be in that array.
    for (const s of NEW_STATUSES) expect(arr![1]).toContain(`'${s}'`)
  })

  it('the policy set is pinned byte-for-byte, all four of 058’s policies', () => {
    const pin = /payments_insert_service\/a\/P payments_no_browser_delete\/d\/R payments_no_browser_update\/w\/R payments_own\/r\/P/
    expect(SQL).toMatch(pin)
    // Name, command AND permissive/restrictive: a restrictive deny silently
    // turned permissive would still be present but could be out-voted.
    expect(FLAT).toMatch(/case when p\.polpermissive then 'P' else 'R' end/)
    expect(FLAT).toMatch(/payments_own no longer scopes SELECT by user_id/)
    expect(FLAT).toMatch(/row level security was disabled/)
  })

  it('both foreign keys the platform depends on are asserted', () => {
    expect(FLAT).toMatch(/entitlement_id FK to public\.entitlements \(ON DELETE SET NULL\) is gone/)
    expect(SQL).toContain("c.confdeltype = 'n'")
    // course_id's FK predates 058 and 060 cannot drop it, but PostgREST
    // resolves the confirmation page's courses(title) embed THROUGH it.
    expect(FLAT).toMatch(/course_id FK to public\.courses is gone/)
    expect(SQL).toContain("c.confrelid = 'public.courses'::regclass")
  })

  it('the final block proves no payment row was written, by explicit column list', () => {
    // The marker is a comment, so locate it in RAW and slice SQL at that
    // offset: the mask preserves length, so the offsets are interchangeable.
    const at = RAW.lastIndexOf('-- \u2550\u2550 5.')
    expect(at, 'the section 5 marker is missing').toBeGreaterThan(0)
    const last = SQL.slice(at)
    expect(last).toContain('payment row data changed')
    expect(last).toContain('the payment count changed')
    // to_jsonb would change shape once the columns are added and could hide a
    // rewrite, so the fingerprint names all 17 pre-060 columns explicitly.
    expect(last).not.toContain('to_jsonb')
    for (const c of PAYMENTS_17) expect(last, `fingerprint omits ${c}`).toContain(c)
    // ...and that neither new column was implicitly backfilled.
    expect(last).toMatch(/acquired a failure_reason or last_ipn_at/)
    expect(last).toMatch(/acquired a provider_token during this transaction/)
  })

  it('060 creates no function, and no SECURITY DEFINER anything', () => {
    expect(CODE).not.toMatch(/create (or replace )?function/i)
    expect(CODE).not.toMatch(/security definer/i)
    expect(CODE).not.toMatch(/security invoker/i)
    expect(CODE).not.toContain('create trigger')
    expect(CODE).not.toContain('create view')
    // And it refuses if a completion routine exists at the end — applying 060
    // after PAY-2C would mean 061 was written against a contract that was not
    // yet in place.
    expect(FLAT).toMatch(/a payment-completion routine exists at the end of this transaction/)
    expect(SQL).toContain("p.proname like '%complete%payment%'")
  })

  it('it touches no table other than public.payments', () => {
    // Every statement that could write names only payments; the other tables
    // appear in 060 solely as FK targets being asserted.
    expect(CODE).not.toMatch(/insert into/i)
    expect(CODE).not.toMatch(/delete from/i)
    expect(CODE).not.toMatch(/\btruncate\b/i)
    expect(CODE).not.toMatch(/update public\./i)
    const alters = [...SQL.matchAll(/^alter table (\S+)/gm)].map(m => m[1])
    expect([...new Set(alters)]).toEqual(['public.payments'])
    for (const t of ['entitlements', 'enrollments', 'certificates', 'courses', 'profiles']) {
      expect(SQL, `060 must not ALTER public.${t}`).not.toMatch(
        new RegExp(`alter table (public\\.)?${t}\\b`))
    }
    // Course prices are a commercial decision, never a migration's.
    expect(CODE).not.toContain('price')
    expect(CODE).not.toContain('is_published')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — the control only this suite can run', () => {
  it('the final verification block is the LAST statement before COMMIT', () => {
    // An apply-time assertion proves nothing about what runs after it. During
    // 058 a mutant placed a `create function` between the final block and
    // COMMIT and passed every assertion in the file. Only the text shows it.
    const commit = SQL.lastIndexOf('\ncommit;')
    expect(commit).toBeGreaterThan(0)
    const lastDo = SQL.lastIndexOf('$do$;', commit)
    expect(lastDo).toBeGreaterThan(0)
    const between = SQL.slice(lastDo + '$do$;'.length, commit)
    expect(between.trim(), `statements between the final block and COMMIT: ${between}`).toBe('')
  })

  it('every DO block is delimited $do$ and none nests another', () => {
    // A mismatched dollar-quote would make the SQL editor run a fragment of
    // this file as if it were a whole statement.
    expect(count(RAW, '\ndo $do$')).toBe(count(RAW, '$do$;'))
    expect(count(RAW, '$do$')).toBe(count(RAW, '\ndo $do$') * 2)
    expect(count(RAW, '\ndo $do$')).toBe(4)
  })

  it('no assertion can be satisfied by a comment', () => {
    // The masking this suite relies on: comments are blanked but offsets kept,
    // so a claim moved into prose stops satisfying its own test.
    expect(SQL).toHaveLength(RAW.length)
    expect(SQL).not.toContain('PAY-2B: the payment contract an atomic completion needs')
    expect(RAW).toContain('PAY-2B: the payment contract an atomic completion needs')
  })

  it('the header records what still blocks a PayDunya TEST transaction', () => {
    // These are owner decisions, not migrations, and must not be quietly lost
    // between slices.
    expect(RAW).toMatch(/priced 0 XOF/)
    expect(RAW).toMatch(/PRICE-LAUNCH-01/)
    expect(RAW).toMatch(/PLATFORM_MODE=pilot/)
    expect(RAW).toMatch(/SEC-4 certificate hardening/)
    expect(RAW).toMatch(/N-3/)
    // ...and what PAY-2C should build on top of it.
    expect(RAW).toMatch(/SECURITY INVOKER \(not DEFINER/)
    expect(RAW).toMatch(/revoke execute on function/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2B — cross-artifact agreement with the deployed reader', () => {
  it('the confirmation page still reads only columns 059 grants', () => {
    // 060 adds columns the page must NOT start reading. If someone widened the
    // projection to include one, this fails in CI rather than as a 42501 in
    // production.
    const page = read(PAGE)
    const sel = /\.select\('([^']*)'\)/.exec(page)
    expect(sel, 'the confirmation page has no .select()').toBeTruthy()
    const requested = sel![1]
    for (const c of NEW_COLUMNS) {
      expect(requested, `the page must not read ${c}`).not.toContain(c)
    }
    const top = requested.replace(/\w+\([^)]*\)/g, '').split(',').map(s => s.trim()).filter(Boolean)
    for (const c of top) {
      expect(ALLOW_059, `the page selects ${c}, which 059 does not grant`).toContain(c)
    }
    expect(requested).not.toContain('*')
  })

  it('no application code references the new columns yet', () => {
    // 060 is a contract, not a feature. PAY-2C writes these; nothing reads them.
    const dirs = ['app', 'components', 'lib', 'types']
    const hits: string[] = []
    const walk = (d: string) => {
      let entries
      try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = `${d}/${e.name}`
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        const src = read(p)
        for (const c of NEW_COLUMNS) if (src.includes(c)) hits.push(`${p}:${c}`)
      }
    }
    dirs.forEach(walk)
    expect(hits, `application code already references: ${hits.join(', ')}`).toEqual([])
  })

  it('the legacy payment stub is still unimported, and still out of scope', () => {
    // N1: lib/payments/index.ts grants the wrong authority (enrollments, not
    // entitlements). Deleting it is a separate slice; 060 must not make it look
    // closer to usable.
    const hits: string[] = []
    const walk = (d: string) => {
      let entries
      try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = `${d}/${e.name}`
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || p === 'lib/payments/index.ts') continue
        if (/from\s+['"][^'"]*lib\/payments['"]|from\s+['"]@\/lib\/payments['"]/.test(read(p))) hits.push(p)
      }
    }
    ;['app', 'components', 'lib', 'types'].forEach(walk)
    expect(hits, `lib/payments is now imported by: ${hits.join(', ')}`).toEqual([])
  })
})
