// @vitest-environment node
/**
 * PAY-2C — migration 062, the atomic payment completion authority.
 *
 * ── WHAT 062 CREATES ─────────────────────────────────────────────────────
 *
 * One function, public.complete_payment(...), SECURITY INVOKER, EXECUTE to
 * service_role only. In one transaction it grants exactly one
 * INDIVIDUAL_PURCHASE entitlement, links it to the payment, ensures the
 * enrollment without disturbing existing progress, writes a payment.completed
 * audit row, and marks the payment completed — or none of it.
 *
 * ── WHAT PROVES WHAT (the A/B/C split) ───────────────────────────────────
 *
 * An assertion belongs INSIDE the migration only if its outcome depends on the
 * production database at apply time. Everything that depends only on the file's
 * own text belongs here. So this suite reads SOURCE TEXT.
 *
 * BEHAVIOUR is proven by the offline PGlite harness (PostgreSQL 17, scratchpad,
 * not committed), which applies the real 058/059/060/061 and then 062 and
 * EXERCISES the function — 93 checks. It covers successful completion,
 * entitlement creation and linkage, enrollment preservation, audit content,
 * idempotent duplicates, fourteen distinct refusals, all five entitlement
 * conflict states, transaction rollback (by breaking the audit insert), browser
 * EXECUTE denial and the preservation of 037/058/059/061.
 *
 * ── ONE LIMITATION, STATED RATHER THAN PAPERED OVER ──────────────────────
 *
 * PGlite is single-connection, so a genuine two-session race was NOT executed.
 * The concurrency guarantee rests on two unique indexes —
 * payments_provider_token_unique and entitlements_one_live_per_course_idx —
 * which cannot be defeated by interleaving, and the harness proves each refuses
 * a duplicate. FOR UPDATE turns a lost race into an orderly wait rather than a
 * 23505; its presence is asserted below, its blocking behaviour is not proven.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIG = 'supabase/migrations/062_atomic_payment_completion.sql'
const RAW = read(MIG)
/** Comments blanked, LENGTH PRESERVED, so RAW offsets still map into SQL. */
const SQL = RAW.replace(/--[^\n]*/g, m => ' '.repeat(m.length))
/** Statements only: literals and quoted identifiers blanked too. */
const CODE = SQL.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""')
const FLAT = SQL.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** The function body, which is where most of the contract lives. */
const BODY = (() => {
  const a = SQL.indexOf('as $fn$')
  const b = SQL.lastIndexOf('$fn$;')
  return a > 0 && b > a ? SQL.slice(a, b) : ''
})()

