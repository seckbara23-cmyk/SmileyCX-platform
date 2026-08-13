import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import AddMemberForm from './AddMemberForm'
import MembershipControls from './MembershipControls'
import {
  ORG_ROLE_LABELS, MEMBERSHIP_STATUS_LABELS,
  type OrgRole, type MembershipStatus,
} from '@/lib/organizations'
import {
  isEntitlementAccessible, inaccessibleReason,
  SOURCE_LABELS, STATUS_LABELS,
  type EntitlementSource, type EntitlementStatus,
} from '@/lib/entitlements'

export const metadata: Metadata = { title: 'Admin — Organisation' }
export const dynamic = 'force-dynamic'

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

/**
 * Organization detail (XPA-7, D7-7 minimal reporting).
 *
 * Everything here is a READ of tables that already existed. There is no
 * organization-specific progress store: completion comes from `lesson_progress`
 * and access from `entitlements`, exactly as the dashboard does it. Building a
 * parallel corporate reporting model would mean two places disagreeing about
 * what a learner has done.
 *
 * The two columns are kept visually separate on purpose. Membership is
 * structural; access is commercial. A member with no live entitlement is shown
 * as having no access, because that is the truth.
 */
export default async function OrganizationDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin()
  const { id } = await params
  const db = createAdminClient()

  const { data: org } = await db.from('organizations').select('*').eq('id', id).maybeSingle()
  if (!org) notFound()

  const [{ data: memberships }, { data: profiles }, { data: ents }, { data: courses }] =
    await Promise.all([
      db.from('organization_memberships').select('*').eq('org_id', id).order('created_at'),
      db.from('profiles').select('id, email, full_name').order('created_at', { ascending: false }),
      db.from('entitlements').select('*').eq('organization_id', id),
      db.from('courses').select('id, title').eq('is_published', true).order('title'),
    ])

  const byUser = new Map((profiles ?? []).map(p => [p.id as string, p]))
  const byCourse = new Map((courses ?? []).map(c => [c.id as string, c]))
  const label = (uid: string) => {
    const p = byUser.get(uid)
    return p ? (p.full_name || p.email || uid.slice(0, 8)) : uid.slice(0, 8) + '…'
  }

  const members = memberships ?? []
  const grants = ents ?? []
  const liveGrants = grants.filter(e => isEntitlementAccessible(e as never))

  // Learners not yet attached to this organization.
  const attached = new Set(members.map(m => m.user_id as string))
  const candidates = (profiles ?? [])
    .filter(p => !attached.has(p.id as string))
    .map(p => ({ id: p.id as string, label: (p.full_name || p.email || p.id) as string }))

  return (
    <div>
      <div className="mb-5">
        <Link href="/admin/organizations" className="text-xs text-primary hover:underline">
          ← Organisations
        </Link>
        <h1 className="text-xl font-extrabold text-dark mt-2">{org.name}</h1>
        <p className="text-xs text-cx-gray mt-1">
          <span className="font-mono">{org.slug}</span>
          {org.industry ? ` · ${org.industry}` : ''}{org.country ? ` · ${org.country}` : ''}
        </p>
        {/* D7-2: plan is legacy metadata from the SmileyCX SaaS product. Shown
            greyed and labelled so nobody reads it as a commercial authority. */}
        <p className="text-[11px] text-cx-gray/70 mt-2">
          Champs hérités (non contractuels) : plan <span className="font-mono">{org.plan}</span>,
          statut <span className="font-mono">{org.plan_status}</span> — sans effet sur l&apos;accès aux formations.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Membres actifs', value: members.filter(m => m.status === 'ACTIVE').length },
          { label: 'Invitations en attente', value: members.filter(m => m.status === 'PENDING').length },
          { label: 'Accès en cours', value: liveGrants.length },
        ].map(s => (
          <div key={s.label} className="cx-card p-4">
            <p className="text-2xl font-extrabold text-dark">{s.value}</p>
            <p className="text-xs text-cx-gray mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <div className="flex flex-col gap-6">

          <div className="cx-card overflow-hidden">
            <div className="px-4 py-3 border-b border-black/[0.05]">
              <h2 className="text-sm font-extrabold text-dark">Membres</h2>
              <p className="text-[11px] text-cx-gray">
                L&apos;appartenance est structurelle : elle n&apos;ouvre aucune formation.
              </p>
            </div>
            {members.length === 0 ? (
              <p className="p-6 text-center text-xs text-cx-gray">Aucun membre.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-light text-cx-gray">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2.5">Apprenant</th>
                      <th className="text-left font-semibold px-3 py-2.5">Rôle</th>
                      <th className="text-left font-semibold px-3 py-2.5">Statut</th>
                      <th className="text-right font-semibold px-3 py-2.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(m => (
                      <tr key={m.id as string} className="border-t border-black/[0.05]">
                        <td className="px-3 py-2.5 text-dark">{label(m.user_id as string)}</td>
                        <td className="px-3 py-2.5 text-cx-gray">
                          {ORG_ROLE_LABELS[m.role as OrgRole] ?? (m.role as string)}
                        </td>
                        <td className="px-3 py-2.5 text-cx-gray">
                          {MEMBERSHIP_STATUS_LABELS[m.status as MembershipStatus] ?? (m.status as string)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MembershipControls
                            membershipId={m.id as string}
                            status={m.status as MembershipStatus}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="cx-card overflow-hidden">
            <div className="px-4 py-3 border-b border-black/[0.05]">
              <h2 className="text-sm font-extrabold text-dark">Accès attribués à cette organisation</h2>
              <p className="text-[11px] text-cx-gray">
                Accordés depuis « Accès formations » par un administrateur plateforme.
              </p>
            </div>
            {grants.length === 0 ? (
              <p className="p-6 text-center text-xs text-cx-gray">
                Aucun accès rattaché à cette organisation.
              </p>
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
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map(e => {
                      const live = isEntitlementAccessible(e as never)
                      const why = inaccessibleReason(e as never)
                      return (
                        <tr key={e.id as string} className="border-t border-black/[0.05]">
                          <td className="px-3 py-2.5 text-dark">{label(e.user_id as string)}</td>
                          <td className="px-3 py-2.5 text-cx-gray">
                            {byCourse.get(e.course_id as string)?.title ?? (e.course_id as string).slice(0, 8) + '…'}
                          </td>
                          <td className="px-3 py-2.5 text-cx-gray">
                            {SOURCE_LABELS[e.source as EntitlementSource] ?? (e.source as string)}
                          </td>
                          <td className="px-3 py-2.5 text-cx-gray">
                            {STATUS_LABELS[e.status as EntitlementStatus] ?? (e.status as string)}
                            {!live && why && <span className="text-cx-gray/70"> · {why}</span>}
                          </td>
                          <td className="px-3 py-2.5 text-cx-gray">{fmt(e.expires_at as string | null)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <AddMemberForm organizationId={id} candidates={candidates} />
      </div>
    </div>
  )
}
