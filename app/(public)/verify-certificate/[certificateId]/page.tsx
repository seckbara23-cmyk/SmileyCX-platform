import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { CheckCircle, XCircle, ShieldOff, Award, Calendar, Hash } from 'lucide-react'
import type { Metadata } from 'next'
import {
  PUBLIC_VERIFICATION_COLUMNS,
  evaluateCertificate,
  type CertificateVerificationRow,
} from '@/lib/certificates/verification'

export const metadata: Metadata = { title: 'Vérification de certificat — XP Client Academy' }

interface Props { params: Promise<{ certificateId: string }> }

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(dateStr))
}

/**
 * CERT-SEC-01. The page uses the service-role client because the lookup is
 * public and `certificates_select_own` (013) would return nothing to an
 * anonymous caller — so RLS cannot police this surface and the policy in
 * `lib/certificates/verification` is what does. It decides three outcomes and
 * hands back only the facts a stranger may see: never the holder's email,
 * never `user_id`, never `revoked_reason`.
 */
export default async function VerifyCertificatePage({ params }: Props) {
  const { certificateId } = await params
  const supabase = createAdminClient()

  const { data } = await supabase
    .from('certificates')
    .select(PUBLIC_VERIFICATION_COLUMNS)
    .eq('id', certificateId)
    .maybeSingle()

  const result = evaluateCertificate(
    data as unknown as CertificateVerificationRow | null,
    certificateId,
  )

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

        {result.outcome === 'valid' ? (
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

            {result.facts.holderName ? (
              <>
                <h1 className="text-2xl font-extrabold text-dark mb-1">{result.facts.holderName}</h1>
                <p className="text-sm text-cx-gray mb-6">a complété avec succès</p>
              </>
            ) : (
              /* No name on file. The credential still verifies on its number,
                 course and date — which is what a third party is checking. */
              <p className="text-sm text-cx-gray mb-6">
                Ce certificat atteste de la réussite de la formation
              </p>
            )}
            <p className="text-lg font-bold text-primary mb-8 leading-snug">{result.facts.courseTitle}</p>

            {/* Details */}
            <div className="grid grid-cols-2 gap-4 text-left">
              <div className="bg-light rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs text-cx-gray mb-1">
                  <Calendar className="w-3.5 h-3.5" /> Date d&apos;émission
                </div>
                <p className="text-sm font-semibold text-dark">
                  {result.facts.issuedAt ? formatDateFR(result.facts.issuedAt) : '—'}
                </p>
              </div>
              <div className="bg-light rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs text-cx-gray mb-1">
                  <Hash className="w-3.5 h-3.5" /> Numéro
                </div>
                <p className="text-sm font-semibold font-mono text-dark">
                  {result.facts.certificateNumber ?? '—'}
                </p>
              </div>
            </div>

            {/* Verification ID */}
            <div className="mt-6 pt-6 border-t border-black/[0.06]">
              <p className="text-xs text-cx-gray mb-1">ID de vérification</p>
              <p className="text-xs font-mono text-primary break-all">{result.facts.certificateId}</p>
            </div>

            <p className="text-xs text-cx-gray mt-6">
              Ce certificat a été émis par XP Client Academy et son authenticité est vérifiée.
            </p>
          </div>
        ) : result.outcome === 'not-valid' ? (
          <div className="cx-card p-8 text-center">
            {/* A certificate with this identifier exists but may not be
                presented as a credential. Saying "introuvable" would itself be
                untrue, so the outcome is stated plainly — without the holder,
                the course, or the administrative reason behind it. */}
            <div className="inline-flex items-center gap-2 bg-red-100 text-red-600 text-sm font-bold px-4 py-2 rounded-full mb-6">
              <ShieldOff className="w-4 h-4" />
              Certificat non valide
            </div>

            <div className="w-20 h-20 rounded-full bg-red-100 mx-auto mb-6 flex items-center justify-center">
              <ShieldOff className="w-10 h-10 text-red-400" />
            </div>

            <h1 className="text-xl font-bold text-dark mb-3">Ce certificat n&apos;est plus valide</h1>
            <p className="text-sm text-cx-gray mb-6">
              XP Client Academy ne peut pas attester de ce certificat. Il ne doit pas être
              considéré comme une qualification en cours de validité. Pour toute question,
              contactez XP Client Academy.
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

            <h1 className="text-xl font-bold text-dark mb-3">Certificat introuvable</h1>
            <p className="text-sm text-cx-gray mb-6">
              Aucun certificat ne correspond à cet identifiant dans notre système.
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
