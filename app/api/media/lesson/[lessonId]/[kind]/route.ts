import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import {
  PROTECTED_BUCKET, PROTECTED_FOLDERS, SIGNED_URL_TTL_SECONDS, signObject, type MediaKind,
} from '@/lib/media/storage'

/**
 * Protected lesson media delivery (XPA-8 W3 / F-2).
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────
 *
 * `<video src={lesson.video_url}>`, where video_url was a permanent public
 * Storage URL. RLS hid the lesson row from callers without access and Storage
 * served the file to them anyway.
 *
 * ── WHY A REDIRECT PER REQUEST, NOT A LONG SIGNED URL ─────────────────────
 *
 * The obvious alternative — hand the page one signed URL valid for an hour —
 * has a property nobody wants: a learner whose entitlement is revoked keeps
 * watching until the URL expires. Here every request, including each Range
 * request a player makes while seeking, re-enters this handler and is
 * re-authorized against the live entitlement. Revocation lands on the next
 * request instead of up to an hour later, and the capability it hands out is
 * measured in minutes.
 *
 * Streaming the bytes through this route instead was rejected: it would put
 * 15 MB videos through a serverless function, and it would hide the URL from
 * devtools without hiding it from the person reading devtools.
 *
 * ── WHY THE LOOKUP USES THE SERVICE ROLE ──────────────────────────────────
 *
 * The lesson row is read with the admin client, then authorization is decided
 * explicitly by `resolveCourseAccessById`. Reading through the caller's own
 * client instead would conflate "this lesson does not exist" with "you may not
 * see it", and would make the access decision an emergent property of a SELECT
 * rather than a statement in the code. The service role is used to LOOK UP,
 * never to DECIDE.
 *
 * ── WHAT A DENIED CALLER LEARNS ───────────────────────────────────────────
 *
 * 404 for a missing lesson, a lesson with no such asset, and a lesson they may
 * not have — one answer for all three, so this route cannot be used to
 * enumerate which lessons exist or which carry video.
 */

export const dynamic = 'force-dynamic'

interface RouteContext { params: Promise<{ lessonId: string; kind: string }> }

const COLUMN: Record<MediaKind, string> = {
  video: 'video_object_path',
  pdf: 'pdf_object_path',
  subtitle: 'subtitle_object_path',
}

const notFound = () => NextResponse.json({ error: 'Introuvable' }, { status: 404 })

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { lessonId, kind } = await params

  if (!(PROTECTED_FOLDERS as readonly string[]).includes(kind)) return notFound()
  const mediaKind = kind as MediaKind

  // A malformed id must not reach the database as a failed uuid cast.
  if (!/^[0-9a-f-]{36}$/i.test(lessonId)) return notFound()

  const admin = createAdminClient()

  // All three columns are selected statically rather than interpolating
  // COLUMN[kind] into the query: a template string defeats PostgREST's typed
  // parser, and building SQL identifiers from request input is a habit worth
  // not having even when the value is validated against an allowlist first.
  const { data: lesson, error } = await admin
    .from('lessons')
    .select('id, video_object_path, pdf_object_path, subtitle_object_path, modules!inner(course_id)')
    .eq('id', lessonId)
    .maybeSingle()

  // An infrastructure failure is NOT "no such lesson". The first version of
  // this handler destructured only `data`, so a failed query became a 404
  // indistinguishable from a missing asset — which is exactly how a stale
  // cached row hid as a content problem during W3 verification. Say which it is.
  if (error) {
    console.error('[media/lesson] lookup failed:', error.code, error.message)
    return NextResponse.json({ error: 'Service indisponible' }, { status: 503 })
  }

  if (!lesson) return notFound()

  const paths: Record<MediaKind, string | null> = {
    video: lesson.video_object_path,
    pdf: lesson.pdf_object_path,
    subtitle: lesson.subtitle_object_path,
  }
  const objectPath = paths[mediaKind]

  const rel = lesson.modules as unknown as { course_id: string } | { course_id: string }[] | null
  const resolvedCourseId = Array.isArray(rel) ? rel[0]?.course_id : rel?.course_id

  // Not yet migrated, or this lesson simply has no asset of this kind. Either
  // way there is nothing here for anyone — answered before the access check so
  // the two cases stay indistinguishable.
  if (!objectPath || !resolvedCourseId) return notFound()

  // ── THE ONE AUTHORITY ───────────────────────────────────────────────────
  // Entitlements decide, exactly as they do for the lesson row itself. Not
  // enrollment, not organization membership, not a mode flag.
  const access = await resolveCourseAccessById(resolvedCourseId)
  if (!access.allowed) {
    return NextResponse.json(
      { error: 'Accès non autorisé' },
      { status: access.reason === 'not_authenticated' ? 401 : 403 },
    )
  }

  const signed = await signObject(
    PROTECTED_BUCKET, objectPath, SIGNED_URL_TTL_SECONDS[mediaKind],
  )
  if (!signed) return notFound()

  // 302, not 307: this is a GET-only delivery endpoint and the redirect is a
  // fresh capability each time, never something to cache.
  const res = NextResponse.redirect(signed, 302)
  res.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return res
}
