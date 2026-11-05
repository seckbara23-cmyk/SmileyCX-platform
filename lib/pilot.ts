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

/**
 * AUTH-02 — the fallback is now AUDIBLE as well as safe.
 *
 * The resolution above is deliberately unchanged: production still degrades
 * toward lockdown, because every other flag in this codebase fails closed and
 * this one must too. What was wrong was not the direction, it was the SILENCE.
 * A missing or misspelled variable produced the most restrictive mode with no
 * signal anywhere, and the symptom an operator actually saw was "students
 * cannot register" — several layers away from the cause.
 *
 * So the degradation is reported. It does NOT change the resolved value, and
 * it is not a gate: registration stays reachable in every mode via middleware's
 * narrow `/signup` exemption, which is the actual fix. This exists so that a
 * configuration mistake is diagnosable in one step instead of several.
 *
 * `null` when the variable was read correctly.
 */
export const PLATFORM_MODE_DIAGNOSTIC: string | null =
  (VALID_MODES as readonly string[]).includes(RAW)
    ? null
    : RAW.length === 0
      ? `NEXT_PUBLIC_PLATFORM_MODE is not set, so PLATFORM_MODE resolved to '${FALLBACK_MODE}'. `
        + `Set it explicitly to one of: ${VALID_MODES.join(', ')}.`
      : `NEXT_PUBLIC_PLATFORM_MODE is set to an unrecognised value (${RAW.length} characters), `
        + `so PLATFORM_MODE resolved to '${FALLBACK_MODE}'. `
        + `It must be exactly one of: ${VALID_MODES.join(', ')}.`

// Emitted once, server-side only. This module may be imported by client components, and a browser console is neither the right audience nor a
// place to describe deployment configuration. The message names the variable
// and reports the VALUE'S LENGTH, never the value — a misconfigured variable
// could contain anything, including something pasted there by mistake.
if (PLATFORM_MODE_DIAGNOSTIC !== null && typeof window === 'undefined') {
  console.warn(`[PLATFORM_MODE] ${PLATFORM_MODE_DIAGNOSTIC}`)
}

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

/*
 * PAYMENTS_ENABLED — RETIRED by XP-PAYTECH-04.
 *
 * It was `NEXT_PUBLIC_PAYMENTS_ENABLED === 'true'`: a BROWSER-VISIBLE, build-time
 * variable deciding whether money could be taken, and when true it rendered a
 * card-number/CVV form. Whether a deployment may take a payment is now decided
 * on the server by `paytechCheckoutAvailability()` (lib/payments/providers.ts),
 * from server-only variables. The export is gone so nothing can consult it
 * again; the deploy gate warns if the variable is still set.
 */
