'use client'

import { Lightbulb, ThumbsUp, AlertTriangle } from 'lucide-react'
import type { CoachingData } from '@/app/actions/ai-practice'

interface Props {
  turns:       CoachingData['turns']
  hints:       CoachingData['hints']
  personaName: string
}

/**
 * Conversation replay (Phase 2A): full transcript with deterministic coaching
 * hints attached to the learner turns the engine flagged. Pure render of
 * stored data — no AI at view time.
 */
export default function ConversationReplay({ turns, hints, personaName }: Props) {
  const hintsByTurn = new Map<number, typeof hints>()
  for (const h of hints) {
    const list = hintsByTurn.get(h.turnIndex) ?? []
    list.push(h)
    hintsByTurn.set(h.turnIndex, list)
  }

  return (
    <div>
      <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-3">
        Revoir la conversation
      </p>

      <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-1">
        {turns.map(t => {
          const turnHints = t.speaker === 'learner' ? hintsByTurn.get(t.turnIndex) : undefined
          const highlighted = (turnHints?.length ?? 0) > 0

          return (
            <div key={t.turnIndex} className={t.speaker === 'learner' ? 'text-right' : 'text-left'}>
              <p className={`text-[10px] font-bold uppercase tracking-widest mb-0.5 ${
                t.speaker === 'learner' ? 'text-primary/70' : 'text-white/40'
              }`}>
                {t.speaker === 'learner' ? 'Vous' : personaName}
              </p>

              <p className={`inline-block text-sm leading-relaxed px-3.5 py-2 rounded-2xl text-left ${
                t.speaker === 'learner'
                  ? highlighted
                    ? 'bg-primary/15 text-white/90 ring-1 ring-primary/40'
                    : 'bg-primary/15 text-white/90'
                  : 'bg-white/[0.05] text-white/80'
              }`}>
                {t.transcript}
              </p>

              {/* Deterministic coach hints on flagged learner turns */}
              {turnHints?.map((h, i) => (
                <div
                  key={i}
                  className={`mt-1.5 text-left inline-block max-w-full px-3.5 py-2.5 rounded-xl border text-xs leading-relaxed ${
                    h.kind === 'negative'
                      ? 'bg-amber-500/[0.08] border-amber-500/30'
                      : 'bg-success/[0.08] border-success/30'
                  }`}
                >
                  <p className="flex items-start gap-1.5 text-white/75">
                    {h.kind === 'negative'
                      ? <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" aria-hidden />
                      : <ThumbsUp className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" aria-hidden />}
                    <span>
                      <span className="font-semibold text-white/90">Coach&nbsp;: </span>
                      {h.commentFr}
                    </span>
                  </p>
                  {h.betterFr && (
                    <p className="flex items-start gap-1.5 mt-1.5 pt-1.5 border-t border-white/[0.08] text-white/65">
                      <Lightbulb className="w-3.5 h-3.5 text-amber-200 shrink-0 mt-0.5" aria-hidden />
                      <span>
                        <span className="font-semibold text-amber-200/90">Meilleure réponse&nbsp;: </span>
                        «&nbsp;{h.betterFr}&nbsp;»
                      </span>
                    </p>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
