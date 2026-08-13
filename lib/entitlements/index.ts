/**
 * Entitlement domain model (XPA-6B).
 *
 * ── THE RATIFIED SEPARATION (Q-L) ─────────────────────────────────────────
 *
 *   ENTITLEMENT  may this learner access this course?   Commercial.
 *   ENROLLMENT   what did this learner actually do?     Academic.
 *
 * Revoking access never deletes learning history, and an enrollment never
 * authorizes access on its own. Everything in this module is on the commercial
 * side of that line.
 *
 * Dependency-free so server and client components can both import it.
 */

// ── Sources (Q-L, ratified) ─────────────────────────────────────────────────

export const ENTITLEMENT_SOURCES = [
  'MANUAL_ADMIN',
  'INDIVIDUAL_PURCHASE',
  'CORPORATE_LICENSE',
  'BUSINESS_EVALUATION',
  'PROMOTIONAL_GRANT',
  'MIGRATION',
] as const
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number]

/**
 * Sources an administrator may select by hand today.
 *
 * The others exist in the schema so the model never has to be reshaped, but
 * they are issued by systems that do not exist yet — XPA-9 payments, XPA-7
 * corporate licences, XPA-6C evaluations — and MIGRATION describes history
 * rather than a decision. Offering them in a form would invite a human to
 * assert a purchase that never happened.
 */
export const ADMIN_SELECTABLE_SOURCES: readonly EntitlementSource[] = [
  'MANUAL_ADMIN',
  'PROMOTIONAL_GRANT',
  // XPA-6C. The comment above says these sources wait for "systems that do not
  // exist yet — XPA-9 payments, XPA-7 corporate licences, XPA-6C evaluations".
  // XPA-6C is that system: an administrator issuing a time-limited trial to a
  // prospective corporate customer IS the mechanism, and there is nothing else
  // for the assertion to be dishonest about. Its expiry is mandatory in three
  // places — this module's EXPIRY_RULES, `validateExpiry`, and the schema CHECK
  // `entitlements_expiry_required` — so a perpetual "evaluation" cannot exist.
  //
  // INDIVIDUAL_PURCHASE and MIGRATION stay out for the original reason — a
  // human must not record a payment no gateway produced, or a history no
  // migration performed.
  'BUSINESS_EVALUATION',
  // XPA-7. The corporate licence is now assertable, and by a PLATFORM admin
  // only (D7-3). An organization administrator manages a roster; they do not
  // mint commercial rights, and `grantEntitlement` stays behind
  // `requirePlatformAdmin()` rather than gaining an org-scoped bypass.
  //
  // Like BUSINESS_EVALUATION its expiry is mandatory in three layers, so a
  // perpetual "licence" cannot exist either. What distinguishes the two is
  // provenance, not mechanics: an evaluation is a trial, a licence is a signed
  // agreement, and `organization_id` records which company it belongs to.
  'CORPORATE_LICENSE',
]

// ── Lifecycle (Q-M, ratified) ───────────────────────────────────────────────
//
// COMPLETED is deliberately absent. Completion is academic and belongs to the
// enrollment: an entitlement that expired the day after a learner finished is
// still EXPIRED, and their completion still stands.

export const ENTITLEMENT_STATUSES = [
  'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'CANCELLED',
] as const
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number]

/** States from which no further transition is offered. */
export const TERMINAL_STATUSES: readonly EntitlementStatus[] = ['REVOKED', 'EXPIRED', 'CANCELLED']

/** States that occupy the one-live-entitlement-per-course slot. */
export const LIVE_STATUSES: readonly EntitlementStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED']

// ── Expiry policy (Q-M) ─────────────────────────────────────────────────────

export type ExpiryRule = 'required' | 'optional' | 'explicit_choice' | 'preserve_original'

export const EXPIRY_RULES: Record<EntitlementSource, ExpiryRule> = {
  INDIVIDUAL_PURCHASE: 'optional',           // non-expiring by default
  MANUAL_ADMIN:        'optional',           // non-expiring unless explicitly limited
  BUSINESS_EVALUATION: 'required',           // an evaluation without an end is not an evaluation
  CORPORATE_LICENSE:   'required',           // per contract
  PROMOTIONAL_GRANT:   'explicit_choice',    // the admin must decide, not default
  MIGRATION:           'preserve_original',  // documented original basis
}

