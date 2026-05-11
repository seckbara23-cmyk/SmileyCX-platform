'use client'

import { useState, useEffect } from 'react'
import QRCode from 'react-qr-code'
import { Download, Printer, Linkedin, Share2, Loader2 } from 'lucide-react'

interface Props {
  certId: string
  certNumber: string
  issuedAt: string
  learnerName: string
  courseTitle: string
  initialPdfUrl?: string | null
}

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(dateStr))
}

export default function CertificateView({
  certId,
  certNumber,
  issuedAt,
  learnerName,
  courseTitle,
  initialPdfUrl,
}: Props) {
  const [pdfUrl, setPdfUrl]           = useState<string | null>(initialPdfUrl ?? null)
  const [generatingPdf, setGenerating] = useState(false)
  const [origin, setOrigin]           = useState('')

  // Capture origin client-side for share URLs
  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  // Auto-generate PDF if not yet stored
  useEffect(() => {
    if (pdfUrl || !certId) return
    setGenerating(true)
    fetch(`/api/certificates/${certId}/pdf`)
      .then(r => r.json())
      .then(({ pdf_url }) => { if (pdf_url) setPdfUrl(pdf_url) })
      .catch(() => { /* silently fail — print is still available */ })
      .finally(() => setGenerating(false))
  }, [certId, pdfUrl])

  const verifyUrl     = `${origin}/verify-certificate/${certId}`
  const certPageUrl   = `${origin}/certificates/${certId}`
  const issueDate     = new Date(issuedAt)
  const issueYear     = issueDate.getFullYear()
  const issueMonth    = issueDate.getMonth() + 1

  // LinkedIn "Add Certification" deeplink
  const linkedInCertUrl = [
    'https://www.linkedin.com/profile/add',
    '?startTask=CERTIFICATION_NAME',
    `&name=${encodeURIComponent(`Certificat — ${courseTitle}`)}`,
    `&organizationName=${encodeURIComponent('SmileyCX Academy')}`,
    `&issueYear=${issueYear}`,
    `&issueMonth=${issueMonth}`,
    `&certId=${encodeURIComponent(certNumber)}`,
    `&certUrl=${encodeURIComponent(certPageUrl)}`,
  ].join('')

  const shareText = `Je viens de compléter la formation "${courseTitle}" sur SmileyCX Academy 🎓 Certificat : ${certPageUrl}`

  const twitterUrl   = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`
  const whatsappUrl  = `https://wa.me/?text=${encodeURIComponent(shareText)}`
  const linkedInPost = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(certPageUrl)}`

  return (
    <>
      {/* ── Action bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 print:hidden">
        <a href="/dashboard" className="text-sm text-cx-gray hover:text-dark transition-colors">
          ← Mon espace
        </a>
        <div className="flex items-center gap-2">
          {pdfUrl ? (
            <a
              href={pdfUrl}
              download={`certificat-smileycx-${certNumber}.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-success text-white text-sm font-semibold rounded-xl hover:bg-success/90 transition-colors shadow-sm"
            >
              <Download className="w-4 h-4" /> Télécharger PDF
            </a>
          ) : generatingPdf ? (
            <span className="inline-flex items-center gap-2 px-4 py-2 bg-light text-cx-gray text-sm font-semibold rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin" /> Génération PDF…
            </span>
          ) : null}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-xl hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Printer className="w-4 h-4" /> Imprimer
          </button>
        </div>
      </div>

      {/* ── Certificate ───────────────────────────────────────── */}
      <div id="certificate-print-area" className="cert-page">

        {/* Outer decorative border */}
        <div className="cert-outer-border" aria-hidden />

        {/* Corner ornaments */}
        <svg aria-hidden className="cert-corner cert-corner-tl" viewBox="0 0 60 60" fill="none">
          <path d="M2 30 L2 2 L30 2" stroke="#4a6de5" strokeWidth="3" strokeLinecap="round" />
          <path d="M2 18 L2 2 L18 2" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" opacity=".6" />
          <circle cx="2" cy="2" r="3" fill="#f59e0b" />
        </svg>
        <svg aria-hidden className="cert-corner cert-corner-tr" viewBox="0 0 60 60" fill="none">
          <path d="M58 30 L58 2 L30 2" stroke="#4a6de5" strokeWidth="3" strokeLinecap="round" />
          <path d="M58 18 L58 2 L42 2" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" opacity=".6" />
          <circle cx="58" cy="2" r="3" fill="#f59e0b" />
        </svg>
        <svg aria-hidden className="cert-corner cert-corner-bl" viewBox="0 0 60 60" fill="none">
          <path d="M2 30 L2 58 L30 58" stroke="#4a6de5" strokeWidth="3" strokeLinecap="round" />
          <path d="M2 42 L2 58 L18 58" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" opacity=".6" />
          <circle cx="2" cy="58" r="3" fill="#f59e0b" />
        </svg>
        <svg aria-hidden className="cert-corner cert-corner-br" viewBox="0 0 60 60" fill="none">
          <path d="M58 30 L58 58 L30 58" stroke="#4a6de5" strokeWidth="3" strokeLinecap="round" />
          <path d="M58 42 L58 58 L42 58" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" opacity=".6" />
          <circle cx="58" cy="58" r="3" fill="#f59e0b" />
        </svg>

        {/* Content */}
        <div className="cert-body">

          {/* Header */}
          <div className="cert-header">
            <p className="cert-brand">
              Smiley<span className="cert-brand-cx">CX</span>{' '}
              <span className="cert-brand-academy">Academy</span>
            </p>
            <div className="cert-divider" />
            <p className="cert-title-label">Certificat de Réussite</p>
          </div>

          {/* Medal */}
          <div className="cert-medal">
            <svg viewBox="0 0 80 80" fill="none" className="w-full h-full">
              <circle cx="40" cy="40" r="38" fill="url(#medalGrad)" />
              <circle cx="40" cy="40" r="33" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
              <path d="M40 16 L44 30 L58 30 L47 39 L51 53 L40 45 L29 53 L33 39 L22 30 L36 30 Z" fill="white" />
              <defs>
                <radialGradient id="medalGrad" cx="40%" cy="35%" r="60%">
                  <stop offset="0%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#d97706" />
                </radialGradient>
              </defs>
            </svg>
          </div>

          {/* Recipient */}
          <p className="cert-awarded-to">Ce certificat est décerné à</p>
          <h1 className="cert-name">{learnerName}</h1>
          <div className="cert-name-line" />

          {/* Course */}
          <p className="cert-for-completing">pour avoir complété avec succès la formation</p>
          <h2 className="cert-course">{courseTitle}</h2>

          {/* Signatures */}
          <div className="cert-signatures">
            <div className="cert-sig-block">
              <div className="cert-sig-line" />
              <p className="cert-sig-name">SmileyCX Consulting</p>
              <p className="cert-sig-role">Organisation</p>
            </div>
            <div className="cert-sig-block">
              <div className="cert-sig-line" />
              <p className="cert-sig-name">Directrice de Formation</p>
              <p className="cert-sig-role">Responsable pédagogique</p>
            </div>
          </div>

          {/* Footer — date left, cert number center, QR right */}
          <div className="cert-footer">
            <span>Délivré le {formatDateFR(issuedAt)}</span>
            <span className="cert-number">N° {certNumber}</span>
            {/* QR code — bottom right, small, links to verify page */}
            {origin && (
              <div className="cert-qr" title="Scanner pour vérifier l'authenticité">
                <QRCode value={verifyUrl} size={56} level="M" />
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── Share section ─────────────────────────────────────── */}
      <div className="mt-6 print:hidden">
        <p className="text-xs text-cx-gray text-center mb-4">
          Partagez votre réussite ·{' '}
          <span className="font-mono text-primary">{certNumber}</span>
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* LinkedIn Add Certification */}
          <a
            href={linkedInCertUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#0077b5] text-white text-sm font-semibold rounded-xl hover:bg-[#006399] transition-colors"
          >
            <Linkedin className="w-4 h-4" />
            Ajouter à LinkedIn
          </a>

          {/* LinkedIn Post */}
          <a
            href={linkedInPost}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#0077b5]/10 text-[#0077b5] text-sm font-semibold rounded-xl hover:bg-[#0077b5]/20 border border-[#0077b5]/20 transition-colors"
          >
            <Share2 className="w-4 h-4" />
            Partager sur LinkedIn
          </a>

          {/* Twitter / X */}
          <a
            href={twitterUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-black text-white text-sm font-semibold rounded-xl hover:bg-black/80 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.631 5.905-5.631zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Partager sur X
          </a>

          {/* WhatsApp */}
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#25d366] text-white text-sm font-semibold rounded-xl hover:bg-[#1ebe59] transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
            WhatsApp
          </a>
        </div>

        {/* Verify link */}
        {origin && (
          <p className="text-center text-xs text-cx-gray mt-4">
            Lien de vérification :{' '}
            <a href={verifyUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-[11px]">
              {verifyUrl}
            </a>
          </p>
        )}
      </div>
    </>
  )
}
