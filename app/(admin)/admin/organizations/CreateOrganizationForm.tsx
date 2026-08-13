'use client'

import { useState, useTransition } from 'react'
import { createOrganization } from '@/app/actions/organizations'
import { normalizeOrgSlug } from '@/lib/organizations'

const field =
  'px-3 py-2 rounded-lg border border-[#dde2f0] text-xs font-normal focus:outline-none focus:border-primary'

export default function CreateOrganizationForm() {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [industry, setIndustry] = useState('')
  const [country, setCountry] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const effectiveSlug = normalizeOrgSlug(slug || name)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setResult(null)
    startTransition(async () => {
      const r = await createOrganization({
        name,
        slug: slug || undefined,
        industry: industry || null,
        country: country || null,
      })
      setResult({ ok: r.ok, message: r.message ?? '' })
      if (r.ok) { setName(''); setSlug(''); setIndustry(''); setCountry('') }
    })
  }

  return (
    <form onSubmit={submit} className="cx-card p-5">
      <h2 className="text-sm font-extrabold text-dark mb-1">Nouvelle organisation</h2>
      <p className="text-xs text-cx-gray mb-4">
        Crée uniquement la structure. Les accès aux formations restent accordés
        individuellement depuis « Accès formations ».
      </p>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Nom
        <input
          type="text" required maxLength={120} className={field}
          value={name} onChange={e => setName(e.target.value)}
          placeholder="ex. Transit Dakar SARL"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Identifiant <span className="font-normal text-cx-gray">(optionnel)</span>
        <input
          type="text" maxLength={60} className={field}
          value={slug} onChange={e => setSlug(e.target.value)}
          placeholder="dérivé du nom si vide"
        />
        {effectiveSlug && (
          <span className="font-normal text-cx-gray font-mono">{effectiveSlug}</span>
        )}
      </label>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <label className="flex flex-col gap-1 text-xs font-semibold text-dark">
          Secteur
          <input
            type="text" maxLength={80} className={field}
            value={industry} onChange={e => setIndustry(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-dark">
          Pays
          <input
            type="text" maxLength={80} className={field}
            value={country} onChange={e => setCountry(e.target.value)}
          />
        </label>
      </div>

      <button
        type="submit" disabled={pending || !name.trim()}
        className="w-full px-4 py-2.5 rounded-cx bg-primary text-white text-sm font-bold hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {pending ? 'Création…' : 'Créer l’organisation'}
      </button>

      {result && (
        <p className={`mt-3 text-xs font-semibold ${result.ok ? 'text-success' : 'text-error'}`}>
          {result.message}
        </p>
      )}
    </form>
  )
}
