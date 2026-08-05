'use server'
/**
 * Entitlement administration (XPA-6B).
 *
 * The manual/admin activation path ratified decision 6 anticipated. Every
 * action here is: platform-admin authorization → validation → rate limit →
 * write as service_role → audit. Same pipeline as user provisioning, for the
 * same reason — this is the only way course access is granted, so it is the
 * only place a mistake becomes an entitlement.
 *
 * ── THE INVARIANT THIS FILE EXISTS TO HOLD (Q-L) ──────────────────────────
 *
 * Revoking access MUST NOT delete learning history.
 *
 * So no function below ever deletes an enrollment, lesson_progress row, quiz
 * attempt or certificate. Revocation and suspension touch the ENTITLEMENT and
 * nothing else. A learner whose corporate licence lapses keeps the record that
 * they passed, and re-granting restores their place rather than a blank slate.
 *
 * The mirror invariant: an enrollment does not authorize access. Activating an
 * entitlement creates an enrollment so the learner has somewhere to accumulate
 * progress, but that row grants nothing — `has_course_access()` never reads it.
 */

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'
import {
  ADMIN_SELECTABLE_SOURCES,
  validateExpiry,
  LIVE_STATUSES,
  type EntitlementSource,
} from '@/lib/entitlements'

const log = createLogger('actions/entitlements')

// Generous for legitimate onboarding, tight enough to bound the damage from a
// compromised admin session. Matches the user-provisioning limit.
const GRANT_LIMIT = { limit: 50, windowMs: 60 * 60 * 1000 }

export interface EntitlementActionResult {
  ok:       boolean
  message?: string
}

async function actorContext() {
  const h = await headers()
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown',
    userAgent: (h.get('user-agent') ?? '').slice(0, 256),
  }
}

// ── Grant ───────────────────────────────────────────────────────────────────

export async function grantEntitlement(input: {
  userId:   string
  courseId: string
  source:   string
  /** ISO date, or null for no expiry. */
  expiresAt: string | null
  /** True when the admin actively decided the expiry (required for PROMOTIONAL_GRANT). */
  expiryDecisionMade: boolean
  startsAt?: string | null
  reason?:   string
}): Promise<EntitlementActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()

  const fail = async (reason: string, message: string): Promise<EntitlementActionResult> => {
    await logAuditEvent({
      eventType: 'entitlement.granted',
      actorType: 'admin',
      actorId:   admin.id,
      actorEmail: admin.email,
      subjectUserId: input.userId || null,
      method:    'admin_panel',
      outcome:   'failure',
      reason,
      ip, userAgent,
      metadata:  { courseId: input.courseId, source: input.source },
    })
    return { ok: false, message }
  }

  // Never trust a client-supplied source. Only the two an administrator may
  // legitimately assert are accepted — a human must not be able to record an
  // INDIVIDUAL_PURCHASE that no payment system produced.
  if (!(ADMIN_SELECTABLE_SOURCES as readonly string[]).includes(input.source)) {
    return fail('source not admin-selectable', "Source d'accès non autorisée.")
  }
  const source = input.source as EntitlementSource

  if (!input.userId || !input.courseId) {
    return fail('missing user or course', 'Apprenant et formation sont requis.')
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return fail('invalid expiry date', "Date d'expiration invalide.")
  }
  const expiry = validateExpiry(source, expiresAt, input.expiryDecisionMade)
  if (!expiry.ok) return fail('expiry rule violated', expiry.error)

  const rl = await rateLimitDb(`entitlement-grant:${admin.id}`, GRANT_LIMIT)
  if (!rl.success) {
    return fail('rate limit exceeded', "Trop d'activations. Réessayez dans quelques minutes.")
  }

  const db = createAdminClient()

  // One live entitlement per learner per course — the same rule the partial
  // unique index enforces. Checked here so the admin gets a sentence rather
  // than a constraint-violation code.
  const { data: existing } = await db
    .from('entitlements')
    .select('id, status')
    .eq('user_id', input.userId)
    .eq('course_id', input.courseId)
    .in('status', LIVE_STATUSES as unknown as string[])
    .maybeSingle()

  if (existing) {
    return fail('live entitlement already exists',
      `Cet apprenant a déjà un accès ${existing.status} pour cette formation.`)
  }

  const { data: created, error } = await db
    .from('entitlements')
    .insert({
      user_id:        input.userId,
      course_id:      input.courseId,
      source,
      status:         'ACTIVE',
      starts_at:      input.startsAt || null,
      expires_at:     input.expiresAt || null,
      granted_by:     admin.id,
      granted_reason: input.reason?.slice(0, 500) || null,
    })
    .select('id')
    .single()

  if (error || !created) {
    return fail(error?.message ?? 'insert returned no row', "L'accès n'a pas pu être créé.")
  }

  // Give the learner somewhere to accumulate progress. This row authorizes
  // NOTHING — has_course_access() does not read enrollments (Q-L). It is
  // idempotent, so re-granting after a revocation reuses the existing academic
  // record instead of starting the learner over.
  await ensureEnrollment(input.userId, input.courseId)

  await logAuditEvent({
    eventType:     'entitlement.granted',
    actorType:     'admin',
    actorId:       admin.id,
    actorEmail:    admin.email,
    subjectUserId: input.userId,
    method:        'admin_panel',
    outcome:       'success',
    ip, userAgent,
    metadata: {
      entitlementId: created.id,
      courseId:      input.courseId,
      source,
      expiresAt:     input.expiresAt ?? null,
      startsAt:      input.startsAt ?? null,
    },
  })

  revalidatePath('/admin/entitlements')
  return { ok: true, message: 'Accès activé.' }
}

