import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'
import CertificateView from './CertificateView'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Certificat de réussite — SmileyCX Academy' }

interface Props { params: Promise<{ certificateId: string }> }

export default async function CertificateByIdPage({ params }: Props) {
  const { certificateId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(PILOT_MODE ? '/courses' : '/login')

  const [{ data: cert }, { data: profile }] = await Promise.all([
    supabase
      .from('certificates')
      .select('id, user_id, certificate_number, issued_at, courses(title)')
      .eq('id', certificateId)
      .single(),
    supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', user!.id)
      .single(),
  ])

  if (!cert) redirect('/dashboard')
  if (cert.user_id !== user!.id) redirect('/dashboard')

  const coursesData = cert.courses as unknown as { title: string } | null
  const courseTitle = coursesData?.title ?? ''
  const learnerName = profile?.full_name || profile?.email || ''

  return (
    <div className="cert-page-wrapper">
      <div className="cx-container max-w-5xl">
        <CertificateView
          certNumber={cert.certificate_number}
          issuedAt={cert.issued_at}
          learnerName={learnerName}
          courseTitle={courseTitle}
        />
        <p className="text-xs text-cx-gray text-center mt-6 print:hidden">
          Ce certificat peut être partagé sur LinkedIn et autres plateformes professionnelles.
          <br />Vérification :{' '}
          <span className="font-mono text-primary">{cert.certificate_number}</span>
        </p>
      </div>
    </div>
  )
}
