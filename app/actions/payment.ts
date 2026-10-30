'use server'
/**
 * The legacy payment-intent action — RETIRED by XP-PAYTECH-04.
 *
 * `createPaymentRecord` was called by `PaymentMethodSelector`, which collected a
 * card number, expiry and CVV (or a mobile-money phone number) in this site's
 * own page and then wrote a `pending` payment that no gateway ever received and
 * nothing ever settled. The learner saw "Paiement en attente" forever.
 *
 * The selector is deleted. This export is kept as an explicit refusal rather
 * than deleted, for the same reason PAY-2C-0 kept `activateEnrollment`: every
 * export of a 'use server' module is a reachable endpoint, and a stale page can
 * still POST to it. A deliberate refusal is testable and legible; a missing
 * action is a framework error with no recorded reason.
 *
 * NOTHING IS IMPORTED. No Supabase client exists in this file, so there is no
 * code path from here to a payment row — and it never reads `metadata`, so no
 * card or phone value can be accepted, logged or stored.
 *
 * Payment now starts in `app/actions/paytech-checkout.ts`, which sends the
 * learner to PayTech's hosted page and takes nothing but a course id.
 */

export interface CreatePaymentResult {
  paymentId?: string
  error?:     string
}

export async function createPaymentRecord(_input: unknown): Promise<CreatePaymentResult> {
  return {
    error: 'Ce formulaire de paiement a été retiré. Rechargez la page pour payer via PayTech.',
  }
}
