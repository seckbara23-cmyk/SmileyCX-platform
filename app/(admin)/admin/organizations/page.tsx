import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import CreateOrganizationForm from './CreateOrganizationForm'
import { isEntitlementAccessible } from '@/lib/entitlements'

export const metadata: Metadata = { title: 'Admin — Organisations' }
export const dynamic = 'force-dynamic'

/**
 * Organizations list (XPA-7).
 *
 * Reads with the service client, like every other admin surface: the page is
 * already behind `requirePlatformAdmin()`, and reading through a session client
 * would let a restrictive policy hide rows an owner is entitled to see.
 *
 * The counts shown are deliberately the two that matter and cannot be confused
 * with each other: how many people belong to the company (structural) and how
 * many of them can actually open a course right now (commercial). An
 * organization with fifty members and no live entitlements has fifty people who
 * can read nothing, and this page must show that rather than imply otherwise.
 */
export default async function OrganizationsPage() {
  await requirePlatformAdmin()
  const db = createAdminClient()

  const [{ data: orgs }, { data: members }, { data: ents }] = await Promise.all([
    db.from('organizations').select('*').order('created_at', { ascending: false }).limit(200),
    db.from('organization_memberships').select('id, org_id, status'),
    db.from('entitlements').select('id, organization_id, status, starts_at, expires_at, revoked_at'),
  ])

  const activeMembers = new Map<string, number>()
  for (const m of members ?? []) {
    if (m.status !== 'ACTIVE') continue
    activeMembers.set(m.org_id as string, (activeMembers.get(m.org_id as string) ?? 0) + 1)
  }

  const liveAccess = new Map<string, number>()
  for (const e of ents ?? []) {
    const org = e.organization_id as string | null
    if (!org) continue
    if (!isEntitlementAccessible(e as never)) continue
    liveAccess.set(org, (liveAccess.get(org) ?? 0) + 1)
  }

  const list = orgs ?? []

  return (
    <div>
      <div className="flex items-baseline justify-between mb-5">
        <div>
          <h1 className="text-xl font-extrabold text-dark">Organisations</h1>
          <p className="text-xs text-cx-gray mt-1">
            Clients B2B et prospects. L&apos;appartenance à une organisation n&apos;ouvre
            aucune formation — seul un accès (entitlement) le fait.
          </p>
        </div>
        <div>
          <span className="text-2xl font-extrabold text-dark">{list.length}</span>
          <span className="text-xs text-cx-gray ml-2">organisation(s)</span>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <div className="cx-card overflow-hidden">
          {list.length === 0 ? (
            <div className="p-8 text-center">
              <p className="font-bold text-dark text-sm mb-1">Aucune organisation</p>
              <p className="text-xs text-cx-gray">
                Créez une organisation pour rattacher des apprenants et leur accorder
                des accès entreprise.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-light text-cx-gray">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2.5">Organisation</th>
                    <th className="text-left font-semibold px-3 py-2.5">Identifiant</th>
                    <th className="text-left font-semibold px-3 py-2.5">Secteur</th>
                    <th className="text-right font-semibold px-3 py-2.5">Membres actifs</th>
                    <th className="text-right font-semibold px-3 py-2.5">Accès en cours</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(o => (
                    <tr key={o.id} className="border-t border-black/[0.05]">
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/admin/organizations/${o.id}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {o.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-cx-gray font-mono">{o.slug}</td>
                      <td className="px-3 py-2.5 text-cx-gray">{o.industry ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right text-dark font-semibold">
                        {activeMembers.get(o.id as string) ?? 0}
                      </td>
                      <td className="px-3 py-2.5 text-right text-dark font-semibold">
                        {liveAccess.get(o.id as string) ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <CreateOrganizationForm />
      </div>
    </div>
  )
}
