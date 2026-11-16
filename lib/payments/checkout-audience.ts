import 'server-only'
import type { EnvLike } from '@/lib/payments/paytech-config'

/**
 * Who may open a NEW PayTech checkout — XP-PAYTECH-P2.
 *
 * `PAYTECH_CHECKOUT_ENABLED` is a deployment-wide switch: once true, every
 * signed-in, verified learner could buy. The first real payments must be made by
 * a handful of named people only, so the switch is now paired with an AUDIENCE:
 *
 *   PAYTECH_CHECKOUT_AUDIENCE = 'pilot' | 'public'   (exact, no default)
 *   PAYTECH_PILOT_USER_IDS    = up to five user ids, comma-separated
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────────────────
 *
 *   audience absent, blank or any other word   -> nobody may buy
 *   pilot with an empty list                   -> nobody may buy
 *   a list that is malformed, duplicated or
 *   longer than five, whatever the audience    -> nobody may buy
 *   public with a list still set               -> nobody may buy (an operator
 *                                                 opening sales must clear the
 *                                                 pilot list, so the two states
 *                                                 can never be confused)
 *
 * The audience narrows; it never widens. Every existing condition —
 * `PAYTECH_CHECKOUT_ENABLED`, the credentials, the mode belonging to this
 * environment, `PAYTECH_ALLOW_PRODUCTION` in production — is still required,
 * and is checked first by `paytechCheckoutAvailability()`.
 *
 * ── WHOSE IDENTITY ────────────────────────────────────────────────────────
 *
 * Only the id of the authenticated session is compared. Nothing a browser sends
 * reaches this module. Being listed grants no course access: it only allows the
 * normal, fully checked checkout to proceed.
 *
 * Neither variable is NEXT_PUBLIC_: the list never reaches a bundle, and the
 * deploy gate refuses any NEXT_PUBLIC_ name containing PAYTECH.
 *
 * `scripts/security/verify-prod-config.mjs` applies the same rules at build
 * time; a parity test keeps the two in step.
 */

export const PAYTECH_CHECKOUT_AUDIENCES = ['pilot', 'public'] as const
export type PaytechCheckoutAudience = (typeof PAYTECH_CHECKOUT_AUDIENCES)[number]

/** The most pilot buyers a deployment may name. */
export const PAYTECH_PILOT_MAX_USERS = 5

export const AUDIENCE_ENV = 'PAYTECH_CHECKOUT_AUDIENCE'
export const PILOT_USERS_ENV = 'PAYTECH_PILOT_USER_IDS'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface CheckoutAudienceConfig {
  /** The audience, or null whenever the configuration is unusable. */
  readonly audience: PaytechCheckoutAudience | null
  /** Lower-cased pilot ids. Empty unless the audience is a usable 'pilot'. */
  readonly pilotUserIds: readonly string[]
  /** Why nobody may buy, or null. Names variables and counts, never an id. */
  readonly error: string | null
}

const closed = (error: string): CheckoutAudienceConfig =>
  Object.freeze({ audience: null, pilotUserIds: Object.freeze([]), error })

/** The pilot list, parsed strictly. Never throws. */
export function parsePilotUserIds(raw: string | undefined): { ids: string[]; error: string | null } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ids: [], error: null }
  const parts = raw.split(',').map(p => p.trim().toLowerCase())
  if (parts.some(p => p.length === 0)) {
    return { ids: [], error: `${PILOT_USERS_ENV} contains an empty entry.` }
  }
  const malformed = parts.filter(p => !UUID_RE.test(p)).length
  if (malformed > 0) {
    return { ids: [], error: `${PILOT_USERS_ENV} contains ${malformed} entr${malformed === 1 ? 'y' : 'ies'} that is not a user id.` }
  }
  if (new Set(parts).size !== parts.length) {
    return { ids: [], error: `${PILOT_USERS_ENV} lists the same user twice.` }
  }
  if (parts.length > PAYTECH_PILOT_MAX_USERS) {
    return { ids: [], error: `${PILOT_USERS_ENV} names ${parts.length} users; at most ${PAYTECH_PILOT_MAX_USERS} are allowed.` }
  }
  return { ids: parts, error: null }
}

/** The audience configuration of this deployment. Never throws. */
export function checkoutAudienceConfig(env: EnvLike = process.env): CheckoutAudienceConfig {
  const list = parsePilotUserIds(env[PILOT_USERS_ENV])
  if (list.error) return closed(list.error)

  const raw = env[AUDIENCE_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return closed(`${AUDIENCE_ENV} is not set. There is deliberately no default: set it to exactly 'pilot' or 'public'.`)
  }
  const audience = raw.trim()
  if (!(PAYTECH_CHECKOUT_AUDIENCES as readonly string[]).includes(audience)) {
    return closed(`${AUDIENCE_ENV} must be exactly 'pilot' or 'public' (${raw.length} characters, not an exact match).`)
  }

  if (audience === 'pilot' && list.ids.length === 0) {
    return closed(`${AUDIENCE_ENV}='pilot' but ${PILOT_USERS_ENV} names nobody.`)
  }
  if (audience === 'public' && list.ids.length > 0) {
    return closed(`${AUDIENCE_ENV}='public' while ${PILOT_USERS_ENV} is still set. Clear the pilot list to open sales.`)
  }

  return Object.freeze({
    audience: audience as PaytechCheckoutAudience,
    pilotUserIds: Object.freeze(audience === 'pilot' ? list.ids : []),
    error: null,
  })
}

/**
 * May THIS authenticated user open a checkout, as far as the audience goes?
 *
 * `userId` must come from the server session. Null (no session) is never a pilot
 * buyer. For 'public' a null user is answered true so pages can show the price
 * with a sign-in prompt; both actions require a session before anything else.
 */
export function audienceAdmits(config: CheckoutAudienceConfig, userId: string | null): boolean {
  if (config.error !== null || config.audience === null) return false
  if (config.audience === 'public') return true
  if (typeof userId !== 'string') return false
  return config.pilotUserIds.includes(userId.trim().toLowerCase())
}
