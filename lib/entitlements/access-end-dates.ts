import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEntitlementAccessible, type EntitlementLike } from '@/lib/entitlements'

/**
 * XP-LAUNCH-FINAL-18 — when each course the learner may open stops being open.
 *
 * For the learner's own dashboard. `my_course_access` deliberately carries no
 * dates and the entitlements table is closed to the browser roles, so this is
 * read on the server, for the signed-in learner's own id only, and returns
 * nothing but a date per course: `null` means no end date (an administrative
 * grant, the free course), a missing key means no accessible entitlement or a
 * failed read. Display only: access itself is still decided by the gate.
 */
export async function learnerAccessEndDates(
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, string | null>> {
  const ends = new Map<string, string | null>()
  const { data, error } = await createAdminClient()
    .from('entitlements')
    .select('course_id, status, starts_at, expires_at, revoked_at')
    .eq('user_id', userId)
  if (error || !data) return ends

  for (const row of data as (EntitlementLike & { course_id: string })[]) {
    if (!isEntitlementAccessible(row, now)) continue
    const previous = ends.get(row.course_id)
    if (previous === null) continue
    if (row.expires_at === null) ends.set(row.course_id, null)
    else if (previous === undefined || new Date(row.expires_at) > new Date(previous)) ends.set(row.course_id, row.expires_at)
  }
  return ends
}
