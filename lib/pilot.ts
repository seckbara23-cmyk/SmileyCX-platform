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
 * Defaults to 'private' when unset (safe closed default).
 */
export type PlatformMode = 'private' | 'pilot' | 'public'

const RAW = process.env.NEXT_PUBLIC_PLATFORM_MODE ?? ''
export const PLATFORM_MODE: PlatformMode =
  RAW === 'pilot' || RAW === 'public' ? (RAW as PlatformMode) : 'private'

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
