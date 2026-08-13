'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setMembershipStatus } from '@/app/actions/organizations'
import { MEMBERSHIP_TRANSITIONS, MEMBERSHIP_STATUS_LABELS, type MembershipStatus } from '@/lib/organizations'

/**
 * Only legal transitions are offered. REMOVED is terminal, so a removed member
 * shows no controls at all — re-adding is a fresh invitation, which keeps the
 * original row as history rather than resurrecting it.
 */
export default function MembershipControls({
  membershipId,
  status,
}: { membershipId: string; status: MembershipStatus }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const next = MEMBERSHIP_TRANSITIONS[status] ?? []
  if (next.length === 0) return <span className="text-cx-gray/60">—</span>

  const run = (to: MembershipStatus) => {
    setError(null)
    startTransition(async () => {
      const r = await setMembershipStatus(membershipId, to)
      if (!r.ok) setError(r.message ?? 'Échec.')
      else router.refresh()
    })
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <div className="inline-flex gap-1.5">
        {next.map(to => (
          <button
            key={to}
            onClick={() => run(to)}
            disabled={pending}
            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-40 ${
              to === 'REMOVED'
                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }`}
          >
            {to === 'REMOVED' ? 'Retirer' : MEMBERSHIP_STATUS_LABELS[to]}
          </button>
        ))}
      </div>
      {error && <span className="text-[11px] text-error">{error}</span>}
    </div>
  )
}
