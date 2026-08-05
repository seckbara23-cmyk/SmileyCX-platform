/**
 * Versioned legal documents (XPA-6A).
 *
 * Acceptance is recorded against a VERSION, not against "the terms". Without a
 * version the record is worthless the moment the text changes: you can prove
 * someone clicked a box, but not what they agreed to.
 *
 * ── HOW TO PUBLISH A NEW VERSION ──────────────────────────────────────────
 * 1. Update the page text under app/(public)/terms or /privacy.
 * 2. Bump the constant below.
 * 3. Nothing else. Existing acceptances keep pointing at the old version, and
 *    `legal_acceptances` gains a new row when a user accepts the new one.
 *
 * ⚠️ AWAITING LEGAL REVIEW. The published pages currently carry a short
 * plain-language summary, not counsel-approved text. That is recorded here
 * rather than papered over, and shown to users on the pages themselves. XPA-6A
 * deliberately does NOT invent legal wording — see the XPA-6A report.
 *
 * Dependency-free so client and server components can both import it.
 */

/** Current Terms of Use version. Bump when the published text changes. */
export const TERMS_VERSION = '2026-08-06-draft'

/** Current Privacy Policy version. Bump when the published text changes. */
export const PRIVACY_VERSION = '2026-08-06-draft'

/**
 * True while the published text is a summary awaiting counsel review. Drives
 * the visible notice on the legal pages. Set to false when approved text lands.
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
