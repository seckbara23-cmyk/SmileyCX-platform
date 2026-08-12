/**
 * UAT-ROUTE-01 — canonical construction of learning routes.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ─────────────────────────────────────
 *
 * Production generated:
 *
 *   /learn/les-fondamentaux-de-l-experience-client/undefined/undefined
 *
 * `app/(public)/courses/[slug]/page.tsx` built its CTA as
 *
 *   `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
 *
 * `modules` is read with the LEARNER'S session, so RLS empties it for exactly
 * the people who lack an entitlement. Optional chaining then yields `undefined`,
 * and a template literal stringifies that to the seven characters "undefined".
 * The route was malformed for precisely the users who were about to be denied.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 *   No application-generated learning URL may contain `undefined`, `null`, or
 *   an empty segment. Where a concrete lesson is required, resolve one first;
 *   if none can be resolved, fail safely to a valid course-level destination
 *   rather than manufacturing a route.
 *
 * ── THIS IS NOT A NEW CONVENTION ──────────────────────────────────────────
 *
 * `app/(platform)/dashboard/page.tsx` and `app/(platform)/checkout/page.tsx`
 * already did exactly this — resolve a concrete lesson, else fall back to
 * `/courses/{slug}`. This module names that existing pattern so the one page
 * that did not follow it now can, without a broader navigation refactor.
 *
 * Route shape, for reference:
 *   /learn/[courseSlug]/[moduleId]/[lessonId]     lesson player
 *   /learn/[courseSlug]/[moduleId]/quiz           module quiz
 *   /learn/[courseSlug]/final-exam                final exam
 *
 * `[moduleId]` and `[lessonId]` accept an id OR a slug — the player resolves
 * either (`mod.id === moduleId || mod.slug === moduleId`). Both are valid
 * segments; neither may be absent.
 */

/** A course-level destination that always exists and is never gated. */
export const coursePageHref = (courseSlug: string): string => `/courses/${courseSlug}`

/**
 * Is this usable as a URL path segment?
 *
 * Rejects the empty string and, deliberately, the literal strings "undefined"
 * and "null" — those are what a template literal produces from the real values,
 * and they are the exact shape of the production defect. A caller that has
 * already stringified a missing value must not slip past this check.
 */
export function isRouteSegment(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  return v.length > 0 && v !== 'undefined' && v !== 'null'
}

/** Shape this module needs. Anything with these fields works — DB rows included. */
export interface LessonRef { id?: string | null; slug?: string | null }
export interface ModuleRef {
  id?: string | null
  slug?: string | null
  lessons?: LessonRef[] | null
}

/** Prefer a slug when present, fall back to the id, else nothing usable. */
function refSegment(ref: ModuleRef | LessonRef | null | undefined): string | null {
  if (!ref) return null
  if (isRouteSegment(ref.slug)) return ref.slug
  if (isRouteSegment(ref.id)) return ref.id
  return null
}

/**
 * A lesson URL, or null when any segment is missing.
 *
 * Returning null rather than a best-effort string is the point: the caller is
 * forced to decide what to do instead, and cannot accidentally render a broken
 * link.
 */
export function lessonHref(
  courseSlug: string,
  moduleRef: ModuleRef | string | null | undefined,
  lessonRef: LessonRef | string | null | undefined,
): string | null {
  if (!isRouteSegment(courseSlug)) return null
  const m = typeof moduleRef === 'string' ? (isRouteSegment(moduleRef) ? moduleRef : null) : refSegment(moduleRef)
  const l = typeof lessonRef === 'string' ? (isRouteSegment(lessonRef) ? lessonRef : null) : refSegment(lessonRef)
  if (!m || !l) return null
  return `/learn/${courseSlug}/${m}/${l}`
}

/** A module-quiz URL, or null when the module cannot be identified. */
export function moduleQuizHref(
  courseSlug: string,
  moduleRef: ModuleRef | string | null | undefined,
): string | null {
  if (!isRouteSegment(courseSlug)) return null
  const m = typeof moduleRef === 'string' ? (isRouteSegment(moduleRef) ? moduleRef : null) : refSegment(moduleRef)
  return m ? `/learn/${courseSlug}/${m}/quiz` : null
}

/** The final exam has no variable segment beyond the course. */
export function finalExamHref(courseSlug: string): string | null {
  return isRouteSegment(courseSlug) ? `/learn/${courseSlug}/final-exam` : null
}

/**
 * The first lesson of the first module that actually has one.
 *
 * Skips empty modules rather than assuming `modules[0]` is populated — a course
 * whose first module has no lessons is a content state, not an error.
 */
export function firstLessonHref(
  courseSlug: string,
  modules: ModuleRef[] | null | undefined,
): string | null {
  for (const mod of modules ?? []) {
    for (const lesson of mod?.lessons ?? []) {
      const href = lessonHref(courseSlug, mod, lesson)
      if (href) return href
    }
  }
  return null
}

/**
 * Where "start / continue learning" should point, guaranteed valid.
 *
 * Never returns null: when no lesson can be resolved — an unentitled learner
 * whose module read was emptied by RLS, or a course with no published lessons —
 * it degrades to the public course page. That page is the honest destination,
 * and the access gate on `/learn/*` would have bounced them there regardless.
 */
export function learnEntryHref(
  courseSlug: string,
  modules: ModuleRef[] | null | undefined,
  preferred?: string | null,
): string {
  if (isRouteSegment(preferred) && !preferred.includes('/undefined') && !preferred.includes('/null')) {
    return preferred
  }
  return firstLessonHref(courseSlug, modules) ?? coursePageHref(courseSlug)
}
