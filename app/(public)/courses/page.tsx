import { createClient } from '@/lib/supabase/server'
import type { Metadata } from 'next'
import CoursesView from './CoursesView'
import { STATIC_CATALOG, levelLabel, type CourseItem, type ParcoursId } from './content'

export const metadata: Metadata = {
  title: 'Nos formations — XP Client Academy',
  description:
    'Trois parcours structurés pour développer vos compétences en expérience client : du débutant au directeur CX. Formations certifiantes adaptées au contexte africain.',
}

const PARCOURS_IDS: ParcoursId[] = ['debutant', 'intermediaire', 'avance']

// Minimum cards shown per parcours: published DB courses first, padded with
// static coming-soon placeholders so the three-column grid stays balanced.
const MIN_CARDS_PER_PARCOURS = 3

function toCleanSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Filler words ignored when comparing course identities.
const STOP_WORDS = new Set([
  'les', 'le', 'la', 'de', 'du', 'des', 'l', 'd', 'et', 'un', 'une',
  'pour', 'vos', 'qui', 'en', 'a', 'au', 'aux',
])

function tokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0 && !STOP_WORDS.has(t))
}

/**
 * True when a static catalog entry refers to a course already on display.
 * Slugs can differ between the DB and the static catalog for the same course
 * (e.g. "les-fondamentaux-de-l-experience-client" vs
 * "fondamentaux-experience-client"), so beyond exact slug equality we treat
 * the static entry as a duplicate when all of its core tokens appear in the
 * displayed course's slug + title.
 */
function isSameCourse(displayed: CourseItem, candidate: CourseItem): boolean {
  if (displayed.slug && candidate.slug && displayed.slug === candidate.slug) return true
  const displayedTokens = new Set(tokens(`${displayed.slug ?? ''} ${displayed.title}`))
  const candidateTokens = tokens(candidate.slug ?? candidate.title)
  return candidateTokens.length > 0 && candidateTokens.every(t => displayedTokens.has(t))
}

export default async function CoursesPage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, slug, title, description, duration_hours, level, cover_url, modules(id)')
    .eq('is_published', true)
    .order('created_at', { ascending: true })

  // The DB is the single source of truth for available courses. Published rows
  // are enriched from the static catalog when their slug matches an entry.
  const published: CourseItem[] = (dbCourses ?? [])
    .filter(db => typeof db.slug === 'string' && db.slug.trim() !== '')
    .map(db => {
      const slug    = toCleanSlug(db.slug as string)
      const static_ = STATIC_CATALOG.find(c => c.slug === slug)
      return {
        slug,
        title:     db.title || static_?.title || '',
        desc:      db.description ?? static_?.desc ?? '',
        duration:  db.duration_hours ? `${db.duration_hours}h` : static_?.duration ?? '',
        level:     levelLabel(db.level ?? static_?.level ?? 'beginner'),
        image:     db.cover_url ?? static_?.image ?? null,
        available: true,
        parcours:  static_?.parcours ?? 'debutant',
      }
    })

  const hasDbCourses = published.length > 0

  // Build the visible list per parcours: published courses first; when fewer
  // than MIN_CARDS_PER_PARCOURS, pad with static placeholders (deduplicated)
  // until exactly three cards are visible. A parcours with three or more
  // published courses shows only those.
  const courses: CourseItem[] = []

  for (const id of PARCOURS_IDS) {
    const visible = published.filter(c => c.parcours === id)

    if (visible.length < MIN_CARDS_PER_PARCOURS) {
      const candidates = STATIC_CATALOG
        .filter(c => c.parcours === id && !visible.some(v => isSameCourse(v, c)))
        // With a live catalog, genuine coming-soon entries make the most honest
        // placeholders; with an empty DB (fallback mode) the static "available"
        // entries come first and keep their availability, preserving the
        // original static-catalog behavior.
        .sort((a, b) =>
          hasDbCourses
            ? Number(a.available) - Number(b.available)
            : Number(b.available) - Number(a.available)
        )

      for (const c of candidates) {
        if (visible.length >= MIN_CARDS_PER_PARCOURS) break
        visible.push(hasDbCourses ? { ...c, available: false } : { ...c })
      }
    }

    courses.push(...visible)
  }

  return <CoursesView courses={courses} />
}