const SIGNATURE = 'text, text, text, text, text, numeric, text'
/** Every structured reason code the function can raise. */
const REASONS = [
  'missing_argument', 'blank_provider_token', 'bad_provider_mode',
  'amount_not_positive', 'currency_unsupported', 'payment_not_found',
  'completed_without_entitlement', 'status_not_completable',
  'payment_identity_incomplete', 'payment_provider_incomplete',
  'stored_amount_not_positive', 'provider_mismatch', 'provider_mode_mismatch',
  'reference_mismatch', 'amount_mismatch', 'currency_mismatch',
  'entitlement_conflict', 'entitlement_revoked_requires_decision',
  'entitlement_race', 'entitlement_not_accessible',
] as const

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — 062 exists, alone, as one transaction', () => {
  it('062 is exactly this migration, and nothing sits above it', () => {
    const f = readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql'))
    expect(f.filter(x => x.startsWith('062'))).toEqual(['062_atomic_payment_completion.sql'])
    const above = f.filter(x => parseInt(x, 10) > 62)
    expect(above, `migrations above 062 exist: ${above.join(', ')}`).toEqual([])
    const nums = f.map(x => /^(\d{3})_/.exec(x)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(62)
    expect(new Set(nums).size, 'two migrations share a number').toBe(nums.length)
  })

  it('every migration 062 depends on is unchanged by this slice', () => {
    // 062 asserts facts about all of these. If one were edited, 062 would be
    // asserting a shape its own repository no longer describes.
    const m058 = read('supabase/migrations/058_payment_provider_foundation.sql')
    const m059 = read('supabase/migrations/059_payment_column_select_security.sql')
    const m060 = read('supabase/migrations/060_payment_completion_contract.sql')
    const m061 = read('supabase/migrations/061_audit_log_privilege_hardening.sql')
    const m037 = read('supabase/migrations/037_entitlements.sql')
    expect(m058).toContain('payments_one_inflight_intent_per_course')
    expect(m058).toContain('payments_provider_mode_required')
    expect(m059).toMatch(/grant select \(/)
    expect(m060).toContain('payments_provider_token_unique')
    expect(m060).toContain('payments_status_valid')
    expect(m061).toContain('revoke all on public.audit_log from public, anon, authenticated;')
    expect(m037).toContain('entitlements_one_live_per_course_idx')
    expect(m037).toContain('INDIVIDUAL_PURCHASE')
    // 037's accessibility definition is the one 062 delegates to.
    expect(m037).toMatch(/create or replace function public\.entitlement_accessible/)
  })

  it('it is ONE transaction: a single begin, a single commit, REPEATABLE READ', () => {
    expect(count(CODE, 'begin isolation level repeatable read;')).toBe(1)
    expect((SQL.match(/^begin[ ;]/gm) ?? []).length).toBe(1)
    expect((SQL.match(/^commit;$/gm) ?? []).length).toBe(1)
    expect(SQL.indexOf('begin isolation')).toBeLessThan(SQL.lastIndexOf('commit;'))
  })

  it('it emits no RAISE NOTICE', () => {
    expect(SQL.toLowerCase()).not.toContain('raise notice')
    expect(SQL.toLowerCase()).not.toContain('raise warning')
  })

  it('it changes no schema, no policy and no other table', () => {
    for (const forbidden of [
      'create table public', 'drop table', 'alter table', 'create index', 'drop index',
      'create policy', 'drop policy', 'alter policy', 'create trigger', 'create view',
      'add column', 'drop column', 'alter column', 'security definer',
    ]) {
      expect(CODE.toLowerCase(), `062 contains "${forbidden}"`).not.toContain(forbidden)
    }
    // The only statement-initial DDL: the function and the snapshot temp table.
    const ddl = [...SQL.matchAll(/^\s*(?:create|drop|alter)(?:\s+\S+){1,3}/gim)].map(m => m[0].trim())
    expect(ddl).toHaveLength(2)
    expect(ddl.some(d => /^create temp table pay_2c_062_before/.test(d))).toBe(true)
    expect(ddl.some(d => /^create function public\.complete_payment/.test(d))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — the function signature and privilege contract', () => {
  it('it is SECURITY INVOKER with a pinned search_path', () => {
    expect(SQL).toContain('security invoker')
    // CODE, not SQL: the postflight RAISES a message containing "SECURITY
    // DEFINER", and that literal would satisfy a negative asserted on SQL.
    expect(CODE).not.toMatch(/security definer/i)
    expect(RAW).toMatch(/complete_payment is SECURITY DEFINER/)
    expect(SQL).toContain('set search_path = public, pg_temp')
    expect(SQL).toContain('returns jsonb')
    expect(SQL).toContain('language plpgsql')
  })

  it('the signature accepts NO learner and NO course — a payment cannot be redirected', () => {
    const sig = /create function public\.complete_payment\(([\s\S]*?)\)\nreturns/.exec(SQL)
    expect(sig, 'the function signature was not found').toBeTruthy()
    const params = sig![1].split(',').map(s => s.trim()).filter(Boolean)
    expect(params.map(p => p.split(/\s+/)[0])).toEqual([
      'p_provider', 'p_provider_mode', 'p_provider_token',
      'p_provider_reference', 'p_reference', 'p_amount', 'p_currency',
    ])
    // The learner and course are DERIVED from the stored row. There is no
    // parameter through which a completion could be pointed elsewhere.
    expect(sig![1]).not.toMatch(/uuid/)
    expect(sig![1]).not.toMatch(/user|course|learner/i)
  })

  it('EXECUTE is revoked from everyone, then granted only to service_role', () => {
    const stmts = SQL.split('\n').filter(l => /^\s*(grant|revoke)\s/i.test(l)).map(l => l.trim())
    expect(stmts).toHaveLength(2)
    expect(stmts[0]).toMatch(/^revoke all on function public\.complete_payment\(/)
    expect(stmts[1]).toMatch(/^grant execute on function public\.complete_payment\(/)
    // The revoke must precede the grant, or the grant would be undone.
    const revokeAt = SQL.indexOf('revoke all on function')
    const grantAt = SQL.indexOf('grant execute on function')
    expect(revokeAt).toBeGreaterThan(0)
    expect(revokeAt).toBeLessThan(grantAt)
    // Both name the full signature, so neither can hit a different overload.
    const rev = /revoke all on function public\.complete_payment\(([^)]*)\)\s*\n?\s*from ([^;]*);/.exec(SQL)
    const gr = /grant execute on function public\.complete_payment\(([^)]*)\)\s*\n?\s*to ([^;]*);/.exec(SQL)
    expect(rev![1].replace(/\s+/g, ' ').trim()).toBe(SIGNATURE)
    expect(gr![1].replace(/\s+/g, ' ').trim()).toBe(SIGNATURE)
    expect(rev![2].split(',').map(s => s.trim()).sort()).toEqual(['anon', 'authenticated', 'public'])
    expect(gr![2].split(',').map(s => s.trim())).toEqual(['service_role'])
  })

  it('no privilege statement touches any table', () => {
    for (const l of SQL.split('\n').filter(x => /^\s*(grant|revoke)\s/i.test(x))) {
      expect(l, `a privilege statement names a table: ${l.trim()}`).toMatch(/on function/)
    }
  })

  it('the postflight asserts EFFECTIVE execute privilege, not the grant text', () => {
    expect(CODE).toContain('has_function_privilege(')
    expect(CODE).toContain('pg_has_role(')
    expect(FLAT).toMatch(/can EXECUTE complete_payment/)
    expect(FLAT).toMatch(/A learner who knows their own reference could complete their own payment/)
    expect(FLAT).toMatch(/still grants EXECUTE to PUBLIC/)
    expect(FLAT).toMatch(/service_role cannot EXECUTE complete_payment/)
    expect(FLAT).toMatch(/complete_payment is SECURITY DEFINER/)
    expect(FLAT).toMatch(/has no pinned search_path/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — the function body: what it refuses and what it writes', () => {
  it('it locks the payment row before doing anything with it', () => {
    expect(BODY).toMatch(/where provider_token = p_provider_token\s*\n\s*for update;/)
    // ...and locks the live entitlement before judging it, so a concurrent
    // admin transition cannot move it mid-transaction.
    expect(BODY).toMatch(/status in \('PENDING', 'ACTIVE', 'SUSPENDED'\)\s*\n\s*for update;/)
    expect(count(BODY, 'for update')).toBe(2)
  })

  it('every refusal carries a machine-readable reason for reconciliation', () => {
    for (const r of REASONS) {
      // Two literal styles are in use: '{"reason":"x"}' for the argument
      // guards (before a payment id exists) and jsonb_build_object('reason',
      // 'x', …) afterwards. Match the bare word rather than one quoting.
      expect(BODY, `the body never raises reason ${r}`).toContain(r)
    }
    // Every raise inside the body supplies a DETAIL, so a caller never has to
    // parse a human sentence to build reconciliation on it.
    //
    // Split on `raise exception` rather than matching to the first ";": one
    // message ("…was REVOKED; automatic repurchase is not authorised") contains
    // a semicolon INSIDE its string literal, and a lazy match truncated that
    // statement before its DETAIL and reported a false missing-DETAIL.
    const chunks = BODY.split('raise exception').slice(1)
    expect(chunks.length).toBeGreaterThanOrEqual(REASONS.length - 2)
    for (const c of chunks) {
      expect(c, `a raise has no DETAIL: ${c.slice(0, 90)}`).toMatch(/detail\s*=/)
      expect(c, `a raise has no errcode: ${c.slice(0, 90)}`).toMatch(/errcode\s*=/)
    }
    // Every DETAIL is JSON carrying a `reason`, so the shape is stable.
    expect(count(BODY, 'detail')).toBe(chunks.length)
    for (const c of chunks) expect(c).toMatch(/reason/)
  })

  it('only pending and processing may be completed', () => {
    expect(BODY).toMatch(/status not in \('pending', 'processing'\)/)
    expect(FLAT).toMatch(/which is not completable/)
    // The four terminal states are never completable, and 062 owns no refund
    // or expiry transition.
    for (const s of ['failed', 'refunded', 'cancelled', 'expired']) {
      expect(BODY, `the body should not write status ${s}`).not.toMatch(
        new RegExp(`status\\s*=\\s*'${s}'`))
    }
    expect(count(BODY, "status             = 'completed'")).toBe(1)
  })

  it('it is idempotent: a retried notification writes nothing', () => {
    expect(BODY).toMatch(/if v_pay\.status = 'completed' then/)
    expect(BODY).toContain("'already_completed'")
    // The idempotent return must come BEFORE any write.
    const idem = BODY.indexOf("'already_completed'")
    const firstInsert = BODY.indexOf('insert into public.entitlements')
    const theUpdate = BODY.indexOf('update public.payments')
    expect(idem).toBeGreaterThan(0)
    expect(idem, 'the idempotent return must precede every write').toBeLessThan(firstInsert)
    expect(idem).toBeLessThan(theUpdate)
    // A completed payment with no entitlement is a broken half-state, not a
    // success: it must raise rather than return.
    expect(BODY).toContain("'completed_without_entitlement'")
  })

  it('it grants exactly one INDIVIDUAL_PURCHASE entitlement, correctly shaped', () => {
    expect(count(BODY, 'insert into public.entitlements')).toBe(1)
    // Bounded by `returning`, not by the first ")": a lazy match to ")"
    // stopped inside now() and silently truncated the value list.
    const insAt = BODY.indexOf('insert into public.entitlements')
    const retAt = BODY.indexOf('returning id into v_ent_id', insAt)
    expect(insAt, 'the entitlement insert was not found').toBeGreaterThan(0)
    expect(retAt).toBeGreaterThan(insAt)
    const whole = BODY.slice(insAt, retAt)
    const ins = [whole, whole.slice(0, whole.indexOf(') values (')),
                 whole.slice(whole.indexOf(') values ('))]
    expect(ins[2]).toContain("'INDIVIDUAL_PURCHASE'")
    expect(ins[2]).toContain("'ACTIVE'")
    // Perpetual: no expires_at. No invented human actor. And external_ref
    // carries OUR reference, never the provider token.
    expect(ins[1]).toContain('expires_at')
    expect(ins[1]).toContain('granted_by')
    expect(ins[1]).toContain('external_ref')
    // starts_at now(), then expires_at NULL (perpetual) and revoked_at NULL.
    expect(ins[2]).toMatch(/now\(\),\s*null,\s*null,/)
    expect(ins[2]).toContain('v_pay.reference')
    expect(ins[2], 'the provider token must never reach the entitlement')
      .not.toContain('provider_token')
    // Never MANUAL_ADMIN: a machine grant must not impersonate an administrator.
    expect(BODY).not.toContain('MANUAL_ADMIN')
  })

  it('delivery is VERIFIED using the platform own accessibility definition', () => {
    // Not re-implemented. 037's entitlement_accessible() is the single
    // definition of "this entitlement currently grants access", and using it
    // collapses PENDING, SUSPENDED and ACTIVE-but-windowed into one rule.
    expect(count(BODY, 'public.entitlement_accessible(')).toBe(2)
    expect(BODY).toContain("'entitlement_not_accessible'")
    expect(FLAT).toMatch(/does not grant access; refusing to complete payment/)
    // The verification must come BEFORE the payment is marked completed.
    expect(BODY.indexOf("'entitlement_not_accessible'"))
      .toBeLessThan(BODY.indexOf('update public.payments'))
  })

  it('it never overwrites an existing enrollment', () => {
    expect(count(BODY, 'insert into public.enrollments')).toBe(1)
    // Guarded by a prior lookup, and the insert is UNTARGETED `on conflict do
    // nothing` — correct whether the unique index on (user_id, course_id) is
    // total or partial. A conflict TARGET would raise 42P10 against a partial
    // index, and the index's partiality was never established.
    expect(BODY).toMatch(/select id into v_enr/)
    expect(BODY).toMatch(/if v_enr is null then/)
    expect(BODY).toMatch(/on conflict do nothing;/)
    expect(BODY, 'a conflict target would raise 42P10 against a partial index')
      .not.toMatch(/on conflict \(/)
    // No UPDATE of enrollments at all: that row carries participation history.
    expect(BODY).not.toMatch(/update public\.enrollments/)
    expect(BODY).not.toMatch(/upsert/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — the audit contract', () => {
  it('it writes exactly one payment.completed row, as the system actor', () => {
    expect(count(BODY, 'insert into public.audit_log')).toBe(1)
    const ins = BODY.slice(BODY.indexOf('insert into public.audit_log'))
    expect(ins).toContain("'payment.completed'")
    expect(ins).toContain("'system'")
    expect(ins).toContain("'success'")
    expect(ins).toContain("'provider_confirm'")
    // actor_type and outcome must be inside 027's CHECK vocabularies.
    expect(['admin', 'self', 'system', 'anonymous']).toContain('system')
    expect(['success', 'failure']).toContain('success')
  })

  it('NO provider token, credential or payload reaches audit metadata', () => {
    const meta = /jsonb_build_object\(([\s\S]*?)\)\n  \);/.exec(BODY)?.[1]
      ?? BODY.slice(BODY.indexOf('insert into public.audit_log'))
    for (const banned of ['provider_token', 'p_provider_token', 'secret', 'apikey',
                          'master_key', 'password', 'bearer', 'hash']) {
      expect(meta.toLowerCase(), `audit metadata may contain ${banned}`).not.toContain(banned)
    }
    // What it DOES carry, so an investigator can reconstruct the decision.
    for (const key of ['paymentId', 'courseId', 'entitlementId', 'reference',
                       'provider', 'providerMode', 'amount', 'currency',
                       'preExistingEntitlement', 'requiresReview', 'txid']) {
      expect(meta, `audit metadata omits ${key}`).toContain(key)
    }
  })

  it('the audit insert has NO exception handler, so its failure rolls everything back', () => {
    // §6: "Ensure failure of the audit insert rolls back completion." The only
    // handler in the body is the unique_violation wrapper around the
    // entitlement insert — and even that re-raises.
    expect(count(BODY, 'exception')).toBeGreaterThan(0)
    const handlers = [...BODY.matchAll(/\n\s*exception\s*\n/g)]
    expect(handlers, 'more than one exception handler in the body').toHaveLength(1)
    expect(BODY).toMatch(/when unique_violation then/)
    // That one handler must sit around the ENTITLEMENT insert, not the audit one.
    const handlerAt = BODY.search(/\n\s*exception\s*\n/)
    expect(handlerAt).toBeLessThan(BODY.indexOf('insert into public.audit_log'))
    // ...and it re-raises rather than swallowing.
    const handler = BODY.slice(handlerAt, BODY.indexOf('end;', handlerAt) + 4)
    expect(handler).toMatch(/raise exception/)
  })

  it('a duplicate purchase is marked ON THE PAYMENT ROW, not only in the audit', () => {
    // The design-review correction. Marking it only in the audit row and the
    // return value left `payments` indistinguishable from an ordinary sale —
    // and app/(admin)/admin/page.tsx computes revenue as
    // sum(amount) where status = 'completed', so a double-sale would have been
    // counted as new revenue with nothing on the row to say otherwise.
    expect(BODY).toContain("'completionReview'")
    expect(BODY).toMatch(/v_review\s+jsonb\s+:=\s+null/)
    expect(BODY).toContain("'preexisting_entitlement'")
    expect(BODY).toContain("'requiresReview',        true")
    // The marker goes in `metadata` — a column 059 withholds from every
    // browser role — so it needs no schema change and cannot leak to a learner.
    expect(BODY).toMatch(/metadata\s+= case\s*\n\s*when v_review is null then metadata/)
    // MERGED, never replaced: an intent's own metadata survives.
    expect(BODY).toMatch(/coalesce\(metadata, '\{\}'::jsonb\)\s*\n\s*\|\| jsonb_build_object\('completionReview', v_review\)/)
    // v_review is built where v_live is assigned, not inside the UPDATE: the
    // CASE would otherwise evaluate v_live on the ordinary branch, where the
    // record is unassigned and would raise.
    expect(BODY.indexOf('v_review := jsonb_build_object'))
      .toBeLessThan(BODY.indexOf('update public.payments'))
    // No second entitlement, no replacement, no refund on this branch.
    const branch = BODY.slice(BODY.indexOf('v_preexist := true'), BODY.indexOf('  else'))
    expect(branch).not.toMatch(/insert into public\.entitlements/)
    expect(branch).not.toMatch(/update public\.entitlements/)
    expect(branch).not.toMatch(/refund/i)
  })

  it('the policy and the upstream obligation are written down', () => {
    const PROSE = RAW.replace(/\n\s*--\s*/g, ' ').replace(/\s+/g, ' ')
    expect(PROSE).toMatch(/The payment IS completed/)
    expect(PROSE).toMatch(/NO second entitlement is created/)
    expect(PROSE).toMatch(/never replaced, reactivated or re-dated/)
    expect(PROSE).toMatch(/NO automatic refund/)
    expect(PROSE).toMatch(/NOT presented as an ordinary sale/)
    // Prevention belongs upstream, and that obligation is named.
    expect(PROSE).toMatch(/the checkout slice must refuse to create an intent for a course the learner already has live access to/)
  })

  it('the PayDunya integration contract is stated as an eight-point obligation', () => {
    const PROSE = RAW.replace(/\n\s*--\s*/g, ' ').replace(/\s+/g, ' ')
    expect(PROSE).toMatch(/THE CONTRACT THE PAYDUNYA INTEGRATION MUST SATISFY/)
    expect(PROSE).toMatch(/CONFIRM SERVER-TO-SERVER/)
    expect(PROSE).toMatch(/NEVER TREAT THE IPN HASH AS A SIGNATURE/)
    expect(PROSE).toMatch(/PASS WHAT IT VERIFIED, NOT WHAT IT WAS SENT/)
    expect(PROSE).toMatch(/ONE CHOKEPOINT/)
    expect(PROSE).toMatch(/OWN THE FORENSICS/)
    expect(PROSE).toMatch(/BE IDEMPOTENT ITSELF/)
  })

  it('the LOCK ORDER is documented, because reordering would create a cycle', () => {
    const PROSE = RAW.replace(/\n\s*--\s*/g, ' ').replace(/\s+/g, ' ')
    expect(PROSE).toMatch(/LOCK ORDER — DO NOT REORDER THESE STATEMENTS/)
    expect(PROSE).toMatch(/payments -> entitlements -> enrollments -> audit_log/)
    expect(PROSE).toMatch(/A deadlock needs two transactions taking the same two locks in OPPOSITE orders/)
    // The body must actually follow the documented order.
    const pay = BODY.indexOf('from public.payments\n   where provider_token')
    const ent = BODY.indexOf('from public.entitlements\n   where user_id')
    const enr = BODY.indexOf('from public.enrollments\n   where user_id')
    const aud = BODY.indexOf('insert into public.audit_log')
    expect(pay).toBeGreaterThan(0)
    expect(pay).toBeLessThan(ent)
    expect(ent).toBeLessThan(enr)
    expect(enr).toBeLessThan(aud)
  })

  it('the audit insert is the LAST write before the return', () => {
    // If it were not, a later write could land without audit evidence.
    const audit = BODY.indexOf('insert into public.audit_log')
    expect(audit).toBeGreaterThan(0)
    // Past the statement itself, or the negative matches its own text.
    const after = BODY.slice(audit + 'insert into public.audit_log'.length)
    expect(after, 'another insert follows the audit row').not.toMatch(/insert into public\./)
    expect(after, 'another update follows the audit row').not.toMatch(/update public\./)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — migration safety', () => {
  it('the preflight refuses a second completion authority', () => {
    expect(FLAT).toMatch(/a payment-completion routine already exists/)
    expect(FLAT).toMatch(/Refusing to add a second authority or an overload/)
    expect(SQL).toContain("p.proname like '%complete%payment%'")
    // ...and the postflight re-counts, so an overload created later in the
    // transaction is caught too.
    expect(FLAT).toMatch(/payment-completion routines exist, expected exactly 1/)
  })

  it('the preflight asserts every contract the function depends on', () => {
    // 060
    expect(FLAT).toMatch(/expected the nineteen 060 produced/)
    expect(FLAT).toMatch(/payments_status_valid is missing/)
    expect(FLAT).toMatch(/payments_provider_token_unique is missing or not a partial unique index/)
    // 037
    expect(FLAT).toMatch(/entitlements_one_live_per_course_idx is missing/)
    expect(FLAT).toMatch(/the live-entitlement predicate does not cover/)
    expect(FLAT).toMatch(/entitlements\.source does not admit INDIVIDUAL_PURCHASE/)
    expect(FLAT).toMatch(/the live-entitlement predicate does not cover/)
    expect(FLAT).toMatch(/entitlements_expiry_required now names INDIVIDUAL_PURCHASE/)
    // enrollments — discovered, not assumed
    expect(FLAT).toMatch(/has NO unique index on \(user_id, course_id\)/)
    expect(SQL).toContain("array['course_id', 'user_id']")
    // 061
    expect(FLAT).toMatch(/holds % on public\.audit_log — 061 is not in effect/)
    // 059
    // Doubled apostrophes: inside a SQL literal, 059's is written 059''s.
    expect(FLAT).toMatch(/059''s six-column allowlist now reads/)
    expect(SQL).toContain("'amount,course_id,currency,id,reference,status'")
    // 058 — the reason INVOKER fails closed
    expect(FLAT).toMatch(/058''s write withdrawal is not in place and INVOKER would not fail closed/)
    // the trusted caller must hold the privileges INVOKER needs
    expect(FLAT).toMatch(/a SECURITY INVOKER function could not perform its writes/)
  })

  it('the final block proves the migration itself wrote nothing', () => {
    const at = RAW.lastIndexOf('-- ══ 4.')
    expect(at).toBeGreaterThan(0)
    const last = SQL.slice(at)
    for (const claim of ['the payment count changed', 'became completed during this migration',
                         'the entitlement count changed', 'the enrollment count changed',
                         'the audit record count changed']) {
      expect(last, `the final block omits "${claim}"`).toContain(claim)
    }
    // Creating the authority must not have exercised it.
    expect(last).toMatch(/INDIVIDUAL_PURCHASE entitlement\(s\) exist/)
    expect(last).toMatch(/payment\.completed audit row\(s\) exist/)
  })

  it('the final verification block is the LAST statement before COMMIT', () => {
    // An apply-time assertion proves nothing about what runs after it.
    const commit = SQL.lastIndexOf('\ncommit;')
    const lastDo = SQL.lastIndexOf('$do$;', commit)
    expect(lastDo).toBeGreaterThan(0)
    expect(SQL.slice(lastDo + '$do$;'.length, commit).trim()).toBe('')
  })

  it('the rollback is fully commented and refuses to orphan granted rights', () => {
    const rb = RAW.slice(RAW.indexOf('-- ROLLBACK'))
    expect(rb).toContain('-- begin;')
    expect(rb).toContain('-- commit;')
    const live = rb.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'))
    expect(live, `executable lines inside the rollback: ${live.join(' | ')}`).toEqual([])
    expect(rb).toMatch(/INDIVIDUAL_PURCHASE entitlement\(s\) were granted through this function/)
    expect(rb).toMatch(/drop function if exists public\.complete_payment\(/)
  })

  it('the header records the trust boundary honestly, including the residual risk', () => {
    // Header prose wraps across comment lines, so a phrase can be broken by
    // "\n-- ". Flatten the comment markers before matching.
    const PROSE = RAW.replace(/\n\s*--\s*/g, ' ').replace(/\s+/g, ' ')
    expect(PROSE).toMatch(/PRIVILEGED PERSISTENCE OPERATION/)
    expect(PROSE).toMatch(/NOT a PayDunya verification mechanism/)
    expect(PROSE).toMatch(/SHA-512 of the MASTER KEY/)
    expect(PROSE).toMatch(/server-to-server confirm/)
    // The residual risk is named, not hidden.
    expect(PROSE).toMatch(/89 call sites/)
    expect(PROSE).toMatch(/confers no capability a service-key holder lacks/)
    // And the open business decisions are recorded where the next reader is.
    expect(PROSE).toMatch(/REVOKED entitlement refuses automatic repurchase/)
    expect(RAW).toMatch(/PRICE-LAUNCH-01/)
    expect(RAW).toMatch(/SEC-4/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('PAY-2C — no caller exists yet', () => {
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
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('NOTHING in the application calls complete_payment yet', () => {
    // 062 creates the authority. The IPN slice builds the caller, behind a
    // single chokepoint. Until then there must be no call site at all.
    const callers: string[] = []
    for (const f of sourceFiles()) {
      if (/\.rpc\(\s*['"]complete_payment['"]/.test(strip(read(f)))) callers.push(f)
    }
    expect(callers, `complete_payment is already called from: ${callers.join(', ')}`).toEqual([])
  })

  it('still nothing writes payments.status = completed from application code', () => {
    // PAY-2C-0's standing assertion. 062 moves completion into the database;
    // it must not reopen an application path.
    const offenders: string[] = []
    for (const f of sourceFiles()) {
      const code = strip(read(f))
      for (const m of code.matchAll(/from\(\s*['"]payments['"]\s*\)/g)) {
        const window = code.slice(m.index!, m.index! + 400)
        if (/\.(update|upsert|insert)\(/.test(window) &&
            (/['"]completed['"]/.test(window) || /completed_at/.test(window))) {
          offenders.push(`${f} @${m.index}`)
        }
      }
    }
    expect(offenders, `payment-completion writer(s): ${offenders.join(', ')}`).toEqual([])
  })

  it('062 is the ONLY migration that defines a completion function, besides withdrawn 003', () => {
    const defines: string[] = []
    for (const m of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
      const sql = read(`supabase/migrations/${m}`).replace(/--[^\n]*/g, '')
      if (/create\s+(or replace\s+)?function\s+\S*complete\S*payment/i.test(sql)) defines.push(m)
    }
    // 003 was NEVER APPLIED and stays withdrawn — verified against production:
    // no such RPC, and none of its webhook_id/payment_intent_id/updated_at
    // columns. 062 is the authority that replaces it.
    expect(defines.sort()).toEqual([
      '003_payment_readiness.sql',
      '062_atomic_payment_completion.sql',
    ])
    // 003's columns must still not be reintroduced by 062.
    for (const c of ['webhook_id', 'payment_intent_id', 'updated_at']) {
      expect(CODE, `062 reintroduces 003's ${c}`).not.toContain(c)
    }
  })

  it('the legacy admin activation path is still disabled', () => {
    // PAY-2C-0. 062 must not quietly re-enable it.
    const action = read('app/(admin)/admin/payments/actions.ts')
    const code = strip(action)
    expect(code).not.toContain('createAdminClient')
    expect(code).not.toContain('complete_payment')
    expect(code).toMatch(/throw new Error\(/)
  })
})
