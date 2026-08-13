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

/** The application URL that delivers a lesson asset. Never a Storage URL. */
export function lessonMediaHref(lessonId: string, kind: MediaKind): string {
  return `/api/media/lesson/${lessonId}/${kind}`
}

/** The application URL that delivers a certificate PDF. Never a Storage URL. */
export function certificateMediaHref(certificateId: string): string {
  return `/api/media/certificate/${certificateId}`
}

/**
 * The src a player should use for a lesson asset.
 *
 * Protected assets resolve to an application route that re-authorizes on every
 * request; external ones pass through untouched.
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
