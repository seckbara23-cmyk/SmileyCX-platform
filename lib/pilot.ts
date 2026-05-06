/**
 * TEMP_FREE_ACCESS: Free-enrollment pilot flag.
 *
 * Controls whether payment is required to access courses.
 * When true, all authenticated users can enroll and learn for free.
 *
 * To re-enable payments:
 *   1. Set NEXT_PUBLIC_FREE_ACCESS_MODE=false in .env.local (or remove it)
 *   2. Search for // TEMP_FREE_ACCESS in the codebase and revert those blocks
 *   3. Run migration 005_free_pilot_access.sql rollback
 */
export const FREE_ACCESS_MODE =
  process.env.NEXT_PUBLIC_FREE_ACCESS_MODE === 'true'

/**
 * PILOT_MODE: Anonymous-access pilot flag.
 *
 * When true, published course content is fully accessible without an account.
 * Auth pages (/login, /signup) redirect to the course catalog.
 * Admin routes remain protected. Progress tracking and certificates are hidden.
 *
 * To disable:
 *   1. Set NEXT_PUBLIC_PILOT_MODE=false in .env.local (or remove it)
 *   2. Run migration 008_pilot_anon_access.sql rollback to restore RLS policies
 */
export const PILOT_MODE =
  process.env.NEXT_PUBLIC_PILOT_MODE === 'true'

/**
 * PAYMENTS_ENABLED: Payment gateway flag.
 *
 * When false (default during pilot), the checkout page bypasses all payment UI
 * and the createPaymentRecord server action refuses to create records.
 *
 * Set NEXT_PUBLIC_PAYMENTS_ENABLED=true only after payment gateways are
 * fully integrated, tested, and webhook handlers are deployed.
 */
export const PAYMENTS_ENABLED =
  process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === 'true'
