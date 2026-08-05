import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, GraduationCap, Calendar, Hash, User, BookOpen, Shield } from 'lucide-react'
import { notFound } from 'next/navigation'
import AdminCertActions from './AdminCertActions'
import type { Metadata } from 'next'
import { PUBLIC_SITE_URL } from '@/lib/brand'

export const metadata: Metadata = { title: 'Admin — Détail certificat' }

// XPA-1: certificate links must resolve on the PUBLIC academy domain.
// This previously defaulted to the private admin portal host, so a shared
// certificate link sent recipients to a page that redirects them to /login.
const SITE_URL = PUBLIC_SITE_URL

interface Props { params: Promise<{ certificateId: string }> }

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    valid:     { cls: 'bg-green-100 text-green-700', label: 'Valide' },
    revoked:   { cls: 'bg-red-100 text-red-600',    label: 'Révoqué' },
    pilot:     { cls: 'bg-amber-100 text-amber-700', label: 'Pilote' },
    duplicate: { cls: 'bg-gray-100 text-gray-500',  label: 'Doublon' },
  }
  const { cls, label } = map[status] ?? { cls: 'bg-gray-100 text-gray-500', label: status }
  return <span className={`inline-block text-xs font-bold px-3 py-1 rounded-full ${cls}`}>{label}</span>
}

function InfoRow({ icon: Icon, label, value, mono = false }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
      <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-gray-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider">{label}</p>
        <p className={`text-sm text-gray-800 mt-0.5 break-all ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</p>
      </div>
    </div>
  )
}

export default async function AdminCertDetailPage({ params }: Props) {
  await requirePlatformAdmin()
  const { certificateId } = await params
  const supabase = createAdminClient()

  const { data: rawCert } = await supabase
    .from('certificates')
    .select('id, certificate_number, issued_at, status, pdf_url, revoked_at, revoked_reason, user_id, course_id, profiles(full_name, email), courses(title, slug)')
    .eq('id', certificateId)
    .single()

  if (!rawCert) notFound()

  const cert = rawCert as unknown as {
    id: string
    certificate_number: string
    issued_at: string
    status: string
    pdf_url: string | null
    revoked_at: string | null
    revoked_reason: string | null
    user_id: string
    course_id: string
    profiles: { full_name: string | null; email: string } | null
    courses:  { title: string; slug: string } | null
  }

  // Profiles/courses come back as arrays from PostgREST; normalise
  const profile = Array.isArray((rawCert as Record<string, unknown>).profiles)
    ? ((rawCert as Record<string, unknown>).profiles as { full_name: string | null; email: string }[])[0] ?? null
    : cert.profiles
  const course = Array.isArray((rawCert as Record<string, unknown>).courses)
    ? ((rawCert as Record<string, unknown>).courses as { title: string; slug: string }[])[0] ?? null
    : cert.courses

  const learnerName = profile?.full_name || profile?.email || '—'
  const certPageUrl = `${SITE_URL}/certificates/${cert.id}`
  const verifyUrl   = `${SITE_URL}/verify-certificate/${cert.id}`

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Back + header */}
      <div>
        <Link
          href="/admin/certificates"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Retour aux certificats
        </Link>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-gray-900">{learnerName}</h1>
            <p className="text-sm text-gray-400 font-mono mt-0.5">{cert.certificate_number}</p>
          </div>
          <div className="ml-auto shrink-0">
            <StatusBadge status={cert.status} />
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6">

        {/* Left: certificate info */}
        <div className="space-y-5">

          {/* Learner */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
              <User className="w-4 h-4 text-gray-400" /> Apprenant
            </h2>
            <InfoRow icon={User}     label="Nom complet"  value={profile?.full_name ?? '—'} />
            <InfoRow icon={User}     label="Email"        value={profile?.email ?? '—'} />
            <InfoRow icon={Shield}   label="User ID"      value={cert.user_id} mono />
          </div>

          {/* Certificate */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-gray-400" /> Certificat
            </h2>
            <InfoRow icon={Hash}     label="Numéro"       value={cert.certificate_number} mono />
            <InfoRow icon={Hash}     label="UUID"         value={cert.id} mono />
            <InfoRow icon={Calendar} label="Émis le"      value={new Date(cert.issued_at).toLocaleDateString('fr-FR', { dateStyle: 'long' })} />
            {cert.revoked_at && (
              <InfoRow icon={Calendar} label="Révoqué le" value={new Date(cert.revoked_at).toLocaleDateString('fr-FR', { dateStyle: 'long' })} />
            )}
            {cert.revoked_reason && (
              <InfoRow icon={Shield} label="Raison révocation" value={cert.revoked_reason} />
            )}
          </div>

          {/* Course */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-gray-400" /> Formation
            </h2>
            <InfoRow icon={BookOpen} label="Titre"        value={course?.title ?? '—'} />
            <InfoRow icon={Hash}     label="Slug"         value={course?.slug  ?? '—'} mono />
            <InfoRow icon={Hash}     label="Course ID"    value={cert.course_id} mono />
          </div>

          {/* URLs */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-bold text-gray-700 mb-3">URLs</h2>
            <div className="space-y-3">
              <div>
                <p className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mb-1">Page certificat</p>
                <a
                  href={certPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-primary hover:underline break-all"
                >
                  {certPageUrl}
                </a>
              </div>
              <div>
                <p className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mb-1">Lien de vérification</p>
                <a
                  href={verifyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-primary hover:underline break-all"
                >
                  {verifyUrl}
                </a>
              </div>
              {cert.pdf_url && (
                <div>
                  <p className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mb-1">PDF stocké</p>
                  <a
                    href={cert.pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-success hover:underline break-all"
                  >
                    {cert.pdf_url}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: actions + QR */}
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sticky top-6">
            <AdminCertActions
              certId={cert.id}
              certNumber={cert.certificate_number}
              certPageUrl={certPageUrl}
              verifyUrl={verifyUrl}
              pdfUrl={cert.pdf_url}
            />
          </div>
        </div>

      </div>
    </div>
  )
}
