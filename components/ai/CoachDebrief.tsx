'use client'

import { useEffect, useState } from 'react'
import { Loader2, GraduationCap } from 'lucide-react'
import { getSessionCoaching, type CoachingData } from '@/app/actions/ai-practice'
import CoachingSummary from './CoachingSummary'
import ConversationReplay from './ConversationReplay'

interface Props {
  sessionId:   string
  anonId?:     string
  personaName: string
  onRetry:     () => void
  onContinue:  () => void
}

/**
 * Coach debrief (Phase 2A): loads the stored deterministic engine output for
 * the completed session and renders the coaching summary + replay. If no
 * coaching data exists (engine skipped, tables absent, error), it silently
 * hands over to the self-assessment — Phase 1 behavior is always available.
 */
export default function CoachDebrief({ sessionId, anonId, personaName, onRetry, onContinue }: Props) {
  const [data,    setData]    = useState<CoachingData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSessionCoaching({ sessionId, anonId })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [sessionId, anonId])

  // No coaching data → skip the debrief entirely (self-assessment fallback).
  useEffect(() => {
    if (!loading && !data) onContinue()
  }, [loading, data, onContinue])

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-white/45 py-6">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Préparation de votre bilan…
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-center gap-2 text-white/80">
        <GraduationCap className="w-4 h-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">Le bilan de votre coach</p>
      </div>

      <CoachingSummary data={data} onRetry={onRetry} onContinue={onContinue} />

      <ConversationReplay turns={data.turns} hints={data.hints} personaName={personaName} />
    </div>
  )
}