/**
 * Validate an expiry choice against the ratified rule for its source.
 *
 * `explicit_choice` is the interesting one: the database cannot tell "the admin
 * chose perpetual" from "the admin never looked at the field", so the
 * distinction has to be carried as an explicit intent flag from the form. Only
 * `required` can be enforced by a CHECK constraint, and it is (migration 037).
 */
export function validateExpiry(
  source: EntitlementSource,
  expiresAt: Date | null,
  expiryDecisionMade: boolean,
): { ok: true } | { ok: false; error: string } {
  const rule = EXPIRY_RULES[source]

  if (rule === 'required' && !expiresAt) {
    return { ok: false, error: `Une date d'expiration est obligatoire pour la source ${source}.` }
  }
  if (rule === 'explicit_choice' && !expiryDecisionMade) {
    return {
      ok: false,
      error: "Pour un accès promotionnel, choisissez explicitement une date d'expiration ou « sans expiration ».",
    }
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "La date d'expiration doit être dans le futur." }
  }
  return { ok: true }
}

// ── The access predicate ────────────────────────────────────────────────────

export interface EntitlementLike {
  status:      EntitlementStatus | string
  starts_at:   string | null
  expires_at:  string | null
  revoked_at:  string | null
}

/**
 * Mirror of the SQL `public.entitlement_accessible(...)` (migration 037).
 *
 * The database answer is the one that counts — this exists so the UI can say
 * *why* rather than render a working page with no content in it. If the two ever
 * disagree, SQL wins and this is the bug.
 *
 * `now` is injectable so tests can pin the boundary rather than race it.
 */
export function isEntitlementAccessible(e: EntitlementLike, now: Date = new Date()): boolean {
  if (e.status !== 'ACTIVE') return false
  if (e.revoked_at) return false
  if (e.starts_at && new Date(e.starts_at).getTime() > now.getTime()) return false
  if (e.expires_at && new Date(e.expires_at).getTime() <= now.getTime()) return false
  return true
}

/** Why an entitlement is not currently granting access. Null when it is. */
export function inaccessibleReason(
  e: EntitlementLike,
  now: Date = new Date(),
): 'not_started' | 'expired' | 'revoked' | 'suspended' | 'pending' | 'cancelled' | null {
  if (isEntitlementAccessible(e, now)) return null
  if (e.revoked_at || e.status === 'REVOKED') return 'revoked'
  if (e.status === 'SUSPENDED') return 'suspended'
  if (e.status === 'CANCELLED') return 'cancelled'
  if (e.status === 'PENDING') return 'pending'
  if (e.expires_at && new Date(e.expires_at).getTime() <= now.getTime()) return 'expired'
  if (e.starts_at && new Date(e.starts_at).getTime() > now.getTime()) return 'not_started'
  return 'expired'
}

// ── Display ─────────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<EntitlementStatus, string> = {
  PENDING:   'En attente',
  ACTIVE:    'Actif',
  SUSPENDED: 'Suspendu',
  REVOKED:   'Révoqué',
  EXPIRED:   'Expiré',
  CANCELLED: 'Annulé',
}

export const SOURCE_LABELS: Record<EntitlementSource, string> = {
  MANUAL_ADMIN:        'Activation manuelle',
  INDIVIDUAL_PURCHASE: 'Achat individuel',
  CORPORATE_LICENSE:   'Licence entreprise',
  BUSINESS_EVALUATION: 'Évaluation entreprise',
  PROMOTIONAL_GRANT:   'Accès promotionnel',
  MIGRATION:           'Reprise historique',
}

export const LEARNER_REASON_LABELS: Record<NonNullable<ReturnType<typeof inaccessibleReason>>, string> = {
  not_started: "L'accès n'a pas encore commencé.",
  expired:     'Votre accès à cette formation a expiré.',
  revoked:     'Votre accès à cette formation a été retiré.',
  suspended:   'Votre accès à cette formation est suspendu.',
  pending:     "Votre accès est en attente d'activation.",
  cancelled:   'Cet accès a été annulé.',
}
