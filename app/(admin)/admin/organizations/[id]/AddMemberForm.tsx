'use client'

import { useState, useTransition } from 'react'
import { addOrganizationMember } from '@/app/actions/organizations'
import { XPA7_ASSIGNABLE_ROLES, ORG_ROLE_LABELS, type OrgRole, type MembershipStatus } from '@/lib/organizations'

const field =
  'px-3 py-2 rounded-lg border border-[#dde2f0] text-xs font-normal focus:outline-none focus:border-primary'

export default function AddMemberForm({
  organizationId,
  candidates,
}: { organizationId: string; candidates: { id: string; label: string }[] }) {
  const [pending, startTransition] = useTransition()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<OrgRole>('viewer')
  const [status, setStatus] = useState<MembershipStatus>('PENDING')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setResult(null)
    startTransition(async () => {
      const r = await addOrganizationMember({ organizationId, userId, role, status })
      setResult({ ok: r.ok, message: r.message ?? '' })
      if (r.ok) setUserId('')
    })
  }

  return (
    <form onSubmit={submit} className="cx-card p-5">
      <h2 className="text-sm font-extrabold text-dark mb-1">Rattacher un apprenant</h2>
      <p className="text-xs text-cx-gray mb-4">
        Le rattachement ne donne accès à aucune formation. Accordez l&apos;accès
        séparément depuis « Accès formations ».
      </p>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Apprenant
        <select required className={field} value={userId} onChange={e => setUserId(e.target.value)}>
          <option value="">— choisir —</option>
          {candidates.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-semibold text-dark mb-3">
        Rôle
        <select className={field} value={role} onChange={e => setRole(e.target.value as OrgRole)}>
          {XPA7_ASSIGNABLE_ROLES.map(r => (
            <option key={r} value={r}>{ORG_ROLE_LABELS[r]}</option>
          ))}
        </select>
      </label>

      <fieldset className="mb-4">
        <legend className="text-xs font-semibold text-dark mb-1.5">Mode</legend>
        {([['PENDING', 'Inviter (en attente d’acceptation)'], ['ACTIVE', 'Rattacher directement']] as const).map(
          ([v, lbl]) => (
            <label key={v} className="flex items-center gap-2 text-xs text-cx-gray mb-1">
              <input
                type="radio" name="mstatus" className="accent-primary"
                checked={status === v} onChange={() => setStatus(v)}
              />
              {lbl}
            </label>
          ),
        )}
      </fieldset>

      <button
        type="submit" disabled={pending || !userId}
        className="w-full px-4 py-2.5 rounded-cx bg-primary text-white text-sm font-bold hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {pending ? 'Enregistrement…' : 'Rattacher'}
      </button>

      {result && (
        <p className={`mt-3 text-xs font-semibold ${result.ok ? 'text-success' : 'text-error'}`}>
          {result.message}
        </p>
      )}
    </form>
  )
}
