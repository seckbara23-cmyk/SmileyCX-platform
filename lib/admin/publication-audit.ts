import 'server-only'
import { logAuditEvent } from '@/lib/audit/log'

/**
 * Course publication auditing (XPA-8 F-5, Track 3).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Publication decides whether a course is DISCOVERABLE by the public. Until
 * this module, it was the only control of that consequence that left no trace:
 * three separate re-publications of courses that had been withdrawn by ruling
 * had to be attributed forensically, by comparing `courses.updated_at`
 * millisecond precision against the fact that no trigger writes that column.
 * That established the mechanism — the admin course form — and never the actor.
 * `audit_log` held six rows all-time, every one an entitlement grant.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * Publication decides nothing about ACCESS. `has_course_access()` has no
 * `is_published` arm, and an entitled learner keeps a withdrawn course. These
 * events are therefore named apart from the `entitlement.*` family on purpose:
 * an investigator reading the log must be able to tell a catalogue change from
 * an access change without inspecting metadata.
 *
 * ── Placement ──────────────────────────────────────────────────────────────
 *
 * Deliberately NOT exported from a `'use server'` module. Every export of such
 * a module is a callable HTTP endpoint, so a helper living there would become
 * externally invocable — the same reasoning that keeps `app/actions/progress.ts`
 * down to a single export. `server-only` makes the boundary a build error
 * rather than a convention.
 */

export interface PublicationTransition {
  courseId: string
  courseTitle: string
  /** Null when the course has no slug yet. */
  courseSlug: string | null
  /**
   * The state the row held BEFORE the write, read from the database rather
   * than inferred from the submitted form. Null means the course did not exist
   * — which is how a create-as-published is distinguished from a
   * re-publication.
   */
  previousIsPublished: boolean | null
  newIsPublished: boolean
  actorId: string
  actorEmail: string | null
  outcome: 'success' | 'failure'
  /** Failure reason. Never a secret. */
  reason?: string | null
}

/**
 * Record one publication-state transition.
 *
 * Call this ONLY when the state actually changed. A save that leaves
 * publication untouched is not a publication event, and recording it would
 * bury the ones that are.
 *
 * Never throws: `logAuditEvent` swallows its own failures by design, so a
 * broken audit path cannot break an operator's edit. The gap still surfaces at
 * error level in the runtime logs.
 */
export async function recordPublicationTransition(t: PublicationTransition): Promise<void> {
  await logAuditEvent({
    eventType:  t.newIsPublished ? 'course.published' : 'course.unpublished',
    actorType:  'admin',
    actorId:    t.actorId,
    actorEmail: t.actorEmail,
    method:     'admin_panel',
    outcome:    t.outcome,
    reason:     t.reason ?? null,
    // `audit_log` is an identity trail and has no course column, so course
    // identity lives here. Nothing in this object is a secret: title and slug
    // are public catalogue data the moment a course is published, and the two
    // booleans are the entire point of the record.
    metadata: {
      courseId:            t.courseId,
      courseTitle:         t.courseTitle,
      courseSlug:          t.courseSlug,
      previousIsPublished: t.previousIsPublished,
      newIsPublished:      t.newIsPublished,
      source:              'admin_course_form',
    },
  })
}
