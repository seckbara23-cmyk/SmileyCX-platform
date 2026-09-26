import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Cookie-less anonymous client.
 *
 * Discovery data is identical for every visitor — the `public_*` views are the
 * projection, and they take no account of who is asking. Binding these reads to
 * the request's cookies would therefore buy nothing, and it actively breaks
 * build-time consumers: `sitemap.ts` and `generateStaticParams` run outside any
 * request, where `cookies()` throws.
 *
 * Using the ANON key (not service-role) keeps the security posture intact: the
 * registry tables are revoked from `anon` in migration 031, so this client can
 * read the views and nothing else.
 */
function publicClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  )
}

/**
 * Public discovery reads (XPA-3).
 *
 * ── Security boundary ────────────────────────────────────────────────────
 * Everything here goes through the cookie-less ANON client above and reads ONLY
 * the `public_*` views created in migration 031. It never uses the service-role
 * client, and it never touches `catalogues`, `course_codes`, `learning_paths`
 * or `learning_path_courses` directly — those remain administrator-only.
 *
 * The views already exclude unproduced codes, unreleased titles, status
 * (backlog/undecided/retired), internal notes and any count of unavailable
 * courses. This module adds no way to ask for them: there is no parameter that
 * widens a result set, and no function returns a total.
 *
 * Course *content* is read from `courses`, whose RLS restricts anonymous
 * callers to published rows. Paths therefore reference courses; they never
 * carry copied pedagogical content.
 */

export interface PublicCatalogue {
  code: string
  title: string
  position: number
}

export interface PublicPath {
  code: string
  kind: 'professional' | 'sector'
  title: string
  objective: string | null
  position: number
}

/** Course fields safe to render on a discovery surface. */
export interface PublicCourse {
  id: string
  code: string | null
  slug: string
  title: string
  description: string | null
  level: string
  duration_hours: number | null
  cover_url: string | null
  is_socle?: boolean
}

/** Catalogues that have at least one published course. */
export async function getPublicCatalogues(): Promise<PublicCatalogue[]> {
  const supabase = publicClient()
  const { data } = await supabase
    .from('public_catalogues')
    .select('code, title, position')
    .order('position')
  return (data ?? []) as PublicCatalogue[]
}

/** Paths of one kind that have at least one published course. */
export async function getPublicPaths(kind: PublicPath['kind']): Promise<PublicPath[]> {
  const supabase = publicClient()
  const { data } = await supabase
    .from('public_learning_paths')
    .select('code, kind, title, objective, position')
    .eq('kind', kind)
    .order('position')
  return (data ?? []) as PublicPath[]
}

/** One path, or null when it has no published course (or does not exist). */
export async function getPublicPath(code: string): Promise<PublicPath | null> {
  const supabase = publicClient()
  const { data } = await supabase
    .from('public_learning_paths')
    .select('code, kind, title, objective, position')
    .eq('code', code.toUpperCase())
    .maybeSingle()
  return (data as PublicPath | null) ?? null
}

/**
 * Published courses of a path, in public order.
 *
 * Two reads by design: the view supplies the *membership* (code, order, socle),
 * `courses` supplies the *content*. Course rows are filtered by RLS to
 * published only, so an unpublished course cannot render even if the view were
 * somehow wrong — defence in depth rather than a single point of failure.
 */
export async function getPublicPathCourses(pathCode: string): Promise<PublicCourse[]> {
  const supabase = publicClient()

  const { data: links } = await supabase
    .from('public_path_courses')
    .select('course_code, position, is_socle')
    .eq('path_code', pathCode.toUpperCase())
    .order('position')

  const rows = (links ?? []) as { course_code: string; position: number; is_socle: boolean }[]
  if (rows.length === 0) return []

  const { data: courses } = await supabase
    .from('courses')
    .select('id, code, slug, title, description, level, duration_hours, cover_url')
    .in('code', rows.map(r => r.course_code))
    .eq('is_published', true)

  const byCode = new Map((courses ?? []).map(c => [c.code as string, c]))

  // Preserve the view's ordering, and silently drop anything the courses query
  // did not return. A missing row means "not publicly visible" — never a
  // placeholder, and never a gap the visitor could count.
  return rows
    .map(r => {
      const c = byCode.get(r.course_code)
      return c ? ({ ...c, is_socle: r.is_socle } as PublicCourse) : null
    })
    .filter((c): c is PublicCourse => c !== null)
}

/**
 * Published courses grouped by catalogue, in LEARNER DISPLAY ORDER.
 *
 * ── CAT-ARCH-01: why two reads instead of one ─────────────────────────────
 *
 * This used to select courses and `.order('code')`, which made the academic
 * identity double as the display position. V8 separates them: the code is
 * permanent (C1-F1 is always C1-F1) while the order a learner sees is editable
 * — Fondations is to open on C1-F4, not on C1-F1.
 *
 * The order lives in `course_codes.position`, and that table is deliberately
 * closed to `anon` (D-Q5: publishing the registry would publish the roadmap —
 * every unproduced code and the whole path composition). So the order arrives
 * through `public_catalogue_courses` (056): published courses only, positions
 * re-ranked 1..N so a gap cannot betray an unproduced code.
 *
 * Same two-read shape as `getPublicPathCourses` above, for the same reason:
 * the view supplies the RELATIONSHIP and the order, `courses` supplies the
 * content and applies its own RLS. A course the view lists but RLS withholds
 * is silently dropped rather than rendered as a hole.
 */
export async function getPublishedCoursesByCatalogue(): Promise<Map<string, PublicCourse[]>> {
  const supabase = publicClient()

  const { data: links } = await supabase
    .from('public_catalogue_courses')
    .select('catalogue_code, course_code, position')
    .order('catalogue_code')
    .order('position')

  const rows = (links ?? []) as { catalogue_code: string; course_code: string; position: number }[]
  if (rows.length === 0) return new Map()

  const { data: courses } = await supabase
    .from('courses')
    .select('id, code, slug, title, description, level, duration_hours, cover_url')
    .in('code', rows.map(r => r.course_code))
    .eq('is_published', true)

  const byCode = new Map(((courses ?? []) as PublicCourse[]).map(c => [c.code as string, c]))

  const grouped = new Map<string, PublicCourse[]>()
  for (const r of rows) {
    const course = byCode.get(r.course_code)
    if (!course) continue
    const arr = grouped.get(r.catalogue_code) ?? []
    arr.push(course)
    grouped.set(r.catalogue_code, arr)
  }
  return grouped
}

/**
 * Paths that publicly feature a given course — for the "ce cours fait partie
 * des parcours…" section on the canonical course page (V4 §8).
 * Only paths that are themselves publicly visible are returned.
 */
export async function getPublicPathsForCourse(courseCode: string | null): Promise<PublicPath[]> {
  if (!courseCode) return []
  const supabase = publicClient()

  const { data: links } = await supabase
    .from('public_path_courses')
    .select('path_code')
    .eq('course_code', courseCode)

  const codes = Array.from(
    new Set(((links ?? []) as { path_code: string }[]).map(l => l.path_code))
  )
  if (codes.length === 0) return []

  const { data: paths } = await supabase
    .from('public_learning_paths')
    .select('code, kind, title, objective, position')
    .in('code', codes)
    .order('kind')
    .order('position')

  return (paths ?? []) as PublicPath[]
}

/** Route segment for a path, by kind. */
export function pathHref(p: Pick<PublicPath, 'code' | 'kind'>): string {
  return `${p.kind === 'sector' ? '/secteurs' : '/parcours'}/${p.code.toLowerCase()}`
}
