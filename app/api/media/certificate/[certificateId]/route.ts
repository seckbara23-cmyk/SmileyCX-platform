import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnerSession } from '@/lib/auth/owner'
import { CERTIFICATE_BUCKET, SIGNED_URL_TTL_SECONDS, signObject } from '@/lib/media/storage'

/**
 * Certificate PDF delivery (XPA-8 W3 / F-2).
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────
 *
 * A permanent public URL stored on `certificates.pdf_url`, in a bucket created
 * with the comment "public bucket: URL is the access control". Measured before
 * remediation: a synthetic certificate written for learner B was downloaded by
 * an anonymous caller, and by a different signed-in learner. The correctly
 * written `cert_owner_select` policy never ran, because the public route does
 * not consult RLS.
 *
 * ── THE AUTHORITY, TAKEN FROM WHAT ALREADY EXISTED ────────────────────────
 *
 * No second access model was invented. `/api/certificates/[id]/pdf` already
 * established the rule — the caller must be the certificate's owner — and this
 * route enforces the same one, plus the administration portal's existing
 * `getOwnerSession()` for support workflows.
 *
 * A certificate is deliberately NOT gated on current course access: it records
 * something the learner completed. Revoking access to a course does not
 * un-earn the certificate, and `access_ended` copy elsewhere already promises
 * that certificates are kept.
 */

export const dynamic = 'force-dynamic'

interface RouteContext { params: Promise<{ certificateId: string }> }

const notFound = () => NextResponse.json({ error: 'Introuvable' }, { status: 404 })

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { certificateId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(certificateId)) return notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const owner = await getOwnerSession()
  if (!user && !owner) {
    return NextResponse.json({ error: 'Connexion requise' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: cert } = await admin
    .from('certificates')
    .select('id, user_id, certificate_number, pdf_object_path')
    .eq('id', certificateId)
    .maybeSingle()

  if (!cert) return notFound()

  // Ownership, or the administration portal. Nothing else.
  const isOwner = Boolean(user && cert.user_id === user.id)
  if (!isOwner && !owner) {
    // 404 rather than 403: a learner probing certificate ids should not be
    // able to tell "exists but not yours" from "does not exist".
    return notFound()
  }

  if (!cert.pdf_object_path) return notFound()

  const signed = await signObject(
    CERTIFICATE_BUCKET,
    cert.pdf_object_path,
    SIGNED_URL_TTL_SECONDS.certificate,
    `certificat-xpclient-${cert.certificate_number ?? cert.id}.pdf`,
  )
  if (!signed) return notFound()

  const res = NextResponse.redirect(signed, 302)
  res.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return res
}
