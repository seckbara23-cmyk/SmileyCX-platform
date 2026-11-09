import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { isValidPaytechRedirectUrl } from '@/lib/payments/paytech-client'
import { IN_FLIGHT_STATUSES } from '@/lib/payments/payment-completion'
import { createLogger } from '@/lib/logger'

const log = createLogger('payments/paytech-resume')

/**
 * The PayTech attempts a learner may RESUME — XP-LAUNCH-04, "resume, never replace".
 *
 * PayTech's own « Annuler » button only redirects the browser: the hosted page it
 * leaves stays payable and `get-status` keeps answering the pending word, with no
 * expiry announced and no notification sent (observed on real test-mode checkouts,
 * still so fourteen hours after the click). The provider documents no call to cancel
 * or invalidate a token. So a cancelled checkout is never replaced by a new one — a
 * second payable page beside the first would be two chargeable checkouts — and is
 * RESUMED instead: the learner is sent back to the same hosted page, through the
 * checkout action's pending branch, which asks the provider first.
 *
 * This module only READS. It decides nothing, writes nothing, and hands no page a
 * token or a URL: it says whether a stored redirect exists, so the cancel page and
 * the checkout page can offer the resume honestly. Every query is scoped to the
 * signed-in learner; nothing a browser sends selects the attempt.
 */
export interface InflightPaytechAttempt {
  readonly paymentId: string
  readonly courseId: string
  readonly courseSlug: string | null
  readonly courseTitle: string | null
  /** The order reference, the only identifier a learner is shown. */
  readonly reference: string
  readonly createdAt: string
  /** A valid hosted-page URL is stored, so checkout can offer the same page again. */
  readonly resumable: boolean
}

/** How many attempts a page lists. One per course is the invariant, so this is generous. */
const DEFAULT_LIMIT = 5

/**
 * The learner's OPENED attempts still in flight (a token was stored, so a hosted
 * page was handed out), newest first. `null` when they cannot be read, so a
 * caller falls back to its generic message rather than claiming there is none.
 */
export async function inflightPaytechAttempts(
  userId: string,
  opts: { courseId?: string; limit?: number } = {},
): Promise<InflightPaytechAttempt[] | null> {
  if (typeof userId !== 'string' || userId.length === 0) return []
  try {
    const admin = createAdminClient()
    const scoped = admin
      .from('payments')
      .select('id, course_id, reference, created_at, metadata, courses(slug, title)')
      .eq('user_id', userId)
      .eq('provider', 'paytech')
      .in('status', [...IN_FLIGHT_STATUSES])
      .not('provider_token', 'is', null)
    const { data, error } = await (opts.courseId ? scoped.eq('course_id', opts.courseId) : scoped)
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? DEFAULT_LIMIT)

    if (error) {
      log.error('could not read the in-flight PayTech attempts')
      return null
    }
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
    return rows.map(toAttempt).filter((a): a is InflightPaytechAttempt => a !== null)
  } catch {
    log.error('reading the in-flight PayTech attempts threw')
    return null
  }
}

/** The one attempt in flight for this course, or none. */
export async function inflightPaytechAttempt(
  userId: string,
  courseId: string,
): Promise<InflightPaytechAttempt | null> {
  const attempts = await inflightPaytechAttempts(userId, { courseId, limit: 1 })
  return attempts && attempts.length > 0 ? attempts[0] : null
}

function toAttempt(row: Record<string, unknown>): InflightPaytechAttempt | null {
  // An attempt without a course cannot be resumed from a checkout page; it is an
  // administrator's matter (`payment_identity_incomplete`), not a learner's.
  if (typeof row.course_id !== 'string' || row.course_id.length === 0) return null
  const joined = row.courses
  const course = (Array.isArray(joined) ? joined[0] : joined) as { slug?: unknown; title?: unknown } | null | undefined
  const stored = (row.metadata as { checkoutUrl?: unknown } | null | undefined)?.checkoutUrl
  return {
    paymentId:   String(row.id),
    courseId:    row.course_id,
    courseSlug:  typeof course?.slug === 'string' ? course.slug : null,
    courseTitle: typeof course?.title === 'string' ? course.title : null,
    reference:   String(row.reference ?? ''),
    createdAt:   String(row.created_at ?? ''),
    // Only whether it exists and is the provider's. The URL itself stays on the server.
    resumable:   isValidPaytechRedirectUrl(stored),
  }
}
