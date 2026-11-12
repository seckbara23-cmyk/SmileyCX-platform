'use client'

import { useState, useTransition } from 'react'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { deleteMyVoiceData, withdrawVoiceConsent } from '@/app/actions/voice-consent'

/**
 * XP-F2-04 — the learner's two rights on their voice data, where the voice
 * exercise is: withdraw the consent, and delete the data. Deleting asks for a
 * confirmation, and the result says plainly when the provider's copy is not
 * deleted yet.
 */
export default function VoiceDataControls() {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<'withdraw' | 'erase' | null>(null)
  const [message, setMessage] = useState('')
  const [isPending, startTransition] = useTransition()

  function withdraw() {
    setMessage('')
    startTransition(async () => {
      const res = await withdrawVoiceConsent()
      setConfirming(null)
      if (res.error) {
        setMessage(res.error)
        return
      }
      setMessage(
        res.erasure === 'pending_provider'
          ? 'Votre accord est retiré et vos entraînements vocaux sont supprimés de la plateforme. La suppression chez notre prestataire vocal n’a pas encore abouti pour une partie d’entre eux : elle est relancée automatiquement jusqu’à son terme.'
          : 'Votre accord est retiré et vos entraînements vocaux sont supprimés, sur la plateforme et chez notre prestataire vocal.',
      )
    })
  }

  function erase() {
    setMessage('')
    startTransition(async () => {
      const res = await deleteMyVoiceData()
      setConfirming(null)
      if (res.error) {
        setMessage(res.error)
        return
      }
      setMessage(
        res.erasure === 'pending_provider'
          ? 'Vos entraînements sont supprimés de la plateforme. La suppression chez notre prestataire vocal n’a pas encore abouti pour une partie d’entre eux : elle est relancée automatiquement jusqu’à son terme.'
          : 'Vos entraînements vocaux sont supprimés, sur la plateforme et chez notre prestataire vocal.',
      )
    })
  }

  return (
    <div className="mt-4 text-xs text-white/60">
      <button type="button" onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1.5 underline" aria-expanded={open}>
        <ShieldCheck className="w-3.5 h-3.5" /> Mes données vocales
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <p>
            Retirer votre accord arrête le traitement de votre voix et supprime vos entraînements vocaux
            (transcriptions et retours). Vous pouvez aussi supprimer ces données en gardant votre accord.
            Votre progression et le nombre d’essais déjà utilisés sont conservés.
          </p>
          <div className="flex flex-wrap gap-3">
            {confirming === null ? (
              <>
                <button type="button" onClick={() => setConfirming('withdraw')} disabled={isPending} className="px-3 py-1.5 rounded-lg border border-white/20 text-white/80 disabled:opacity-40">
                  Retirer mon accord
                </button>
                <button type="button" onClick={() => setConfirming('erase')} disabled={isPending} className="px-3 py-1.5 rounded-lg border border-red-400/40 text-red-200 disabled:opacity-40">
                  Supprimer mes données vocales
                </button>
              </>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                {confirming === 'withdraw' ? 'Retirer votre accord et supprimer vos entraînements vocaux ?' : 'Supprimer définitivement vos entraînements vocaux ?'}
                <button type="button" onClick={confirming === 'withdraw' ? withdraw : erase} disabled={isPending} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/80 text-white disabled:opacity-40">
                  {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Oui, confirmer
                </button>
                <button type="button" onClick={() => setConfirming(null)} disabled={isPending} className="px-3 py-1.5 rounded-lg text-white/60">
                  Annuler
                </button>
              </span>
            )}
          </div>
          {message && <p role="status" className="text-white/80">{message}</p>}
        </div>
      )}
    </div>
  )
}
