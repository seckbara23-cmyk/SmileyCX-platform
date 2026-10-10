'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'

/**
 * PAY-2C-0 — THIS ACTION IS DISABLED. It refuses, and it writes nothing.
 *
 * ── WHAT IT USED TO DO, AND WHY THAT WAS WRONG ────────────────────────────
 *
 * It set `payments.status = 'completed'` and then upserted a row into
 * `enrollments`. Since XPA-6B (migration 037) an enrollment authorizes
 * NOTHING: `has_course_access()` reads `entitlements` alone, and its own
 * comment says so — "Enrollment does not authorize access (Q-L)". So the
 * button marked a payment PAID and the learner still could not open the
 * course. An administrator pressing "Activer" produced a confirmed payment,
 * a plausible-looking academic record, and no access.
 *
 * It was also unsound in three further ways:
 *
 *   * NOT ATOMIC. Two separate statements with no transaction. A failure
 *     between them left a payment marked completed with no enrollment at all.
 *   * NO IDENTITY CHECK. `payments.user_id` and `payments.course_id` are both
 *     NULLABLE. A row with either NULL would have been written into
 *     `enrollments`, whose own columns are NOT NULL, or silently mis-attributed.
 *   * NO VERIFICATION. Nothing checked an amount, a currency, a provider, a
 *     provider mode or a provider token. "Completed" meant "an admin clicked".
 *
 * ── WHY IT REFUSES RATHER THAN BEING DELETED ──────────────────────────────
 *
 * Every export of a 'use server' module is a reachable HTTP endpoint. A browser
 * holding a stale page, or anyone replaying a previously captured action id,
 * can still POST to it. Deleting the export would make that fail — but with a
 * framework error, and with nothing in the repository recording why. Keeping an
 * explicit refusal means the denial is deliberate, testable, and legible to the
 * next reader.
 *
 * `requirePlatformAdmin()` is still called FIRST and deliberately: a non-admin
 * must be refused as a non-admin (redirected, learning nothing), not told that
 * a payment feature is pending. The refusal below is for administrators.
 *
 * NOTHING ELSE IS IMPORTED. No Supabase client of any kind is constructed in
 * this file, so there is no code path from here to a payment write — a property
 * the PAY-2C-0 test suite asserts by reading this source.
 *
 * ── WHAT REPLACES IT ──────────────────────────────────────────────────────
 *
 * PAY-2C: a single SQL function that marks the payment completed AND grants the
 * INDIVIDUAL_PURCHASE entitlement in ONE transaction, callable only by a
 * trusted server-side caller that has independently verified the payment with
 * PayDunya server-to-server. Until that exists there is no correct way to
 * complete a payment, so there is no action here that pretends otherwise.
 *
 * Do NOT "fix" this by inserting an entitlement here instead. A manual grant is
 * already available, audited and rate-limited, at /admin/entitlements
 * (grantEntitlement) — and it deliberately refuses the INDIVIDUAL_PURCHASE
 * source, because a human must not record a purchase no payment system
 * produced.
 */
export async function activateEnrollment(_formData: FormData): Promise<void> {
  // Non-admins are refused as non-admins, before any feature message exists.
  await requirePlatformAdmin()

  throw new Error(
    "L'activation manuelle des paiements est désactivée. " +
    "Elle sera rétablie avec l'intégration sécurisée PayDunya (PAY-2C), " +
    "qui confirmera chaque paiement auprès du prestataire avant d'accorder " +
    "l'accès. Pour accorder un accès maintenant, utilisez Admin → Accès.",
  )
}
