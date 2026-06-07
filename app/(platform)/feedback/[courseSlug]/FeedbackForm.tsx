'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Loader2, Star } from 'lucide-react'
import { submitFeedback } from '@/app/actions/feedback'

interface Props {
  courseId: string
}

function StarRating({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (rating: number) => void
}) {
  const [hovered, setHovered] = useState(0)
  return (
    <div>
      <p className="text-sm font-semibold text-dark mb-2">{label}</p>
      <div className="flex gap-1" onMouseLeave={() => setHovered(0)}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHovered(n)}
            onClick={() => onChange(n)}
            className="p-0.5 transition-transform hover:scale-110 focus:outline-none"
            aria-label={`${n} étoile${n > 1 ? 's' : ''}`}
          >
            <Star
              className={`w-8 h-8 transition-colors ${
                n <= (hovered || value)
                  ? 'fill-amber-400 text-amber-400'
                  : 'fill-none text-gray-300'
              }`}
            />
          </button>
        ))}
        {value > 0 && (
          <span className="ml-2 self-center text-sm text-cx-gray font-semibold">
            {['', 'Insuffisant', 'Passable', 'Bien', 'Très bien', 'Excellent'][value]}
          </span>
        )}
      </div>
    </div>
  )
}

export default function FeedbackForm({ courseId }: Props) {
  const router = useRouter()

  const [clarity,    setClarity]    = useState(0)
  const [practical,  setPractical]  = useState(0)
  const [easeOfUse,  setEaseOfUse]  = useState(0)
  const [mostUseful, setMostUseful] = useState('')
  const [confusing,  setConfusing]  = useState('')
  const [recommend,  setRecommend]  = useState<boolean | undefined>(undefined)
  const [fairPrice,  setFairPrice]  = useState('')
  const [comment,    setComment]    = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitted,  setSubmitted]  = useState(false)
  const [error,      setError]      = useState('')

  const canSubmit = clarity > 0 && practical > 0 && easeOfUse > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')

    const result = await submitFeedback({
      courseId,
      clarityRating:        clarity,
      practicalValueRating: practical,
      easeOfUseRating:      easeOfUse,
      mostUseful:           mostUseful.trim() || undefined,
      confusingPart:        confusing.trim()  || undefined,
      wouldRecommend:       recommend,
      fairPrice:            fairPrice.trim()  || undefined,
      comment:              comment.trim()    || undefined,
    })

    setSubmitting(false)
    if (result.error) {
      setError(result.error)
    } else {
      setSubmitted(true)
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mb-4">
          <CheckCircle className="w-8 h-8 text-success" />
        </div>
        <h2 className="text-xl font-extrabold text-dark mb-2">Merci pour votre retour&nbsp;!</h2>
        <p className="text-sm text-cx-gray max-w-sm mb-6">
          Vos réponses nous aident à améliorer XP Client Academy pour la prochaine version.
        </p>
        <button
          onClick={() => router.push('/dashboard')}
          className="px-6 py-3 bg-primary text-white font-semibold rounded-cx hover:bg-primary/90 transition-colors text-sm"
        >
          Retour à mon espace
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">

      {/* Ratings */}
      <div className="cx-card p-6 space-y-6">
        <h2 className="text-base font-bold text-dark border-b border-black/[0.06] pb-3">
          Évaluez votre expérience{' '}
          <span className="text-cx-gray font-normal text-sm">(obligatoire)</span>
        </h2>
        <StarRating label="Clarté du contenu" value={clarity} onChange={setClarity} />
        <StarRating label="Valeur pratique" value={practical} onChange={setPractical} />
        <StarRating label="Facilité d'utilisation de la plateforme" value={easeOfUse} onChange={setEaseOfUse} />
      </div>

      {/* Open questions */}
      <div className="cx-card p-6 space-y-5">
        <h2 className="text-base font-bold text-dark border-b border-black/[0.06] pb-3">
          Vos retours{' '}
          <span className="text-cx-gray font-normal text-sm">(facultatif)</span>
        </h2>

        <div>
          <label htmlFor="fb-most-useful" className="block text-sm font-semibold text-dark mb-1.5">
            Qu&apos;est-ce qui vous a été le plus utile&nbsp;?
          </label>
          <textarea
            id="fb-most-useful"
            value={mostUseful}
            onChange={e => setMostUseful(e.target.value)}
            rows={3}
            placeholder="Les exemples concrets, les exercices pratiques…"
            className="w-full px-3 py-2.5 rounded-xl border border-black/[0.1] text-sm bg-light focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        <div>
          <label htmlFor="fb-confusing" className="block text-sm font-semibold text-dark mb-1.5">
            Qu&apos;est-ce qui était confus ou difficile à suivre&nbsp;?
          </label>
          <textarea
            id="fb-confusing"
            value={confusing}
            onChange={e => setConfusing(e.target.value)}
            rows={3}
            placeholder="Navigation, formulation des questions, rythme…"
            className="w-full px-3 py-2.5 rounded-xl border border-black/[0.1] text-sm bg-light focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        <div>
          <p className="text-sm font-semibold text-dark mb-2">
            Recommanderiez-vous cette formation&nbsp;?
          </p>
          <div className="flex gap-3" role="group" aria-label="Recommandation">
            {([true, false] as const).map(val => (
              <button
                key={String(val)}
                type="button"
                onClick={() => setRecommend(val)}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold border-2 transition-colors ${
                  recommend === val
                    ? val
                      ? 'border-success bg-success/10 text-success'
                      : 'border-red-400 bg-red-50 text-red-600'
                    : 'border-black/[0.08] text-cx-gray hover:border-black/20'
                }`}
              >
                {val ? 'Oui' : 'Non'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="fb-fair-price" className="block text-sm font-semibold text-dark mb-1.5">
            Quel prix vous semblerait juste pour cette formation&nbsp;?
          </label>
          <input
            id="fb-fair-price"
            type="text"
            value={fairPrice}
            onChange={e => setFairPrice(e.target.value)}
            placeholder="Ex : 15 000 FCFA, 25€…"
            className="w-full sm:w-64 px-3 py-2.5 rounded-xl border border-black/[0.1] text-sm bg-light focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div>
          <label htmlFor="fb-comment" className="block text-sm font-semibold text-dark mb-1.5">
            Commentaire libre{' '}
            <span className="text-cx-gray font-normal">(facultatif)</span>
          </label>
          <textarea
            id="fb-comment"
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={4}
            placeholder="Tout ce que vous souhaitez nous partager…"
            className="w-full px-3 py-2.5 rounded-xl border border-black/[0.1] text-sm bg-light focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-500">{error}</p>
      )}

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-cx hover:bg-primary/90 transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting ? 'Envoi en cours…' : 'Envoyer mon avis'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/dashboard')}
          className="text-sm text-cx-gray hover:text-dark transition-colors"
        >
          Passer pour l&apos;instant
        </button>
      </div>
    </form>
  )
}
