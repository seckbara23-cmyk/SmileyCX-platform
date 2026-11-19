import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { ownerEmails } from '@/lib/auth/owner-email'
import { sendCommercialIntegrityAlert } from '@/lib/email'

/**
 * XP-PAYTECH-P7 — the daily commercial integrity check, run by the reconciliation cron
 * after a complete sweep. Read-only. It alerts the owners only when it finds something:
 *
 *   * a price change in the last WINDOW_HOURS (migration 067's append-only record),
 *     and whether it was confirmed in the administration or made OUTSIDE it;
 *   * a completed payment with no recorded access (payment_entitlements): an
 *     access-grant failure, which complete_payment() should make impossible.
 *
 * Duplicate enrollments are not queried: the unique index on (user_id, course_id)
 * that 062 requires makes them impossible.
 *
 * It never throws and never changes the sweep's own result.
 */

const log = createLogger('catalogue/commercial-integrity')

export const WINDOW_HOURS = 26
const COMPLETED_LOOKBACK_DAYS = 30
const MAX_ROWS = 200

export interface PriceChangeRow {
  occurred_at: string; item_kind: string; item_code: string | null; operation: string
  old_price: number | string | null; new_price: number | string | null
  confirmed: boolean; actor_source: string; actor_email: string | null; jwt_role: string | null
}

/** Made by the course editor through 067's function: confirmed, attributed, via the application's service role. */
export function confirmedInApp(c: Pick<PriceChangeRow, 'confirmed' | 'actor_source' | 'jwt_role'>): boolean {
  return c.confirmed && c.actor_source === 'admin_rpc' && c.jwt_role === 'service_role'
}

export interface IntegrityReport {
  priceChanges: number
  priceChangesOutsideApp: number
  accessLinkMissing: number
  alertsSent: number
  unavailable?: string
}

const num = (v: number | string | null) => (v === null ? null : Number(v))

export async function checkCommercialIntegrity(now = Date.now()): Promise<IntegrityReport> {
  const report: IntegrityReport = { priceChanges: 0, priceChangesOutsideApp: 0, accessLinkMissing: 0, alertsSent: 0 }
  try {
    const admin = createAdminClient()

    const { data: changes, error: changesError } = await admin
      .from('commercial_price_changes')
      .select('occurred_at, item_kind, item_code, operation, old_price, new_price, confirmed, actor_source, actor_email, jwt_role')
      .gt('occurred_at', new Date(now - WINDOW_HOURS * 3_600_000).toISOString())
      .order('occurred_at', { ascending: true })
      .limit(MAX_ROWS)
    if (changesError) {
      report.unavailable = 'price_changes_unreadable'
      log.error({ code: (changesError as { code?: string }).code }, 'integrity check: price changes unreadable')
    }
    const priceRows = (changes ?? []) as PriceChangeRow[]

    const { data: completed, error: completedError } = await admin
      .from('payments')
      .select('id, reference')
      .eq('status', 'completed')
      .gt('created_at', new Date(now - COMPLETED_LOOKBACK_DAYS * 86_400_000).toISOString())
      .limit(MAX_ROWS)
    let missing: string[] = []
    if (completedError) {
      report.unavailable = report.unavailable ?? 'payments_unreadable'
      log.error('integrity check: completed payments unreadable')
    } else if ((completed ?? []).length > 0) {
      const ids = (completed as { id: string }[]).map(p => p.id)
      const { data: links, error: linksError } = await admin.from('payment_entitlements').select('payment_id').in('payment_id', ids)
      if (linksError) {
        report.unavailable = report.unavailable ?? 'links_unreadable'
        log.error('integrity check: payment_entitlements unreadable')
      } else {
        const linked = new Set((links as { payment_id: string }[]).map(l => l.payment_id))
        missing = (completed as { id: string; reference: string }[]).filter(p => !linked.has(p.id)).map(p => p.reference)
      }
    }

    report.priceChanges = priceRows.length
    report.priceChangesOutsideApp = priceRows.filter(c => !confirmedInApp(c)).length
    report.accessLinkMissing = missing.length

    if (priceRows.length > 0 || missing.length > 0) {
      const data = {
        windowHours: WINDOW_HOURS,
        accessLinkMissing: missing,
        priceChanges: priceRows.map(c => ({
          at: c.occurred_at, kind: c.item_kind, code: c.item_code,
          oldPrice: num(c.old_price), newPrice: num(c.new_price),
          confirmedInApp: confirmedInApp(c), actorEmail: c.actor_email,
        })),
      }
      for (const to of ownerEmails()) {
        const sent = await sendCommercialIntegrityAlert(to, data)
        if (sent.success) report.alertsSent += 1
      }
      if (report.alertsSent === 0) log.error(report, 'integrity check found something but no alert was sent')
    }
    log.info(report, 'commercial integrity check finished')
  } catch {
    report.unavailable = report.unavailable ?? 'failed'
    log.error('commercial integrity check failed')
  }
  return report
}
