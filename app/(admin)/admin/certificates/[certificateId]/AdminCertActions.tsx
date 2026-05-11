'use client'

import { useState } from 'react'
import QRCode from 'react-qr-code'
import { Copy, Check, RefreshCw, Download, ExternalLink, Loader2 } from 'lucide-react'

interface Props {
  certId: string
  certNumber: string
  certPageUrl: string
  verifyUrl: string
  pdfUrl: string | null
}

export default function AdminCertActions({ certId, certNumber, certPageUrl, verifyUrl, pdfUrl }: Props) {
  const [copied, setCopied]         = useState(false)
  const [regenState, setRegenState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [currentPdfUrl, setPdfUrl]  = useState(pdfUrl)

  async function copyVerifyLink() {
    await navigator.clipboard.writeText(verifyUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function regeneratePdf() {
    setRegenState('loading')
    try {
      const res = await fetch(`/api/certificates/${certId}/pdf`)
      if (!res.ok) throw new Error('failed')
      const { pdf_url } = await res.json()
      if (pdf_url) setPdfUrl(pdf_url)
      setRegenState('done')
      setTimeout(() => setRegenState('idle'), 3000)
    } catch {
      setRegenState('error')
      setTimeout(() => setRegenState('idle'), 3000)
    }
  }

  return (
    <div className="space-y-5">
      {/* QR Code */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">QR de vérification</p>
        <div className="bg-white border border-gray-100 rounded-xl p-4 inline-block">
          <QRCode value={verifyUrl} size={120} level="M" />
        </div>
        <p className="text-xs text-gray-400 mt-2 break-all">{verifyUrl}</p>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</p>

        <a
          href={certPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 w-full px-4 py-2.5 bg-primary text-white text-sm font-semibold rounded-xl hover:bg-primary/90 transition-colors"
        >
          <ExternalLink className="w-4 h-4 shrink-0" /> Voir le certificat
        </a>

        <a
          href={verifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 w-full px-4 py-2.5 bg-light border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:bg-white transition-colors"
        >
          <ExternalLink className="w-4 h-4 shrink-0" /> Page de vérification
        </a>

        <button
          onClick={copyVerifyLink}
          className="flex items-center gap-2.5 w-full px-4 py-2.5 bg-light border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:bg-white transition-colors"
        >
          {copied
            ? <><Check className="w-4 h-4 shrink-0 text-success" /> Copié !</>
            : <><Copy className="w-4 h-4 shrink-0" /> Copier le lien de vérification</>
          }
        </button>

        {currentPdfUrl ? (
          <a
            href={currentPdfUrl}
            download={`certificat-${certNumber}.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 w-full px-4 py-2.5 bg-success/10 text-success text-sm font-semibold rounded-xl hover:bg-success/20 transition-colors border border-success/20"
          >
            <Download className="w-4 h-4 shrink-0" /> Télécharger le PDF
          </a>
        ) : null}

        <button
          onClick={regeneratePdf}
          disabled={regenState === 'loading'}
          className={`flex items-center gap-2.5 w-full px-4 py-2.5 text-sm font-semibold rounded-xl border transition-colors ${
            regenState === 'done'    ? 'bg-success/10 text-success border-success/20' :
            regenState === 'error'   ? 'bg-red-50 text-red-600 border-red-200' :
            regenState === 'loading' ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' :
            'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
          }`}
        >
          {regenState === 'loading' ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> :
           regenState === 'done'    ? <Check className="w-4 h-4 shrink-0" /> :
                                      <RefreshCw className="w-4 h-4 shrink-0" />}
          {regenState === 'loading' ? 'Génération…' :
           regenState === 'done'    ? 'PDF régénéré !' :
           regenState === 'error'   ? 'Erreur — réessayer' :
           currentPdfUrl            ? 'Régénérer le PDF' : 'Générer le PDF'}
        </button>
      </div>

      {/* PDF status */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Statut PDF</p>
        {currentPdfUrl ? (
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success bg-success/10 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-success" /> Généré
            </span>
            <p className="text-xs text-gray-400 break-all mt-1">{currentPdfUrl}</p>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Manquant
          </span>
        )}
      </div>
    </div>
  )
}
