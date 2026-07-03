'use client'

import { TrendingUp, TrendingDown, RotateCcw, ArrowRight } from 'lucide-react'
import type { CoachingData } from '@/app/actions/ai-practice'

interface Props {
  data:       CoachingData
  onRetry:    () => void
  onContinue: () => void
}

function scoreColor(score: number): string {
  if (score >= 7) return 'text-success'
  if (score >= 5) return 'text-amber-300'
  return 'text-red-300'
}

function scoreBar(score: number): string {
  if (score >= 7) return 'bg-success'
  if (score >= 5) return 'bg-amber-400'
  return 'bg-red-400'
}

/**
 * Deterministic coaching summary (Phase 2A) — strengths, areas to improve,
 * competency scores, retry CTA. Rendered from stored engine output; no AI.
 */
export default function CoachingSummary({ data, onRetry, onContinue }: Props) {
  return (
    <div className="flex flex-col gap-6">

      {/* Overall */}
      <div className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/10">
        <span className={`text-3xl font-extrabold tabular-nums ${scoreColor(data.overallScore)}`}>
          {data.overallScore}<span className="text-base text-white/40 font-semibold">/10</span>
        </span>
        <p className="text-xs text-white/55 leading-relaxed">
          Score indicatif calculé automatiquement à partir de votre conversation.
          Utilisez la relecture ci-dessous pour comprendre chaque moment clé.
        </p>
      </div>

      {/* Competency scores */}
      <div>
        <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-2.5">
          Vos compétences sur cette session
        </p>
        <div className="flex flex-col gap-2">
          {data.scores.map(s => (
            <div key={s.key} className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-[13px] text-white/75 truncate">{s.labelFr}</span>
              <div className="flex-1 h-2 bg-white/[0.08] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${scoreBar(s.score)}`}
                  style={{ width: `${s.score * 10}%` }}
                />
              </div>
              <span className={`w-8 text-right text-[13px] font-bold tabular-nums ${scoreColor(s.score)}`}>
                {s.score}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Strengths / improvements */}
      <div className="grid sm:grid-cols-2 gap-4">
        {data.strengths.length > 0 && (
          <div className="px-4 py-3.5 rounded-xl bg-success/[0.06] border border-success/25">
            <p className="text-[11px] font-bold text-success uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5" aria-hidden /> Points forts
            </p>
            <ul className="flex flex-col gap-1.5">
              {data.strengths.map(s => (
                <li key={s.key} className="text-[13px] text-white/75 leading-relaxed">
                  <span className="font-semibold text-white/90">{s.labelFr}</span>
                  {s.evidenceFr && (
                    <span className="block text-xs text-white/45 mt-0.5">«&nbsp;{s.evidenceFr}&nbsp;»</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.improvements.length > 0 && (
          <div className="px-4 py-3.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/25">
            <p className="text-[11px] font-bold text-amber-300 uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <TrendingDown className="w-3.5 h-3.5" aria-hidden /> À travailler
            </p>
            <ul className="flex flex-col gap-1.5">
              {data.improvements.map(s => (
                <li key={s.key} className="text-[13px] text-white/75 leading-relaxed">
                  <span className="font-semibold text-white/90">{s.labelFr}</span>
                  {s.evidenceFr && (
                    <span className="block text-xs text-white/45 mt-0.5">«&nbsp;{s.evidenceFr}&nbsp;»</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-all"
        >
          Continuer vers l&apos;auto-évaluation <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 hover:text-white transition-all"
        >
          <RotateCcw className="w-4 h-4" aria-hidden /> Refaire l&apos;exercice
        </button>
      </div>
    </div>
  )
}
