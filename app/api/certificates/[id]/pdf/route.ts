import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { CertificatePDFDocument } from '@/lib/pdf/CertificatePDF'
import { certificateVerifyUrl } from '@/lib/brand'
import { certificateMediaHref } from '@/lib/media/storage'

// Force Node.js runtime — @react-pdf/renderer does not run on Edge
export const runtime = 'nodejs'

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify ownership and fetch cert data
  const { data: cert } = await supabase
    .from('certificates')
    .select('id, user_id, certificate_number, issued_at, pdf_object_path, courses(title)')
    .eq('id', id)
    .single()

  if (!cert) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (cert.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // XPA-8 W3 (F-2): this returns the APPLICATION's delivery URL, never a
  // Storage URL. It used to return `pdf_url` — a permanent public link into a
  // public bucket, which meant anyone holding it could download a named
  // learner's certificate. The route below re-checks ownership on every fetch.
  if (cert.pdf_object_path) {
    return NextResponse.json({ pdf_url: certificateMediaHref(id) })
  }

  // Fetch learner profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single()

  const courseTitle = (cert.courses as unknown as { title: string } | null)?.title ?? 'Formation XP Client'
  const learnerName = profile?.full_name || profile?.email || 'Apprenant'

  // Generate PDF buffer
  const doc = React.createElement(CertificatePDFDocument, {
    learnerName,
    courseTitle,
    certNumber:  cert.certificate_number,
    issuedAt:    cert.issued_at,
    // XPA-1: always the public academy domain, never the admin portal host.
    verifyUrl:   certificateVerifyUrl(cert.id as string),
  })
  const buffer = await renderToBuffer(doc as React.ReactElement)

  // Upload to Supabase Storage
  const admin      = createAdminClient()
  const storagePath = `${user.id}/${id}.pdf`

  const { error: uploadError } = await admin.storage
    .from('certificates')
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    })

  if (uploadError) {
    console.error('[cert-pdf] upload error:', uploadError.message)
    return NextResponse.json({ error: 'PDF upload failed' }, { status: 500 })
  }

  // Persist the canonical OBJECT PATH, not a URL. The path is durable identity;
  // a delivery URL is a capability that expires in two minutes and is minted
  // per request by /api/media/certificate/[id] after re-checking ownership.
  await admin
    .from('certificates')
    .update({ pdf_object_path: storagePath })
    .eq('id', id)

  return NextResponse.json({ pdf_url: certificateMediaHref(id) })
}
