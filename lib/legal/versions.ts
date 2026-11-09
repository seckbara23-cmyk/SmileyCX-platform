/**
 * Versioned legal documents (XPA-6A, XP-LAUNCH-FINAL-11).
 *
 * Acceptance is recorded against a VERSION, not against "the terms". Without a
 * version the record is worthless the moment the text changes: you can prove
 * someone clicked a box, but not what they agreed to.
 *
 * ── HOW TO PUBLISH A NEW VERSION ──────────────────────────────────────────
 * 1. Update the text in ./documents (the pages render it).
 * 2. Bump the constant below, and the `version` of that text.
 * 3. Nothing else. Existing acceptances keep pointing at the old version:
 *    `legal_acceptances` gains a new row when a user accepts the new terms at
 *    registration, and each order keeps the versions accepted at checkout
 *    (`payments.metadata.legal`, see ./checkout-consent).
 *
 * ⚠️ NOT LAWYER-APPROVED. Version 1.0 of the four texts is XP CLIENT's launch
 * text (CGU/CGV v0.3, privacy policy and legal notice v0.2, each published as
 * 1.0). It was drafted with the help of AI tools and a lawyer's review is
 * planned; nothing published may claim otherwise.
 *
 * Dependency-free so client and server components can both import it.
 */

/** Conditions générales d'utilisation. Bump when the published text changes. */
export const TERMS_VERSION = '1.0'

/** Politique de confidentialité. Bump when the published text changes. */
export const PRIVACY_VERSION = '1.0'

/**
 * Conditions générales de vente, accepted at checkout before every purchase
 * (CGV art. 4). Deliberately NOT in LEGAL_DOCUMENTS: the acceptance is recorded
 * on the order itself, so registration and migration 035's list are untouched.
 */
export const SALES_TERMS_VERSION = '1.0'

/** Mentions légales. Displayed only; nobody accepts them. */
export const LEGAL_NOTICE_VERSION = '1.0'

/**
 * True while the published texts await the lawyer's review. Drives a factual
 * notice on the legal pages. Set to false only once that review has happened.
 */
export const LEGAL_TEXT_PENDING_REVIEW = true

/** Document identifiers, matching the `document` check constraint in migration 035. */
export const LEGAL_DOCUMENTS = ['terms', 'privacy'] as const
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number]

/** Current version for each document. */
export const CURRENT_LEGAL_VERSIONS: Record<LegalDocument, string> = {
  terms:   TERMS_VERSION,
  privacy: PRIVACY_VERSION,
}
