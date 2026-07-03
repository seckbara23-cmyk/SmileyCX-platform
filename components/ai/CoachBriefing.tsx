'use client'

import { Mic, Target, Clock, BarChart3, CheckCircle2, Loader2 } from 'lucide-react'
import type { VoiceBriefing } from '@/app/actions/ai-practice'

const DIFFICULTY_LABELS = ['Découverte', 'Facile', 'Intermédiaire', 'Avancé', 'Expert']

interface Props {
  briefing:   VoiceBriefing
  pending:    boolean
  startLabel: string
  disabled:   boolean
  onStart:    () => void
}

/** Pre-conversation coach briefing — pure scenario configuration, no AI. */
export default function CoachBriefing({ briefing, pending, startLabel, disabled, onStart }: Props) {
  const difficulty = briefing.difficulty && briefing.difficulty >= 1 && briefing.difficulty <= 5
    ? briefing.difficulty
    : null

  return (
    <div className="flex flex-col gap-5">

      {/* Objective */}
      {briefing.objective_fr && (
        <div className="px-4 py-3.5 rounded-xl bg-primary/[0.08] border border-primary/25">
          <p className="text-[11px] font-bold text-primary/90 uppercase tracking-widest mb-1.5">
            Objectif du jour
          </p>
          <p className="text-sm text-white/85 leading-relaxed">{briefing.objective_fr}</p>
        </div>
      )}

      {/* Meta row: duration + difficulty */}
      {(briefing.duration_min || difficulty) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-white/55">
          {briefing.duration_min && (
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" aria-hidden />
              Durée estimée&nbsp;: ~{briefing.duration_min}&nbsp;min
            </span>
          )}
          {difficulty && (
            <span className="flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" aria-hidden />
              Difficulté&nbsp;: {DIFFICULTY_LABELS[difficulty - 1]}
              <span className="flex items-center gap-0.5 ml-1" aria-hidden>
                {[1, 2, 3, 4, 5].map(i => (
                  <span
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full ${i <= difficulty ? 'bg-primary' : 'bg-white/15'}`}
                  />
                ))}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Goals */}
      {(briefing.goals_fr?.length ?? 0) > 0 && (
        <div>
          <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5" aria-hidden /> Vos objectifs
          </p>
          <ul className="flex flex-col gap-1.5">
            {briefing.goals_fr!.map((g, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-white/75 leading-relaxed">
                <span className="text-primary mt-0.5">•</span> {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Success criteria */}
      {(briefing.success_criteria_fr?.length ?? 0) > 0 && (
        <div>
          <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Critères de réussite
          </p>
          <ul className="flex flex-col gap-1.5">
            {briefing.success_criteria_fr!.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-white/60 leading-relaxed">
                <CheckCircle2 className="w-3.5 h-3.5 text-success/70 shrink-0 mt-0.5" aria-hidden /> {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={onStart}
          disabled={disabled || pending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
          {startLabel}
        </button>
      </div>
    </div>
  )
}
