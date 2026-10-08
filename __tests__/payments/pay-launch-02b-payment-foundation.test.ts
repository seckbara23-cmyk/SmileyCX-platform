// @vitest-environment node
/**
 * PAY-LAUNCH-02B / PAY-1 — the payment provider foundation (migration 058),
 * and the end of browser-role write authority over public.payments.
 *
 * ── WHAT THIS SLICE IS ────────────────────────────────────────────────────
 *
 * Migration 058 adds four nullable columns, two CHECK constraints, one partial
 * unique index and one FK, and it closes T1: the `payments_update_own` policy
 * that let a learner mark their own payment 'completed' from the browser. It
 * writes NO row, and it creates nothing resembling a PayDunya integration —
 * PAY-2 owns the completion authority and the IPN.
 *
 * ── WHY THIS SUITE CARRIES MORE THAN IT USED TO ───────────────────────────
 *
 * The first draft of 058 was 842 lines, 430 of them executable, and 386 of
 * those were verification. The final review split them by one rule:
 *
 *   an assertion belongs in the MIGRATION only if its outcome depends on the
 *   production database at apply time; if it depends only on the migration's
 *   own text, it belongs HERE
 *
 * because the file is frozen and reviewed before it is applied. A migration
 * asserting that its own `create unique index … where status in (…)` produced
 * a unique partial index was only asking the database to confirm that the file
 * is the file — it could never fail. Roughly 200 executable lines of that came
 * out of 058 and the responsibility landed in this suite, which is why several
 * groups below assert DDL text where they once asserted the migration's own
 * apply-time checks.
 *
 * 058 keeps what it cannot know: the live column list, the live status
 * vocabulary, existing data, and the ACL and policy set that `revoke` and
 * `drop policy if exists` actually leave behind.
 *
 * ── WHAT PROVES WHAT ──────────────────────────────────────────────────────
 *
 * A vitest run has no database, so everything below reads migration SOURCE
 * TEXT (comments blanked, so a comment can never satisfy an assertion).
 *
 * Behaviour against real data is proven by the offline PGlite harness
 * (PostgreSQL 17, scratchpad, not committed), which rebuilds public.payments
 * with the THIRTEEN columns production actually has and the pre-058 authority
 * (Supabase's default table-wide grants plus the four policies 001 and 011
 * left behind), applies the real file and exercises it as anon, as a learner,
 * as a platform admin and as the service role across four worlds — the
 * production-faithful empty corpus, a legacy corpus, a corpus with a
 * pre-existing duplicate in-flight intent that 058 must refuse, and a decoy
 * relation of the same name in another schema that must NOT block the apply —
 * plus mutants of 058, every one caught.
 *
 * ONE class of defect is out of reach of both the migration and the harness: a
 * statement placed after the migration's final verification block but still
 * inside the transaction. Section 6 has already run and cannot see it. A draft
 * that created complete_payment() there passed every apply-time check, so the
 * FILE's shape is the control, and `the final verification block is the last
 * statement before COMMIT` below is that control. It is not decoration.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/058_payment_provider_foundation.sql'
const RAW = read(MIG)
/**
 * Comments blanked, LENGTH PRESERVED — so a comment can never satisfy an
 * assertion, and an offset found in RAW still maps into SQL. (Deleting the
 * comments instead shifts every later offset, which silently broke the
 * section-6 slice when this suite was first written.)
 */
const SQL = RAW.replace(/--[^\n]*/g, m => ' '.repeat(m.length))
/**
 * Statements only: string literals and quoted identifiers blanked too, so a
 * RAISE message can never satisfy a syntax assertion. Use SQL — not CODE —
 * wherever the thing being asserted IS a literal or a quoted identifier:
 * against CODE such an assertion matches blanks, and its negation is vacuous.
 */
const CODE = SQL.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""')
const FLAT = SQL.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const files = () => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))

