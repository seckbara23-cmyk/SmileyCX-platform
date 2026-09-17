/**
 * Media identity and delivery addresses (XPA-8 W3 / F-2) — pure and isomorphic.
 *
 * Deliberately separate from `lib/media/storage.ts`: that module is
 * `server-only` because it mints signed URLs with the service-role key, and
 * the learn player is a client component that needs to know WHERE to ask for a
 * video without being able to sign anything itself.
 *
 * Everything here is safe in a browser bundle. It contains no key, no signing,
 * and no access decision — only "what is this asset" and "which URL does the
 * application serve it from".
 */

/** Learner-protected media. Private: no public route, no SELECT policy. */
export const PROTECTED_BUCKET = 'course-content'

/** Public marketing media — course thumbnails on the anonymous catalogue. */
export const PUBLIC_BUCKET = 'course-media'

/** Learner certificates. Private; one folder per user id. */
export const CERTIFICATE_BUCKET = 'certificates'

/** Upload folders holding learner-protected content. */
export const PROTECTED_FOLDERS = ['video', 'pdf', 'subtitle'] as const
/** Upload folders that are genuinely public. */
export const PUBLIC_FOLDERS = ['cover'] as const

export type MediaKind = (typeof PROTECTED_FOLDERS)[number]

/**
 * Parse one of our own public Storage URLs back into an object path.
 *
 * The mirror of migration 042's regex, exercised by the same test, so the SQL
 * backfill and the TypeScript cannot drift about what a path is. Returns null
 * for anything not ours — an external embed is not a parse failure, it is
 * somebody else's URL.
 */
export function objectPathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/course-media\/(.+)$/.exec(url)
  if (!m) return null
  try {
    return decodeURI(m[1])
  } catch {
    return m[1]
  }
}

/**
 * Which value should actually be used to serve a lesson asset.
 *
 * Precedence lives here and nowhere else:
 *   1. an object path  → we host it privately; deliver through the media route
 *   2. an absolute URL → somebody else hosts it; hand it over untouched
 *   3. nothing
 *
 * The intermediate state matters: between deploying this code and running the
 * 042 backfill every path is NULL and every lesson falls through to its
 * existing URL. That window is intentional — it is what makes the code safe to
 * ship before the objects have moved.
 */
export function resolveAssetSource(
  objectPath: string | null | undefined,
  legacyUrl: string | null | undefined,
): { kind: 'protected'; path: string } | { kind: 'external'; url: string } | null {
  if (objectPath) return { kind: 'protected', path: objectPath }
  if (legacyUrl) return { kind: 'external', url: legacyUrl }
  return null
}

/**
 * What the BROWSER is told about a lesson asset (XPA-8 WC-2, migration 054).
 *
 * The database derives this from the raw columns and hands out the kind of
 * asset, never its location:
 *
 *   'protected'  we host it privately — ask /api/media/lesson/<id>/<kind>,
 *                which re-checks the entitlement and signs server-side
 *   'external'   somebody else hosts it — the URL is in `<kind>_external_url`
 *   null         no playable asset
 *
 * `<kind>_external_url` is non-null ONLY for 'external', and the database
 * refuses to put an internal Storage location in it.
 */
export type LessonMediaSource = 'protected' | 'external' | null

/** The application URL that delivers a lesson asset. Never a Storage URL. */
export function lessonMediaHref(lessonId: string, kind: MediaKind): string {
  return `/api/media/lesson/${lessonId}/${kind}`
}

/**
 * The src a player should use, from the DERIVED fields alone.
 *
 * This is the browser-facing half of `lessonAssetSrc()` below, and the reason
 * the learn player no longer needs `*_object_path` or the legacy `*_url`:
 * migration 055 withdraws SELECT on those six columns from `anon` and
 * `authenticated`, and nothing here asks for them.
 *
 * A protected asset resolves to the application route WITHOUT the object path
 * ever reaching the browser — the path stays server-side, in the route that
 * signs it. An external URL is handed over untouched. Anything else is no
 * asset, which is the same fail-closed answer the database gives for a value
 * it could not classify.
 */
export function lessonAssetSrcFromSource(
  lessonId: string,
  kind: MediaKind,
  source: LessonMediaSource | string | null | undefined,
  externalUrl: string | null | undefined,
): string | null {
  if (source === 'protected') return lessonMediaHref(lessonId, kind)
  if (source === 'external') return externalUrl || null
  return null
}

/** The application URL that delivers a certificate PDF. Never a Storage URL. */
export function certificateMediaHref(certificateId: string): string {
  return `/api/media/certificate/${certificateId}`
}

/**
 * The src for a lesson asset, from the RAW columns.
 *
 * TRUSTED CALLERS ONLY — server code holding the raw columns, and the
 * reference the 054 classification restates in SQL. Browser code uses
 * `lessonAssetSrcFromSource()` instead: after migration 055 the raw columns
 * are not readable by `anon` or `authenticated` at all.
 */
export function lessonAssetSrc(
  lessonId: string,
  kind: MediaKind,
  objectPath: string | null | undefined,
  legacyUrl: string | null | undefined,
): string | null {
  const src = resolveAssetSource(objectPath, legacyUrl)
  if (!src) return null
  return src.kind === 'protected' ? lessonMediaHref(lessonId, kind) : src.url
}
