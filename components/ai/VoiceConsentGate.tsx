'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { acceptVoiceConsent } from '@/app/actions/voice-consent'

/**
 * XP-F2-01 — explicit consent to the voice processing, before the first
 * conversation (privacy policy art. 6). The box starts unticked; the server
 * records the accepted version and refuses any voice session without it.
 */
export default function VoiceConsentGate({
  version,
  textFr,
  onAccepted,
  onCancel,
}: {
  version: string
  textFr: string
  onAccepted: () => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()

  function accept() {
    setError('')
    startTransition(async () => {
      const res = await acceptVoiceConsent({ version, accepted: checked })
      if (res.error) {
        setError(res.error)
        return
      }
      onAccepted()
    })
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4 rounded-xl bg-white/[0.03] border border-white/10">
      <div className="flex items-center gap-2 text-sm font-bold text-white">
        <ShieldCheck className="w-4 h-4 text-primary" /> Votre accord avant l’entraînement vocal
      </div>
      <label className="flex items-start gap-3 text-sm text-white/80 leading-relaxed">
        <input
          type="checkbox"
          name="voiceConsent"
          checked={checked}
          onChange={e => setChecked(e.target.checked)}
          className="mt-1"
        />
        <span>
          {textFr}{' '}
          <Link href="/privacy" className="underline text-primary">Politique de confidentialité, article 6</Link>.
        </span>
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={accept}
          disabled={!checked || isPending}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-40"
        >
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Accepter et commencer
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-xl text-sm text-white/60">
          Annuler
        </button>
      </div>
    </div>
  )
}
