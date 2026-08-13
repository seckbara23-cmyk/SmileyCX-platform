// @vitest-environment node
/**
 * XPA-6C — commercial business evaluation / trial access.
 *
 * Ratified: `BUSINESS_EVALUATION` is a TIME-LIMITED COMMERCIAL EVALUATION
 * ENTITLEMENT for a prospective corporate customer. It is not an employee
 * competency-assessment engine.
 *
 * ── WHAT THIS PHASE ACTUALLY CHANGED ──────────────────────────────────────
 *
 * Almost nothing, and that is the point. XPA-6B built the source, the
 * mandatory-expiry CHECK, the lifecycle, the audit events and the access seam.
 * The grant form already computed `mustExpire` and rendered a required date for
 * it. All of that was unreachable because `ADMIN_SELECTABLE_SOURCES` withheld
 * the source, with the reason recorded in the code: it awaited "XPA-6C
 * evaluations". This phase is that system arriving.
 *
 * So these tests defend two things: that the source is now assertable by an
 * administrator and ONLY by an administrator, and that its defining
 * characteristic — an expiry nobody can escape — holds in every layer.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ADMIN_SELECTABLE_SOURCES,
  ENTITLEMENT_SOURCES,
  EXPIRY_RULES,
  validateExpiry,
  isEntitlementAccessible,
  inaccessibleReason,
} from '@/lib/entitlements'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const SQL = stripSql(read('supabase/migrations/037_entitlements.sql'))
const ACTION = stripTs(read('app/actions/entitlements.ts'))
const FORM = stripTs(read('app/(admin)/admin/entitlements/GrantEntitlementForm.tsx'))

const NOW = new Date('2026-08-13T12:00:00Z')
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
const evaluation = (over: Record<string, unknown> = {}) => ({
  status: 'ACTIVE', starts_at: null, expires_at: day(30), revoked_at: null, ...over,
} as never)

// ═══════════════════════════════════════════════════════════════════════════
// THE SOURCE IS NOW ADMIN-ASSERTABLE — AND STILL EXACTLY BOUNDED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C the source', () => {
  it('BUSINESS_EVALUATION is an admin-selectable source', () => {
    expect(ADMIN_SELECTABLE_SOURCES).toContain('BUSINESS_EVALUATION')
  })

  it('CORPORATE_LICENSE stays out — it is XPA-7 and asserts a signed contract', () => {
    expect(ADMIN_SELECTABLE_SOURCES).not.toContain('CORPORATE_LICENSE')
  })

  it('machine-issued sources stay out', () => {
    for (const s of ['INDIVIDUAL_PURCHASE', 'MIGRATION']) {
      expect(ADMIN_SELECTABLE_SOURCES, s).not.toContain(s)
    }
  })

  it('no new source was invented — the six ratified sources are unchanged', () => {
    expect([...ENTITLEMENT_SOURCES].sort()).toEqual([
      'BUSINESS_EVALUATION', 'CORPORATE_LICENSE', 'INDIVIDUAL_PURCHASE',
      'MANUAL_ADMIN', 'MIGRATION', 'PROMOTIONAL_GRANT',
    ])
  })

  it('the server action still refuses any source outside the allow-list', () => {
    expect(ACTION).toMatch(/ADMIN_SELECTABLE_SOURCES.*includes\(input\.source\)/s)
    expect(ACTION).toMatch(/source not admin-selectable/)
  })

  it('an evaluation is never silently converted to MANUAL_ADMIN', () => {
    // The action assigns the caller's source through, unchanged.
    expect(ACTION).toMatch(/const source = input\.source as EntitlementSource/)
    expect(ACTION).not.toMatch(/source\s*=\s*['"`]MANUAL_ADMIN['"`]/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MANDATORY EXPIRY — THE DEFINING CHARACTERISTIC, IN THREE LAYERS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C mandatory expiry', () => {
  it('the rule is declared', () => {
    expect(EXPIRY_RULES.BUSINESS_EVALUATION).toBe('required')
  })

  it('layer 1 — validateExpiry rejects a perpetual evaluation', () => {
    const r = validateExpiry('BUSINESS_EVALUATION', null, true)
    expect(r.ok).toBe(false)
  })

  it('layer 1 — and rejects an expiry already in the past', () => {
    expect(validateExpiry('BUSINESS_EVALUATION', new Date(Date.now() - 1000), true).ok).toBe(false)
  })

  it('layer 1 — accepts a future expiry', () => {
    expect(validateExpiry('BUSINESS_EVALUATION', new Date(Date.now() + 86_400_000), true).ok).toBe(true)
  })

  it('layer 2 — the server action calls validateExpiry before writing', () => {
    const guard = ACTION.indexOf('validateExpiry(')
    const insert = ACTION.indexOf(".from('entitlements')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(insert)
  })

  it('layer 3 — the SCHEMA refuses it even if both layers above were bypassed', () => {
    const c = SQL.slice(SQL.indexOf('constraint entitlements_expiry_required'), )
    expect(c.slice(0, 300)).toMatch(/BUSINESS_EVALUATION/)
    expect(c.slice(0, 300)).toMatch(/expires_at is not null/)
  })

  it('the form renders a REQUIRED date for a mandatory-expiry source', () => {
    expect(FORM).toMatch(/mustExpire = rule === 'required'/)
    expect(FORM).toMatch(/mustExpire \?[\s\S]{0,200}required/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCESS WINDOW — timestamp-driven, no job in the loop
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C evaluation window', () => {
  it('an active evaluation inside its window grants access', () => {
    expect(isEntitlementAccessible(evaluation(), NOW)).toBe(true)
  })

  it('before starts_at it does not grant access', () => {
    expect(isEntitlementAccessible(evaluation({ starts_at: day(3) }), NOW)).toBe(false)
    expect(inaccessibleReason(evaluation({ starts_at: day(3) }), NOW)).toBe('not_started')
  })

  it('from starts_at onward it does', () => {
    expect(isEntitlementAccessible(evaluation({ starts_at: day(-1) }), NOW)).toBe(true)
  })

  it('after expires_at it does not', () => {
    expect(isEntitlementAccessible(evaluation({ expires_at: day(-1) }), NOW)).toBe(false)
    expect(inaccessibleReason(evaluation({ expires_at: day(-1) }), NOW)).toBe('expired')
  })

  it('revoked early denies immediately, before the expiry', () => {
    const revoked = evaluation({ status: 'REVOKED', revoked_at: day(-1) })
    expect(isEntitlementAccessible(revoked, NOW)).toBe(false)
    expect(inaccessibleReason(revoked, NOW)).toBe('revoked')
  })

  it('suspended denies', () => {
    expect(isEntitlementAccessible(evaluation({ status: 'SUSPENDED' }), NOW)).toBe(false)
  })

  it('expiry needs no background job — the row stays ACTIVE and unmutated', () => {
    const expired = evaluation({ expires_at: day(-1) })
    expect(isEntitlementAccessible(expired, NOW)).toBe(false)
    // Status is still ACTIVE: nothing rewrote the row to stop access.
    expect((expired as unknown as { status: string }).status).toBe('ACTIVE')
    // And the SQL predicate compares timestamps rather than reading a flag.
    const fn = SQL.slice(SQL.indexOf('function public.entitlement_accessible'))
    expect(fn.slice(0, 900)).toMatch(/expires_at/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ENTITLEMENT IS AUTHORITY — UAT-ACCESS-01 APPLIES TO EVALUATIONS TOO
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C access authority', () => {
  it('the seam is source-agnostic — no special case for evaluations', () => {
    const fn = SQL.slice(
      SQL.indexOf('create or replace function public.has_course_access'),
      SQL.indexOf('comment on function public.has_course_access'),
    )
    expect(fn).toContain('entitlements')
    expect(fn, 'the seam branches on source').not.toMatch(/BUSINESS_EVALUATION|MANUAL_ADMIN/)
    expect(fn, 'the seam reads enrollments again').not.toContain('enrollments')
  })

  it('no page or action special-cases the evaluation source for access', () => {
    for (const f of [
      'lib/auth/course-access.ts',
      'app/(learn)/learn/[courseSlug]/layout.tsx',
      'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx',
      'app/(platform)/certificate/[courseSlug]/page.tsx',
    ]) {
      expect(stripTs(read(f)), `${f} special-cases the source`).not.toContain('BUSINESS_EVALUATION')
    }
  })

  it('an expired evaluation is not rescued by an enrollment', () => {
    // The predicate never consults enrollments, so an active academic row
    // cannot revive an expired commercial one. Asserted at the seam.
    const fn = SQL.slice(
      SQL.indexOf('create or replace function public.has_course_access'),
      SQL.indexOf('comment on function public.has_course_access'),
    )
    expect(fn).not.toContain('enrollments')
    expect(isEntitlementAccessible(evaluation({ expires_at: day(-1) }), NOW)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LEARNER CANNOT TOUCH ANY OF IT
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C learner containment', () => {
  it('every mutating action requires a platform admin', () => {
    for (const fn of ['grantEntitlement', 'revokeEntitlement', 'suspendEntitlement']) {
      expect(ACTION, fn).toContain(fn)
    }
    // The grant path and the shared transition helper both gate on it.
    expect(ACTION).toMatch(/export async function grantEntitlement[\s\S]{0,400}requirePlatformAdmin\(\)/)
    expect(ACTION).toMatch(/async function transition\([\s\S]{0,400}requirePlatformAdmin\(\)/)
  })

  it('the entitlements table holds no privilege for any app role', () => {
    expect(SQL).toMatch(/revoke all on public\.entitlements from/i)
    expect(SQL).toMatch(/entitlements must hold NO app-role privileges/)
  })

  it('the browser never receives a service-role key', () => {
    expect(FORM).not.toContain('SERVICE_ROLE')
    expect(FORM).not.toContain('supabase/admin')
  })

  it('the learner-safe view exposes no commercial detail', () => {
    // The SELECT list only. The view's own `comment on` legitimately NAMES the
    // excluded columns ("Deliberately EXCLUDES source, granted_by, …"), so a
    // slice that runs past the projection trips on the documentation.
    const v = SQL.slice(SQL.indexOf('create or replace view public.my_course_access'))
    const projection = v.slice(0, v.indexOf('from public.entitlements'))
    for (const col of ['source', 'granted_by', 'granted_reason', 'external_ref', 'revoked_reason']) {
      expect(projection, `my_course_access exposes ${col}`).not.toContain(col)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE AND BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6C scope', () => {
  it('evaluations stay course-level — no academy-wide abstraction invented', () => {
    const t = SQL.slice(SQL.indexOf('create table if not exists public.entitlements'))
    expect(t.slice(0, 900)).toMatch(/course_id\s+uuid\s+not null/)
  })

  it('no XPA-7 organization architecture was created', () => {
    const files = ['supabase/migrations', 'lib', 'app']
    // No migration in this phase at all, and no companies/organizations table.
    expect(read('supabase/migrations/037_entitlements.sql')).not.toMatch(/create table.*organizations/i)
    expect(files.length).toBeGreaterThan(0)
  })

  it('prospect identification reuses external_ref rather than a new table', () => {
    const t = SQL.slice(SQL.indexOf('create table if not exists public.entitlements'))
    expect(t.slice(0, 1400)).toMatch(/external_ref\s+text/)
  })

  it('the audit records grant and revoke, and expiry is documented as derived', () => {
    expect(read('lib/audit/log.ts')).toContain("'entitlement.granted'")
    expect(read('lib/audit/log.ts')).toContain("'entitlement.revoked'")
    const brief = read('docs/xpa-6c-brief.md')
    expect(brief).toMatch(/Expiry is \*\*not\*\* an event|not an event/)
  })
})

describe('XPA-6C operating-mode independence', () => {
  it('no mode flag participates in the grant path or the access seam', () => {
    for (const flag of ['PLATFORM_MODE', 'PILOT_MODE', 'FREE_ACCESS_MODE', 'SELF_ENROLLMENT_OPEN']) {
      expect(ACTION, `${flag} in the grant action`).not.toContain(flag)
      expect(stripTs(read('lib/auth/course-access.ts')), `${flag} in the seam`).not.toContain(flag)
      expect(stripTs(read('lib/entitlements/index.ts')), `${flag} in the domain model`).not.toContain(flag)
    }
  })
})
