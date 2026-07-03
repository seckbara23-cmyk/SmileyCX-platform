'use client'

import { Sparkles, TrendingUp, TrendingDown, Lightbulb, ThumbsUp, AlertTriangle, Target, RotateCcw } from 'lucide-react'
import type { ClaudeReport } from '@/lib/ai/claude-report'
import type { CoachingData } from '@/app/actions/ai-practice'

interface Props {
  report: ClaudeReport
  turns:  CoachingData['turns']
  personaName: string
  onRetry: () => void
}

function scoreColor(s: number): string {
  if (s >= 7) return 'text-success'
  if (s >= 5) return 'text-amber-300'
  return 'text-red-300'
}
function scoreBar(s: number): string {
  if (s >= 7) return 'bg-success'
  if (s >= 5) return 'bg-amber-400'
  return 'bg-red-400'
}

const ANNOTATION_STYLE = {
  positive:    { border: 'border-success/30',    bg: 'bg-success/[0.08]',    Icon: ThumbsUp,      icon: 'text-success' },
  warning:     { border: 'border-amber-500/30',  bg: 'bg-amber-500/[0.08]',  Icon: AlertTriangle, icon: 'text-amber-300' },
  improvement: { border: 'border-primary/30',    bg: 'bg-primary/[0.08]',    Icon: Lightbulb,     icon: 'text-primary' },
} as const

/**
 * Claude-enhanced coach report (Phase 2B). Pure render of the stored evaluation
 * — no AI at view time. Shown when a Claude report exists; otherwise the
 * deterministic report is displayed instead.
 */
export default function ClaudeCoachReport({ report, turns, personaName, onRetry }: Props) {
  const annById = new Map(report.replay_annotations.map(a => [a.turn_index, a]))

  return (
    <div className="flex flex-col gap-7">

      {/* Header */}
      <div className="flex items-center gap-2 text-white/80">
        <Sparkles className="w-4 h-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">Analyse IA de votre coach</p>
      </div>

      {/* Overall + summary */}
      <div className="flex items-start gap-4 px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/10">
        <span className={`text-3xl font-extrabold tabular-nums shrink-0 ${scoreColor(report.overall_score)}`}>
          {report.overall_score}<span className="text-base text-white/40 font-semibold">/10</span>
        </span>
        <p className="text-sm text-white/75 leading-relaxed">{report.summary}</p>
      </div>

      {/* Competency scores + comments */}
      {report.competencies.length > 0 && (
        <div>
          <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-2.5">Compétences</p>
          <div className="flex flex-col gap-3">
            {report.competencies.map(c => (
              <div key={c.key}>
                <div className="flex items-center gap-3">
                  <span className="w-44 shrink-0 text-[13px] text-white/75 truncate">{c.key}</span>
                  <div className="flex-1 h-2 bg-white/[0.08] rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${scoreBar(c.score)}`} style={{ width: `${c.score * 10}%` }} />
                  </div>
                  <span className={`w-8 text-right text-[13px] font-bold tabular-nums ${scoreColor(c.score)}`}>{c.score}</span>
                </div>
                {c.comment && <p className="text-xs text-white/50 mt-1 ml-0 leading-relaxed">{c.comment}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strengths / areas to improve */}
      <div className="grid sm:grid-cols-2 gap-4">
        {report.strengths.length > 0 && (
          <div className="px-4 py-3.5 rounded-xl bg-success/[0.06] border border-success/25">
            <p className="text-[11px] font-bold text-success uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5" aria-hidden /> Points forts
            </p>
            <ul className="flex flex-col gap-1.5">
              {report.strengths.map((s, i) => (
                <li key={i} className="text-[13px] text-white/75 leading-relaxed flex items-start gap-2">
                  <span className="text-success mt-0.5">•</span> {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.areas_to_improve.length > 0 && (
          <div className="px-4 py-3.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/25">
            <p className="text-[11px] font-bold text-amber-300 uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <TrendingDown className="w-3.5 h-3.5" aria-hidden /> À améliorer
            </p>
            <ul className="flex flex-col gap-1.5">
              {report.areas_to_improve.map((s, i) => (
                <li key={i} className="text-[13px] text-white/75 leading-relaxed flex items-start gap-2">
                  <span className="text-amber-300 mt-0.5">•</span> {s}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Improvement plan */}
      <div className="px-4 py-3.5 rounded-xl bg-primary/[0.06] border border-primary/25">
        <p className="text-[11px] font-bold text-primary uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5" aria-hidden /> Votre plan de progression
        </p>
        <p className="text-[13px] text-white/80 leading-relaxed mb-2">
          <span className="font-semibold">Priorité&nbsp;:</span> {report.improvement_plan.priority}
        </p>
        <p className="text-[13px] text-white/80 leading-relaxed">
          <span className="font-semibold">Prochain objectif&nbsp;:</span> {report.improvement_plan.next_practice_goal}
        </p>
      </div>

      {/* Replay with AI annotations */}
      <div>
        <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-3">
          Relecture commentée
        </p>
        <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-1">
          {turns.map(t => {
            const ann = t.speaker === 'learner' ? annById.get(t.turnIndex) : undefined
            return (
              <div key={t.turnIndex} className={t.speaker === 'learner' ? 'text-right' : 'text-left'}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-0.5 ${
                  t.speaker === 'learner' ? 'text-primary/70' : 'text-white/40'
                }`}>
                  {t.speaker === 'learner' ? 'Vous' : personaName}
                </p>
                <p className={`inline-block text-sm leading-relaxed px-3.5 py-2 rounded-2xl text-left ${
                  t.speaker === 'learner'
                    ? ann ? 'bg-primary/15 text-white/90 ring-1 ring-primary/40' : 'bg-primary/15 text-white/90'
                    : 'bg-white/[0.05] text-white/80'
                }`}>
                  {t.transcript}
                </p>
                {ann && (() => {
                  const s = ANNOTATION_STYLE[ann.type]
                  return (
                    <div className={`mt-1.5 text-left inline-block max-w-full px-3.5 py-2.5 rounded-xl border text-xs leading-relaxed ${s.bg} ${s.border}`}>
                      <p className="flex items-start gap-1.5 text-white/75">
                        <s.Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${s.icon}`} aria-hidden />
                        <span><span className="font-semibold text-white/90">Coach&nbsp;: </span>{ann.comment}</span>
                      </p>
                      {ann.suggested_phrase && (
                        <p className="flex items-start gap-1.5 mt-1.5 pt-1.5 border-t border-white/[0.08] text-white/65">
                          <Lightbulb className="w-3.5 h-3.5 text-amber-200 shrink-0 mt-0.5" aria-hidden />
                          <span><span className="font-semibold text-amber-200/90">Meilleure réponse&nbsp;: </span>«&nbsp;{ann.suggested_phrase}&nbsp;»</span>
                        </p>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      </div>

      <div>
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
