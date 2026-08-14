import type { Metadata } from 'next'
import CoursesView from './CoursesView'
import { levelLabel, type CourseItem, type ParcoursId } from './content'
import { getPublishedCoursesByCatalogue } from '@/lib/queries/catalogue'

export const metadata: Metadata = {
  title: 'Nos formations — XP Client Academy',
  description:
    'Formations certifiantes en expérience client, du niveau Fondations au niveau Avancé. Contenus pratiques adaptés au contexte africain.',
  alternates: { canonical: '/courses' },
}

/**
 * ── XPA-8 B-2B: PUBLICATION MUST ACTUALLY TAKE EFFECT ──────────────────────
 *
 * This page had no revalidation, so Next prerendered it at build time and
 * served that HTML until the next deployment. Measured during B-2B: after
 * C2-F2 was unpublished, `/courses/mesurer-l-experience-client` correctly
 * began returning 404 — while `/courses` kept shipping the course in its
 * serialized payload as `"available": true`. The catalogue was advertising a
 * course that 404s on click, and would have gone on doing so until somebody
 * happened to redeploy.
 *
 * Unpublishing is the platform's only withdrawal mechanism. A withdrawal that
 * depends on remembering to redeploy is not a mechanism. Sixty seconds bounds
 * the staleness while keeping the page cacheable; the course DETAIL route is
 * already dynamic and refuses immediately, so the exposure during that window
 * is a stale card, never stale content.
 */
export const revalidate = 60

/**
 * Public course catalogue (XPA-3).
 *
 * Browsing is now driven by the CATALOGUE structure seeded in XPA-2, replacing
 * the pilot-era grouping — a hardcoded list in `content.ts` matched to database
 * rows by token heuristics, then padded with "coming soon" placeholder cards so
 * that each tier always displayed three.
 *
 * That padding is removed. Per management decision Q-E the public site shows
 * ONLY published courses that exist: no placeholder cards, no planned totals,
 * no unavailable counts, no unreleased titles. A tier with nothing published
 * renders empty rather than advertising what is being built.
 *
 * Grouping uses `courses.code` (the immutable academic identity), so a course
 * lands in its catalogue by fact rather than by title matching. Data is read
 * through the anon-scoped client, so RLS (`is_published = true`) is the
 * boundary. The internal registry tables are never queried here.
 */

/** Catalogue code → the existing three-tier UI grouping. */
const CATALOGUE_TO_PARCOURS: Record<string, ParcoursId> = {
  C1: 'debutant',
  C2: 'intermediaire',
  C3: 'avance',
}

export default async function CoursesPage() {
  const byCatalogue = await getPublishedCoursesByCatalogue()

  const courses: CourseItem[] = []
  for (const [catalogueCode, list] of Array.from(byCatalogue.entries())) {
    const parcours = CATALOGUE_TO_PARCOURS[catalogueCode]
    if (!parcours) continue   // unknown catalogue: omit rather than guess

    for (const c of list) {
      courses.push({
        slug:      c.slug,
        title:     c.title,
        desc:      c.description ?? '',
        duration:  c.duration_hours != null ? `${c.duration_hours}h` : '',
        level:     levelLabel(c.level),
        image:     c.cover_url,
        // Only published courses reach this point, so everything shown is
        // genuinely available. There is no "unavailable" state on this page.
        available: true,
        parcours,
      })
    }
  }

  return <CoursesView courses={courses} />
}
