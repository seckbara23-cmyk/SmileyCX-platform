/**
 * Course-access contract (XPA-6A).
 *
 * The TypeScript half of the seam whose authoritative half is the SQL function
 * `public.has_course_access(uuid)` (migration 035). Both answer the same
 * question, and the database answer is the one that counts — this module exists
 * so that server components can render an honest page instead of a working page
 * full of empty data.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 * This is NOT the enforcement point. RLS is. If this module were deleted, a
 * learner without an enrollment would still read zero lesson rows. Every check
 * here is about telling the user the truth, not about keeping them out.
 *
 * ── XPA-6B ────────────────────────────────────────────────────────────────
 * Entitlements plug in by extending `has_course_access()` in SQL and adding one
 * arm to `resolveCourseAccess()` below. No page, layout or policy changes.
 *
 * Ratified model (decision 4): Account != Payment != Enrollment != Access.
 * Each is a separate fact, and only the last one opens content.
 */

import { createClient } from '@/lib/supabase/server'

/** Why access was refused. Drives which honest message the learner sees. */
export type CourseAccessDenial =
  | 'not_authenticated'
  | 'email_unverified'
  | 'account_inactive'
  | 'not_entitled'
  | 'access_ended'
  | 'course_not_found'

export interface CourseAccess {
  allowed:   boolean
  reason?:   CourseAccessDenial
  courseId?: string
  /** Present when the caller is signed in. */
  userId?:   string
}

/**
 * Resolve whether the current caller may read a course's learning material.
 *
 * Mirrors `public.has_course_access()` exactly. The order of the checks is
 * chosen so the learner gets the most actionable message: "confirm your email"
 * is more useful than "you are not enrolled" when both are true.
 */
export async function resolveCourseAccess(courseSlug: string): Promise<CourseAccess> {
  const supabase = await createClient()

  const { data: course } = await supabase
    .from('courses')
    .select('id')
    .eq('slug', courseSlug)
    .maybeSingle()

  if (!course) return { allowed: false, reason: 'course_not_found' }
  return resolveCourseAccessById(course.id as string)
}

/**
 * Same contract, keyed by course id.
 *
 * Exists because server actions reach a course through whatever they already
 * hold — a scenario, a quiz, a lesson — and re-deriving a slug just to look the
 * id back up would be a round trip that can disagree with itself.
 */
export async function resolveCourseAccessById(courseId: string): Promise<CourseAccess> {
  const supabase = await createClient()

  if (!courseId) return { allowed: false, reason: 'course_not_found' }

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { allowed: false, reason: 'not_authenticated', courseId }

  // email_confirmed_at is read from the verified session, not from a column the
  // application maintains — auth.users is the only authority for it.
  if (!user.email_confirmed_at) {
    return { allowed: false, reason: 'email_unverified', courseId, userId: user.id }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('platform_role, account_status')
    .eq('id', user.id)
    .maybeSingle()

  // Platform admins reach all material — the same arm the SQL function has, and
  // the reason content administration keeps working after the lockdown.
  if (profile?.platform_role === 'super_admin') {
    return { allowed: true, courseId, userId: user.id }
  }

  if (profile && profile.account_status !== 'active') {
    return { allowed: false, reason: 'account_inactive', courseId, userId: user.id }
  }

  // ── XPA-6B: ENTITLEMENTS, via the learner-safe view ───────────────────
  //
  // Two things changed here and both are deliberate.
  //
  // 1. Q-L: an enrollment is an academic transcript and must not authorize
  //    access on its own. The SQL seam dropped its enrollments arm in migration
  //    037; this mirror drops it in the same commit, so the two cannot drift
  //    into disagreeing about who may read a course.
  //
  // 2. This reads `my_course_access`, NOT `entitlements`. The base table holds
  //    provenance, timing and revocation detail and is revoked from every app
  //    role — a learner session querying it gets 42501, by design. The view
  //    answers only "may I open this, and did an access of mine end?".
  const { data } = await supabase
    .from('my_course_access')
    .select('has_access, access_ended')
    .eq('course_id', courseId)
    .maybeSingle()

  if (!data?.has_access) {
    // The distinction the learner needs is "you never had this" versus "yours
    // ended" — the first is a purchase decision, the second is a support
    // conversation. WHY it ended (expired, revoked, suspended) is deliberately
    // not available here: it is commercial data and the view does not carry it.
    return {
      allowed: false,
      reason:  data?.access_ended ? 'access_ended' : 'not_entitled',
      courseId,
      userId:  user.id,
    }
  }

  return { allowed: true, courseId, userId: user.id }
}

/** Learner-facing copy for a denial. Honest about the reason, never about internals. */
export function denialMessage(reason: CourseAccessDenial): { title: string; body: string } {
  switch (reason) {
    case 'not_authenticated':
      return {
        title: 'Connexion requise',
        body:  'Connectez-vous pour accéder au contenu de cette formation.',
      }
    case 'email_unverified':
      return {
        title: 'Confirmez votre adresse email',
        body:  'Votre compte existe, mais votre adresse email n’a pas encore été confirmée. Consultez votre boîte de réception pour finaliser votre inscription.',
      }
    case 'account_inactive':
      return {
        title: 'Compte suspendu',
        body:  'Votre compte n’est pas actif. Contactez-nous pour rétablir votre accès.',
      }
    case 'course_not_found':
      return {
        title: 'Formation introuvable',
        body:  'Cette formation n’existe pas ou n’est plus disponible.',
      }
    case 'access_ended':
      return {
        title: 'Votre accès n’est plus actif',
        body:  'Votre accès à cette formation n’est plus actif. Votre progression, vos résultats et vos certificats sont conservés — contactez-nous pour rétablir votre accès.',
      }
    case 'not_entitled':
    default:
      return {
        title: 'Vous n’avez pas accès à cette formation',
        body:  'La création d’un compte ne donne pas accès aux formations. Un accès doit être activé pour votre compte.',
      }
  }
}
