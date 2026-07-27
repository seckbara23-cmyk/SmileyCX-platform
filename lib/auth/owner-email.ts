/**
 * Administrator allowlist predicate (CX-AUTH-1) — pure, dependency-free.
 *
 * Deliberately separate from lib/auth/owner.ts: this module must be importable
 * from the EDGE middleware runtime, which cannot load `server-only` or
 * `next/headers`. Keep it free of imports so both runtimes can use it.
 *
 * ADMIN_OWNER_EMAILS is a comma-separated allowlist of authorized
 * administrator addresses. It is read server-side only — no NEXT_PUBLIC_
 * prefix, so it never reaches the client bundle.
 *
 * This is an allowlist, NOT a role model: every listed address has identical,
 * full administration access. There is no hierarchy and no per-address
 * permission. Adding a tiered model is a separate decision.
 */

/**
 * Parsed allowlist: trimmed, lowercased, empty entries dropped.
 * Returns an empty array when the variable is missing or blank.
 */
export function ownerEmails(): string[] {
  return (process.env.ADMIN_OWNER_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Is this address on the administrator allowlist?
 *
 * Fails CLOSED: when ADMIN_OWNER_EMAILS is missing or empty the allowlist is
 * empty and this returns false for every input, so a missing environment
 * variable locks the portal rather than opening it. An empty config must never
 * compare equal to an empty email.
 */
export function isOwnerEmail(email: string | null | undefined): boolean {
  const allowed = ownerEmails()
  if (allowed.length === 0) return false
  if (!email) return false
  return allowed.includes(email.trim().toLowerCase())
}
