/**
 * Platform admission (XPA-8 W1).
 *
 * ── THE FOUR QUESTIONS, AND WHICH ONE THIS ANSWERS ────────────────────────
 *
 *   AUTHENTICATION   who is this user?                  Supabase session.
 *   ADMISSION        may this account use the app?      ← THIS MODULE
 *   ENTITLEMENT      which course may they open?        has_course_access().
 *   ENROLLMENT       what have they actually done?      Academic only.
 *   ORG MEMBERSHIP   which organization may they act in? Structural only.
 *
 * None of these may substitute for another. In particular an admitted account
 * is not an entitled one: admission gets you through the front door, and every
 * course still costs an entitlement.
 *
 * ── WHAT THIS REPLACED, AND WHY IT HAD TO GO ──────────────────────────────
 *
 * This module used to export a hardcoded list:
 *
 *     export const ALLOWED_PRIVATE_EMAILS = [
 *       'seckbara23@gmail.com',
 *       'mariemelly@gmail.com',
 *     ]
 *
 * Two things were wrong with it, and the second is the serious one.
 *
 * It was WRONG IN FACT. The real production account is `mariemeify@gmail.com`;
 * the list said `mariemelly@`. A third real account was absent entirely. So
 * enabling the ratified private mode would have locked out the learner holding
 * every entitlement on the platform.
 *
 * It was WRONG IN KIND. An email address is not an authorization. Onboarding a
 * learner would have meant editing source and redeploying — which is not an
 * onboarding model, it is a deployment. The allowlist was built as a pre-launch
 * SITE LOCKDOWN, for a period when nobody was supposed to see the platform at
 * all, and it was being asked to serve as an ADMISSION mechanism for a platform
 * that now has paying customers. Those are different jobs.
 *
 * ── THE SIGNAL THIS USES INSTEAD ──────────────────────────────────────────
 *
 * `profiles.account_status`, which already existed and already meant this:
 *
 *   - added by migration 035, `not null default 'active'`
 *   - CHECK (account_status in ('active','suspended','disabled'))
 *   - already consulted by `resolveCourseAccessById()` — a suspended learner
 *     was already refused course access
 *   - pinned by `profiles_update_own` WITH CHECK, so a learner cannot
 *     reactivate themselves
 *
 * No new table, no new boolean, no new source of truth. Admission is now a
 * property of the account, set by an administrator, and readable at runtime.
 */

import { PLATFORM_MODE } from '@/lib/pilot'

export const isPrivateMode = PLATFORM_MODE === 'private'

/** Why an account was refused the application. Drives the honest message. */
export type AdmissionDenial =
  | 'not_authenticated'
  | 'no_profile'
  | 'suspended'
  | 'disabled'

export interface AdmissionSubject {
  account_status?: string | null
  platform_role?: string | null
}

/**
 * May this account use the production application?
 *
 * Deliberately synchronous and dependency-free: the caller fetches the profile
 * with whatever client it already holds (middleware has the SSR client; server
 * components have their own), and this decides. Keeping the I/O out means the
 * rule itself is testable without a database.
 *
 * FAIL CLOSED. A missing profile is refused rather than waved through — an
 * authenticated user with no profile row is a provisioning failure, and the
 * XPA-6A registration path treats it the same way.
 */
export function resolveAdmission(
  profile: AdmissionSubject | null | undefined,
  isAuthenticated = true,
): { admitted: true } | { admitted: false; reason: AdmissionDenial } {
  if (!isAuthenticated) return { admitted: false, reason: 'not_authenticated' }
  if (!profile) return { admitted: false, reason: 'no_profile' }

  // Platform administrators are admitted on their role. This is admission, not
  // entitlement: it lets them reach /admin and operate the system. It grants no
  // course — `has_course_access()` decides that separately, and it has its own
  // admin arm for content administration.
  if (profile.platform_role === 'super_admin') return { admitted: true }

  const status = profile.account_status ?? 'active'
  if (status === 'suspended') return { admitted: false, reason: 'suspended' }
  if (status === 'disabled') return { admitted: false, reason: 'disabled' }
  if (status !== 'active') return { admitted: false, reason: 'disabled' }

  return { admitted: true }
}

/** Convenience predicate for callers that only need the boolean. */
export function isAdmitted(
  profile: AdmissionSubject | null | undefined,
  isAuthenticated = true,
): boolean {
  return resolveAdmission(profile, isAuthenticated).admitted
}

/** Learner-facing copy. Honest about the reason, never about internals. */
export const ADMISSION_DENIAL_LABELS: Record<AdmissionDenial, string> = {
  not_authenticated: 'Connectez-vous pour accéder à la plateforme.',
  no_profile:        "Votre compte n'est pas encore complètement provisionné. Contactez-nous.",
  suspended:         'Votre compte est suspendu. Contactez-nous pour le rétablir.',
  disabled:          "Votre compte n'est plus actif.",
}
