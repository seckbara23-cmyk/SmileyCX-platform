import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Protected media delivery — the server half (XPA-8 W3 / F-2).
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 *   knowing an object path or a historical URL is NOT authorization
 *
 * Before this module, `has_course_access()` governed the lesson ROW while
 * Storage served the FILE to anybody who asked. A learner with no entitlement —
 * and an anonymous visitor with no account — downloaded the same 15 MB video
 * the entitled learner paid for, and could enumerate all 149 of them first.
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────
 *
 *   private object  →  authorization check  →  short-lived delivery capability
 *
 * The authorization step is NOT reimplemented here. Course media asks
 * `resolveCourseAccessById()`, the same seam the learn page, the layout and
 * `has_course_access()` in SQL already use. Certificates ask about ownership.
 * This module only mints the capability once somebody else has said yes, so
 * there is no second access model to keep in sync.
 *
 * ── WHY `server-only` ─────────────────────────────────────────────────────
 *
 * Minting needs the service-role key, which must never be reachable from a
 * client component. This import fails the build if a browser bundle pulls it
 * in. The pure helpers a client legitimately needs — which URL to ask, how to
 * read a path — live in `lib/media/paths.ts` and carry no key.
 */

export {
  PROTECTED_BUCKET, PUBLIC_BUCKET, CERTIFICATE_BUCKET,
  PROTECTED_FOLDERS, PUBLIC_FOLDERS,
  objectPathFromPublicUrl, resolveAssetSource,
  lessonMediaHref, certificateMediaHref, lessonAssetSrc,
  type MediaKind,
} from '@/lib/media/paths'

import { PROTECTED_BUCKET } from '@/lib/media/paths'

/**
 * How long a minted delivery URL stays valid.
 *
 * ── HOW THESE NUMBERS WERE CHOSEN ─────────────────────────────────────────
 *
 * The delivery route 302-redirects to a freshly signed URL on EVERY request,
 * so a TTL only has to outlive the single fetch that follows the redirect —
 * not the viewing session. That is what makes short values safe, and it is why
 * revocation takes effect on the next request rather than up to an hour later.
 *
 * `video` is not 30 seconds because a browser issues Range requests while
 * seeking and buffering and each one must survive a slow connection. This
 * platform's learners are largely in Senegal on mobile networks, where a
 * multi-megabyte range can take minutes. 300s covers that comfortably while
 * keeping a leaked URL near-worthless.
 *
 * `pdf` and `certificate` are single downloads that start immediately, so they
 * get the shorter window.
 *
 * Verified against this project: a URL signed for 5s serves at t=0 and returns
 * 400 InvalidJWT at t=7s; the token is bound to one object path (another
 * object's token returns InvalidSignature), and altering the signature, the
 * `exp`, or the embedded url is rejected as InvalidJWT.
 */
export const SIGNED_URL_TTL_SECONDS = {
  video: 300,
  subtitle: 300,
  pdf: 120,
  certificate: 120,
} as const

/**
 * Mint a short-lived delivery URL for one object in a private bucket.
 *
 * Returns null rather than throwing: every caller has already decided the
 * requester is authorized, so a failure here is an infrastructure problem, and
 * a 404 is a better answer than a 500 naming a bucket.
 *
 * Refuses anything that looks like a URL. A path column holding a URL is the
 * exact confusion this work exists to end, and the database has a CHECK
 * constraint saying the same thing.
 */
export async function signObject(
  bucket: string,
  objectPath: string,
  ttlSeconds: number,
  /**
   * Filename to force as a download. Needed because the browser's `download`
   * attribute is ignored once a link redirects cross-origin, so without this a
   * certificate would open as `abc123.pdf` from a supabase.co host.
   */
  downloadAs?: string,
): Promise<string | null> {
  if (!objectPath || /^[a-z]+:\/\//i.test(objectPath)) return null

  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(objectPath, ttlSeconds, downloadAs ? { download: downloadAs } : undefined)

  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/** Convenience for the common case: a protected lesson asset. */
export function signProtected(objectPath: string, ttlSeconds: number) {
  return signObject(PROTECTED_BUCKET, objectPath, ttlSeconds)
}
