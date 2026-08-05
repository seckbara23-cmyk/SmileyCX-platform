import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { CertificatePDFDocument } from '@/lib/pdf/CertificatePDF'
import { certificateVerifyUrl } from '@/lib/brand'

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
    .select('id, user_id, certificate_number, issued_at, pdf_url, courses(title)')
    .eq('id', id)
    .single()

  if (!cert) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (cert.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // If PDF already generated, return existing URL
  if (cert.pdf_url) {
    return NextResponse.json({ pdf_url: cert.pdf_url })
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

  // Get public URL
  const { data: { publicUrl } } = admin.storage
    .from('certificates')
    .getPublicUrl(storagePath)

  // Persist pdf_url on the certificate record
  await admin
    .from('certificates')
    .update({ pdf_url: publicUrl })
    .eq('id', id)

  return NextResponse.json({ pdf_url: publicUrl })
}
