'use client'

import { useState } from 'react'
import { Loader2, ClipboardCheck } from 'lucide-react'
import type { SelfAssessmentQuestion } from '@/app/actions/ai-practice'

const SCALE_LABELS = ['Pas du tout', 'Un peu', 'Plutôt oui', 'Tout à fait']

interface Props {
  questions: SelfAssessmentQuestion[]
  submitting: boolean
  onSubmit: (_answers: Record<string, number | string>) => void
}

export default function SelfAssessmentForm({ questions, submitting, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<string, number | string>>({})

  const scaleQuestions = questions.filter(q => q.type === 'scale')
  const allScaleAnswered = scaleQuestions.every(q => typeof answers[q.id] === 'number')

  function setAnswer(id: string, value: number | string) {
    setAnswers(prev => ({ ...prev, [id]: value }))
  }

  return (
    <div className="flex flex-col gap-6">
      {questions.map((q, i) => (
        <div key={q.id}>
          <p className="text-sm font-semibold text-white/90 leading-snug mb-3">
            <span className="text-white/40 mr-1.5">{i + 1}.</span>{q.question}
          </p>

          {q.type === 'scale' ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SCALE_LABELS.map((label, idx) => {
                const value = idx + 1
                const active = answers[q.id] === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAnswer(q.id, value)}
                    aria-pressed={active}
                    className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all ${
                      active
                        ? 'bg-primary/20 border-primary text-white'
                        : 'bg-white/[0.03] border-white/10 text-white/60 hover:bg-white/[0.06] hover:text-white/80'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          ) : (
            <textarea
              value={(answers[q.id] as string) ?? ''}
              onChange={e => setAnswer(q.id, e.target.value)}
              rows={3}
              placeholder="Votre réponse…"
              className="w-full px-3.5 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white/90 placeholder:text-white/25 focus:border-primary focus:outline-none transition-colors resize-y"
            />
          )}
        </div>
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => onSubmit(answers)}
          disabled={!allScaleAnswered || submitting}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
          Voir mon bilan
        </button>
        {!allScaleAnswered && (
          <span className="text-xs text-white/30">Répondez à toutes les questions à échelle</span>
        )}
      </div>
    </div>
  )
}
