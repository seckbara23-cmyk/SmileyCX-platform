// @vitest-environment node
/**
 * AUDIT-SEC-01 — migration 061, the audit_log grant layer.
 *
 * ── THE ROOT CAUSE ───────────────────────────────────────────────────────
 *
 * Migration 027 created audit_log, enabled RLS, added one admin SELECT policy,
 * and revoked UPDATE and DELETE from the browser roles. Its comment reasoned
 * that RLS governs writes — true for INSERT, UPDATE and DELETE.
 *
 * TRUNCATE IS NOT GOVERNED BY RLS. It is a table-level operation and never
 * consults a policy. Supabase's ALTER DEFAULT PRIVILEGES had granted all seven
 * privileges to anon and authenticated at creation, 027 took back two, and the
 * one privilege that can erase the whole trail in a single statement fell
 * between the layers: the policy could not see it, and the revoke did not name
 * it. Production inspection confirmed anon and authenticated both held
 * effective TRUNCATE, INSERT, REFERENCES and TRIGGER over 19 records.
 *
 * ── WHAT PROVES WHAT (the A/B/C split) ───────────────────────────────────
 *
 * An assertion belongs INSIDE the migration only if its outcome depends on the
 * production database at apply time. Everything that depends only on the file's
 * own text belongs here. So this suite reads SOURCE TEXT.
 *
 * EFFECTIVE privilege and real behaviour are proven by the offline PGlite
 * harness (PostgreSQL 17, scratchpad, not committed), which rebuilds 027's
 * audit_log plus the 058/059/060 payment contract and applies the real 061
 * across nine worlds — 173 checks. It proves the exposure by EXECUTION: before
 * 061 a learner session's `truncate table public.audit_log` SUCCEEDS; after it,
 * the same statement is refused 42501. Reading a grant could not show that.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/061_audit_log_privilege_hardening.sql'
const RAW = read(MIG)
/** Comments blanked, LENGTH PRESERVED, so RAW offsets still map into SQL. */
const SQL = RAW.replace(/--[^\n]*/g, m => ' '.repeat(m.length))
/** Statements only: literals and quoted identifiers blanked too. */
const CODE = SQL.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""')
const FLAT = SQL.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** 027's fifteen columns, parsed from 027 rather than retyped. */
const AUDIT_15 = (() => {
  const src = read('supabase/migrations/027_identity_hardening.sql')
  const m = /create table if not exists public\.audit_log \(([\s\S]*?)\n\);/.exec(src)
  if (!m) return []
  return [...m[1].matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map(x => x[1])
})()

const BROWSER_ROLES = ['anon', 'authenticated'] as const
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — 061 exists, alone, as one transaction', () => {
  it('061 is exactly this migration, and nothing sits above it', () => {
    const f = readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql'))
    expect(f.filter(x => x.startsWith('061'))).toEqual(['061_audit_log_privilege_hardening.sql'])
    // PAY-2C later authored 062. The rule is not "nothing above 061" but
    // "nothing above 061 reopens the audit_log grant layer".
    const above = f.filter(x => parseInt(x, 10) > 61)
    expect(above).toEqual(['062_atomic_payment_completion.sql', '063_payment_state_machine.sql', '064_payment_exceptions.sql'])
    const m062 = read('supabase/migrations/062_atomic_payment_completion.sql')
      .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    for (const stmt of m062.match(/^\s*(grant|revoke)\s[\s\S]*?;/gim) ?? []) {
      expect(stmt, '062 moves a privilege on audit_log').toMatch(/on function/i)
    }
    expect(m062, '062 must not touch the audit policy').not.toMatch(/(create|drop|alter)\s+policy/i)
    expect(m062, '062 must not alter audit_log').not.toMatch(/alter table/i)
    // 062 WRITES audit_log, from inside a SECURITY INVOKER function — so the
    // write happens with the CALLER's privileges, which 061 left intact for
    // service_role and withdrew from every browser role.
    expect(m062).toMatch(/insert into public\.audit_log/)
    expect(m062).toMatch(/security invoker/)
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(64)
    expect(new Set(nums).size, 'two migrations share a number').toBe(nums.length)
  })

  it('027, 058, 059 and 060 are unchanged by this slice', () => {
    // 061 asserts facts about all four. If one were edited, 061 would be
    // asserting a shape its own repository no longer describes.
    expect(AUDIT_15).toHaveLength(15)
    const m027 = read('supabase/migrations/027_identity_hardening.sql')
    // 027's single privilege statement — the gap this slice closes — is intact.
    const stmts027 = m027.replace(/--[^\n]*/g, '').split('\n')
      .filter(l => /^\s*(grant|revoke)\s/i.test(l) && /audit_log/.test(l))
    expect(stmts027.map(s => s.trim()))
      .toEqual(['revoke update, delete on public.audit_log from anon, authenticated;'])
    // 059's two privilege statements, still two.
    const m059 = read('supabase/migrations/059_payment_column_select_security.sql')
    const stmts059 = m059.replace(/--[^\n]*/g, '').split('\n')
      .filter(l => /^\s*(grant|revoke)\s/i.test(l))
      .map(l => l.trim().split(/\s+/)[0].toLowerCase())
    expect(stmts059).toEqual(['revoke', 'grant'])
    // 060 still carries its own replay key and status contract.
    const m060 = read('supabase/migrations/060_payment_completion_contract.sql')
    expect(m060).toContain('payments_provider_token_unique')
    expect(m060).toContain('payments_status_valid')
  })

  it('it is ONE transaction: a single begin, a single commit, REPEATABLE READ', () => {
    expect(count(CODE, 'begin isolation level repeatable read;')).toBe(1)
    expect((SQL.match(/^begin[ ;]/gm) ?? []).length).toBe(1)
    expect((SQL.match(/^commit;$/gm) ?? []).length).toBe(1)
    expect(SQL.indexOf('begin isolation')).toBeLessThan(SQL.lastIndexOf('commit;'))
    expect(CODE).not.toContain('rollback')
  })

  it('it emits no RAISE NOTICE — the Supabase SQL editor does not display them', () => {
    expect(SQL.toLowerCase()).not.toContain('raise notice')
    expect(SQL.toLowerCase()).not.toContain('raise warning')
    expect(SQL.toLowerCase()).not.toContain('raise info')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — exactly two privilege statements, and nothing else', () => {
  it('the executable SQL contains precisely two grant/revoke statements', () => {
    const stmts = SQL.split('\n').filter(l => /^\s*(grant|revoke)\s/i.test(l)).map(l => l.trim())
    expect(stmts).toEqual([
      'revoke all on public.audit_log from public, anon, authenticated;',
      'grant select on public.audit_log to authenticated;',
    ])
  })

  it('the REVOKE is `all`, and names PUBLIC as well as both browser roles', () => {
    // `all` rather than naming the four privileges, for a reason measured during
    // 059: a table-level REVOKE of a privilege DOES cascade to that privilege's
    // COLUMN-level grants. Naming privileges individually would leave a column
    // grant on `metadata` untouched, and a column grant is invisible to
    // has_table_privilege.
    const rev = /revoke all on public\.audit_log from ([^;]*);/.exec(SQL)
    expect(rev, 'the revoke is not `revoke all`').toBeTruthy()
    const targets = rev![1].split(',').map(s => s.trim()).sort()
    expect(targets).toEqual(['anon', 'authenticated', 'public'])
    // A narrower revoke would not reach column grants — assert the form, not
    // just the targets.
    expect(SQL).not.toMatch(/revoke\s+(select|insert|update|delete|truncate|references|trigger)[^;]*on public\.audit_log/i)
  })

  it('the GRANT restores SELECT only, to authenticated only', () => {
    const gr = /grant ([a-z, ]+) on public\.audit_log to ([^;]*);/.exec(SQL)
    expect(gr).toBeTruthy()
    expect(gr![1].trim()).toBe('select')
    expect(gr![2].split(',').map(s => s.trim())).toEqual(['authenticated'])
    // anon is granted nothing at all, and no column-level grant is issued.
    expect(SQL).not.toMatch(/grant[^;]*on public\.audit_log to[^;]*anon/i)
    expect(SQL).not.toMatch(/grant select \(/i)
  })

  it('no privilege statement names any table other than audit_log', () => {
    for (const l of SQL.split('\n').filter(x => /^\s*(grant|revoke)\s/i.test(x))) {
      expect(l, `a privilege statement names another table: ${l.trim()}`)
        .toMatch(/on public\.audit_log\b/)
    }
    // service_role is ASSERTED, never re-granted or revoked.
    expect(SQL).not.toMatch(/^\s*(grant|revoke)[^;]*service_role/im)
  })

  it('there is no schema change, no policy change and no DML', () => {
    for (const forbidden of [
      'create table', 'drop table', 'alter table', 'create index', 'drop index',
      'create policy', 'drop policy', 'alter policy', 'create function',
      'create trigger', 'create view', 'security definer',
      'insert into', 'delete from', 'alter column', 'add column', 'drop column',
    ]) {
      expect(CODE.toLowerCase(), `061 contains "${forbidden}"`).not.toContain(forbidden)
    }
    expect(CODE).not.toMatch(/\btruncate\b/i)
    expect(CODE).not.toMatch(/update\s+public\./i)
    // The one permitted DDL: the ON COMMIT DROP snapshot table.
    expect(count(CODE, 'create temp table')).toBe(1)
    expect(SQL).toContain('on commit drop')
    const ddl = [...SQL.matchAll(/^\s*(?:create|drop|alter)(?:\s+\S+){1,3}/gim)].map(m => m[0].trim())
    expect(ddl, `unexpected statement-initial DDL: ${ddl.join(' | ')}`).toHaveLength(1)
    expect(ddl[0]).toMatch(/^create temp table audit_sec_01_before/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — the preflight fails closed', () => {
  it('it pins 027s fifteen columns, derived from 027 rather than retyped', () => {
    const pinned = (() => {
      const c = [...SQL.matchAll(/'([a-z_]+(?:,[a-z_]+){10,})'/g)].map(m => m[1].split(','))
      return c.find(x => x.length === 15) ?? []
    })()
    expect(pinned).toHaveLength(15)
    expect(pinned).toEqual([...AUDIT_15].sort())
  })

  it('it refuses a privilege that arrives by ROLE MEMBERSHIP', () => {
    // The one exposure no revoke can reach. Without this the two statements
    // would appear to succeed and change nothing.
    expect(CODE).toContain('pg_has_role(')
    expect(FLAT).toMatch(/reaches TRUNCATE\/INSERT\/TRIGGER on public\.audit_log through membership of role\(s\)/)
    expect(FLAT).toMatch(/A revoke cannot remove an inherited privilege/)
    // It must check the three privileges that matter, for both browser roles.
    expect(FLAT).toMatch(/has_table_privilege\(r\.rolname, 'public\.audit_log', 'TRUNCATE'\)/)
    expect(FLAT).toMatch(/foreach v_role in array array\['anon', 'authenticated'\] loop/)
  })

  it('it refuses if service_role would be stripped by the revoke on PUBLIC', () => {
    // The revoke names PUBLIC. If service_role held audit_log privileges only
    // via PUBLIC, that statement would remove the one role that must keep them.
    expect(FLAT).toMatch(/service_role holds SELECT\/INSERT on public\.audit_log but NOT by direct grant/)
    expect(SQL).toContain("acl.grantee = to_regrole('service_role')::oid")
    expect(FLAT).toMatch(/service_role lacks % on public\.audit_log/)
  })

  it('it refuses an unexpected policy set, and RLS being off', () => {
    expect(FLAT).toMatch(/policy audit_log_admin_read is missing or is not a SELECT policy/)
    expect(FLAT).toMatch(/carries % policies; 027 left exactly one/)
    expect(FLAT).toMatch(/row level security is NOT enabled on public\.audit_log/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — the postflight asserts EFFECTIVE privilege', () => {
  it('privilege is tested with the functions that account for inheritance', () => {
    // Reading a GRANT proves nothing: has_*_privilege accounts for role
    // membership, for PUBLIC and for column-level grants.
    expect(count(CODE, 'has_table_privilege(')).toBeGreaterThanOrEqual(8)
    expect(count(CODE, 'has_any_column_privilege(')).toBeGreaterThanOrEqual(3)
    expect(CODE).toContain('aclexplode')
    expect(SQL).toContain('aclexplode(c.relacl)')
    expect(SQL).toContain('aclexplode(a.attacl)')
  })

  it('it asserts no browser role can TRUNCATE, INSERT, UPDATE or DELETE', () => {
    const arr = /foreach v_priv in array array\[([^\]]*)\] loop/.exec(
      SQL.slice(SQL.indexOf('2. THE RESULTING EFFECTIVE') > 0
        ? SQL.indexOf('2. THE RESULTING EFFECTIVE') : 0))
    expect(FLAT).toMatch(/still holds % on public\.audit_log/)
    for (const p of WRITE_PRIVS) {
      expect(SQL, `the postflight does not check ${p}`).toContain(`'${p}'`)
    }
    expect(arr).toBeTruthy()
    // TRUNCATE gets its own named assertion, because it is the finding.
    expect(FLAT).toMatch(/STILL holds TRUNCATE on public\.audit_log — the exposure this migration exists to close/)
  })

  it('it asserts anon loses the read and authenticated keeps exactly SELECT', () => {
    expect(FLAT).toMatch(/anon can still read public\.audit_log/)
    expect(FLAT).toMatch(/authenticated lost SELECT on public\.audit_log/)
    expect(FLAT).toMatch(/audit_log_admin_read now guards a privilege nobody holds/)
    for (const r of BROWSER_ROLES) expect(SQL).toContain(`'${r}'`)
  })

  it('it asserts the trusted writer survives, and says why that matters', () => {
    expect(FLAT).toMatch(/service_role lost % on public\.audit_log/)
    // The reason this must be asserted rather than assumed: logAuditEvent
    // swallows its own errors, so a broken writer is SILENT.
    expect(RAW).toMatch(/swallows its own errors|SWALLOWS its own errors/)
  })

  it('it asserts the policy and RLS are exactly as 027 left them', () => {
    expect(FLAT).toMatch(/row level security was disabled/)
    expect(FLAT).toMatch(/now carries % policies, expected exactly 1/)
    expect(FLAT).toMatch(/audit_log_admin_read no longer reads as a permissive SELECT policy on is_platform_admin\(\)/)
  })

  it('it asserts the neighbouring privilege contracts did not move', () => {
    // 061 names only audit_log, so this cannot fail by construction — which is
    // exactly why it is cheap to prove rather than claim in prose.
    expect(FLAT).toMatch(/a browser role holds % on public\.payments/)
    expect(SQL).toContain("'amount,course_id,currency,id,reference,status'")
    expect(FLAT).toMatch(/a browser role can read public\.entitlements/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — not one audit record changed', () => {
  it('the final block fingerprints the rows by EXPLICIT column list', () => {
    const at = RAW.lastIndexOf('-- ══ 3.')
    expect(at, 'section 3 marker not found').toBeGreaterThan(0)
    const last = SQL.slice(at)
    expect(last).toContain('audit record data changed')
    expect(last).toContain('the audit record count changed')
    // to_jsonb would mask a column being added or retyped mid-transaction.
    expect(last).not.toContain('to_jsonb')
    for (const c of AUDIT_15) expect(last, `fingerprint omits ${c}`).toContain(c)
  })

  it('the final block also pins the policy set, indexes and column set', () => {
    const at = RAW.lastIndexOf('-- ══ 3.')
    const last = SQL.slice(at)
    expect(last).toMatch(/the audit_log policy set changed/)
    expect(last).toMatch(/the audit_log index count changed/)
    expect(last).toMatch(/the audit_log column set changed/)
    expect(last).toMatch(/metadata is no longer NOT NULL with a default/)
    // 053's publication trigger inserts into audit_log and depends on that
    // default; breaking it would block course publication.
    expect(RAW).toMatch(/053/)
  })

  it('the final verification block is the LAST statement before COMMIT', () => {
    // An apply-time assertion proves nothing about what runs after it. During
    // 058 a mutant placed a `create function` between the final block and
    // COMMIT and passed every assertion in the file.
    const commit = SQL.lastIndexOf('\ncommit;')
    expect(commit).toBeGreaterThan(0)
    const lastDo = SQL.lastIndexOf('$do$;', commit)
    expect(lastDo).toBeGreaterThan(0)
    const between = SQL.slice(lastDo + '$do$;'.length, commit)
    expect(between.trim(), `statements between the final block and COMMIT: ${between}`).toBe('')
  })

  it('this slice creates no function, and PAY-2C is still unstarted', () => {
    expect(CODE).not.toMatch(/create (or replace )?function/i)
    expect(FLAT).toMatch(/a payment-completion routine exists/)
    expect(SQL).toContain("p.proname like '%complete%payment%'")
    // 061 was PAY-2C's number; the header must say where the function went.
    expect(RAW).toMatch(/062/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — operator step and guarded rollback', () => {
  it('the file carries an operator step with an observable before/after', () => {
    expect(RAW).toContain('OPERATOR STEP — NOT APPLIED AT AUTHORING TIME')
    // The observable difference: anon went from 200-with-[] to 42501.
    expect(RAW).toMatch(/42501/)
    expect(RAW).toMatch(/200 with \[\]/)
    expect(RAW).toMatch(/docs\/pay-2c-preflight-inspection\.sql/)
  })

  it('the rollback is fully commented and keeps 027s UPDATE/DELETE denial', () => {
    const rb = RAW.slice(RAW.indexOf('-- ROLLBACK'))
    expect(rb).toContain('-- begin;')
    expect(rb).toContain('-- commit;')
    const live = rb.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'))
    expect(live, `executable lines inside the rollback: ${live.join(' | ')}`).toEqual([])
    // Rolling back 061 must not also undo 027: UPDATE and DELETE were denied
    // before this slice and must stay denied after any rollback of it.
    expect(rb).toMatch(/revoke update, delete on public\.audit_log from anon, authenticated/)
    expect(rb).toMatch(/INCLUDING THE EXPOSURE/)
  })

  it('it records what this slice deliberately does NOT fix', () => {
    expect(RAW).toMatch(/service_role retains TRUNCATE, UPDATE and DELETE/)
    expect(RAW).toMatch(/no tamper-evidence/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDIT-SEC-01 — cross-artifact: who actually uses audit_log', () => {
  const SRC_DIRS = ['app', 'components', 'lib'] as const
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

  it('the ONLY audit_log accessor in the codebase is the service-role INSERT', () => {
    // This is what makes removing anon's SELECT and narrowing authenticated's
    // to SELECT-only safe: nothing reads the table at all.
    const hits: string[] = []
    for (const f of sourceFiles()) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      for (const m of src.matchAll(/from\(\s*['"]audit_log['"]\s*\)/g)) {
        const window = src.slice(m.index!, m.index! + 200)
        hits.push(`${f}:${/\.insert\(/.test(window) ? 'INSERT' : /\.select\(/.test(window) ? 'SELECT' : 'OTHER'}`)
      }
    }
    expect(hits).toEqual(['lib/audit/log.ts:INSERT'])
    // ...and it goes through the service-role client, which 061 preserves.
    const helper = read('lib/audit/log.ts')
    expect(helper).toContain('createAdminClient()')
    expect(helper).not.toMatch(/from '@\/lib\/supabase\/client'/)
  })

  it('no browser-role read of audit_log exists, so anons SELECT served nothing', () => {
    // Comment-masked. Three files mention audit_log in PROSE — a docblock in
    // the user-deletion action explaining the SEC-1 snapshot, and two comments
    // in publication-audit.ts. Prose is fine; only code can read a table, and
    // an earlier draft of this test flagged those three as readers.
    const offenders: string[] = []
    for (const f of sourceFiles()) {
      if (f === 'lib/audit/log.ts') continue
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      if (/audit_log/.test(code)) offenders.push(f)
    }
    expect(offenders, `audit_log is referenced in CODE outside the helper: ${offenders.join(', ')}`)
      .toEqual([])
  })

  it('the audit helper still supplies the three NOT NULL columns', () => {
    // 061 does not change the table, but if the writer stopped supplying these
    // the insert would fail — and logAuditEvent swallows the error.
    const helper = read('lib/audit/log.ts')
    for (const c of ['event_type:', 'actor_type:', 'outcome:']) {
      expect(helper, `the audit helper no longer supplies ${c}`).toContain(c)
    }
    expect(helper).toMatch(/metadata:\s*event\.metadata\s*\?\?\s*\{\}/)
  })
})
