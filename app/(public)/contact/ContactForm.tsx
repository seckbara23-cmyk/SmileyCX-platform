'use client'

import { useState, useTransition } from 'react'
import { sendContactMessage } from './actions'
import { CheckCircle, Loader2 } from 'lucide-react'

const SERVICES = [
  { value: '', label: 'Choisir un service…' },
  { value: 'online', label: 'Formation en ligne' },
  { value: 'presentiel', label: 'Formation en présentiel' },
  { value: 'autre', label: 'Autre' },
]

export default function ContactForm({ defaultService }: { defaultService?: string }) {
  const [pending, startTransition] = useTransition()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const data = new FormData(e.currentTarget)
    startTransition(async () => {
      const result = await sendContactMessage(data)
      if (result.error) {
        setError(result.error)
      } else {
        setSent(true)
      }
    })
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-success" />
        </div>
        <h2 className="text-xl font-bold text-dark">Message envoyé !</h2>
        <p className="text-cx-gray max-w-sm">
          Merci pour votre message. Nous vous répondrons dans les plus brefs délais.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid sm:grid-cols-2 gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-semibold text-dark">Nom complet <span className="text-red-500">*</span></label>
          <input
            id="name"
            name="name"
            type="text"
            required
            placeholder="Aminata Diallo"
            className="w-full px-4 py-2.5 rounded-xl border border-black/[0.1] text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-semibold text-dark">Adresse email <span className="text-red-500">*</span></label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="aminata@exemple.com"
            className="w-full px-4 py-2.5 rounded-xl border border-black/[0.1] text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="service" className="text-sm font-semibold text-dark">Service</label>
          <select
            id="service"
            name="service"
            defaultValue={defaultService ?? ''}
            className="w-full px-4 py-2.5 rounded-xl border border-black/[0.1] text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          >
            {SERVICES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="subject" className="text-sm font-semibold text-dark">Sujet <span className="text-red-500">*</span></label>
          <input
            id="subject"
            name="subject"
            type="text"
            required
            placeholder="Formation équipe service client"
            className="w-full px-4 py-2.5 rounded-xl border border-black/[0.1] text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="message" className="text-sm font-semibold text-dark">Message <span className="text-red-500">*</span></label>
        <textarea
          id="message"
          name="message"
          required
          rows={5}
          placeholder="Décrivez votre besoin ou posez votre question…"
          className="w-full px-4 py-2.5 rounded-xl border border-black/[0.1] text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark disabled:opacity-60 transition-all w-full sm:w-auto"
      >
        {pending && <Loader2 className="w-4 h-4 animate-spin" />}
        Envoyer le message
      </button>
    </form>
  )
}
