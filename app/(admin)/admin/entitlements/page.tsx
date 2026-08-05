import type { Metadata } from 'next'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import GrantEntitlementForm from './GrantEntitlementForm'
import { EntitlementControls, RefreshExpiryButton } from './EntitlementControls'
import {
  isEntitlementAccessible,
  inaccessibleReason,
  STATUS_LABELS,
  SOURCE_LABELS,
  type EntitlementStatus,
  type EntitlementSource,
} from '@/lib/entitlements'

export const metadata: Metadata = { title: 'Admin — Accès aux formations' }
export const dynamic = 'force-dynamic'

interface Row {
  id: string
  user_id: string
  course_id: string
  source: EntitlementSource
  status: EntitlementStatus
  starts_at: string | null
  expires_at: string | null
  revoked_at: string | null
  revoked_reason: string | null
  granted_reason: string | null
  created_at: string
}

function fmt(d: string | null) {
  return d ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' }).format(new Date(d)) : '—'
}

const STATUS_CLASS: Record<string, string> = {
  ACTIVE:    'text-green-700 bg-green-50',
  PENDING:   'text-blue-700 bg-blue-50',
  SUSPENDED: 'text-amber-700 bg-amber-50',
  REVOKED:   'text-red-700 bg-red-50',
  EXPIRED:   'text-cx-gray bg-light border border-black/[0.08]',
  CANCELLED: 'text-cx-gray bg-light border border-black/[0.08]',
}

/**
 * Course-access administration (XPA-6B).
 *
 * The one place course access is granted, suspended and revoked. Reads use the
 * service client because an administrator must see EVERY entitlement, including
 * other learners' — `requirePlatformAdmin()` above is what makes that legitimate,
 * and it is called here rather than relying on the route-group layout (the gap
 * XPA-6A closed on the admin dashboard).
 */
export default async function EntitlementsAdminPage() {
  await requirePlatformAdmin()
  const db = createAdminClient()

  const [{ data: rows }, { data: profiles }, { data: courses }] = await Promise.all([
    db.from('entitlements').select('*').order('created_at', { ascending: false }).limit(200),
    db.from('profiles').select('id, email, full_name, first_name, last_name').order('created_at', { ascending: false }),
    db.from('courses').select('id, title, slug').eq('is_published', true).order('title'),
  ])

  const byUser = new Map((profiles ?? []).map(p => [p.id, p]))
  const byCourse = new Map((courses ?? []).map(c => [c.id, c]))
  const list = (rows ?? []) as Row[]

  const learnerLabel = (id: string) => {
    const p = byUser.get(id)
    if (!p) return id.slice(0, 8) + '…'
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name
    return name ? `${name} — ${p.email}` : p.email
  }

  const liveCount = list.filter(e => isEntitlementAccessible(e)).length

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-extrabold text-dark">Accès aux formations</h1>
        <p className="text-sm text-cx-gray mt-1">
          L&apos;accès à une formation est accordé ici, indépendamment du compte et du paiement.
          La progression pédagogique est conservée séparément et n&apos;est jamais supprimée par
          une révocation.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="cx-card px-4 py-2.5">
          <span className="text-lg font-extrabold text-dark">{liveCount}</span>
          <span className="text-xs text-cx-gray ml-2">accès actifs</span>
        </div>
        <div className="cx-card px-4 py-2.5">
          <span className="text-lg font-extrabold text-dark">{list.length}</span>
          <span className="text-xs text-cx-gray ml-2">enregistrements</span>
        </div>
        <RefreshExpiryButton />
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <div className="cx-card overflow-hidden">
          {list.length === 0 ? (
            <div className="p-8 text-center">
              <p className="font-bold text-dark text-sm mb-1">Aucun accès accordé</p>
              <p className="text-xs text-cx-gray">
                Aucun apprenant n&apos;a accès au contenu des formations pour le moment.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-light text-cx-gray">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2.5">Apprenant</th>
                    <th className="text-left font-semibold px-3 py-2.5">Formation</th>
                    <th className="text-left font-semibold px-3 py-2.5">Source</th>
                    <th className="text-left font-semibold px-3 py-2.5">Statut</th>
                    <th className="text-left font-semibold px-3 py-2.5">Échéance</th>
                    <th className="text-right font-semibold px-3 py-2.5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(e => {
                    const live = isEntitlementAccessible(e)
                    const why = inaccessibleReason(e)
                    return (
                      <tr key={e.id} className="border-t border-black/[0.05] align-top">
                        <td className="px-3 py-2.5 text-dark">{learnerLabel(e.user_id)}</td>
                        <td className="px-3 py-2.5 text-cx-gray">
                          {byCourse.get(e.course_id)?.title ?? e.course_id.slice(0, 8) + '…'}
                        </td>
                        <td className="px-3 py-2.5 text-cx-gray">{SOURCE_LABELS[e.source] ?? e.source}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-block px-2 py-0.5 rounded-full font-bold text-[10px] ${STATUS_CLASS[e.status] ?? ''}`}>
                            {STATUS_LABELS[e.status] ?? e.status}
                          </span>
                          {/* An ACTIVE row whose date has passed is not access —
                              say so, rather than letting the badge imply it. */}
                          {!live && e.status === 'ACTIVE' && why && (
                            <span className="block text-[10px] text-amber-700 mt-0.5">
                              n&apos;accorde pas l&apos;accès ({why})
                            </span>
                          )}
                          {e.revoked_reason && (
                            <span className="block text-[10px] text-cx-gray mt-0.5 max-w-[180px]">
                              {e.revoked_reason}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-cx-gray whitespace-nowrap">
                          {e.expires_at ? fmt(e.expires_at) : 'sans expiration'}
                          {e.starts_at && (
                            <span className="block text-[10px]">dès {fmt(e.starts_at)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <EntitlementControls entitlementId={e.id} status={e.status} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <GrantEntitlementForm
          learners={(profiles ?? []).map(p => ({
            id: p.id,
            label: ([p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name || p.email) as string,
          }))}
          courses={(courses ?? []).map(c => ({ id: c.id, label: c.title as string }))}
        />
      </div>
    </div>
  )
}
