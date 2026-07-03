'use client'

import { RotateCcw, Lightbulb } from 'lucide-react'
import type { SelfAssessmentQuestion } from '@/app/actions/ai-practice'

const SCALE_LABELS = ['Pas du tout', 'Un peu', 'Plutôt oui', 'Tout à fait']

interface Props {
  questions: SelfAssessmentQuestion[]
  answers:   Record<string, number | string>
  onRetry:   () => void
}

export default function SessionSummary({ questions, answers, onRetry }: Props) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-white/60 leading-relaxed">
        Voici votre bilan. Comparez vos réponses aux repères d&apos;un conseiller expérimenté,
        puis recommencez pour progresser.
      </p>

      <div className="flex flex-col gap-4">
        {questions.map((q, i) => {
          const answer = answers[q.id]
          const answerLabel =
            q.type === 'scale' && typeof answer === 'number'
              ? SCALE_LABELS[answer - 1] ?? '—'
              : (answer as string) || '—'

          return (
            <div key={q.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-sm font-semibold text-white/90 leading-snug mb-2">
                <span className="text-white/40 mr-1.5">{i + 1}.</span>{q.question}
              </p>

              <p className="text-xs text-white/50 mb-2">
                <span className="font-semibold text-white/70">Votre réponse&nbsp;:</span>{' '}
                <span className={q.type === 'text' ? 'italic' : ''}>{answerLabel}</span>
              </p>

              {q.guidance && (
                <div className="flex items-start gap-2 mt-2 pt-2 border-t border-white/[0.06]">
                  <Lightbulb className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
                  <p className="text-xs text-white/55 leading-relaxed">
                    <span className="font-semibold text-amber-200/90">Ce qu&apos;un excellent conseiller aurait fait&nbsp;: </span>
                    {q.guidance}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 hover:text-white transition-all"
        >
          <RotateCcw className="w-4 h-4" /> Recommencer la pratique
        </button>
      </div>
    </div>
  )
}
