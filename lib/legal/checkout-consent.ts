/**
 * The three boxes ticked before every purchase — XP-LAUNCH-FINAL-11 (CGV art. 4).
 *
 *   1. acceptance of the CGU and the CGV, at the versions on screen;
 *   2. the express request for immediate access (CGV 7.1), which does NOT
 *      deprive the buyer of the rights Senegalese law gives them;
 *   3. the certification of being 18 or older, or of buying as the parent or
 *      legal representative of the learner (CGV 9).
 *
 * None is pre-ticked. The browser sends what was ticked and the version it was
 * shown; the server accepts only all three, for the current version, and then
 * records them on the order with the SERVER's clock (a browser's time proves
 * nothing). A stale page — a version the server no longer offers — is refused
 * and asked to reload, never silently upgraded.
 *
 * Dependency-free so the checkout components and the server action share it.
 */
import { SALES_TERMS_VERSION, TERMS_VERSION } from './versions'

/** The version pair the checkout shows. One string because both texts move together at 1.0. */
export const CHECKOUT_TERMS_VERSION = `${TERMS_VERSION}+${SALES_TERMS_VERSION}`

/** What the browser sends: the three boxes and the version they were shown at. */
export interface CheckoutConsent {
  readonly version: string
  readonly terms: boolean
  readonly immediateAccess: boolean
  readonly adultOrGuardian: boolean
}

/** What is recorded on the order (`payments.metadata.legal`). */
export interface CheckoutConsentRecord {
  readonly cgu: string
  readonly cgv: string
  /** Server time at which the attempt carrying this acceptance was created. */
  readonly acceptedAt: string
  readonly immediateAccessRequested: true
  readonly adultOrGuardianCertified: true
}

export type ConsentCheck = 'accepted' | 'incomplete' | 'stale'

/** Strict: an object, the current version, and all three boxes exactly `true`. */
export function checkCheckoutConsent(raw: unknown): ConsentCheck {
  if (!raw || typeof raw !== 'object') return 'incomplete'
  const c = raw as Partial<Record<keyof CheckoutConsent, unknown>>
  if (c.terms !== true || c.immediateAccess !== true || c.adultOrGuardian !== true) return 'incomplete'
  if (c.version !== CHECKOUT_TERMS_VERSION) return 'stale'
  return 'accepted'
}

/** The record written on the order once the consent has been checked. */
export function checkoutConsentRecord(acceptedAt: Date): CheckoutConsentRecord {
  return {
    cgu: TERMS_VERSION,
    cgv: SALES_TERMS_VERSION,
    acceptedAt: acceptedAt.toISOString(),
    immediateAccessRequested: true,
    adultOrGuardianCertified: true,
  }
}

/** The consent of three ticked boxes at the current version: what the checkout sends. */
export function tickedCheckoutConsent(): CheckoutConsent {
  return { version: CHECKOUT_TERMS_VERSION, terms: true, immediateAccess: true, adultOrGuardian: true }
}
