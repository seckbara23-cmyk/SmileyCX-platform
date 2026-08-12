'use client'

import { useState, useTransition } from 'react'
import { Dumbbell, CheckCircle, RotateCcw, Loader2 } from 'lucide-react'
import DragMatchQuestion, { type DragMatchOptions } from '@/components/quiz/DragMatchQuestion'
import { submitExercise, type ExerciseSubmitResult } from '@/app/actions/exercise'

export interface ExerciseCategory {
  id:    string
  name:  string
  color: string | null
}

// XPA-6D. `correct_category_id` is deliberately absent. It was here, it was
// fetched by the browser, and correctness was compared against it client-side —
// the answer key was in the page on every lesson render. The authoritative
// mapping now arrives only in the scoring result, after submission.
export interface ExerciseItem {
  id:    string
  label: string
}

export interface ExerciseData {
  id:           string
  title:        string
  instructions: string | null
  categories:   ExerciseCategory[]
  items:        ExerciseItem[]
}

interface Props {
  exercise: ExerciseData
}

export default function ExerciseBlock({ exercise }: Props) {
  const [placements,  setPlacements]  = useState<Record<string, string>>({})
  const [submitted,   setSubmitted]   = useState(false)
  const [result,      setResult]      = useState<ExerciseSubmitResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isPending,   startTransition] = useTransition()

  const options: DragMatchOptions = {
    categories: exercise.categories.map(c => ({ id: c.id, label: c.name })),
    items:      exercise.items.map(i => ({ id: i.id, label: i.label })),
  }

  const allPlaced = exercise.items.every(item => item.id in placements)

  // Derived from the SERVER's result, not from the exercise payload. Before
  // submission `result` is null, so there is nothing here to reveal.
  const correctPlacements: Record<string, string> = result
    ? Object.fromEntries(
        Object.entries(result.itemResults).map(([itemId, r]) => [itemId, r.correctCategoryId]),
      )
    : {}

  function handleValidate() {
    if (!allPlaced || submitted) return
    setSubmitted(true)

    startTransition(async () => {
      // Always scored server-side. The former `pilotMode` branch graded in the
      // browser against a client-held key; the server action handles anonymous
      // and pilot callers alike (it scores for everyone and persists only for
      // an authenticated user), so there is no case left that needs it.
      const { result: res, error } = await submitExercise({
        exerciseId: exercise.id,
        placements,
      })
      if (res) setResult(res)
      else if (error) setSubmitError(error)
    })
  }

  function handleReset() {
    setPlacements({})
    setSubmitted(false)
    setResult(null)
    setSubmitError(null)
  }

  return (
    <div className="mt-10 pt-8 border-t border-white/10">

      {/* Section header */}
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
          <Dumbbell className="w-4 h-4 text-primary" />
        </div>
        <div>
          <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Exercice pratique</p>
          <h3 className="text-base font-bold text-white leading-snug">{exercise.title}</h3>
        </div>
      </div>

      {exercise.instructions && (
        <p className="text-sm text-white/60 mb-5 leading-relaxed">{exercise.instructions}</p>
      )}

      {/* Drag-and-match */}
      <DragMatchQuestion
        questionId={exercise.id}
        options={options}
        placements={placements}
        onPlacementsChange={setPlacements}
        submitted={submitted}
        correctPlacements={result ? correctPlacements : undefined}
      />

      {/* Scoring failed — say so rather than silently showing no feedback */}
      {submitted && submitError && (
        <div className="mt-4 px-4 py-3 rounded-xl border bg-red-500/10 border-red-500/30">
          <p className="text-sm font-semibold text-white">{submitError}</p>
          <p className="text-xs text-white/40 mt-0.5">Réessayez dans un instant.</p>
        </div>
      )}

      {/* Result banner */}
      {submitted && result && (
        <div className={`mt-4 flex items-center gap-3 px-4 py-3 rounded-xl border ${
          result.score === 100
            ? 'bg-green-500/10 border-green-500/30'
            : result.score >= 60
            ? 'bg-amber-500/10 border-amber-500/30'
            : 'bg-red-500/10 border-red-500/30'
        }`}>
          <CheckCircle className={`w-5 h-5 shrink-0 ${
            result.score === 100 ? 'text-green-400' : result.score >= 60 ? 'text-amber-400' : 'text-red-400'
          }`} />
          <div className="flex-1">
            <p className="text-sm font-bold text-white">
              {result.correct} / {result.total} correct{result.correct > 1 ? 's' : ''}
              <span className="font-normal text-white/50 ml-2">({result.score}%)</span>
            </p>
            <p className="text-xs text-white/40 mt-0.5">
              {result.score === 100
                ? 'Parfait ! Vous maîtrisez ce contenu.'
                : result.score >= 60
                ? 'Bon travail ! Relisez les éléments incorrects.'
                : 'Continuez à pratiquer pour renforcer vos acquis.'}
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex items-center gap-3">
        {!submitted ? (
          <button
            onClick={handleValidate}
            disabled={!allPlaced || isPending}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Valider mes réponses
          </button>
        ) : (
          <button
            onClick={handleReset}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 hover:text-white transition-all"
          >
            <RotateCcw className="w-4 h-4" /> Réessayer
          </button>
        )}
        {!submitted && !allPlaced && (
          <span className="text-xs text-white/30">
            Placez tous les éléments pour valider
          </span>
        )}
      </div>
    </div>
  )
}
