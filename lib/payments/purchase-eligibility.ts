import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEntitlementAccessible, LIVE_STATUSES } from '@/lib/entitlements'

/**
 * Would `complete_payment()` fulfil a purchase of this course by this learner?
 * — XP-PAYTECH-04 (XP-PAYTECH-READY-01 F3).
 *
 * Checkout used to ask only "does the learner already have access?". But 062
 * refuses fulfilment in two further states, and a learner in either could pay
 * and THEN be refused, with the money taken:
 *
 *   * a LIVE entitlement (PENDING, ACTIVE, SUSPENDED) that does not grant access
 *     — 062 raises `entitlement_conflict`;
 *   * no live entitlement but a REVOKED one — 062 raises
 *     `entitlement_revoked_requires_decision`.
 *
 * This mirrors 062 §7 exactly, using the same access predicate (037's
 * `entitlement_accessible`, mirrored by `isEntitlementAccessible`). The
 * integration suite proves the two agree against the real SQL, state by state.
 * If they ever disagree, 062 wins at completion — this exists so the learner
 * is refused BEFORE paying rather than after.
 */
export type PurchaseBlocker = 'entitlement_conflict' | 'entitlement_revoked_requires_decision'

/**
 * XP-LAUNCH-FINAL-08 (065): a PURCHASE whose six-month window has closed is rolled over
 * to EXPIRED by `complete_payment()` before it grants the new window, so it blocks
 * nothing: the learner may buy the course again. Only a purchase: an expired
 * administrative, corporate or promotional grant still blocks, because 065 does not
 * touch it and would refuse the completion.
 */
function isLapsedPurchase(e: { source?: unknown; status?: unknown; expires_at?: unknown; revoked_at?: unknown }, now: number): boolean {
  return e.source === 'INDIVIDUAL_PURCHASE'
    && e.status === 'ACTIVE'
    && !e.revoked_at
    && typeof e.expires_at === 'string'
    && new Date(e.expires_at).getTime() <= now
}

export async function purchaseBlocker(userId: string, courseId: string): Promise<PurchaseBlocker | null> {
  const { data, error } = await createAdminClient()
    .from('entitlements')
    .select('source, status, starts_at, expires_at, revoked_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)

  // Fail closed: if we cannot tell, we do not take the money.
  if (error || !Array.isArray(data)) return 'entitlement_conflict'

  const now = Date.now()
  const live = data
    .filter(e => (LIVE_STATUSES as readonly string[]).includes(String(e.status)))
    .filter(e => !isLapsedPurchase(e, now))
  if (live.length > 0) {
    // An accessible live entitlement is "already has access", which checkout
    // refuses earlier; anything else live is 062's conflict.
    return live.some(e => isEntitlementAccessible(e)) ? null : 'entitlement_conflict'
  }
  return data.some(e => e.status === 'REVOKED') ? 'entitlement_revoked_requires_decision' : null
}
