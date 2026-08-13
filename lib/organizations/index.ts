/**
 * Organization domain model (XPA-7).
 *
 * ── THE SEPARATION THIS PHASE MUST NOT BLUR ───────────────────────────────
 *
 *   ORGANIZATION   who the company is, and who works there.   Structural.
 *   MEMBERSHIP     which people belong to it, and in what capacity. Structural.
 *   ENTITLEMENT    may this learner open this course?          Commercial. Authority.
 *   ENROLLMENT     what did this learner actually do?          Academic.
 *
 * Only the third opens content. `has_course_access()` reads entitlements and
 * nothing else — not memberships, not `organizations.plan`, not this module.
 * An organization is context for a grant, never a substitute for one (D7-2).
 *
 * Dependency-free so server and client components can both import it.
 */

// ── Membership roles (legacy schema, preserved per D-Q4) ────────────────────
//
// Five roles exist in the deployed table and are kept. XPA-7 uses two of them:
// `org_admin` manages the roster, `viewer` is an ordinary employee-learner. The
// middle three are ranked by `has_org_role()` and left unused rather than
// removed — removing values from a deployed CHECK is destructive and buys
// nothing.

export const ORG_ROLES = [
  'org_admin', 'cx_manager', 'team_manager', 'analyst', 'viewer',
] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/** Roles XPA-7 actually assigns. The rest remain valid but unused. */
export const XPA7_ASSIGNABLE_ROLES: readonly OrgRole[] = ['org_admin', 'viewer']

/** Matches the SQL rank in `has_org_role()`. Higher outranks lower. */
export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  viewer: 1, analyst: 2, team_manager: 3, cx_manager: 4, org_admin: 5,
}

export function outranks(role: OrgRole | null | undefined, min: OrgRole): boolean {
  if (!role) return false
  return ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[min]
}

// ── Membership lifecycle (D7-4) ─────────────────────────────────────────────
//
// Only ACTIVE confers membership. PENDING is an unaccepted invitation and
// REMOVED is history — both are deliberately kept as rows rather than deleted,
// so "who used to be here" survives, and both are filtered out by
// `is_org_member()` / `has_org_role()` in SQL.

export const MEMBERSHIP_STATUSES = ['PENDING', 'ACTIVE', 'REMOVED'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/** The only status that grants anything. */
export function isActiveMember(status: string | null | undefined): boolean {
  return status === 'ACTIVE'
}

/**
 * Legal transitions. A REMOVED member is re-added by a fresh invitation rather
 * than by resurrecting the old row, so REMOVED is terminal.
 */
export const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  PENDING: ['ACTIVE', 'REMOVED'],
  ACTIVE:  ['REMOVED'],
  REMOVED: [],
}

export function canTransition(from: MembershipStatus, to: MembershipStatus): boolean {
  return (MEMBERSHIP_TRANSITIONS[from] ?? []).includes(to)
}

// ── Organization status ─────────────────────────────────────────────────────
//
// `plan` and `plan_status` are LEGACY and NON-AUTHORITATIVE (D7-2). They came
// from the SmileyCX SaaS product and describe a subscription model this platform
// no longer uses. They are read for display only and must never gate access;
// entitlements are the sole authority. Kept, not dropped, pending a later audit.

export const LEGACY_ORG_PLANS = ['trial', 'starter', 'growth', 'enterprise'] as const
export const LEGACY_ORG_PLAN_STATUSES = ['active', 'suspended', 'cancelled'] as const

/**
 * Guard for the one mistake this module exists to prevent.
 *
 * If anything ever asks "does this organization's plan let them in?", the answer
 * is that the question is wrong. Access is per learner, per course, through an
 * entitlement.
 */
export const PLAN_IS_NOT_ACCESS =
  'organizations.plan is legacy metadata (D7-2). Course access is decided by has_course_access() from entitlements alone.'

// ── Display ─────────────────────────────────────────────────────────────────

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  org_admin:    'Administrateur',
  cx_manager:   'Responsable CX',
  team_manager: "Chef d'équipe",
  analyst:      'Analyste',
  viewer:       'Membre',
}

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  PENDING: 'Invitation en attente',
  ACTIVE:  'Actif',
  REMOVED: 'Retiré',
}

/** A slug that is safe in a URL and stable as an identifier. */
export function normalizeOrgSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
