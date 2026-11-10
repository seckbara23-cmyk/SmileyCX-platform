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
 *
 * XP-LAUNCH-FINAL-08: an attempt buys one course or one pack (migration 065), and a
 * pack attempt is resumed the same way, from the pack's checkout.
 */
export interface InflightPaytechAttempt {
  readonly paymentId: string
  /** The course the attempt buys; empty for a pack. */
  readonly courseId: string
  readonly courseSlug: string | null
  readonly courseTitle: string | null
  /** The pack the attempt buys, when it buys one. */
  readonly packCode: string | null
  readonly packTitle: string | null
  /** The order reference, the only identifier a learner is shown. */
  readonly reference: string
  readonly createdAt: string
  /** A valid hosted-page URL is stored, so checkout can offer the same page again. */
  readonly resumable: boolean
}

/** How many attempts a page lists. One per course is the invariant, so this is generous. */
const DEFAULT_LIMIT = 5

const SELECT = 'id, course_id, pack_id, reference, created_at, metadata, courses(slug, title), course_packs(code, title)'

/**
 * The learner's OPENED attempts still in flight (a token was stored, so a hosted
 * page was handed out), newest first. `null` when they cannot be read, so a
 * caller falls back to its generic message rather than claiming there is none.
 */
export async function inflightPaytechAttempts(
  userId: string,
  opts: { courseId?: string; packId?: string; limit?: number } = {},
): Promise<InflightPaytechAttempt[] | null> {
  if (typeof userId !== 'string' || userId.length === 0) return []
  try {
    const admin = createAdminClient()
    let scoped = admin
      .from('payments')
      .select(SELECT)
      .eq('user_id', userId)
      .eq('provider', 'paytech')
      .in('status', [...IN_FLIGHT_STATUSES])
      .not('provider_token', 'is', null)
    if (opts.courseId) scoped = scoped.eq('course_id', opts.courseId)
    if (opts.packId) scoped = scoped.eq('pack_id', opts.packId)
    const { data, error } = await scoped
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

/** The one attempt in flight for this pack, or none. */
export async function inflightPaytechPackAttempt(
  userId: string,
  packId: string,
): Promise<InflightPaytechAttempt | null> {
  const attempts = await inflightPaytechAttempts(userId, { packId, limit: 1 })
  return attempts && attempts.length > 0 ? attempts[0] : null
}

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Record<string, unknown> | null | undefined

function toAttempt(row: Record<string, unknown>): InflightPaytechAttempt | null {
  const course = one(row.courses)
  const pack = one(row.course_packs)
  const isCourse = typeof row.course_id === 'string' && row.course_id.length > 0
  const isPack = !isCourse && typeof pack?.code === 'string' && pack.code.length > 0
  // An attempt with neither a course nor a readable pack cannot be resumed from a
  // checkout page; it is an administrator's matter (`payment_identity_incomplete`).
  if (!isCourse && !isPack) return null
  const stored = (row.metadata as { checkoutUrl?: unknown } | null | undefined)?.checkoutUrl
  return {
    paymentId:   String(row.id),
    courseId:    isCourse ? String(row.course_id) : '',
    courseSlug:  isCourse && typeof course?.slug === 'string' ? course.slug : null,
    courseTitle: isCourse && typeof course?.title === 'string' ? course.title : null,
    packCode:    isPack ? String(pack!.code) : null,
    packTitle:   isPack && typeof pack?.title === 'string' ? pack.title : null,
    reference:   String(row.reference ?? ''),
    createdAt:   String(row.created_at ?? ''),
    // Only whether it exists and is the provider's. The URL itself stays on the server.
    resumable:   isValidPaytechRedirectUrl(stored),
  }
}
