'use client'
import { useState, useTransition } from 'react'
import { Pause, Play, Ban, RefreshCw } from 'lucide-react'
import {
  suspendEntitlement,
  reinstateEntitlement,
  revokeEntitlement,
  materialiseExpiredEntitlements,
} from '@/app/actions/entitlements'

/**
 * Lifecycle controls for one entitlement (XPA-6B).
 *
 * Revocation asks for a reason and confirms, because it is the one transition
 * with no way back: REVOKED is terminal, and restoring access means granting a
 * NEW entitlement so the revocation and its reason stay on the record.
 *
 * What it does NOT do is warn about losing progress — because none is lost.
 * Revoking touches the entitlement only (Q-L).
 */
export function EntitlementControls({
  entitlementId,
  status,
}: {
  entitlementId: string
  status: string
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')

  const terminal = ['REVOKED', 'EXPIRED', 'CANCELLED'].includes(status)
  if (terminal) {
    return <span className="text-[11px] text-cx-gray/70">Terminé — créer un nouvel accès</span>
  }

  function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    setError('')
    startTransition(async () => {
      const r = await fn()
      if (!r.ok) setError(r.message ?? 'Échec')
    })
  }

  return (
    <div className="flex flex-col gap-1 items-end">
      <div className="flex gap-1.5">
        {status === 'ACTIVE' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => suspendEntitlement(entitlementId))}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <Pause className="w-3 h-3" /> Suspendre
          </button>
        )}

        {(status === 'SUSPENDED' || status === 'PENDING') && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => reinstateEntitlement(entitlementId))}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-50"
          >
            <Play className="w-3 h-3" /> Activer
          </button>
        )}

        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const reason = window.prompt(
              'Motif de la révocation (conservé dans le journal d’audit).\n\n' +
              'La progression, les résultats et les certificats de l’apprenant sont conservés.',
            )
            if (reason === null) return
            run(() => revokeEntitlement(entitlementId, reason))
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50"
        >
          <Ban className="w-3 h-3" /> Révoquer
        </button>
      </div>
      {error && <span className="text-[10px] text-red-600 max-w-[220px] text-right">{error}</span>}
    </div>
  )
}

/**
 * Materialise EXPIRED for reporting.
 *
 * The label says "statuses" rather than "access" on purpose: access already
 * stopped at expiry. This only updates what the list shows.
 */
export function RefreshExpiryButton() {
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const r = await materialiseExpiredEntitlements()
          setNote(r.message ?? '')
        })}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-cx bg-light border border-black/[0.08] text-cx-gray hover:bg-white disabled:opacity-50"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${pending ? 'animate-spin' : ''}`} />
        Actualiser les statuts d&apos;expiration
      </button>
      {note && <span className="text-[11px] text-cx-gray">{note}</span>}
    </div>
  )
}
