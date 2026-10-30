import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { isProductionDeployment } from '@/lib/payments/providers'
import type { EnvLike } from '@/lib/payments/paytech-config'

const log = createLogger('payments/database-guard')

/**
 * May THIS deployment do privileged payment work on THIS database?
 * XP-PAYTECH-04.
 *
 * A production deployment may. Anything else (a preview, a branch build, a
 * developer's machine) may only when the database itself declares that it is a
 * sandbox, in `public.payment_environment` (migration 063). A missing marker,
 * an unreadable one, or `live` all refuse.
 *
 * The database declares its environment, and the application cannot change the
 * marker.
 *
 * Every write a payment can receive passes through this check: the status
 * writes and the completion call in `payment-completion.ts`, and the entry
 * points in `paytech-checkout.ts`, `paytech-reconcile.ts`, the IPN route, the
 * sweep and the admin actions.
 */
export type PaymentDatabaseAuthority =
  | { readonly allowed: true; readonly reason: null }
  | { readonly allowed: false; readonly reason: 'database_not_sandbox' | 'marker_unreadable' }

const ALLOWED: PaymentDatabaseAuthority = Object.freeze({ allowed: true, reason: null })

export async function paymentDatabaseAuthority(
  env: EnvLike = process.env,
): Promise<PaymentDatabaseAuthority> {
  if (isProductionDeployment(env)) return ALLOWED
  try {
    const { data, error } = await createAdminClient()
      .from('payment_environment')
      .select('mode')
      .eq('singleton', true)
      .maybeSingle()
    if (error || !data) {
      log.warn('payment work refused: the database declares no payment environment')
      return { allowed: false, reason: 'marker_unreadable' }
    }
    if ((data as { mode?: unknown }).mode !== 'sandbox') {
      log.warn('payment work refused: this deployment is not production and the database is not a sandbox')
      return { allowed: false, reason: 'database_not_sandbox' }
    }
    return ALLOWED
  } catch {
    log.warn('payment work refused: the payment environment could not be read')
    return { allowed: false, reason: 'marker_unreadable' }
  }
}
