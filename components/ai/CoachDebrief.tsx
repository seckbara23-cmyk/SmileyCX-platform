'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, GraduationCap, Sparkles } from 'lucide-react'
import { getSessionCoaching, type CoachingData } from '@/app/actions/ai-practice'
import { getSessionReport, evaluateSessionWithClaude } from '@/app/actions/ai-coach'
import { AI_COACH_CLAUDE_ENABLED } from '@/lib/ai/flags'
import type { ClaudeReport } from '@/lib/ai/claude-report'
import CoachingSummary from './CoachingSummary'
import ConversationReplay from './ConversationReplay'
import ClaudeCoachReport from './ClaudeCoachReport'

interface Props {
  sessionId:   string
  anonId?:     string
  personaName: string
  onRetry:     () => void
  onContinue:  () => void
}

/**
 * Coach debrief. Phase 2A: deterministic engine output (summary + replay).
 * Phase 2B (flag-gated): if a Claude report is already stored, show it; else
 * offer a one-shot "Analyse IA" trigger. Claude is never called automatically,
 * never more than once per session (stored report is reused on reload), and any
 * failure keeps the deterministic report visible with a non-blocking notice.
 * If no deterministic data exists, hand over to the self-assessment.
 */
export default function CoachDebrief({ sessionId, anonId, personaName, onRetry, onContinue }: Props) {
  const [data,    setData]    = useState<CoachingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [report,  setReport]  = useState<ClaudeReport | null>(null)
  const [aiError, setAiError] = useState('')
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getSessionCoaching({ sessionId, anonId }),
      AI_COACH_CLAUDE_ENABLED ? getSessionReport({ sessionId, anonId }) : Promise.resolve(null),
    ])
      .then(([coaching, stored]) => {
        if (cancelled) return
        setData(coaching)
        setReport(stored)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setData(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [sessionId, anonId])

  // No coaching data → skip the debrief entirely (self-assessment fallback).
  useEffect(() => {
    if (!loading && !data) onContinue()
  }, [loading, data, onContinue])

  function handleAnalyze() {
    setAiError('')
    startTransition(async () => {
      const res = await evaluateSessionWithClaude({ sessionId, anonId })
      if ('report' in res) {
        setReport(res.report)
      } else if ('reason' in res) {
        // Not configured / disabled / incomplete → stay on the deterministic report silently.
        if (res.reason === 'not_configured') {
          setAiError("L'analyse IA détaillée n'est pas encore disponible.")
        }
      } else {
        setAiError('Analyse IA indisponible pour le moment — votre bilan ci-dessous reste valable.')
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-white/45 py-6">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Préparation de votre bilan…
      </div>
    )
  }

  if (!data) return null

  // Claude report available → show the AI-enhanced report.
  if (report) {
    return (
      <ClaudeCoachReport
        report={report}
        turns={data.turns}
        personaName={personaName}
        onRetry={onRetry}
      />
    )
  }

  // Evaluation running.
  if (isPending) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-white/60 py-8">
        <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden />
        Analyse IA de votre conversation…
      </div>
    )
  }

  // Deterministic report (+ optional AI trigger when the Claude flag is on).
  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-center gap-2 text-white/80">
        <GraduationCap className="w-4 h-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">Le bilan de votre coach</p>
      </div>

      {AI_COACH_CLAUDE_ENABLED && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleAnalyze}
            className="self-start inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-all"
          >
            <Sparkles className="w-4 h-4" aria-hidden /> Obtenir l&apos;analyse IA détaillée
          </button>
          {aiError && <p className="text-xs text-amber-300/90">{aiError}</p>}
        </div>
      )}

      <CoachingSummary data={data} onRetry={onRetry} onContinue={onContinue} />

      <ConversationReplay turns={data.turns} hints={data.hints} personaName={personaName} />
    </div>
  )
}
