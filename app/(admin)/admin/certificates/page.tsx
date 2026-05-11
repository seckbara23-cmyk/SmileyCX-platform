import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { GraduationCap, ChevronLeft, ChevronRight, ExternalLink, Copy } from 'lucide-react'
import CertSearchBar from './CertSearchBar'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Certificats' }

const PAGE_SIZE = 25

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://smiley-cx-platform.vercel.app'

interface PageProps {
  searchParams?: { q?: string; course?: string; status?: string; pdf?: string; page?: string }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  const map: Record<string, string> = {
    valid:     'bg-green-100 text-green-700',
    revoked:   'bg-red-100 text-red-600',
    pilot:     'bg-amber-100 text-amber-700',
    duplicate: 'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    valid: 'Valide', revoked: 'Révoqué', pilot: 'Pilote', duplicate: 'Doublon',
  }
  return { cls: map[status] ?? 'bg-gray-100 text-gray-500', label: labels[status] ?? status }
}

function pdfBadge(url: string | null) {
  return url
    ? { cls: 'bg-green-100 text-green-700', label: 'Généré' }
    : { cls: 'bg-amber-100 text-amber-700', label: 'Manquant' }
}

export default async function AdminCertificatesPage({ searchParams }: PageProps) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const q          = searchParams?.q?.trim() ?? ''
  const courseFilter  = searchParams?.course ?? ''
  const statusFilter  = searchParams?.status ?? ''
  const pdfFilter     = searchParams?.pdf ?? ''
  const page          = Math.max(1, parseInt(searchParams?.page ?? '1', 10))

  // ── Fetch all certificates with joins ──────────────────────────────────
  // Admin client bypasses RLS, limit 1000 is safe for pilot scale
  const { data: allCerts } = await supabase
    .from('certificates')
    .select('id, certificate_number, issued_at, status, pdf_url, user_id, course_id, profiles(full_name, email), courses(id, title, slug)')
    .order('issued_at', { ascending: false })
    .limit(1000)

  type CertRow = {
    id: string
    certificate_number: string
    issued_at: string
    status: string
    pdf_url: string | null
    user_id: string
    course_id: string
    profiles: { full_name: string | null; email: string } | null
    courses:  { id: string; title: string; slug: string } | null
  }

  const certs: CertRow[] = ((allCerts ?? []) as unknown[]).map(raw => {
    const r = raw as Record<string, unknown>
    return {
      id:                 r.id as string,
      certificate_number: r.certificate_number as string,
      issued_at:          r.issued_at as string,
      status:             (r.status as string) ?? 'valid',
      pdf_url:            r.pdf_url as string | null,
      user_id:            r.user_id as string,
      course_id:          r.course_id as string,
      profiles:           Array.isArray(r.profiles)
        ? (r.profiles[0] as { full_name: string | null; email: string } ?? null)
        : r.profiles as { full_name: string | null; email: string } | null,
      courses: Array.isArray(r.courses)
        ? (r.courses[0] as { id: string; title: string; slug: string } ?? null)
        : r.courses as { id: string; title: string; slug: string } | null,
    }
  })

  // ── Filter ─────────────────────────────────────────────────────────────
  const filtered = certs.filter(c => {
    if (q) {
      const text = q.toLowerCase()
      const matches =
        c.profiles?.full_name?.toLowerCase().includes(text) ||
        c.profiles?.email?.toLowerCase().includes(text) ||
        c.courses?.title?.toLowerCase().includes(text) ||
        c.certificate_number?.toLowerCase().includes(text)
      if (!matches) return false
    }
    if (courseFilter   && c.course_id !== courseFilter) return false
    if (statusFilter   && c.status    !== statusFilter)  return false
    if (pdfFilter === 'generated' && !c.pdf_url)         return false
    if (pdfFilter === 'missing'   && c.pdf_url)          return false
    return true
  })

  // ── Pagination ─────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const paginated  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // ── Stats ──────────────────────────────────────────────────────────────
  const now         = new Date()
  const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const thisMonth   = certs.filter(c => c.issued_at >= monthStart).length
  const missingPdf  = certs.filter(c => !c.pdf_url).length
  const validCount  = certs.filter(c => c.status === 'valid').length
  const revokedCount = certs.filter(c => c.status === 'revoked').length

  // Most completed course
  const courseCount: Record<string, { title: string; count: number }> = {}
  certs.forEach(c => {
    if (c.courses) {
      const key = c.course_id
      courseCount[key] = { title: c.courses.title, count: (courseCount[key]?.count ?? 0) + 1 }
    }
  })
  const topCourse = Object.values(courseCount).sort((a, b) => b.count - a.count)[0]

  // Distinct courses for filter dropdown
  const distinctCourses = Object.entries(courseCount).map(([id, { title }]) => ({ id, title }))

  // ── Page URL helper ────────────────────────────────────────────────────
  function pageUrl(p: number) {
    const params = new URLSearchParams()
    if (q)            params.set('q', q)
    if (courseFilter) params.set('course', courseFilter)
    if (statusFilter) params.set('status', statusFilter)
    if (pdfFilter)    params.set('pdf', pdfFilter)
    params.set('page', String(p))
    return `/admin/certificates?${params.toString()}`
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900 flex items-center gap-2">
            <GraduationCap className="w-6 h-6 text-primary" /> Certificats
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {certs.length} certificat{certs.length !== 1 ? 's' : ''} émis · {filtered.length} résultat{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          { label: 'Total émis',      value: certs.length,   color: 'text-primary bg-primary/10' },
          { label: 'Ce mois-ci',      value: thisMonth,      color: 'text-secondary bg-secondary/10' },
          { label: 'Valides',         value: validCount,     color: 'text-success bg-success/10' },
          { label: 'Révoqués',        value: revokedCount,   color: 'text-red-600 bg-red-100' },
          { label: 'PDF manquants',   value: missingPdf,     color: 'text-amber-700 bg-amber-100' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <p className={`text-2xl font-extrabold ${color.split(' ')[0]}`}>{value}</p>
            <p className="text-xs text-gray-400 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Top course */}
      {topCourse && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <GraduationCap className="w-4 h-4 text-amber-600" />
          </div>
          <div>
            <p className="text-xs text-gray-400">Formation la plus complétée</p>
            <p className="text-sm font-semibold text-gray-800">{topCourse.title}
              <span className="text-gray-400 font-normal ml-2">({topCourse.count} certificat{topCourse.count !== 1 ? 's' : ''})</span>
            </p>
          </div>
        </div>
      )}

      {/* Search + Filters */}
      <CertSearchBar
        courses={distinctCourses}
        currentQ={q}
        currentCourse={courseFilter}
        currentStatus={statusFilter}
        currentPdf={pdfFilter}
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {paginated.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            <GraduationCap className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Aucun certificat trouvé</p>
            {(q || courseFilter || statusFilter || pdfFilter) && (
              <p className="text-xs mt-1">Essayez de modifier vos filtres</p>
            )}
          </div>
        ) : (
          <>
            {/* Desktop header */}
            <div className="hidden lg:grid lg:grid-cols-[1fr_160px_140px_90px_80px_100px] gap-3 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider border-b border-gray-100">
              <span>Apprenant / Formation</span>
              <span>N° Certificat</span>
              <span>Émis le</span>
              <span>Statut</span>
              <span>PDF</span>
              <span>Actions</span>
            </div>

            <div className="divide-y divide-gray-50">
              {paginated.map(cert => {
                const { cls: sBadge, label: sLabel } = statusBadge(cert.status)
                const { cls: pBadge, label: pLabel } = pdfBadge(cert.pdf_url)
                const verifyUrl = `${SITE_URL}/verify-certificate/${cert.id}`

                return (
                  <div key={cert.id} className="hover:bg-gray-50/60 transition-colors">

                    {/* Desktop row */}
                    <div className="hidden lg:grid lg:grid-cols-[1fr_160px_140px_90px_80px_100px] gap-3 px-5 py-3.5 items-center">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {cert.profiles?.full_name || cert.profiles?.email || '—'}
                        </p>
                        <p className="text-xs text-gray-400 truncate">{cert.profiles?.email}</p>
                        <p className="text-xs text-primary/80 truncate mt-0.5">{cert.courses?.title}</p>
                      </div>
                      <span className="text-xs font-mono text-gray-600 truncate">{cert.certificate_number}</span>
                      <span className="text-xs text-gray-500">
                        {new Date(cert.issued_at).toLocaleDateString('fr-FR')}
                      </span>
                      <span className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-full ${sBadge}`}>
                        {sLabel}
                      </span>
                      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${pBadge}`}>
                        {pLabel}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/admin/certificates/${cert.id}`}
                          className="text-xs text-primary font-semibold hover:underline"
                        >
                          Voir →
                        </Link>
                      </div>
                    </div>

                    {/* Mobile card */}
                    <div className="lg:hidden px-4 py-3.5">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-gray-800 truncate">
                            {cert.profiles?.full_name || cert.profiles?.email}
                          </p>
                          <p className="text-xs text-gray-400 truncate">{cert.profiles?.email}</p>
                          <p className="text-xs text-primary/80 truncate">{cert.courses?.title}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${sBadge}`}>{sLabel}</span>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${pBadge}`}>{pLabel}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs font-mono text-gray-500">{cert.certificate_number}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-400">{new Date(cert.issued_at).toLocaleDateString('fr-FR')}</span>
                          <Link href={`/admin/certificates/${cert.id}`} className="text-xs text-primary font-semibold">Voir →</Link>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100">
                <p className="text-xs text-gray-400">
                  Page {safePage} sur {totalPages} · {filtered.length} résultats
                </p>
                <div className="flex items-center gap-1.5">
                  {safePage > 1 ? (
                    <Link
                      href={pageUrl(safePage - 1)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" /> Précédent
                    </Link>
                  ) : (
                    <span className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-300 bg-gray-50 rounded-lg cursor-not-allowed">
                      <ChevronLeft className="w-3.5 h-3.5" /> Précédent
                    </span>
                  )}
                  {safePage < totalPages ? (
                    <Link
                      href={pageUrl(safePage + 1)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      Suivant <ChevronRight className="w-3.5 h-3.5" />
                    </Link>
                  ) : (
                    <span className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-gray-300 bg-gray-50 rounded-lg cursor-not-allowed">
                      Suivant <ChevronRight className="w-3.5 h-3.5" />
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
