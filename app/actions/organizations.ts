'use server'
/**
 * Organization administration (XPA-7).
 *
 * ── WHERE AUTHORITY LIVES ─────────────────────────────────────────────────
 *
 * Every action here is behind `requirePlatformAdmin()`. That is D7-3, and it is
 * not a convenience: an organization administrator manages a ROSTER, and a
 * platform administrator issues COMMERCIAL RIGHTS. Letting the first mint the
 * second is how a B2B model quietly becomes a self-service one.
 *
 * So there is deliberately no `grantCorporateLicense` in this file. Corporate
 * licences are granted by `grantEntitlement` in `app/actions/entitlements.ts`,
 * which already requires a platform admin, validates the mandatory expiry, and
 * audits. XPA-7 only teaches it which organization a grant belongs to.
 *
 * ── WHAT THESE ROWS DO NOT DO ─────────────────────────────────────────────
 *
 * Nothing here opens a course. `has_course_access()` reads entitlements and
 * never memberships, so an organization with a hundred members and no
 * entitlements has a hundred people who can read nothing.
 */

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'
import {
  XPA7_ASSIGNABLE_ROLES,
  MEMBERSHIP_STATUSES,
  canTransition,
  normalizeOrgSlug,
  type MembershipStatus,
  type OrgRole,
} from '@/lib/organizations'

const log = createLogger('actions/organizations')

export interface OrgActionResult { ok: boolean; message?: string; id?: string }

const Uuid = z.string().uuid()

const CreateOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(2).max(60).optional(),
  industry: z.string().trim().max(80).optional().nullable(),
  country: z.string().trim().max(80).optional().nullable(),
})

async function actorContext() {
  const h = await headers()
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent') ?? null,
  }
}

// ── Organizations ───────────────────────────────────────────────────────────

export async function createOrganization(input: {
  name: string; slug?: string; industry?: string | null; country?: string | null
}): Promise<OrgActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()

  const parsed = CreateOrgSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Nom d’organisation invalide.' }

  const slug = normalizeOrgSlug(parsed.data.slug || parsed.data.name)
  if (!slug) return { ok: false, message: 'Identifiant (slug) invalide.' }

  const db = createAdminClient()

  const { data: clash } = await db
    .from('organizations').select('id').eq('slug', slug).maybeSingle()
  if (clash) return { ok: false, message: `L’identifiant « ${slug} » est déjà utilisé.` }

  // `plan` and `plan_status` are left at their schema defaults on purpose.
  // They are legacy metadata (D7-2) and this action must not imply they mean
  // anything commercially.
  const { data: created, error } = await db
    .from('organizations')
    .insert({
      name: parsed.data.name,
      slug,
      industry: parsed.data.industry || null,
      country: parsed.data.country || null,
    })
    .select('id')
    .single()

  if (error || !created) {
    log.error({ err: error?.message, slug }, 'Failed to create organization')
    return { ok: false, message: 'L’organisation n’a pas pu être créée.' }
  }

  await logAuditEvent({
    eventType: 'organization.created',
    actorType: 'admin', actorId: admin.id, actorEmail: admin.email,
    method: 'admin_panel', outcome: 'success', ip, userAgent,
    metadata: { organizationId: created.id, slug, name: parsed.data.name },
  })

  revalidatePath('/admin/organizations')
  return { ok: true, id: created.id, message: 'Organisation créée.' }
}

// ── Membership ──────────────────────────────────────────────────────────────

/**
 * Add a learner to an organization.
 *
 * `status` decides whether this is an invitation or a direct add:
 *   PENDING — invited, confers nothing until accepted
 *   ACTIVE  — a real member from this moment
 *
 * Idempotent on `(org_id, user_id)`: re-adding an existing member reports the
 * current state rather than creating a duplicate, which the table's UNIQUE
 * constraint would refuse anyway. Multi-organization membership is allowed
 * (D7-5), so this never checks whether the learner belongs elsewhere.
 */
