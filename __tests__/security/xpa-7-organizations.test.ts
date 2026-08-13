// @vitest-environment node
/**
 * XPA-7 — B2B organizations and corporate licensing.
 *
 * ── THE SEPARATION THIS PHASE MUST NOT BLUR ───────────────────────────────
 *
 *   ORGANIZATION / MEMBERSHIP   who the company is, and who works there.
 *   ENTITLEMENT                 may this learner open this course? Authority.
 *
 * Only the second opens content. The whole risk of a B2B phase is that
 * "belongs to a customer" quietly becomes "may read the courses" — so most of
 * what follows checks that membership grants nothing.
 *
 * ── THE DEFECT THIS PHASE CLOSED ──────────────────────────────────────────
 *
 * Migration 004's `memberships_insert` permitted `user_id = auth.uid() AND
 * role = 'viewer'` with NO constraint on which `org_id`. Proved against
 * production: an unrelated learner self-joined an organization as viewer (HTTP
 * 201) and could then read its name, slug and membership list. Harmless only
 * because zero organizations existed; XPA-7 is what makes them exist.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ORG_ROLES, XPA7_ASSIGNABLE_ROLES, ORG_ROLE_RANK, outranks,
  MEMBERSHIP_STATUSES, MEMBERSHIP_TRANSITIONS, canTransition, isActiveMember,
  normalizeOrgSlug,
} from '@/lib/organizations'
import { ADMIN_SELECTABLE_SOURCES, EXPIRY_RULES } from '@/lib/entitlements'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const M040 = stripSql(read('supabase/migrations/040_organizations_xpa7.sql'))
const M037 = stripSql(read('supabase/migrations/037_entitlements.sql'))
const ORG_ACTIONS = stripTs(read('app/actions/organizations.ts'))
const ENT_ACTIONS = stripTs(read('app/actions/entitlements.ts'))

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION — the self-join isolation defect
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 — a learner must not be able to join an organization they were not added to', () => {
  it('XPA-7: the self-service viewer arm is gone from memberships_insert', () => {
    const policy = M040.slice(M040.indexOf('create policy "memberships_insert"'))
    const body = policy.slice(0, policy.indexOf(';'))
    expect(body, 'the role = viewer self-join arm is back').not.toMatch(/viewer/)
    expect(body).toMatch(/is_platform_admin/)
    expect(body).toMatch(/has_org_role\(\s*org_id\s*,\s*'org_admin'\s*\)/)
  })

  it('XPA-7: membership creation requires authority over THAT organization', () => {
    const policy = M040.slice(M040.indexOf('create policy "memberships_insert"'))
    const body = policy.slice(0, policy.indexOf(';'))
    // The org_id must be the one being written to, not any organization.
    expect(body).toMatch(/has_org_role\(org_id/)
    expect(body, 'the check no longer keys on the row being inserted').not.toMatch(/user_id = auth\.uid\(\)/)
  })

  it('XPA-7: the migration asserts the defect is closed at apply time', () => {
    expect(M040).toMatch(/memberships_insert still allows a self-service viewer join/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MEMBERSHIP GRANTS NOTHING
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 membership is not access', () => {
  it('has_course_access() never learned about organizations', () => {
    const fn = M037.slice(
      M037.indexOf('create or replace function public.has_course_access'),
      M037.indexOf('comment on function public.has_course_access'),
    )
    expect(fn).toContain('entitlements')
    expect(fn, 'the seam reads organization data').not.toMatch(/organization/i)
    expect(fn, 'the seam reads enrollments again').not.toContain('enrollments')
  })

  it('migration 040 asserts the seam was not widened', () => {
    expect(M040).toMatch(/has_course_access\(\) now reads organization data/)
    expect(M040).toMatch(/Q-L violated/)
  })

  it('organization actions never touch entitlements', () => {
    expect(ORG_ACTIONS, 'an organization action writes entitlements')
      .not.toMatch(/\.from\(\s*['"`]entitlements['"`]\s*\)/)
  })

  it('there is no org-scoped granting action', () => {
    for (const forbidden of ['grantCorporateLicense', 'grantForOrganization', 'orgGrant']) {
      expect(ORG_ACTIONS, forbidden).not.toContain(forbidden)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D7-3 — CORPORATE LICENCE AUTHORITY STAYS WITH THE PLATFORM ADMIN
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 corporate licence authority', () => {
  it('CORPORATE_LICENSE is admin-selectable and expiry stays mandatory', () => {
    expect(ADMIN_SELECTABLE_SOURCES).toContain('CORPORATE_LICENSE')
    expect(EXPIRY_RULES.CORPORATE_LICENSE).toBe('required')
  })

  it('the mandatory expiry is still enforced by the schema', () => {
    const c = M037.slice(M037.indexOf('constraint entitlements_expiry_required'))
    expect(c.slice(0, 300)).toMatch(/CORPORATE_LICENSE/)
    expect(c.slice(0, 300)).toMatch(/expires_at is not null/)
  })

  it('every organization action requires a PLATFORM admin', () => {
    for (const fn of ['createOrganization', 'addOrganizationMember', 'setMembershipStatus']) {
      const start = ORG_ACTIONS.indexOf(`export async function ${fn}`)
      expect(start, fn).toBeGreaterThan(-1)
      const body = ORG_ACTIONS.slice(start, start + 600)
      expect(body, `${fn} does not require a platform admin`).toContain('requirePlatformAdmin()')
    }
  })

  it('requirePlatformAdmin was not weakened on the grant path', () => {
    expect(ENT_ACTIONS).toMatch(/export async function grantEntitlement[\s\S]{0,900}requirePlatformAdmin\(\)/)
    expect(ENT_ACTIONS, 'the grant path consults org membership')
      .not.toMatch(/has_org_role|is_org_member/)
  })

  it('machine-issued sources are still not assertable by a human', () => {
    for (const s of ['INDIVIDUAL_PURCHASE', 'MIGRATION']) {
      expect(ADMIN_SELECTABLE_SOURCES, s).not.toContain(s)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D7-1 — ONE LIVE ENTITLEMENT PER LEARNER PER COURSE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 preserves the single-live-entitlement invariant', () => {
  it('the partial unique index is untouched', () => {
    expect(M037).toMatch(/create unique index if not exists entitlements_one_live_per_course_idx/)
    const idx = M037.slice(M037.indexOf('entitlements_one_live_per_course_idx'))
    expect(idx.slice(0, 200)).toMatch(/\(user_id, course_id\)/)
    expect(idx.slice(0, 200)).toMatch(/PENDING.*ACTIVE.*SUSPENDED/s)
  })

  it('migration 040 does not drop or alter it', () => {
    expect(M040).not.toMatch(/drop index[\s\S]{0,80}one_live_per_course/i)
    expect(M040).not.toMatch(/entitlements_one_live_per_course_idx/)
  })

  it('the grant path still refuses a second live entitlement', () => {
    expect(ENT_ACTIONS).toMatch(/live entitlement already exists/)
    expect(ENT_ACTIONS).toMatch(/LIVE_STATUSES/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ATTRIBUTION, NOT AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 organization attribution', () => {
  it('organization_id is nullable and never backfilled', () => {
    expect(M040).toMatch(/add column if not exists organization_id uuid/)
    expect(M040).toMatch(/on delete set null/)
    expect(M040, 'a backfill was introduced').not.toMatch(/update public\.entitlements[\s\S]{0,200}set organization_id/i)
    expect(M040).toMatch(/organization_id was backfilled/)
  })

  it('deleting an organization must not delete commercial history', () => {
    const col = M040.slice(M040.indexOf('add column if not exists organization_id'))
    expect(col.slice(0, 200)).toMatch(/on delete set null/)
    expect(col.slice(0, 200), 'cascade would erase entitlements').not.toMatch(/on delete cascade/)
  })

  it('external_ref is left alone as historical metadata', () => {
    expect(M040, 'external_ref was rewritten').not.toMatch(/set external_ref/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D7-4 — MEMBERSHIP LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 membership lifecycle', () => {
  it('declares exactly three statuses', () => {
    expect([...MEMBERSHIP_STATUSES].sort()).toEqual(['ACTIVE', 'PENDING', 'REMOVED'])
    const c = M040.slice(M040.indexOf('organization_memberships_status_check'))
    for (const s of MEMBERSHIP_STATUSES) expect(c.slice(0, 300)).toContain(s)
  })

  it('only ACTIVE confers membership', () => {
    expect(isActiveMember('ACTIVE')).toBe(true)
    for (const s of ['PENDING', 'REMOVED', null, undefined, '']) {
      expect(isActiveMember(s as never), String(s)).toBe(false)
    }
  })

  it('the SQL helpers filter on ACTIVE, so the lifecycle is not decoration', () => {
    for (const fn of ['is_org_member', 'get_org_role', 'has_org_role']) {
      const body = M040.slice(M040.indexOf(`function public.${fn}`))
      expect(body.slice(0, 700), `${fn} ignores status`).toMatch(/status = 'ACTIVE'/)
    }
  })

  it('REMOVED is terminal', () => {
    expect(MEMBERSHIP_TRANSITIONS.REMOVED).toEqual([])
    expect(canTransition('REMOVED', 'ACTIVE')).toBe(false)
    expect(canTransition('ACTIVE', 'REMOVED')).toBe(true)
    expect(canTransition('PENDING', 'ACTIVE')).toBe(true)
  })

  it('the action refuses an illegal transition rather than applying it', () => {
    expect(ORG_ACTIONS).toMatch(/canTransition\(from, to\)/)
    expect(ORG_ACTIONS).toMatch(/non autoris/)
  })

  it('a duplicate membership is reported, not duplicated', () => {
    expect(ORG_ACTIONS).toMatch(/déjà rattaché/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D7-5 / D7-6 / D7-2
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 ratified boundaries', () => {
  it('D7-5: multi-organization membership is allowed — no global uniqueness', () => {
    expect(M040, 'a global one-org-per-user constraint was added')
      .not.toMatch(/unique[\s\S]{0,80}\(\s*user_id\s*\)/i)
    expect(ORG_ACTIONS, 'the action rejects a learner who belongs elsewhere')
      .not.toMatch(/already belongs to another organization/i)
  })

  it('D7-6: no seats anywhere', () => {
    for (const term of ['seat', 'seats', 'capacity', 'allocation', 'overage']) {
      expect(M040.toLowerCase(), `migration mentions ${term}`).not.toContain(term)
      expect(ORG_ACTIONS.toLowerCase(), `actions mention ${term}`).not.toContain(term)
    }
  })

  it('D7-2: plan is never consulted for access', () => {
    expect(M040, 'the migration reads plan').not.toMatch(/where[\s\S]{0,60}plan/i)
    expect(ORG_ACTIONS, 'an action branches on plan').not.toMatch(/plan_status\s*===|\.plan\s*===/)
    const seam = M037.slice(
      M037.indexOf('create or replace function public.has_course_access'),
      M037.indexOf('comment on function public.has_course_access'),
    )
    expect(seam).not.toMatch(/plan/i)
  })

  it('no competing organization model was created', () => {
    expect(M040, 'a companies table was created').not.toMatch(/create table[\s\S]{0,40}compan/i)
    expect(M040, 'organizations was recreated').not.toMatch(/create table[\s\S]{0,40}organizations/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ROLE MODEL AND HELPERS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 role model', () => {
  it('preserves the five legacy roles and assigns only two', () => {
    expect([...ORG_ROLES].sort()).toEqual(
      ['analyst', 'cx_manager', 'org_admin', 'team_manager', 'viewer'])
    expect([...XPA7_ASSIGNABLE_ROLES].sort()).toEqual(['org_admin', 'viewer'])
  })

  it('the TS rank mirrors the SQL rank', () => {
    expect(ORG_ROLE_RANK).toEqual({
      viewer: 1, analyst: 2, team_manager: 3, cx_manager: 4, org_admin: 5,
    })
    const sqlFn = M040.slice(M040.indexOf('function public.has_org_role'))
    for (const [name, n] of Object.entries(ORG_ROLE_RANK)) {
      expect(sqlFn.slice(0, 900)).toContain(`'${name}',${n}`.replace(',', ','))
    }
  })

  it('outranks is inclusive of the minimum', () => {
    expect(outranks('org_admin', 'viewer')).toBe(true)
    expect(outranks('viewer', 'viewer')).toBe(true)
    expect(outranks('viewer', 'org_admin')).toBe(false)
    expect(outranks(null, 'viewer')).toBe(false)
  })

  it('an org admin never becomes a platform admin', () => {
    expect(ORG_ACTIONS, 'an action grants platform_role').not.toMatch(/platform_role/)
    // Stripped, like every other source in this file. The check is about what
    // the admin path CALLS; prose that names a helper calls nothing. (XPA-8 W2
    // added a comment here explaining why `requireOrgMembership` was deleted.)
    const seam = stripTs(read('lib/auth/session.ts'))
    expect(seam, 'platform admin now consults org membership').not.toMatch(/has_org_role|is_org_member/)
  })

  it('the action refuses a role outside the assignable set', () => {
    expect(ORG_ACTIONS).toMatch(/XPA7_ASSIGNABLE_ROLES[\s\S]{0,80}includes\(input\.role\)/)
  })
})

describe('XPA-7 slug normalisation', () => {
  it('produces a safe, stable identifier', () => {
    expect(normalizeOrgSlug('Transit Dakar SARL')).toBe('transit-dakar-sarl')
    expect(normalizeOrgSlug('  Éléphant  &  Cie  ')).toBe('elephant-cie')
    expect(normalizeOrgSlug('///')).toBe('')
    expect(normalizeOrgSlug('a'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION DISCIPLINE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-7 migration discipline', () => {
  it('040 wraps itself in a transaction', () => {
    expect(M040).toMatch(/^\s*begin\s*;/im)
    expect(M040).toMatch(/commit\s*;\s*$/im)
  })

  it('is additive and reconciliation-safe', () => {
    expect(M040).toMatch(/add column if not exists organization_id/)
    expect(M040).toMatch(/add column if not exists status/)
    expect(M040, 'a table is dropped').not.toMatch(/drop table/i)
    expect(M040, 'a column is dropped').not.toMatch(/drop column/i)
  })

  it('does not edit applied migrations 037-039', () => {
    for (const f of ['037_entitlements', '038_answer_key_protection', '039_public_course_structure']) {
      expect(read(`supabase/migrations/${f}.sql`), f).not.toContain('XPA-7')
    }
  })

  it('re-asserts privileges rather than assuming the legacy grants', () => {
    expect(M040).toMatch(/revoke all on public\.organizations\s+from anon/)
    expect(M040).toMatch(/revoke all on public\.organization_memberships from anon/)
    expect(M040).toMatch(/anon\/PUBLIC still hold privileges/)
  })

  it('every new mutating policy has a WITH CHECK', () => {
    expect(M040).toMatch(/membership UPDATE policy without WITH CHECK/)
    expect(M040).toMatch(/organizations policy without WITH CHECK/)
  })
})
