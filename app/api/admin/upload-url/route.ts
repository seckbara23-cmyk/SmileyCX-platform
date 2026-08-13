import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnerSession } from '@/lib/auth/owner'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { PROTECTED_BUCKET, PUBLIC_BUCKET, PROTECTED_FOLDERS } from '@/lib/media/storage'
import { z } from 'zod'

/**
 * XPA-8 W3 (F-2): an upload's destination is decided by WHAT IT IS.
 *
 * This route used to put everything in `course-media` — a public bucket — and
 * hand the admin UI a permanent public URL to store on the lesson. That is how
 * 149 lesson videos ended up anonymously downloadable and enumerable.
 *
 * Now `cover` (a marketing thumbnail on the anonymous catalogue) goes to the
 * public bucket and gets a URL, while `video`, `pdf` and `subtitle` go to the
 * private bucket and get a PATH — never a URL, because no URL for them is
 * valid for longer than a few minutes and none may be persisted.
 */
const BUCKET_FOR: Record<string, string> = {
  cover: PUBLIC_BUCKET,
  video: PROTECTED_BUCKET,
  pdf: PROTECTED_BUCKET,
  subtitle: PROTECTED_BUCKET,
}

const ALLOWED: Record<string, string[]> = {
  cover:    ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video:    ['video/mp4', 'video/quicktime', 'video/webm'],
  pdf:      ['application/pdf'],
  subtitle: ['text/vtt', 'text/plain'],  // WebVTT subtitles
}

const UploadRequestSchema = z.object({
  filename:    z.string().min(1).max(255),
  contentType: z.string().min(1),
  folder:      z.enum(['cover', 'video', 'pdf', 'subtitle']),
})

// 30 signed URLs per admin per minute
const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 }

export async function POST(request: NextRequest) {
  // SECURITY (CX-AUTH-1, repairs CX-AUTH-0 finding F-1):
  // This previously checked only that an `scx_admin` cookie was PRESENT — never
  // its value, never a role. Because the handler then used the service-role
  // client to mint a signed upload URL into a PUBLIC bucket, any anonymous
  // caller sending `Cookie: scx_admin=x` obtained write access.
  //
  // Authorization is now a verified Supabase session belonging to the owner.
  // A forged cookie carries no session and is rejected here.
  const session = await getOwnerSession()
  if (!session) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }

  const ip = getClientIp(request)
  // Rate-limit key is now bound to the verified user id, not an attacker-chosen
  // cookie value (which previously let a caller pick a fresh bucket per request).
  const rl = rateLimit(`upload-url:${session.user.id}:${ip}`, RATE_LIMIT)
  if (!rl.success) {
    return NextResponse.json({ error: 'Trop de requêtes' }, { status: 429 })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'Corps invalide' }, { status: 400 })
  }

  const parsed = UploadRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Données invalides', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { filename, contentType, folder } = parsed.data

  if (!ALLOWED[folder]?.includes(contentType)) {
    return NextResponse.json(
      { error: `Type de fichier non autorisé pour ${folder}` },
      { status: 400 }
    )
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? 'bin'
  const safePath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const bucket = BUCKET_FOR[folder]
  const isProtected = (PROTECTED_FOLDERS as readonly string[]).includes(folder)

  const supabase = createAdminClient()

  // The bucket is created by migration 041, not here. The previous version
  // called createBucket({ public: true }) on every request, which meant the
  // privacy of a bucket was re-asserted by an upload handler — a place nobody
  // would think to look when asking "why is this public?".
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(safePath)

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Erreur Storage' }, { status: 500 })
  }

  // A protected upload gets NO delivery URL. There is no URL to give: delivery
  // is minted per request behind an entitlement check, and persisting one here
  // is exactly the mistake being repaired.
  return NextResponse.json({
    signedUrl: data.signedUrl,
    token:     data.token,
    bucket,
    path:      safePath,
    isProtected,
    publicUrl: isProtected
      ? null
      : `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${bucket}/${safePath}`,
  })
}
