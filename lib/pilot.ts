/**
 * PLATFORM_MODE: Single source of truth for platform access level.
 *
 *  private — End-of-pilot lockdown. Signup disabled; all learning routes
 *            require auth; new enrollment paused; waitlist CTA shown to
 *            visitors. Existing enrolled users retain access.
 *  pilot   — Open pilot. Anonymous access to published content; no account
 *            required; free enrollment active.
 *  public  — Production. Auth + payments required; signup open.
 *
 * Set NEXT_PUBLIC_PLATFORM_MODE in .env.local.
 * Defaults to 'pilot' when unset (open pilot is current operating mode).
 */
export type PlatformMode = 'private' | 'pilot' | 'public'

/**
 * XPA-8 W1 — this resolution FAILS CLOSED in production.
 *
 * It used to read: anything that is not exactly 'private' or 'public' becomes
 * 'pilot'. So an environment that forgot the variable, or misspelled it, or had
 * it stripped by a deploy, silently ran the MOST PERMISSIVE mode — anonymous
 * content browsing and free self-enrollment — on production. Every other
 * security flag in this codebase fails closed: `SELF_ENROLLMENT_OPEN` requires
 * the literal 'true', `disable_signup` stays on, the admin allowlist denies on
 * absence. This one rewarded absence.
 *
 * Now an unrecognised value resolves by ENVIRONMENT rather than by convenience:
 *
 *   value      | any environment
 *   -----------|----------------------------------------------------------
 *   'private'  | private
 *   'pilot'    | pilot
 *   'public'   | public
 *   missing    | production -> 'private'   ·  otherwise -> 'pilot'
 *   invalid    | production -> 'private'   ·  otherwise -> 'pilot'
 *
 * Production therefore degrades toward lockdown, and local development keeps
 * the permissive default it needs to be useful. The non-production default is
 * an explicit decision, not an oversight — stated here so that changing it is
 * also a decision.
 *
 * Note this changes nothing where the variable IS set: production currently
 * sets 'pilot' explicitly and continues to get 'pilot'. Only absence and typos
 * behave differently, and only in the safe direction.
 */
const VALID_MODES: readonly PlatformMode[] = ['private', 'pilot', 'public']

const RAW = (process.env.NEXT_PUBLIC_PLATFORM_MODE ?? '').trim()

/** Where an unrecognised value lands. Exported so tests can assert the intent. */
export const FALLBACK_MODE: PlatformMode =
  process.env.NODE_ENV === 'production' ? 'private' : 'pilot'

export const PLATFORM_MODE: PlatformMode =
  (VALID_MODES as readonly string[]).includes(RAW) ? (RAW as PlatformMode) : FALLBACK_MODE

// ── Derived flags — kept for backward compatibility with existing imports ──

/**
 * PILOT_MODE: true when PLATFORM_MODE === 'pilot'.
 * When true, published course content is accessible without an account.
 */
export const PILOT_MODE = PLATFORM_MODE === 'pilot'

/**
 * FREE_ACCESS_MODE: true when PLATFORM_MODE === 'pilot'.
 * When true, authenticated users can enroll for free (no payment required).
 */
export const FREE_ACCESS_MODE = PLATFORM_MODE === 'pilot'

/**
 * PAYMENTS_ENABLED: true only when explicitly set via env override.
 * Set NEXT_PUBLIC_PAYMENTS_ENABLED=true after payment gateways are live.
 */
export const PAYMENTS_ENABLED =
  process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === 'true'
