/**
 * XP Client Academy brand and domain constants (XPA-1).
 *
 * Single source of truth for the public identity. Before XPA-1 these values were
 * duplicated as literals across ~15 files, which is how the platform ended up
 * with three different legacy fallback domains all claiming to be canonical.
 *
 * ── Domain policy (ratified, D-DOMAIN) ────────────────────────────────────
 * The dual-domain architecture is PRESERVED and deliberate:
 *
 *   www.xpclient-academy.com  → canonical PUBLIC academy. Every user-facing
 *                               URL, certificate link, metadata entry and
 *                               canonical link uses this.
 *   the Vercel deployment host → technical deployment / private admin portal.
 *                               NOT a brand surface, and never named here.
 *
 * The deployment hostname is defined once, in `lib/hosts.ts`, and consumed by
 * the middleware host boundary. It is infrastructure, must NOT be "rebranded",
 * and is deliberately absent from this module so that a brand-wide search never
 * surfaces it as something to change. Only user-facing URLs live here.
 *
 * Dependency-free by design so both server and client components can import it.
 */

/**
 * Canonical public academy origin. Never the Vercel deployment host.
 *
 * NEXT_PUBLIC_SITE_URL is the single override, and it is purpose-built for this.
 * NEXT_PUBLIC_APP_URL is deliberately NOT consulted: it is a legacy variable
 * that previously carried legacy-domain values, and its production value cannot
 * be read from the repository. Letting it participate would mean a stale
 * setting could silently poison every canonical URL, OG tag, sitemap entry and
 * certificate link — exactly the class of drift XPA-1 exists to remove. If the
 * variable is unset, the hardcoded canonical domain is correct by construction.
 */
export const PUBLIC_SITE_URL: string =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.xpclient-academy.com'

/** Product name, as shown to users. */
export const BRAND_NAME = 'XP Client Academy'

/** Legal/issuing entity — used on certificates and in metadata authorship. */
export const BRAND_LEGAL_NAME = 'XP Client Consulting'

/**
 * Public contact address DISPLAYED in the UI.
 *
 * The charte graphique (XP-BRAND-01 §8) makes contact@xpclient-academy.com the
 * official public address, which settles the display half of decision Q-C.
 *
 * Reads ONLY NEXT_PUBLIC_CONTACT_EMAIL. A server-only variable cannot be
 * inlined into client bundles, so using one here would make the Footer (a
 * client component) show a different address from the server.
 */
export const CONTACT_EMAIL: string =
  process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'contact@xpclient-academy.com'

/**
 * Delivery recipient for contact and waitlist mail lives in
 * `lib/email/contact-recipient.ts`, which is server-only: it reads a
 * server-side variable, and this module must stay client-safe.
 */

/** Official public phone number, display form (XP-BRAND-01 §8). */
export const CONTACT_PHONE = '+221 78 685 78 78'
/** Official public phone number, tel: link form. */
export const CONTACT_PHONE_HREF = 'tel:+221786857878'
/** Official public location. */
export const CONTACT_LOCATION = 'Dakar, Sénégal'

/** Absolute URL on the canonical public domain. */
export function publicUrl(path: string): string {
  const base = PUBLIC_SITE_URL.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/** Public certificate verification URL — always on the academy domain. */
export function certificateVerifyUrl(certificateId: string): string {
  return publicUrl(`/verify-certificate/${certificateId}`)
}

/** Public certificate view URL — always on the academy domain. */
export function certificateViewUrl(certificateId: string): string {
  return publicUrl(`/certificates/${certificateId}`)
}
