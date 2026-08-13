'use client'
import { useState, useTransition } from 'react'
import { KeyRound } from 'lucide-react'
import { grantEntitlement } from '@/app/actions/entitlements'
import {
  ADMIN_SELECTABLE_SOURCES,
  EXPIRY_RULES,
  SOURCE_LABELS,
  type EntitlementSource,
} from '@/lib/entitlements'

interface Option { id: string; label: string }

/**
 * Manual admin activation (XPA-6B, ratified decision 6).
 *
 * ── THE EXPIRY CONTROL IS THE INTERESTING PART (Q-M) ─────────────────────
 * For PROMOTIONAL_GRANT the administrator must CHOOSE, and the database cannot
 * tell "chose perpetual" from "never looked at the field" — both arrive as
 * null. So the choice is carried as an explicit radio plus an
 * `expiryDecisionMade` flag, and the form refuses to submit until one is
 * picked. A defaulted perpetual promotional access is exactly the mistake this
 * prevents.
 */
export default function GrantEntitlementForm({
  learners,
  courses,
}: {
  learners: Option[]
  courses: Option[]
}) {
  const [pending, startTransition] = useTransition()
  const [userId, setUserId] = useState('')
  const [courseId, setCourseId] = useState('')
  const [source, setSource] = useState<EntitlementSource>('MANUAL_ADMIN')
  const [expiryMode, setExpiryMode] = useState<'' | 'never' | 'date'>('')
  const [expiresAt, setExpiresAt] = useState('')
  // XPA-6C: `grantEntitlement` has always accepted `startsAt` and
  // `entitlement_accessible()` has always denied before it; the form simply
  // never offered the field. An evaluation window that opens on an agreed date
  // is the ordinary commercial case.
  const [startsAt, setStartsAt] = useState('')
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const rule = EXPIRY_RULES[source]
  const mustChoose = rule === 'explicit_choice'
  const mustExpire = rule === 'required'

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setResult(null)

    const decided = mustExpire ? true : expiryMode !== ''
    if (mustChoose && !decided) {
      setResult({ ok: false, message: "Choisissez explicitement une échéance pour un accès promotionnel." })
      return
    }

    startTransition(async () => {
      const r = await grantEntitlement({
        userId,
        courseId,
        source,
        expiresAt: expiryMode === 'date' || mustExpire ? (expiresAt || null) : null,
        expiryDecisionMade: decided,
        startsAt: startsAt || null,
        reason,
      })
      setResult({ ok: r.ok, message: r.message ?? '' })
      if (r.ok) {
        setUserId(''); setCourseId(''); setExpiryMode(''); setExpiresAt('')
        setStartsAt(''); setReason('')
      }
    })
  }

  const field = 'w-full px-3 py-2 rounded-cx border border-[#dde2f0] text-sm bg-white outline-none focus:border-primary'

  return (
    <form onSubmit={submit} className="cx-card p-5">
      <h2 className="text-sm font-extrabold text-dark flex items-center gap-1.5 mb-4">
        <KeyRound className="w-4 h-4 text-primary" /> Activer un accès
      </h2>

      {result && (
        <div className={`mb-4 px-3 py-2 rounded-cx text-xs ${
          result.ok ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {result.message}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-dark">
          Apprenant
          <select className={field} value={userId} onChange={e => setUserId(e.target.value)} required>
            <option value="">Sélectionner…</option>
            {learners.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-semibold text-dark">
          Formation
          <select className={field} value={courseId} onChange={e => setCourseId(e.target.value)} required>
            <option value="">Sélectionner…</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Source de l&apos;accès
        <select
          className={field}
          value={source}
          onChange={e => { setSource(e.target.value as EntitlementSource); setExpiryMode('') }}
        >
          {ADMIN_SELECTABLE_SOURCES.map(s => (
            <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
          ))}
        </select>
        <span className="text-[11px] font-normal text-cx-gray">
          Les achats, licences entreprise et évaluations sont émis par leurs systèmes respectifs
          et ne sont pas saisissables ici.
        </span>
      </label>

      {/* XPA-6C: optional start boundary. Access is denied until it passes. */}
      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Début de l&apos;accès <span className="font-normal text-cx-gray">(optionnel)</span>
        <input
          type="date" className={field}
          value={startsAt} onChange={e => setStartsAt(e.target.value)}
        />
        <span className="font-normal text-cx-gray">
          Laissez vide pour un accès immédiat. Avant cette date, l&apos;accès est refusé.
        </span>
      </label>

      <fieldset className="mb-3">
        <legend className="text-xs font-semibold text-dark mb-1.5">
          Échéance
          {mustExpire && <span className="text-error"> * obligatoire pour cette source</span>}
          {mustChoose && <span className="text-error"> * choix explicite requis</span>}
        </legend>

        {mustExpire ? (
          <input
            type="date" required className={field}
            value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs text-cx-gray">
              <input
                type="radio" name="expiry" className="accent-primary"
                checked={expiryMode === 'never'} onChange={() => setExpiryMode('never')}
              />
              Sans expiration
            </label>
            <label className="flex items-center gap-2 text-xs text-cx-gray">
              <input
                type="radio" name="expiry" className="accent-primary"
                checked={expiryMode === 'date'} onChange={() => setExpiryMode('date')}
              />
              Expire le
              <input
                type="date"
                className="px-2 py-1 rounded-md border border-[#dde2f0] text-xs"
                value={expiresAt}
                onChange={e => { setExpiresAt(e.target.value); setExpiryMode('date') }}
                required={expiryMode === 'date'}
              />
            </label>
          </div>
        )}
      </fieldset>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-4">
        Motif (journalisé)
        <input
          type="text" className={field} maxLength={500}
          value={reason} onChange={e => setReason(e.target.value)}
          placeholder="ex. inscription confirmée par téléphone"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="w-full px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-cx hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Activation…' : "Activer l'accès"}
      </button>

      <p className="text-[11px] text-cx-gray mt-3 leading-relaxed">
        L&apos;activation crée un accès commercial et un dossier pédagogique. Révoquer un accès
        plus tard ne supprime ni la progression, ni les résultats, ni les certificats.
      </p>
    </form>
  )
}
