import { createClient } from '@/lib/supabase/server'
import type { Metadata } from 'next'
import CoursesView from './CoursesView'
import { STATIC_CATALOG, levelLabel, type CourseItem } from './content'

export const metadata: Metadata = {
  title: 'Nos formations — XP Client Academy',
  description:
    'Trois parcours structurés pour développer vos compétences en expérience client : du débutant au directeur CX. Formations certifiantes adaptées au contexte africain.',
}

function toCleanSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default async function CoursesPage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, slug, title, description, duration_hours, level, cover_url, modules(id)')
    .eq('is_published', true)
    .order('created_at', { ascending: true })

  // The DB is the source of truth for available courses: when it has published
  // rows, static "available" entries are dropped (they are fallbacks for an
  // empty catalog only). Static coming-soon entries always remain, and a DB row
  // matching one of them overrides it and marks it available.
  const hasDbCourses = (dbCourses?.length ?? 0) > 0
  const catalog: CourseItem[] = STATIC_CATALOG
    .filter(c => !hasDbCourses || !c.available)
    .map(c => ({ ...c }))

  for (const db of dbCourses ?? []) {
    if (typeof db.slug !== 'string' || db.slug.trim() === '') continue
    const slug = toCleanSlug(db.slug)
    const entry = catalog.find(c => c.slug === slug)
    if (entry) {
      entry.available = true
      entry.title     = db.title || entry.title
      entry.desc      = db.description ?? entry.desc
      entry.duration  = db.duration_hours ? `${db.duration_hours}h` : entry.duration
      entry.level     = levelLabel(db.level ?? entry.level)
      entry.image     = db.cover_url ?? entry.image
    } else {
      catalog.push({
        slug,
        title:     db.title,
        desc:      db.description ?? '',
        duration:  db.duration_hours ? `${db.duration_hours}h` : '',
        level:     levelLabel(db.level ?? 'beginner'),
        image:     db.cover_url ?? null,
        available: true,
        parcours:  'debutant',
      })
    }
  }

  return <CoursesView courses={catalog} />
}