/**
 * Idempotent academic record. Never overwrites an existing enrollment, because
 * that row carries the learner's participation history.
 */
async function ensureEnrollment(userId: string, courseId: string): Promise<void> {
  const db = createAdminClient()
  const { error } = await db.from('enrollments').upsert(
    { user_id: userId, course_id: courseId, payment_id: null, status: 'active' },
    { onConflict: 'user_id,course_id', ignoreDuplicates: true },
  )
  if (error) {
    // Non-fatal: the entitlement is what grants access. A missing enrollment
    // costs progress tracking, not entry, and is loud in the logs.
    log.error({ err: error.message, userId, courseId }, 'Failed to ensure enrollment')
  }
}

// ── Suspend / reinstate / revoke ─────────────────────────────────────────────

type Transition = 'SUSPENDED' | 'ACTIVE' | 'REVOKED' | 'CANCELLED'

async function transition(
  entitlementId: string,
  to: Transition,
  reason: string | undefined,
  eventType: 'entitlement.suspended' | 'entitlement.reinstated' | 'entitlement.revoked' | 'entitlement.cancelled',
): Promise<EntitlementActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()
  const db = createAdminClient()

  const { data: current } = await db
    .from('entitlements')
    .select('id, user_id, course_id, status, source')
    .eq('id', entitlementId)
    .maybeSingle()

  if (!current) return { ok: false, message: 'Accès introuvable.' }

  // REVOKED / EXPIRED / CANCELLED are terminal. Re-opening one would rewrite
  // history; the correct move is to grant a NEW entitlement, which keeps both
  // the old record and its reason intact.
  if (['REVOKED', 'EXPIRED', 'CANCELLED'].includes(current.status)) {
    return {
      ok: false,
      message: `Cet accès est ${current.status}. Créez un nouvel accès plutôt que de rouvrir celui-ci.`,
    }
  }

  const patch: Record<string, unknown> = { status: to }
  if (to === 'REVOKED') {
    patch.revoked_at = new Date().toISOString()
    patch.revoked_reason = reason?.slice(0, 500) ?? null
  }

  const { error } = await db.from('entitlements').update(patch).eq('id', entitlementId)

  if (error) {
    await logAuditEvent({
      eventType, actorType: 'admin', actorId: admin.id, actorEmail: admin.email,
      subjectUserId: current.user_id, method: 'admin_panel', outcome: 'failure',
      reason: error.message, ip, userAgent,
      metadata: { entitlementId, courseId: current.course_id },
    })
    return { ok: false, message: "La modification n'a pas pu être enregistrée." }
  }

  // NOTHING else is touched. No enrollment is deleted, no progress is cleared,
  // no certificate is withdrawn — Q-L: revoking access must not delete learning
  // history. If this function ever grows a delete, that decision has been
  // reversed and it needs to be ratified, not slipped in.

  await logAuditEvent({
    eventType, actorType: 'admin', actorId: admin.id, actorEmail: admin.email,
    subjectUserId: current.user_id, method: 'admin_panel', outcome: 'success',
    reason: reason?.slice(0, 500) ?? null, ip, userAgent,
    metadata: {
      entitlementId,
      courseId: current.course_id,
      from: current.status,
      to,
      learningHistoryPreserved: true,
    },
  })

  revalidatePath('/admin/entitlements')
  return { ok: true, message: 'Accès mis à jour.' }
}

export async function suspendEntitlement(entitlementId: string, reason?: string) {
  return transition(entitlementId, 'SUSPENDED', reason, 'entitlement.suspended')
}

export async function reinstateEntitlement(entitlementId: string, reason?: string) {
  return transition(entitlementId, 'ACTIVE', reason, 'entitlement.reinstated')
}

export async function revokeEntitlement(entitlementId: string, reason?: string) {
  return transition(entitlementId, 'REVOKED', reason, 'entitlement.revoked')
}

export async function cancelEntitlement(entitlementId: string, reason?: string) {
  return transition(entitlementId, 'CANCELLED', reason, 'entitlement.cancelled')
}

// ── Expiry materialisation ──────────────────────────────────────────────────

/**
 * Flip ACTIVE entitlements whose `expires_at` has passed to EXPIRED.
 *
 * Reporting only. Access already stopped at `expires_at` — the SQL predicate is
 * time-based, so a learner cannot read a course between expiry and the moment
 * this runs. If it never runs, the listing shows a stale status and nothing
 * else. A boundary that depends on a job having run is one that fails quietly
 * when the job does not.
 */
export async function materialiseExpiredEntitlements(): Promise<EntitlementActionResult> {
  const admin = await requirePlatformAdmin()
  const { ip, userAgent } = await actorContext()

  const { data, error } = await createAdminClient().rpc('expire_due_entitlements')

  if (error) {
    log.error({ err: error.message }, 'expire_due_entitlements failed')
    return { ok: false, message: 'La mise à jour des expirations a échoué.' }
  }

  const count = (data as number | null) ?? 0
  if (count > 0) {
    await logAuditEvent({
      eventType: 'entitlement.expired', actorType: 'admin',
      actorId: admin.id, actorEmail: admin.email,
      method: 'admin_panel', outcome: 'success', ip, userAgent,
      metadata: { expiredCount: count },
    })
  }

  revalidatePath('/admin/entitlements')
  return { ok: true, message: `${count} accès expiré(s) mis à jour.` }
}