export async function addOrganizationMember(input: {
  organizationId: string
  userId: string
  role: OrgRole
  status?: MembershipStatus
}): Promise<OrgActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()

  if (!Uuid.safeParse(input.organizationId).success || !Uuid.safeParse(input.userId).success) {
    return { ok: false, message: 'Organisation ou apprenant invalide.' }
  }
  if (!(XPA7_ASSIGNABLE_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, message: 'Rôle non assignable.' }
  }
  const status: MembershipStatus = input.status ?? 'PENDING'
  if (!(MEMBERSHIP_STATUSES as readonly string[]).includes(status) || status === 'REMOVED') {
    return { ok: false, message: 'Statut d’adhésion invalide.' }
  }

  const db = createAdminClient()

  const { data: existing } = await db
    .from('organization_memberships')
    .select('id, status, role')
    .eq('org_id', input.organizationId)
    .eq('user_id', input.userId)
    .maybeSingle()

  if (existing) {
    return {
      ok: false, id: existing.id,
      message: `Cet apprenant est déjà rattaché (${existing.status}).`,
    }
  }

  const { data: created, error } = await db
    .from('organization_memberships')
    .insert({
      org_id: input.organizationId,
      user_id: input.userId,
      role: input.role,
      status,
      invited_by: admin.id,
    })
    .select('id')
    .single()

  if (error || !created) {
    log.error({ err: error?.message, org: input.organizationId }, 'Failed to add member')
    return { ok: false, message: 'L’adhésion n’a pas pu être créée.' }
  }

  await logAuditEvent({
    eventType: status === 'PENDING' ? 'organization.member_invited' : 'organization.member_added',
    actorType: 'admin', actorId: admin.id, actorEmail: admin.email,
    subjectUserId: input.userId,
    method: 'admin_panel', outcome: 'success', ip, userAgent,
    metadata: {
      organizationId: input.organizationId, membershipId: created.id,
      role: input.role, status, authorizing: false,
    },
  })

  revalidatePath(`/admin/organizations/${input.organizationId}`)
  return { ok: true, id: created.id, message: status === 'PENDING' ? 'Invitation enregistrée.' : 'Membre ajouté.' }
}

/**
 * Move a membership through its lifecycle.
 *
 * Illegal transitions are refused rather than silently applied — REMOVED is
 * terminal, and a removed member is re-added by a fresh invitation so the
 * original row survives as history.
 */
export async function setMembershipStatus(
  membershipId: string,
  to: MembershipStatus,
  reason?: string,
): Promise<OrgActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()

  if (!Uuid.safeParse(membershipId).success) return { ok: false, message: 'Adhésion invalide.' }
  if (!(MEMBERSHIP_STATUSES as readonly string[]).includes(to)) {
    return { ok: false, message: 'Statut invalide.' }
  }

  const db = createAdminClient()
  const { data: current } = await db
    .from('organization_memberships')
    .select('id, org_id, user_id, status')
    .eq('id', membershipId)
    .maybeSingle()

  if (!current) return { ok: false, message: 'Adhésion introuvable.' }

  const from = current.status as MembershipStatus
  if (from === to) return { ok: true, message: 'Statut inchangé.' }
  if (!canTransition(from, to)) {
    return { ok: false, message: `Transition ${from} → ${to} non autorisée.` }
  }

  const { error } = await db
    .from('organization_memberships')
    .update({ status: to })
    .eq('id', membershipId)

  if (error) {
    log.error({ err: error.message, membershipId }, 'Failed to change membership status')
    return { ok: false, message: 'Le statut n’a pas pu être modifié.' }
  }

  await logAuditEvent({
    eventType: to === 'REMOVED' ? 'organization.member_removed' : 'organization.member_activated',
    actorType: 'admin', actorId: admin.id, actorEmail: admin.email,
    subjectUserId: current.user_id as string,
    method: 'admin_panel', outcome: 'success', ip, userAgent,
    reason,
    metadata: {
      organizationId: current.org_id, membershipId, from, to, authorizing: false,
    },
  })

  revalidatePath(`/admin/organizations/${current.org_id}`)
  return { ok: true, message: 'Statut mis à jour.' }
}
