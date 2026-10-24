import 'server-only'

/**
 * Mailbox that actually RECEIVES contact-form and waitlist notifications.
 *
 * Kept out of `lib/brand.ts` on purpose. That module is imported by client
 * components (the Footer), so a server-only `process.env.CONTACT_EMAIL` read
 * there would be `undefined` in the browser bundle and the two halves of the
 * app would quietly disagree — a trap `xpa-1-branding` guards against, and one
 * this slice walked straight into before the guard caught it.
 *
 * ── WHY DELIVERY IS SEPARATE FROM DISPLAY ─────────────────────────────────
 *
 * XP-BRAND-01 §8 makes contact@xpclient-academy.com the official address to
 * SHOW. It does not say that mailbox is routed yet, and decision Q-C recorded
 * why that matters: pointing delivery at an unconfirmed address discards every
 * contact and waitlist submission with no error anywhere. Publishing the new
 * address must not also redirect delivery into a hole.
 *
 * So the public page shows the official address immediately, while delivery
 * stays on the last mailbox known to receive until an operator moves it.
 *
 * Resolution order:
 *   1. CONTACT_EMAIL             — the operator's switch; set this to the new
 *                                  mailbox the moment it is live.
 *   2. NEXT_PUBLIC_CONTACT_EMAIL — if the public address has been configured
 *                                  explicitly, it is deliberate, so honour it.
 *   3. the last address known to receive.
 */
export const CONTACT_RECIPIENT_EMAIL: string =
  process.env.CONTACT_EMAIL
  ?? process.env.NEXT_PUBLIC_CONTACT_EMAIL
  ?? 'bonjour@smileycx.com'
