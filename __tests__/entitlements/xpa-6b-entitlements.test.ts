// @vitest-environment node
/**
 * XPA-6B — commercial entitlements.
 *
 * Two invariants carry this phase, and everything below defends one of them:
 *
 *   Q-L  Revoking access MUST NOT delete learning history.
 *   Q-L  Enrollment MUST NOT independently authorize course access.
 *
 * The second is the one that decays quietly. An enrollment row looks like
 * permission — it is called "enrollment", it has a status, and for most of this
 * platform's life it WAS permission. A future change that reads it "just to be
 * safe" reconnects payment to access without anyone deciding to.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isEntitlementAccessible,
  inaccessibleReason,
  validateExpiry,
  ENTITLEMENT_SOURCES,
  ENTITLEMENT_STATUSES,
  ADMIN_SELECTABLE_SOURCES,
  EXPIRY_RULES,
} from '@/lib/entitlements'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const MIGRATION = 'supabase/migrations/037_entitlements.sql'

const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const sql = stripSql(read(MIGRATION))

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCESS PREDICATE (Q-M) — behavioural, not textual
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B access predicate', () => {
  const NOW = new Date('2026-08-06T12:00:00Z')
  const base = { status: 'ACTIVE', starts_at: null, expires_at: null, revoked_at: null }

  it('grants a plain ACTIVE entitlement', () => {
    expect(isEntitlementAccessible(base, NOW)).toBe(true)
  })

  it('denies every non-ACTIVE status', () => {
    for (const status of ENTITLEMENT_STATUSES.filter(s => s !== 'ACTIVE')) {
      expect(isEntitlementAccessible({ ...base, status }, NOW), status).toBe(false)
    }
  })

  it('denies before starts_at and grants from it', () => {
    expect(isEntitlementAccessible({ ...base, starts_at: '2026-08-07T00:00:00Z' }, NOW)).toBe(false)
    expect(isEntitlementAccessible({ ...base, starts_at: '2026-08-05T00:00:00Z' }, NOW)).toBe(true)
  })

  it('denies at and after expires_at — the boundary is exclusive', () => {
    // Access must stop AT the instant of expiry, not one tick later.
    expect(isEntitlementAccessible({ ...base, expires_at: NOW.toISOString() }, NOW)).toBe(false)
    expect(isEntitlementAccessible({ ...base, expires_at: '2026-08-06T11:59:59Z' }, NOW)).toBe(false)
    expect(isEntitlementAccessible({ ...base, expires_at: '2026-08-06T12:00:01Z' }, NOW)).toBe(true)
  })

  it('denies a revoked entitlement even when status was left ACTIVE', () => {
    expect(isEntitlementAccessible({ ...base, revoked_at: '2026-08-01T00:00:00Z' }, NOW)).toBe(false)
  })

  it('reports a usable reason for each denial', () => {
    expect(inaccessibleReason({ ...base, expires_at: '2026-01-01T00:00:00Z' }, NOW)).toBe('expired')
    expect(inaccessibleReason({ ...base, starts_at: '2027-01-01T00:00:00Z' }, NOW)).toBe('not_started')
    expect(inaccessibleReason({ ...base, revoked_at: '2026-01-01T00:00:00Z' }, NOW)).toBe('revoked')
    expect(inaccessibleReason({ ...base, status: 'SUSPENDED' }, NOW)).toBe('suspended')
    expect(inaccessibleReason(base, NOW)).toBeNull()
  })

  it('the TS predicate mirrors the SQL one clause for clause', () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function public.entitlement_accessible'),
      sql.indexOf('comment on function public.entitlement_accessible'),
    )
    expect(fn).toMatch(/p_status = 'ACTIVE'/)
    expect(fn).toMatch(/p_revoked_at is null/)
    expect(fn).toMatch(/p_starts_at\s+is null or p_starts_at\s+<= now\(\)/)
    expect(fn).toMatch(/p_expires_at is null or p_expires_at >\s+now\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EXPIRY RULES (Q-M)
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B expiry rules', () => {
  const FUTURE = new Date(Date.now() + 86_400_000)

  it('requires expiry for BUSINESS_EVALUATION and CORPORATE_LICENSE', () => {
    for (const s of ['BUSINESS_EVALUATION', 'CORPORATE_LICENSE'] as const) {
      expect(EXPIRY_RULES[s]).toBe('required')
      expect(validateExpiry(s, null, true).ok, s).toBe(false)
      expect(validateExpiry(s, FUTURE, true).ok, s).toBe(true)
    }
  })

  it('allows perpetual purchase and manual grants', () => {
    for (const s of ['INDIVIDUAL_PURCHASE', 'MANUAL_ADMIN'] as const) {
      expect(EXPIRY_RULES[s]).toBe('optional')
      expect(validateExpiry(s, null, false).ok, s).toBe(true)
    }
  })

  it('forces an explicit decision for PROMOTIONAL_GRANT', () => {
    // The database cannot tell "chose perpetual" from "never looked at the
    // field" — both arrive as null — so the intent must be carried explicitly.
    expect(validateExpiry('PROMOTIONAL_GRANT', null, false).ok).toBe(false)
    expect(validateExpiry('PROMOTIONAL_GRANT', null, true).ok).toBe(true)
    expect(validateExpiry('PROMOTIONAL_GRANT', FUTURE, true).ok).toBe(true)
  })

  it('rejects an expiry already in the past', () => {
    expect(validateExpiry('MANUAL_ADMIN', new Date(Date.now() - 1000), true).ok).toBe(false)
  })

  it('the required rule is enforced by the SCHEMA, not only the form', () => {
    expect(sql).toMatch(/constraint entitlements_expiry_required/)
    const c = sql.slice(sql.indexOf('constraint entitlements_expiry_required'))
    expect(c.slice(0, 300)).toMatch(/BUSINESS_EVALUATION/)
    expect(c.slice(0, 300)).toMatch(/CORPORATE_LICENSE/)
    expect(c.slice(0, 300)).toMatch(/expires_at is not null/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE RATIFIED MODEL
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B ratified model', () => {
  it('declares exactly the six approved sources', () => {
    expect([...ENTITLEMENT_SOURCES].sort()).toEqual([
      'BUSINESS_EVALUATION', 'CORPORATE_LICENSE', 'INDIVIDUAL_PURCHASE',
      'MANUAL_ADMIN', 'MIGRATION', 'PROMOTIONAL_GRANT',
    ])
    for (const s of ENTITLEMENT_SOURCES) expect(sql, s).toContain(`'${s}'`)
  })

  it('declares exactly the six approved states and NOT completed', () => {
    expect([...ENTITLEMENT_STATUSES].sort()).toEqual([
      'ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING', 'REVOKED', 'SUSPENDED',
    ])
    // COMPLETED is academic and belongs to the enrollment.
    const statusCheck = sql.slice(sql.indexOf('status        text'), sql.indexOf('starts_at'))
    expect(statusCheck).not.toMatch(/COMPLETED/i)
  })

  it('only lets an admin assert sources a human can legitimately assert', () => {
    // A person must not be able to record an INDIVIDUAL_PURCHASE that no payment
    // system produced, or a CORPORATE_LICENSE with no contract behind it.
    expect([...ADMIN_SELECTABLE_SOURCES].sort()).toEqual(['MANUAL_ADMIN', 'PROMOTIONAL_GRANT'])
    const action = stripTs(read('app/actions/entitlements.ts'))
    expect(action).toMatch(/ADMIN_SELECTABLE_SOURCES.*includes\(input\.source\)/s)
  })

  it('allows at most one LIVE entitlement per learner per course', () => {
    expect(sql).toMatch(/create unique index if not exists entitlements_one_live_per_course_idx/)
    const idx = sql.slice(sql.indexOf('entitlements_one_live_per_course_idx'))
    expect(idx.slice(0, 300)).toMatch(/\(user_id, course_id\)/)
    // Terminal states are excluded so history accumulates rather than blocking.
    expect(idx.slice(0, 300)).toMatch(/where status in \('PENDING', 'ACTIVE', 'SUSPENDED'\)/)
  })

  it('keeps revocation and revoked_at consistent in both directions', () => {
    expect(sql).toMatch(/constraint entitlements_revocation_consistent/)
    expect(sql).toMatch(/\(status = 'REVOKED'\) = \(revoked_at is not null\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Q-L — THE TWO INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B: enrollment does not authorize access', () => {
  it('the SQL seam reads entitlements and NOT enrollments', () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function public.has_course_access'),
      sql.indexOf('comment on function public.has_course_access'),
    )
    expect(fn).toMatch(/from public\.entitlements ent/)
    expect(fn).toMatch(/public\.entitlement_accessible\(/)
    expect(fn, 'the enrollments arm must be REMOVED, not supplemented')
      .not.toMatch(/public\.enrollments/)
    // And the arms that were never allowed stay gone.
    expect(fn).not.toMatch(/is_free|is_published/)
    expect(fn).not.toMatch(/auth\.uid\(\)\s+is\s+null/i)
  })

  it('the migration asserts that removal at apply time', () => {
    expect(sql).toMatch(/raise exception 'has_course_access\(\) still reads enrollments/)
    expect(sql).toMatch(/raise exception 'has_course_access\(\) does not consult entitlements'/)
  })

  it('the TS mirror reads entitlements and NOT enrollments', () => {
    const ts = stripTs(read('lib/auth/course-access.ts'))
    const fn = ts.slice(ts.indexOf('export async function resolveCourseAccessById'))
    expect(fn).toMatch(/from\('my_course_access'\)/)
    expect(fn).not.toMatch(/from\('enrollments'\)/)
    // The base table is unreachable from a learner session — querying it would
    // return 42501 — so the mirror must go through the learner-safe view.
    expect(fn).not.toMatch(/from\('entitlements'\)/)
  })

  it('the learner dashboard lists entitlements, not enrollments', () => {
    // Listing enrollments would show a learner courses they can no longer open.
    const page = stripTs(read('app/(platform)/dashboard/page.tsx'))
    expect(page).toMatch(/from\('my_course_access'\)/)
    expect(page).toMatch(/accessibleCourseIds/)
    expect(page).not.toMatch(/from\('entitlements'\)/)
  })

  it('XPA-6A content policies are NOT edited — the seam absorbs the change', () => {
    // The promise XPA-6A made: XPA-6B extends the function, not the policies.
    for (const t of ['lessons', 'modules', 'quizzes', 'quiz_questions']) {
      expect(sql, `037 must not redefine ${t}_visible`)
        .not.toMatch(new RegExp(`create policy "${t}_visible"`))
    }
  })
})

describe('XPA-6B: revocation preserves learning history', () => {
  const action = stripTs(read('app/actions/entitlements.ts'))

  it('no entitlement action deletes learning data', () => {
    for (const table of [
      'enrollments', 'lesson_progress', 'quiz_attempts', 'certificates',
      'exercise_submissions', 'ai_sessions',
    ]) {
      expect(action, `must never delete from ${table}`)
        .not.toMatch(new RegExp(`from\\(['"]${table}['"]\\)[\\s\\S]{0,120}\\.delete\\(`))
    }
    // No delete at all, on anything.
    expect(action).not.toMatch(/\.delete\(\)/)
  })

  it('revocation updates only the entitlement row', () => {
    const fn = action.slice(action.indexOf('async function transition'))
    const body = fn.slice(0, fn.indexOf('export async function suspendEntitlement'))
    const updates = body.match(/\.from\(['"](\w+)['"]\)/g) ?? []
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) expect(u).toContain('entitlements')
  })

  it('granting reuses an existing enrollment rather than resetting it', () => {
    // Re-granting after a revocation must restore the learner's place, not
    // start them over.
    const fn = action.slice(action.indexOf('async function ensureEnrollment'))
    expect(fn.slice(0, 600)).toMatch(/ignoreDuplicates:\s*true/)
    expect(fn.slice(0, 600)).toMatch(/onConflict:\s*'user_id,course_id'/)
  })

  it('terminal states are not re-opened in place', () => {
    // Re-opening a REVOKED entitlement would erase the reason it was revoked.
    expect(action).toMatch(/\['REVOKED', 'EXPIRED', 'CANCELLED'\]\.includes\(current\.status\)/)
  })

  it('records that history was preserved, in the audit trail', () => {
    expect(action).toMatch(/learningHistoryPreserved:\s*true/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EXPIRY IS NOT A CRON JOB
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B expiry does not depend on a job running', () => {
  it('access is evaluated from expires_at, not from the EXPIRED status', () => {
    const fn = sql.slice(
      sql.indexOf('create or replace function public.entitlement_accessible'),
      sql.indexOf('comment on function public.entitlement_accessible'),
    )
    expect(fn).toMatch(/p_expires_at >\s+now\(\)/)
    expect(fn).not.toMatch(/'EXPIRED'/)
  })

  it('the materialiser only relabels ACTIVE rows whose date has passed', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.expire_due_entitlements'))
    const body = fn.slice(0, fn.indexOf('comment on function public.expire_due_entitlements'))
    expect(body).toMatch(/set status = 'EXPIRED'/)
    expect(body).toMatch(/where status = 'ACTIVE'/)
    expect(body).toMatch(/expires_at <= now\(\)/)
    expect(body).not.toMatch(/delete/i)
  })

  it('the materialiser is service-role only', () => {
    expect(sql).toMatch(/revoke all on function public\.expire_due_entitlements\(\) from anon/)
    expect(sql).toMatch(/revoke all on function public\.expire_due_entitlements\(\) from authenticated/)
    expect(sql).not.toMatch(/grant execute on function public\.expire_due_entitlements/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PRIVILEGES, RLS AND ADMIN CONTROLS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6B privileges and controls', () => {
  it('grants NO app role any privilege on the base table', () => {
    // entitlements carries provenance, timing and revocation detail. It is
    // commercial authorization data: anon and authenticated must not reach it
    // at all, so 42501 is the correct answer rather than "200, zero rows".
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(`revoke all on public.entitlements from ${role}`)
    }
    expect(sql, 'no GRANT on the base table to any app role')
      .not.toMatch(/grant\s+\w+\s+on\s+public\.entitlements\s+to/i)
  })

  it('exposes exactly one learner-facing reader, granted SELECT only', () => {
    expect(sql).toMatch(/create or replace view public\.my_course_access/)
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(`revoke all on public.my_course_access from ${role}`)
    }
    const revoke = sql.indexOf('revoke all on public.my_course_access from public')
    const grant = sql.indexOf('grant select on public.my_course_access to authenticated')
    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(revoke, 'REVOKE must precede GRANT — D-GRANT').toBeLessThan(grant)
    expect(sql).not.toMatch(/grant\s+\w+\s+on\s+public\.my_course_access\s+to[^;]*anon/i)
  })

  it('the learner view cannot serve provenance, timing or revocation data', () => {
    const view = sql.slice(
      sql.indexOf('create or replace view public.my_course_access'),
      sql.indexOf('comment on view public.my_course_access'),
    )
    // Structural: a view cannot return a column it does not select.
    for (const col of [
      'source', 'granted_by', 'granted_reason', 'external_ref', 'revoked_reason', 'user_id',
    ]) {
      expect(view, `my_course_access must not project ${col}`)
        .not.toMatch(new RegExp(`(^|[\\s,])${col}\\s*(,|$)`, 'm'))
    }
    expect(view).toMatch(/ent\.course_id/)
    expect(view).toMatch(/as has_access/)
    expect(view).toMatch(/as access_ended/)
    expect(view).toMatch(/where ent\.user_id = auth\.uid\(\)/)
  })

  it('asserts the exact matrix from information_schema at apply time', () => {
    expect(sql).toMatch(/information_schema\.role_table_grants/)
    expect(sql).toMatch(/raise exception 'entitlements must hold NO app-role privileges/)
    expect(sql).toMatch(/raise exception 'my_course_access must hold ONLY authenticated:SELECT/)
  })

  /**
   * The first apply failed because it treated an EXPECTED_DENIAL as broken:
   * it revoked anon's privileges and then asserted the table was readable as
   * anon. Every probe is now classified explicitly.
   */
  it('classifies write outcomes with FOUR names, not two', () => {
    // Attempt 2 failed by demanding 42501 and calling 55000 broken. A view that
    // cannot be written to at all is a STRONGER guarantee than a missing grant.
    expect(sql).toMatch(/return 'REFUSED_BY_PRIVILEGE'/)
    expect(sql).toMatch(/return 'REFUSED_BY_VIEW'/)
    expect(sql).toMatch(/return 'ALLOWED'/)
    expect(sql).toMatch(/return 'BROKEN:'/)
    expect(sql).toMatch(/when insufficient_privilege then/)
    expect(sql).toMatch(/when object_not_in_prerequisite_state or feature_not_supported then/)
  })

  it('accepts both safe refusals for a write through the view', () => {
    expect(sql).toMatch(/v not in \('REFUSED_BY_PRIVILEGE', 'REFUSED_BY_VIEW'\)/)
    // ...but never ALLOWED.
    expect(sql).toMatch(/wrote through my_course_access/)
  })

  it('proves a refused write changed nothing, rather than trusting the error', () => {
    expect(sql).toMatch(/create or replace function public\.xpa6b_snapshot/)
    expect(sql).toMatch(/snap_before := public\.xpa6b_snapshot\(\)/)
    expect(sql).toMatch(/snap_after := public\.xpa6b_snapshot\(\)/)
    expect(sql).toMatch(/snap_before is distinct from snap_after/)
    expect(sql).toMatch(/still changed data/)
    expect(sql).toMatch(/mutated live data/)
  })

  it('runs the write probes against LIVE data, not only an empty table', () => {
    // On an empty table "unchanged" is trivially true and proves nothing.
    const live = sql.indexOf('a learner wrote through my_course_access with live data')
    const grant = sql.indexOf('an ACTIVE in-window entitlement did not grant access')
    expect(live).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(grant, 'live write probes must run after an entitlement exists').toBeLessThan(live)
  })

  it('never asserts that entitlements is readable as anon', () => {
    // The exact contradiction that failed the first apply.
    expect(sql).not.toMatch(/entitlements is not readable as anon/)
  })

  it('drops every apply-time helper it created', () => {
    expect(sql).toMatch(/drop function if exists public\.xpa6b_probe/)
    expect(sql).toMatch(/drop function if exists public\.xpa6b_snapshot/)
  })

  it('exercises the whole lifecycle at apply time', () => {
    for (const claim of [
      'access granted with no entitlement',
      'enrollment alone granted access',
      'an ACTIVE in-window entitlement did not grant access',
      'a SUSPENDED entitlement still granted access',
      'reinstatement did not restore access',
      'a REVOKED entitlement still granted access',
      'revocation destroyed the enrollment',
      'an entitlement past expires_at still granted access',
      'a learner can enumerate another learner',
    ]) {
      expect(sql, `apply-time check missing: ${claim}`).toContain(claim)
    }
  })

  it('proves expiry without mutating the row', () => {
    // Flipping the status to EXPIRED would prove nothing about whether access
    // stops before the materialiser has run.
    expect(sql).toMatch(/expiry test row was mutated/)
  })

  it('leaves no test data or helper behind', () => {
    expect(sql).toMatch(/XPA6B_ROLLBACK_TEST_DATA/)
    expect(sql).toMatch(/raise exception 'behavioural checks left % entitlement row/)
    expect(sql).toMatch(/raise exception 'behavioural checks left an enrollment behind'/)
  })

  it('confirms the four content policies still evaluate', () => {
    expect(sql).toMatch(/content policy on % is not evaluatable as anon/)
    expect(sql).toMatch(/content policy on % is not evaluatable as authenticated/)
    expect(sql).toMatch(/raise exception 'has_course_access\(\) grants access with no authenticated user'/)
  })

  it('RLS stays on as defence in depth', () => {
    expect(sql).toMatch(/alter table public\.entitlements enable row level security/)
    expect(sql).toMatch(/create policy "entitlements_select_own"[\s\S]*?for select/)
    expect(sql).not.toMatch(/create policy "entitlements[^"]*"[\s\S]{0,120}for (insert|update|delete)/i)
  })

  it('every admin action is authorized, audited, and the grant is rate limited', () => {
    const src = read('app/actions/entitlements.ts')
    expect(src).toMatch(/^'use server'/m)
    expect(src).toMatch(/requirePlatformAdmin\(\)/)
    expect(src).toMatch(/rateLimitDb\(`entitlement-grant:/)
    expect(src).toMatch(/logAuditEvent\(/)
    for (const evt of [
      'entitlement.granted', 'entitlement.suspended', 'entitlement.reinstated',
      'entitlement.revoked', 'entitlement.cancelled', 'entitlement.expired',
    ]) {
      expect(src, evt).toContain(`'${evt}'`)
    }
    expect(src).toMatch(/outcome:\s*'failure'/)
    expect(src).toMatch(/outcome:\s*'success'/)
  })

  it('the admin page authorizes itself, not just its layout', () => {
    // The gap XPA-6A closed on the admin dashboard must not reappear.
    const page = read('app/(admin)/admin/entitlements/page.tsx')
    expect(page).toMatch(/requirePlatformAdmin\(\)/)
  })

  it('adds no payment, organization or evaluation object', () => {
    for (const forbidden of [
      /create table[^;]*\bpayments?\b/i,
      /create table[^;]*\borganizations?\b/i,
      /create table[^;]*\bevaluation/i,
      /create table[^;]*\bseats?\b/i,
    ]) {
      expect(sql).not.toMatch(forbidden)
    }
  })

  it('contains no USING (true) and no GRANT ALL to anon or public', () => {
    expect(sql).not.toMatch(/using\s*\(\s*true\s*\)/i)
    expect(sql).not.toMatch(/grant\s+all\s+on\s+\S+\s+to\s+(anon|public)/i)
  })
})
