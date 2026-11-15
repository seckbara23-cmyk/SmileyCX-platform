'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, HelpCircle, Loader2, RotateCcw } from 'lucide-react'
import { getVoiceFeedback } from '@/app/actions/ai-practice'
import type { VoiceFeedback, CriterionResult } from '@/lib/voice/feedback'

/**
 * XP-F2-01 — the learner's qualitative feedback after a voice exercise:
 * per observation criterion, réussi / à retravailler / pas assez d'éléments,
 * with its rationale. No score. An invitation to retry when the objective
 * was not met. Polls briefly while the provider finishes its analysis.
 */

const POLL_MS = 4000
const MAX_POLLS = 8

const ICON: Record<CriterionResult, typeof CheckCircle2> = {
  success: CheckCircle2,
  failure: AlertCircle,
  unknown: HelpCircle,
}

export default function VoiceFeedbackPanel({
  sessionId,
  onContinue,
  onRetry,
}: {
  sessionId: string
  onContinue: () => void
  onRetry: () => void
}) {
  const [feedback, setFeedback] = useState<VoiceFeedback | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let polls = 0
    async function load() {
      const res = await getVoiceFeedback({ sessionId })
      if (cancelled) return
      if (res.feedback) return setFeedback(res.feedback)
      if (res.pending && ++polls < MAX_POLLS) return void setTimeout(load, POLL_MS)
      setError(res.error ?? 'Le retour n’est pas encore disponible. Vous pouvez continuer et revenir plus tard.')
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId])

  if (!feedback && !error) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/70">
        <Loader2 className="w-4 h-4 animate-spin" /> Préparation de votre retour…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {feedback && (
        <>
          <p className="text-sm font-semibold text-white">{feedback.summaryFr}</p>
          <ul className="flex flex-col gap-3">
            {feedback.criteria.map(c => {
              const Icon = ICON[c.result]
              return (
                <li key={c.id} className="px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Icon className="w-4 h-4 text-primary" /> {c.labelFr} — {c.resultLabelFr}
                  </p>
                  <p className="mt-1 text-sm text-white/70 leading-relaxed">{c.rationaleFr}</p>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {error && <p className="text-sm text-white/70">{error}</p>}
      <div className="flex gap-3">
        {feedback?.retryInvited && (
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold">
            <RotateCcw className="w-4 h-4" /> Recommencer l’exercice
          </button>
        )}
        <button type="button" onClick={onContinue} className="px-4 py-2 rounded-xl text-sm text-white/80 border border-white/15">
          Continuer
        </button>
      </div>
    </div>
  )
}