/** The status vocabulary production's CHECK constraint actually carries. */
const STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded'] as const
const IN_FLIGHT = ['pending', 'processing'] as const
const TERMINAL = ['completed', 'failed', 'refunded'] as const
/** The four columns PAY-1 adds. */
const NEW_COLS = ['provider', 'provider_mode', 'provider_token', 'entitlement_id'] as const
/** The thirteen production already had, read GET-only from PostgREST. */
const EXISTING_COLS = [
  'id', 'user_id', 'course_id', 'company_id', 'amount', 'currency', 'method',
  'status', 'reference', 'provider_reference', 'metadata', 'created_at', 'completed_at',
] as const
const INDEX_NAME = 'payments_one_inflight_intent_per_course'

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 — 058 exists, alone, as one transaction that writes nothing', () => {
  it('058 is exactly this migration, and nothing sits above it', () => {
    const f = files()
    expect(f.filter(x => x.startsWith('058'))).toEqual(['058_payment_provider_foundation.sql'])
    expect(f.filter(x => parseInt(x, 10) > 58)).toEqual([])
    expect(f.filter(x => x.startsWith('046')), '046 stays withdrawn').toEqual([])
    expect(f.filter(x => x.startsWith('051')), '051 stays reserved').toEqual([])
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(58)
    expect(new Set(nums).size, 'two migrations share a number').toBe(nums.length)
  })

  it('the migrations this slice depends on are byte-identical', () => {
    const blob = (p: string) =>
      execFileSync('git', ['hash-object', p], { cwd: ROOT, encoding: 'utf8' }).trim()
    expect(blob('supabase/migrations/055_restrict_lesson_media_columns.sql'))
      .toBe('4d1337e104d6049cc097eacd5d384c6f39102a72')
    expect(blob('supabase/migrations/056_catalogue_display_order.sql'))
      .toBe('c95391b85128e076360268a35fdff2d4910de5fd')
    expect(blob('supabase/migrations/057_v8_registry_reorder.sql'))
      .toBe('ec10e17d5c95b83e34a9aee6f24cf0975796ddcd')
  })

  it('runs as ONE repeatable-read transaction', () => {
    expect(count(FLAT, 'begin isolation level repeatable read;')).toBe(1)
    expect(CODE.match(/(^|\s)begin;/g), 'a bare BEGIN would not pin one snapshot').toBeNull()
    expect(count(CODE, 'commit;')).toBe(1)
    expect(CODE.indexOf('begin isolation level repeatable read;')).toBeLessThan(CODE.indexOf('commit;'))
  })

  it('writes NO table: not one INSERT, UPDATE, DELETE or TRUNCATE', () => {
    // "Do not rewrite historical data" is provable, not promised: the
    // migration contains no DML at all. This single scan is also what replaces
    // the nine cross-table fingerprints the first draft carried — a statement
    // that does not exist cannot have written anything.
    expect(CODE).not.toMatch(/\binsert\s+into\b/i)
    expect(CODE).not.toMatch(/\bupdate\s+[\w.]+\s+set\b/i)
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i)
    expect(CODE).not.toMatch(/\btruncate\b/i)
  })

  it('every grant and revoke is on public.payments, and there are exactly two', () => {
    const stmts = CODE.match(/^[ \t]*(grant|revoke)[\s\S]*?;/gim) ?? []
    expect(stmts).toHaveLength(2)
    for (const s of stmts) expect(s, `not scoped to payments: ${s}`).toMatch(/on public\.payments\b/i)
    // Order matters: revoke everything, then hand SELECT back. The reverse
    // would leave the browser roles with nothing.
    expect(CODE.indexOf('revoke all on public.payments'))
      .toBeLessThan(CODE.indexOf('grant select on public.payments'))
    expect(CODE).not.toMatch(/grant\s+all\b/i)
    expect(CODE).not.toMatch(/\bto\s+public\b/i)
  })

  it('every DDL statement targets public.payments, and no function or view is created', () => {
    for (const s of CODE.match(/^[ \t]*alter\s+table[\s\S]*?;/gim) ?? []) {
      expect(s, `alters something else: ${s.slice(0, 60)}`).toMatch(/alter\s+table\s+public\.payments\b/i)
    }
    for (const s of CODE.match(/^[ \t]*create\s+(unique\s+)?index[\s\S]*?;/gim) ?? []) {
      expect(s, `indexes something else: ${s.slice(0, 60)}`).toMatch(/on\s+public\.payments\b/i)
    }
    for (const s of CODE.match(/^[ \t]*(create|drop)\s+policy[\s\S]*?;/gim) ?? []) {
      expect(s, `a policy on something else: ${s.slice(0, 60)}`).toMatch(/on\s+public\.payments\b/i)
    }
    expect(CODE, 'PAY-1 creates no function').not.toMatch(/create\s+(or\s+replace\s+)?function/i)
    expect(CODE, 'PAY-1 creates no view').not.toMatch(/create\s+(or\s+replace\s+)?view/i)
    expect(CODE, 'PAY-1 creates no trigger').not.toMatch(/create\s+trigger/i)
    const tables = CODE.match(/create\s+(temp\s+)?table[\s\S]*?\bas\b/gi) ?? []
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatch(/create temp table pay_1_058_before on commit drop as/i)
    expect(CODE, 'row level security must not be disabled').not.toMatch(/disable\s+row\s+level\s+security/i)
  })

  it('the final verification block is the LAST statement before COMMIT', () => {
    // THE CONTROL FOR A DEFECT NEITHER THE SQL NOR THE HARNESS CAN CATCH.
    // An assertion proves nothing about statements that run after it. A draft
    // that created complete_payment() between section 6 and COMMIT passed
    // every apply-time check, because section 6 had already run. The only
    // defence is that nothing is allowed to sit there.
    const body = RAW.slice(0, RAW.indexOf('\ncommit;') + 1)
    const lastBlock = body.lastIndexOf('$do$;')
    expect(lastBlock, 'no verification block found').toBeGreaterThan(0)
    const trailing = body.slice(lastBlock + '$do$;'.length).replace(/--[^\n]*/g, '').trim()
    expect(trailing, 'a statement sits after the last verification block').toBe('')
  })

  it('it fails closed, emits no unobservable output, and documents a guarded rollback', () => {
    expect(count(SQL, 'raise exception')).toBeGreaterThanOrEqual(20)
    expect(SQL).toMatch(/refusing to re-apply/)
    // NO RAISE NOTICE AT ALL. The documented apply path is the Supabase SQL
    // editor, which does not display NOTICE output — so a notice is machinery
    // whose only reader cannot see it. Anything worth knowing is an exception
    // that stops the apply.
    expect(count(SQL, 'raise notice'), 'NOTICE output is invisible in the SQL editor').toBe(0)
    const tail = RAW.slice(RAW.lastIndexOf('-- ROLLBACK'))
    expect(tail).toMatch(/-- begin;/)
    expect(tail).toMatch(/-- commit;/)
    expect(tail).toMatch(/carry provider data/)
    expect(tail, 'the rollback must restore the policy it removed').toMatch(/payments_update_own/)
  })

  it('THE SIMPLIFICATION HOLDS: no apply-time ceremony creeps back', () => {
    // Everything the final review classified B or C, asserted absent so that a
    // future edit cannot quietly reintroduce it. Each of these either re-read
    // DDL this file had just executed, or fingerprinted state this file
    // contains no statement to touch (and which, under one MVCC snapshot, it
    // could not have observed changing anyway).
    for (const gone of [
      // re-parsing of its own DDL
      'atttypid', 'attnotnull', 'atthasdef', 'attgenerated', 'confdeltype',
      'convalidated', 'indisunique', 'indpred', 'indnatts', 'pg_get_indexdef',
      // fingerprints of unrelated row data
      'entitlements_md5', 'enrollments_md5', 'certificates_md5',
      'course_pricing_md5', 'platform_roles_md5', 'to_jsonb',
      // catalogue fingerprints of unrelated objects
      'entitlements_policies', 'enrollments_policies',
      'has_course_access_def', 'my_course_access_def',
      'method_check', 'status_check', 'anon_sees_registry', 'anon_sees_media_path',
      // speculative name scanning
      'proname like',
      // state captured only to feed a notice
      'n_inflight',
    ]) {
      expect(SQL, `apply-time ceremony returned: ${gone}`).not.toContain(gone)
    }
    // pg_get_constraintdef survives EXACTLY once — reading the live status
    // vocabulary in section 0, which is production state and cannot be known
    // from this file.
    expect(count(SQL, 'pg_get_constraintdef'), 'only the status-vocabulary read may remain').toBe(1)
    // And the file is now mostly its own audit trail rather than its own echo.
    const exec = RAW.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).length
    expect(exec, 'executable lines drifted well above the reviewed budget').toBeLessThan(280)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · the preflight asks only what production can answer', () => {
  it('RLS must already be enabled — never enabled as a side effect', () => {
    expect(SQL).toMatch(/relrowsecurity/)
    expect(SQL).toMatch(/row level security is NOT enabled on public\.payments/)
    expect(CODE, 'enabling RLS here would silently change who can read the table')
      .not.toMatch(/enable\s+row\s+level\s+security/i)
  })

  it('the live column list is pinned to production\'s thirteen', () => {
    const before = [...EXISTING_COLS].sort().join(',')
    expect(SQL, 'the preflight does not pin production\'s 13 columns').toContain(`'${before}'`)
    expect(before.split(',')).toHaveLength(13)
    expect(SQL).toMatch(/company_id/)   // production has it; schema.sql does not
    expect(SQL).toMatch(/Re-read the table before re-running/)
  })

  it('THE INDEX PREFLIGHT IS SCHEMA-QUALIFIED', () => {
    // A bare `pg_class.relname = '…'` lookup matches an identically named
    // relation in ANY schema, so an unrelated table called
    // payments_one_inflight_intent_per_course elsewhere in the database would
    // have produced a false "refusing to re-apply" and blocked a legitimate
    // first apply. to_regclass resolves one name in one schema.
    expect(SQL).toContain(`to_regclass('public.${INDEX_NAME}') is not null`)
    expect(SQL, 'an unqualified relation lookup returned')
      .not.toMatch(new RegExp(`relname\\s*=\\s*'${INDEX_NAME}'`))
    // No unqualified pg_class.relname comparison anywhere: every relation this
    // migration looks up is addressed by schema.
    expect(SQL, 'pg_class is queried by bare relname somewhere').not.toMatch(/relname\s*=\s*'/)
    expect(SQL).toContain(`public.${INDEX_NAME} already exists`)
  })

  it('a second apply is refused rather than half-applied', () => {
    for (const c of NEW_COLS) {
      expect(SQL, `${c} is not covered by the re-apply guard`).toMatch(new RegExp(`'${c}'`))
    }
    expect(SQL).toMatch(/already exist; refusing to re-apply/)
  })

  it('the status vocabulary is READ from the live constraint, never trusted', () => {
    // "Do not guess": the migration interrogates the real CHECK and refuses to
    // run if the vocabulary is not exactly the five values it was written for.
    expect(SQL).toMatch(/pg_get_constraintdef/)
    expect(SQL).toMatch(/attname = 'status'/)
    for (const s of STATUSES) expect(SQL, `${s} is not demanded`).toContain(`'${s}'`)
    expect(SQL).toMatch(/expected exactly 5/)
    expect(SQL).toMatch(/has no single-column CHECK constraint/)
  })

  it('a pre-existing duplicate in-flight pair is refused, not repaired', () => {
    expect(SQL).toMatch(/group by user_id, course_id/)
    expect(SQL).toMatch(/having count\(\*\) > 1/)
    expect(SQL).toMatch(/already hold more than one in-flight payment/)
    // Only rows with a real owner can collide, so the guard matches the index.
    expect(SQL).toMatch(/user_id is not null and course_id is not null/)
    // It refuses; it never rewrites.
    expect(SQL).toMatch(/Resolve them/)
  })

  it('the snapshot captures only what section 6 consumes', () => {
    const snap = /create temp table pay_1_058_before[\s\S]*?;/i.exec(SQL)?.[0] ?? ''
    expect(snap).toBeTruthy()
    expect(snap).toMatch(/payments_md5/)
    expect(snap).toMatch(/n_payments/)
    expect(snap).toMatch(/complete_payment_absent/)
    // Three columns, not seventeen.
    expect((snap.match(/\bas\s+\w+_?\w*,|\bas\s+\w+;/g) ?? []).length).toBeLessThanOrEqual(4)
    expect(snap).toMatch(/on commit drop/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 1. the four new columns: type and nullability', () => {
  it('adds exactly the four columns, each nullable with no default', () => {
    // THIS is now the sole guarantee of the shape — 058 no longer re-reads the
    // catalogue to confirm what this statement says. `add column provider
    // text` cannot produce a NOT NULL column, so the statement IS the proof.
    const alter = /alter table public\.payments\s+add column[\s\S]*?;/i.exec(CODE)?.[0] ?? ''
    expect(alter).toBeTruthy()
    for (const c of NEW_COLS) {
      expect(alter, `${c} is not added`).toMatch(new RegExp(`add column if not exists ${c}\\b`, 'i'))
    }
    expect((alter.match(/add column/gi) ?? [])).toHaveLength(4)
    // NOT NULL or a DEFAULT would make every legacy row a lie, or back-fill it.
    expect(alter, 'a new column is NOT NULL').not.toMatch(/\bnot\s+null\b/i)
    expect(alter, 'a new column carries a DEFAULT').not.toMatch(/\bdefault\b/i)
    expect(alter).toMatch(/provider\s+text/i)
    expect(alter).toMatch(/provider_mode\s+text/i)
    expect(alter).toMatch(/provider_token\s+text/i)
    expect(alter).toMatch(/entitlement_id\s+uuid/i)
  })

  it('entitlement_id references entitlements(id) ON DELETE SET NULL', () => {
    expect(CODE).toMatch(/entitlement_id\s+uuid\s*references public\.entitlements\(id\) on delete set null/i)
    // CASCADE would delete the money with the grant; RESTRICT would make
    // deleting a learner's account fail, since entitlements cascade from
    // auth.users. SET NULL matches what user_id and course_id already do.
    expect(CODE, 'the FK must not cascade').not.toMatch(/entitlements\(id\) on delete cascade/i)
    expect(CODE, 'the FK must not restrict').not.toMatch(/entitlements\(id\) on delete restrict/i)
    expect(CODE, 'the FK must not be left at NO ACTION')
      .not.toMatch(/entitlements\(id\)\s*[,)]/i)
  })

  it('the resulting 17-column shape is still pinned, once', () => {
    const after = [...EXISTING_COLS, ...NEW_COLS].sort().join(',')
    expect(SQL, 'the result is not pinned at 17 columns').toContain(`'${after}'`)
    expect(after.split(',')).toHaveLength(17)
    expect(SQL).toMatch(/which is not the thirteen it held plus the four this migration adds/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 2. an invalid provider_mode is rejected by the database', () => {
  it('provider_mode admits exactly test and live, or NULL', () => {
    expect(SQL).toMatch(
      /add constraint payments_provider_mode_valid\s*check \(provider_mode is null or provider_mode in \('test', 'live'\)\)/i)
    const check = /payments_provider_mode_valid\s*check[\s\S]*?;/i.exec(SQL)?.[0] ?? ''
    expect([...new Set(check.match(/'[a-z]+'/g) ?? [])].sort()).toEqual(["'live'", "'test'"])
  })

  it('the database and the application agree on the mode vocabulary', () => {
    // Two layers, one vocabulary. If PAYDUNYA_MODES ever grows a third mode,
    // this fails until the CHECK is widened deliberately.
    const config = read('lib/payments/paydunya-config.ts')
    const modes = /PAYDUNYA_MODES = \[([^\]]*)\] as const/.exec(config)?.[1] ?? ''
    expect(modes.match(/'[a-z]+'/g)).toEqual(["'test'", "'live'"])
    expect(SQL).toMatch(/provider_mode in \('test', 'live'\)/)
  })

  it('a provider may never be recorded without its mode', () => {
    expect(CODE).toMatch(
      /add constraint payments_provider_mode_required\s*check \(provider is null or provider_mode is not null\)/i)
  })

  it('both constraints are NULL-tolerant, so a legacy row cannot violate them', () => {
    expect(CODE).toMatch(/check \(provider_mode is null or/i)
    expect(CODE).toMatch(/check \(provider is null or/i)
    // A CHECK enforces itself for the life of the table, which is why 058 no
    // longer reads it back at apply time.
    expect((CODE.match(/add constraint payments_provider_mode_\w+/gi) ?? [])).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 3. existing and legacy payment rows remain valid', () => {
  it('nothing is back-filled, and the migration proves it against real rows', () => {
    // Retained in 058 as Class A: a DEFAULT or a trigger could fill a column
    // in, and only the database can say whether one did.
    expect(SQL).toMatch(/provider is not null or provider_mode is not null/)
    expect(SQL).toMatch(/the new columns must be NULL everywhere/)
    expect(SQL).toMatch(/row\(s\) acquired a provider value/)
  })

  it('the payment rows are fingerprinted by an explicit column list', () => {
    // to_jsonb would change shape when the four columns are added and could
    // hide a rewrite behind that change.
    expect(SQL).toMatch(/payments_md5/)
    expect(SQL).toMatch(/payment row data changed/)
    expect(SQL).toMatch(/the payment count changed from % to %/)
    for (const c of EXISTING_COLS) {
      expect(SQL, `${c} is missing from the row fingerprint`).toMatch(new RegExp(`p\\.${c}\\b`))
    }
  })

  it('058 does not widen or redefine the method vocabulary', () => {
    // Enforced by scanning this file rather than by fingerprinting a
    // constraint 058 contains no statement to alter.
    expect(CODE).not.toMatch(/payments_method_check/i)
    expect(CODE, '058 must not redefine the method vocabulary').not.toMatch(/method\s+in\s*\(/i)
    expect(CODE, '058 must not drop a constraint it did not create').not.toMatch(/drop\s+constraint/i)
    expect(CODE, '058 must not alter an existing column').not.toMatch(/alter\s+column/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 4/5. one live purchase intent per learner per course', () => {
  it('a PARTIAL UNIQUE index on exactly (user_id, course_id)', () => {
    // Sole guarantee: 058 no longer re-parses pg_index to confirm what this
    // statement plainly says.
    expect(SQL).toMatch(new RegExp(
      `create unique index ${INDEX_NAME}\\s*on public\\.payments \\(user_id, course_id\\)\\s*where status in \\('pending', 'processing'\\);`, 'i'))
    // A UNIQUE constraint cannot carry a WHERE clause, so an index is the only
    // form this contract can take.
    expect(CODE).not.toMatch(/add constraint[\s\S]{0,80}unique \(user_id, course_id\)/i)
  })

  it('the predicate covers the in-flight states and NO terminal state', () => {
    const pred = /where status in \(([^)]*)\)/i.exec(SQL)?.[1] ?? ''
    expect([...new Set(pred.match(/'[a-z]+'/g) ?? [])].sort())
      .toEqual([...IN_FLIGHT].map(s => `'${s}'`).sort())
    for (const t of TERMINAL) {
      expect(pred, `${t} is inside the predicate, which would block retry and rewrite history`)
        .not.toContain(t)
    }
  })

  it('NULLs stay DISTINCT, so two orphaned rows cannot collide', () => {
    // user_id and course_id are ON DELETE SET NULL; NULLS NOT DISTINCT would
    // make every orphaned in-flight row collide with every other.
    expect(CODE).not.toMatch(/nulls\s+not\s+distinct/i)
  })

  it('the FK gets a supporting partial index for ON DELETE SET NULL', () => {
    expect(SQL).toMatch(/create index payments_entitlement_idx\s*on public\.payments \(entitlement_id\)\s*where entitlement_id is not null;/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 6/7/8. T1: no browser role may mutate a payment', () => {
  it('the vulnerable policy is dropped', () => {
    expect(SQL).toMatch(/drop policy if exists "payments_update_own" on public\.payments;/i)
    expect(SQL, 'the hole must not be recreated').not.toMatch(
      /create policy "payments_update_own"/i)
  })

  it('the FOR ALL admin policy is dropped too — it granted unused browser writes', () => {
    expect(SQL).toMatch(/drop policy if exists "payments_admin_all" on public\.payments;/i)
    expect(SQL).not.toMatch(/create policy "payments_admin_all"/i)
    // Admin READ is preserved by payments_own, which already admits an admin.
    expect(SQL).toMatch(/payments_own/)
  })

  it('the privilege layer is closed, not just the policy layer', () => {
    expect(CODE).toMatch(/revoke all on public\.payments from anon, authenticated;/i)
    expect(CODE).toMatch(/grant select on public\.payments to anon, authenticated;/i)
  })

  it('two RESTRICTIVE deny policies make the invariant independent of future mistakes', () => {
    expect(SQL).toMatch(
      /create policy "payments_no_browser_update" on public\.payments\s*as restrictive for update to anon, authenticated\s*using \(false\) with check \(false\);/i)
    expect(SQL).toMatch(
      /create policy "payments_no_browser_delete" on public\.payments\s*as restrictive for delete to anon, authenticated\s*using \(false\);/i)
    expect(count(CODE.toLowerCase(), 'as restrictive')).toBe(2)
    expect(SQL, 'a deny policy must not be permissive').not.toMatch(
      /create policy "payments_no_browser_update" on public\.payments\s*for update/i)
    // A FOR ALL restrictive deny would also deny SELECT — the learner's read.
    expect(CODE).not.toMatch(/as restrictive for all/i)
  })

  it('058 proves every write privilege is gone, at table AND column level', () => {
    // RETAINED AS CLASS A. A table-level `revoke` does NOT remove column-level
    // ACLs, and says nothing about privileges reaching a role through role
    // membership — so this genuinely depends on what production already had.
    expect(SQL).toMatch(/'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'/)
    expect(SQL).toMatch(/still holds % on public\.payments/)
    expect(SQL).toMatch(/has_any_column_privilege/)
    expect(SQL).toMatch(/'INSERT', 'UPDATE', 'REFERENCES'/)
    expect(SQL).toMatch(/still holds % on some COLUMN of public\.payments/)
  })

  it('058 proves no permissive policy admits a write, and nothing reaches PUBLIC', () => {
    // RETAINED AS CLASS A. Both scan whatever production actually has,
    // including policies and grants this migration has never heard of, and
    // neither is removed by `revoke … from anon, authenticated`.
    expect(SQL).toMatch(/polcmd in \('a', 'w', 'd', '\*'\)/)
    expect(SQL).toMatch(/permissive policy\/policies still admit a write/)
    expect(SQL).toMatch(/aclexplode/)
    expect(SQL).toMatch(/grants privilege\(s\) to PUBLIC/)
    expect(SQL).toMatch(/is missing or is not RESTRICTIVE/)
  })

  it('058 proves the trusted service-role path is intact', () => {
    expect(SQL).toMatch(/to_regrole\('service_role'\)/)
    expect(SQL).toMatch(/service_role lost % on public\.payments/)
    expect(CODE, 'service_role must not lose a privilege')
      .not.toMatch(/revoke[\s\S]{0,80}service_role/i)
  })

  it('the admin surfaces that write payments use the service-role client', () => {
    // The reason withdrawing browser-role writes is safe: nothing used them.
    const action = read('app/(admin)/admin/payments/actions.ts')
    expect(action).toMatch(/createAdminClient/)
    expect(action).toMatch(/requirePlatformAdmin/)
    expect(action, 'the admin action must not use the user-scoped client')
      .not.toMatch(/from '@\/lib\/supabase\/server'/)
    expect(read('app/(admin)/admin/payments/page.tsx')).toMatch(/createAdminClient/)
    const create = read('app/actions/payment.ts')
    expect(create, 'payment creation must stay on the admin client').toMatch(/createAdminClient/)
    expect(create).toMatch(/\.from\('payments'\)\s*\n?\s*\.insert/)
  })

  it('the RLS lint baseline records 058 as the supersession, and still tracks 001', () => {
    // The linter reads each migration in isolation, so 001's CREATE POLICY is
    // still a finding there — exactly like profiles_update_own, fixed by 027.
    // The entry stays; the note must say what fixed it.
    const b = JSON.parse(read('scripts/security/rls-lint-baseline.json'))
    expect(b.known).toContain('001_phase_a_rls_fix.sql::payments_update_own')
    const note = b.notes['001_phase_a_rls_fix.sql::payments_update_own']
    expect(note.status, 'the note still calls T1 live').toMatch(/058/)
    expect(JSON.stringify(note)).toMatch(/PAY-1/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 9. permitted learner payment reads remain correct', () => {
  it('SELECT is withdrawn from nobody: the learner read policy survives', () => {
    expect(SQL, 'payments_own must not be dropped').not.toMatch(/drop policy[\s\S]{0,60}"payments_own"/i)
    expect(SQL).toMatch(/polname = 'payments_own' and polcmd = 'r'/)
    expect(SQL).toMatch(/PAY-1 must not remove payment visibility/)
    expect(SQL).toMatch(/PAY-1 withdraws WRITE authority only/)
  })

  it('no column-level SELECT restriction is applied — that is PAY-1B', () => {
    expect(CODE).not.toMatch(/revoke select on public\.payments/i)
    expect(CODE).not.toMatch(/grant select \(/i)
  })

  it('provider_token is documented as reconciliation data, not a credential', () => {
    expect(SQL).toMatch(/Server reconciliation data, not a credential/)
    expect(RAW).not.toMatch(/PAYDUNYA_(MODE|TEST_|LIVE_)/)
    expect(RAW).not.toMatch(/MASTER_KEY|PRIVATE_KEY/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 10. entitlement authority is unchanged', () => {
  it('058 contains no statement that could touch an entitlement or enrollment', () => {
    // This replaced nine before/after fingerprints. Under one MVCC snapshot
    // those compared the migration against itself and could never fail; a
    // statement that does not exist is the stronger proof.
    for (const t of ['entitlements', 'enrollments']) {
      expect(CODE, `058 writes public.${t}`)
        .not.toMatch(new RegExp(`(insert into|update|delete from|truncate)\\s+(table\\s+)?public\\.${t}\\b`, 'i'))
      expect(CODE, `058 alters public.${t}`)
        .not.toMatch(new RegExp(`alter table\\s+public\\.${t}\\b`, 'i'))
      expect(CODE, `058 policies public.${t}`)
        .not.toMatch(new RegExp(`policy[\\s\\S]{0,80}on public\\.${t}\\b`, 'i'))
    }
    // The only reference is the FK target, which points FROM the money TO the
    // grant and confers nothing.
    expect(CODE).toMatch(/references public\.entitlements\(id\)/i)
    // Nor may it touch the access seam by any other route.
    for (const obj of ['has_course_access', 'my_course_access', 'course_codes',
                       'certificates', 'lesson_progress', 'quiz_attempts']) {
      expect(CODE, `058 references ${obj}`).not.toContain(obj)
    }
  })

  it('complete_payment() is neither created nor modified — PAY-2 owns it', () => {
    expect(CODE).not.toMatch(/create\s+(or\s+replace\s+)?function[\s\S]{0,80}complete_payment/i)
    expect(SQL).toMatch(/complete_payment_absent/)
    // Checked in the LAST block, not in section 5 — see the file-shape test
    // above for why that distinction is load-bearing.
    const at = RAW.indexOf('══ 6. NOT ONE PAYMENT ROW WAS WRITTEN')
    expect(at, 'section 6 not found').toBeGreaterThan(0)
    const lastBlock = SQL.slice(at)
    expect(lastBlock).toMatch(/to_regprocedure\('public\.complete_payment\(text,text\)'\) is not null/)
    expect(lastBlock).toMatch(/exists at the end of this transaction/)
    expect(lastBlock).toMatch(/existed BEFORE this migration/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · 11. no PayDunya network or API code exists', () => {
  const SHIPPED = ['app', 'components', 'lib', 'types', 'scripts', 'supabase']

  function walk(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.next') continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full, acc)
      else if (/\.(ts|tsx|js|jsx|mjs|sql|json)$/.test(e)) acc.push(full)
    }
    return acc
  }

  it('no PayDunya endpoint, host or API path appears in shipped code', () => {
    const hits: string[] = []
    for (const f of SHIPPED.flatMap(d => walk(join(ROOT, d)))) {
      const s = readFileSync(f, 'utf8')
      for (const re of [/paydunya\.com/i, /checkout-invoice/i, /PAYDUNYA-MASTER-KEY/i,
                        /PAYDUNYA-PRIVATE-KEY/i, /PAYDUNYA-TOKEN/i]) {
        if (re.test(s)) hits.push(`${f.slice(ROOT.length + 1)} :: ${re}`)
      }
    }
    expect(hits, `PayDunya API material found:\n${hits.join('\n')}`).toEqual([])
  })

  it('the configuration module still makes no network call and holds no URL', () => {
    const cfg = read('lib/payments/paydunya-config.ts')
    expect(cfg.split('\n')[0], 'server-only must be the first line').toBe("import 'server-only'")
    for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /axios/, /https?:\/\//, /require\(/]) {
      expect(cfg, `the config module reaches the network: ${re}`).not.toMatch(re)
    }
  })

  it('no PayDunya client, webhook route or IPN handler exists', () => {
    for (const p of ['app/api/webhooks/paydunya', 'app/api/webhooks/paydunya/route.ts',
                     'app/api/payments/webhook', 'lib/payments/paydunya-client.ts',
                     'lib/payments/paydunya.ts']) {
      expect(existsSync(join(ROOT, p)), `${p} exists — PAY-2 has not been authorised`).toBe(false)
    }
    expect(readdirSync(join(ROOT, 'lib/payments')).sort())
      .toEqual(['index.ts', 'paydunya-config.ts'])
  })

  it('payment creation, the feature flag and the stub are all untouched', () => {
    const create = read('app/actions/payment.ts')
    expect(create).toMatch(/if \(!PAYMENTS_ENABLED\)/)
    expect(create).toMatch(/status:\s+'pending'/)
    expect(create, 'PAY-1 must not wire a provider into checkout creation')
      .not.toMatch(/PAYDUNYA|provider_mode|provider_token|entitlement_id/i)
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      expect(read('.env.local')).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
    }
    const stub = read('lib/payments/index.ts')
    expect(stub).toMatch(/PILOT MODE: No real payment gateways are wired yet/)
    expect(stub.match(/process\.env/g), 'the stub started reading the environment').toBeNull()
    expect(stub, 'the stub must not have gained a grant path')
      .not.toMatch(/\.from\(['"]entitlements['"]\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-1 · the gates recorded for after this slice', () => {
  const GATES = RAW.slice(RAW.indexOf('GATES BEFORE PAYMENTS ARE ENABLED'))

  it('PAY-1B(a) — the application stops reading select(*) FIRST', () => {
    expect(GATES).toMatch(/PAY-1B\(a\)/)
    expect(GATES).toMatch(/APPLICATION ONLY/)
    expect(GATES).toMatch(/checkout\/confirm/)
    expect(GATES).toMatch(/explicit safe\s*\n?--\s*projection|explicit safe projection/)
    // The reason the order is forced: under column grants `select *` fails.
    expect(GATES).toMatch(/42501/)
    expect(GATES).toMatch(/rather than narrowing/)
    // ...and the reader it would break still reads `*`, which is why.
    const confirm = read('app/(platform)/checkout/confirm/page.tsx')
    expect(confirm).toMatch(/\.select\('\*, courses\(title, slug\)'\)/)
  })

  it('PAY-1B(b) — migration 059 carries all seven requirements', () => {
    expect(GATES).toMatch(/PAY-1B\(b\)\s+MIGRATION 059/)
    expect(GATES, 'revoke browser table-wide SELECT').toMatch(/revoke the browser roles' table-wide SELECT/)
    expect(GATES, 'explicit allowlist for authenticated').toMatch(/EXPLICIT column allowlist/)
    expect(GATES, 'exclude provider_token').toMatch(/EXCLUDE provider_token/)
    expect(GATES, 'exclude metadata').toMatch(/EXCLUDE metadata/)
    expect(GATES, 'anon gets no payment SELECT').toMatch(/`anon` receives NO payment SELECT/)
    expect(GATES, 'service role keeps reconciliation access')
      .toMatch(/service_role retains full reconciliation access/)
    expect(GATES, 'the preflight must refuse if any token exists')
      .toMatch(/PREFLIGHT REFUSES if ANY payments\.provider_token IS NOT\s*\n?--\s*NULL/)
    expect(GATES, 'the ordering constraint on PAY-2')
      .toMatch(/ONLY AFTER PAY-1B MAY PAY-2 WRITE provider_token/)
  })

  it('SEC-4 — certificate hardening is recorded as a paid-launch blocker', () => {
    expect(GATES).toMatch(/SEC-4/)
    expect(GATES).toMatch(/blocks PAID production launch/)
    for (const policy of ['cert_service_insert', 'cert_service_update', 'certificates_insert_auth']) {
      expect(GATES, `${policy} is not named`).toContain(policy)
    }
    expect(GATES).toMatch(/verify-certificate/)
    expect(GATES).toMatch(/isValid = !!cert/)
    expect(GATES, 'the finding must say it was read, not executed')
      .toMatch(/deliberately NOT\s*\n?--\s*executed/)
    // ...and PAY-1 touched none of it.
    expect(CODE).not.toMatch(/storage\.objects|cert_service|certificates_insert_auth/i)
  })

  it('N-3 enrollments_update is recorded as non-blocking, with the reason', () => {
    expect(GATES).toMatch(/N-3 enrollments_update — NON-BLOCKING/)
    expect(GATES).toMatch(/authorize\s*\n?--\s*NOTHING|authorize NOTHING/)
    expect(GATES).toMatch(/without reading\s*\n?--\s*enrollments|without reading enrollments/)
  })

  it('PAY-2 is handed the corrected assumptions it must not re-derive', () => {
    expect(GATES, '003 was never applied').toMatch(/complete_payment\(\) DOES NOT EXIST/)
    expect(GATES, 'SECURITY DEFINER default EXECUTE grant')
      .toMatch(/revoke execute on function … from public, anon, authenticated/)
    expect(GATES).toMatch(/CREATE FUNCTION grants EXECUTE to PUBLIC by default/)
    expect(GATES, 'no webhook idempotency key yet').toMatch(/NO webhook_id column/)
    expect(GATES, 'provider_token is not unique').toMatch(/carries NO unique index/)
    expect(GATES, 'method has no paydunya value').toMatch(/There is no 'paydunya' value/)
    expect(GATES, 'the abandoned-intent flow').toMatch(/BLOCKED from starting another/)
    expect(GATES, 'company_id drift').toMatch(/UNEXPLAINED SCHEMA DRIFT/)
    expect(GATES, 'organization_id is NOT drift').toMatch(/migration 040 adds it/)
    expect(GATES, 'entitlements are the authority').toMatch(/never an enrollment/)
  })
})
