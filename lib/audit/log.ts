import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'

const log = createLogger('audit')

/**
 * Identity audit trail (SEC-2 / F-3).
 *
 * Writes append-only records to public.audit_log via the service-role client.
 * Server-side only: it is imported exclusively from `'use server'` modules and
 * route handlers, and depends on createAdminClient(), which reads the
 * server-only SUPABASE_SERVICE_ROLE_KEY.
 *
 * NEVER pass passwords, tokens, session cookies, API keys or invitation secrets
 * in `metadata` or `reason` — audit records are readable by every platform admin
 * and are retained after the subject account is deleted.
 */

export type AuditEventType =
  | 'user.created'
  | 'user.deleted'
  | 'user.role_changed'
  | 'user.registration_blocked'
  // XPA-6A — public learner registration lifecycle. `event_type` is free text
  // in the table (no check constraint), so extending this union needs no
  // migration; the union exists to keep call sites honest.
  | 'user.registered'
  | 'user.email_verified'
  | 'user.verification_resent'
  | 'user.password_reset_requested'
  | 'user.legal_accepted'
  // XPA-6B — entitlement lifecycle. These are the ONLY events that change who
  // can read a course, so they are the first place to look when access is
  // disputed.
  | 'entitlement.granted'
  | 'entitlement.suspended'
  | 'entitlement.reinstated'
  | 'entitlement.revoked'
  | 'entitlement.cancelled'
  | 'entitlement.expired'
  // UAT-ACCESS-01 — the ACADEMIC record being initialised for a learner the
  // entitlement seam has already authorized. Deliberately named apart from the
  // entitlement events above: this one changes NOTHING about who can read a
  // course, and an investigator reading the log should be able to tell that at
  // a glance rather than by checking what `enrollments` means this month.
  | 'enrollment.initialized'
  // XPA-7 — organization structure and roster. NONE of these change who can
  // read a course: `has_course_access()` reads entitlements alone. They are
  // named apart from the entitlement events so an investigator can tell a
  // roster change from an access change without inspecting the metadata.
  | 'organization.created'
  | 'organization.member_invited'
  | 'organization.member_added'
  | 'organization.member_activated'
  | 'organization.member_removed'

export type AuditActorType = 'admin' | 'self' | 'system' | 'anonymous'
export type AuditOutcome   = 'success' | 'failure'

export interface AuditEvent {
  eventType:     AuditEventType
  actorType:     AuditActorType
  actorId?:      string | null
  actorEmail?:   string | null
  subjectUserId?: string | null
  subjectEmail?: string | null
  /** How the action was performed, e.g. 'admin_panel', 'self_signup', 'api'. */
  method?:       string | null
  invitationId?: string | null
  outcome:       AuditOutcome
  /** Human-readable failure reason. Must not contain secrets. */
  reason?:       string | null
  ip?:           string | null
  userAgent?:    string | null
  metadata?:     Record<string, unknown>
}

/**
 * Record an identity event. Never throws: a failure to audit must not break the
 * user-facing action, but it is always logged at error level so the gap is
 * visible in runtime logs.
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('audit_log').insert({
      event_type:      event.eventType,
      actor_type:      event.actorType,
      actor_id:        event.actorId        ?? null,
      actor_email:     event.actorEmail     ?? null,
      subject_user_id: event.subjectUserId  ?? null,
      subject_email:   event.subjectEmail   ?? null,
      method:          event.method         ?? null,
      invitation_id:   event.invitationId   ?? null,
      outcome:         event.outcome,
      reason:          event.reason         ?? null,
      ip:              event.ip             ?? null,
      user_agent:      event.userAgent      ?? null,
      metadata:        event.metadata       ?? {},
    })

    if (error) {
      // Most likely cause: migration 027 not yet applied.
      log.error(
        { eventType: event.eventType, outcome: event.outcome, error: error.message },
        'Failed to write audit_log record'
      )
    }
  } catch (e) {
    log.error(
      { eventType: event.eventType, error: (e as Error).message },
      'Unexpected failure writing audit_log record'
    )
  }
}
