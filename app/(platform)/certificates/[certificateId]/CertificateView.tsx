'use client'

interface Props {
  certNumber: string
  issuedAt: string
  learnerName: string
  courseTitle: string
}

function formatDateFR(dateStr: string) {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(dateStr))
}

export default function CertificateView({ certNumber, issuedAt, learnerName, courseTitle }: Props) {
  return (
    <>
      {/* Action bar */}
      <div className="flex items-center justify-between gap-3 mb-6 print:hidden">
        <a href="/dashboard" className="text-sm text-cx-gray hover:text-dark transition-colors">
          ← Mon espace
        </a>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-xl hover:bg-primary/90 transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Télécharger / Imprimer
          </button>
        </div>
      </div>

      {/* Certificate — screen + print target */}
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
              <text x="40" y="53" textAnchor="middle" fontSize="30" fill="white">★</text>
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

          {/* Footer */}
          <div className="cert-footer">
            <span>Délivré le {formatDateFR(issuedAt)}</span>
            <span className="cert-number">N° {certNumber}</span>
          </div>

        </div>
      </div>
    </>
  )
}
