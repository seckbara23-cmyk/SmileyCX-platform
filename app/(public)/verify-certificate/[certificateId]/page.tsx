import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { CheckCircle, XCircle, Award, Calendar, Hash } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Vérification de certificat — XP Client Academy' }

interface Props { params: Promise<{ certificateId: string }> }

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(dateStr))
}

export default async function VerifyCertificatePage({ params }: Props) {
  const { certificateId } = await params

  // Use admin client — this page is public, no user auth needed
  const supabase = createAdminClient()

  const { data: cert } = await supabase
    .from('certificates')
    .select('id, certificate_number, issued_at, courses(title), profiles(full_name, email)')
    .eq('id', certificateId)
    .single()

  const isValid = !!cert

  const courseTitle = isValid
    ? ((cert.courses  as unknown as { title: string } | null)?.title ?? '')
    : ''
  const profileData  = isValid
    ? (cert.profiles as unknown as { full_name: string | null; email: string } | null)
    : null
  const learnerName = profileData?.full_name || profileData?.email || ''

  return (
    <div className="min-h-screen bg-light flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg">

        {/* Brand */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <p className="text-2xl font-extrabold text-primary">
              XP<span className="text-secondary"> Client</span>{' '}
              <span className="text-base font-semibold text-cx-gray">Academy</span>
            </p>
          </Link>
          <p className="text-sm text-cx-gray mt-1">Système de vérification de certificat</p>
        </div>

        {isValid ? (
          <div className="cx-card p-8 text-center">
            {/* Valid badge */}
            <div className="inline-flex items-center gap-2 bg-success/10 text-success text-sm font-bold px-4 py-2 rounded-full mb-6">
              <CheckCircle className="w-4 h-4" />
              Certificat valide
            </div>

            {/* Trophy */}
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-400 to-amber-600 mx-auto mb-6 flex items-center justify-center shadow-lg">
              <Award className="w-10 h-10 text-white" />
            </div>

            <h1 className="text-2xl font-extrabold text-dark mb-1">{learnerName}</h1>
            <p className="text-sm text-cx-gray mb-6">a complété avec succès</p>
            <p className="text-lg font-bold text-primary mb-8 leading-snug">{courseTitle}</p>

            {/* Details */}
            <div className="grid grid-cols-2 gap-4 text-left">
              <div className="bg-light rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs text-cx-gray mb-1">
                  <Calendar className="w-3.5 h-3.5" /> Date d&apos;émission
                </div>
                <p className="text-sm font-semibold text-dark">{formatDateFR(cert.issued_at)}</p>
              </div>
              <div className="bg-light rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs text-cx-gray mb-1">
                  <Hash className="w-3.5 h-3.5" /> Numéro
                </div>
                <p className="text-sm font-semibold font-mono text-dark">{cert.certificate_number}</p>
              </div>
            </div>

            {/* Verification ID */}
            <div className="mt-6 pt-6 border-t border-black/[0.06]">
              <p className="text-xs text-cx-gray mb-1">ID de vérification</p>
              <p className="text-xs font-mono text-primary break-all">{cert.id}</p>
            </div>

            <p className="text-xs text-cx-gray mt-6">
              Ce certificat a été émis par XP Client Academy et son authenticité est vérifiée.
            </p>
          </div>
        ) : (
          <div className="cx-card p-8 text-center">
            {/* Invalid badge */}
            <div className="inline-flex items-center gap-2 bg-red-100 text-red-600 text-sm font-bold px-4 py-2 rounded-full mb-6">
              <XCircle className="w-4 h-4" />
              Certificat introuvable
            </div>

            <div className="w-20 h-20 rounded-full bg-red-100 mx-auto mb-6 flex items-center justify-center">
              <XCircle className="w-10 h-10 text-red-400" />
            </div>

            <h1 className="text-xl font-bold text-dark mb-3">Certificat invalide ou introuvable</h1>
            <p className="text-sm text-cx-gray mb-6">
              Le certificat correspondant à cet identifiant n&apos;existe pas dans notre système
              ou a peut-être été révoqué.
            </p>
            <p className="text-xs text-cx-gray bg-light rounded-lg px-4 py-3 font-mono break-all">
              ID : {certificateId}
            </p>

            <Link
              href="/"
              className="inline-flex items-center gap-2 mt-6 px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-cx hover:bg-primary/90 transition-colors"
            >
              Retour à l&apos;accueil
            </Link>
          </div>
        )}

        <p className="text-center text-xs text-cx-gray mt-6">
          XP Client Academy · Formation professionnelle en expérience client
        </p>
      </div>
    </div>
  )
}
