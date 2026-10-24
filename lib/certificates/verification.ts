/**
 * CERT-SEC-01 — the public certificate verification policy.
 *
 * ── WHY THIS IS A MODULE AND NOT A FEW LINES IN THE PAGE ────────────────────
 *
 * `/verify-certificate/<id>` is the one certificate surface with no viewer:
 * anyone holding a link can read it, and what it says is the platform
 * attesting to a credential. Two defects made that attestation unreliable.
 *
 *   1. Validity was never checked. The page selected neither `status` nor
 *      `revoked_at`, filtered on nothing but the id, and computed
 *      `isValid = !!cert` — so a REVOKED certificate rendered the green
 *      "Certificat valide" badge with the holder's name, course, issue date
 *      and number. The failure branch's own copy already said "ou a peut-être
 *      été révoqué": the UI promised a check the query never made.
 *
 *   2. The learner's email address was selected into a public page and used as
 *      the displayed name whenever `full_name` was absent.
 *
 * Row Level Security cannot help here. `certificates_select_own` (migration
 * 013) limits anon to its own rows, which for an anonymous caller is none — so
 * the page necessarily uses the service-role client to serve a public lookup.
 * Every validity and privacy rule therefore has to live in application code,
 * which is exactly why it belongs in one small, testable place rather than
 * inline in JSX.
 *
 * ── THE CONTRACT, FROM THE SCHEMA ──────────────────────────────────────────
 *
 * `certificates` (base schema + migration 019):
 *
 *   status             TEXT NOT NULL DEFAULT 'valid'
 *                        CHECK (status IN ('valid','revoked','pilot','duplicate'))
 *   revoked_at         TIMESTAMPTZ          -- nullable
 *   revoked_reason     TEXT                 -- nullable, NEVER public
 *   issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   certificate_number TEXT UNIQUE NOT NULL
 *   UNIQUE(user_id, course_id)
 *
 * Two consequences worth stating, because both bound this policy:
 *
 *   • `issued_at` is NOT NULL, so the schema has no draft state. A row that
 *     exists is a row that was issued; there is no "issued, not a draft"
 *     condition left to enforce beyond existence.
 *   • There is no expiry column anywhere in the schema. This policy therefore
 *     applies no expiration rule — inventing one would refuse credentials the
 *     product never time-limited.
 */

/** Exactly the values migration 019's CHECK constraint admits. */
export const CERTIFICATE_STATUSES = ['valid', 'revoked', 'pilot', 'duplicate'] as const
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number]

/**
 * The only status a stranger may be told is a genuine credential.
 *
 *   valid      → yes, that is what it means.
 *   revoked    → withdrawn; attesting it would be false.
 *   duplicate  → by definition not the authoritative record for that
 *                (learner, course) pair, so confirming it would attest the
 *                same credential twice.
 *   pilot      → a pilot/test artefact. Real to the platform, not a
 *                qualification to present to a third party.
 *
 * Narrow by construction: a status added later is not publicly verifiable
 * until someone decides it should be.
 */
export const PUBLICLY_VERIFIABLE_STATUSES: readonly string[] = ['valid']

/**
 * The columns the public lookup may read.
 *
 * `profiles(email)` and `user_id` are absent deliberately, not by oversight:
 * the public page has no business with either, and selecting a column is
 * enough to serialise it into the RSC payload even when nothing renders it.
 * `revoked_reason` is absent for the same reason — it is an administrative
 * note, frequently about a person.
 */
export const PUBLIC_VERIFICATION_COLUMNS =
  'id, certificate_number, issued_at, status, revoked_at, courses(title), profiles(full_name)'

export interface CertificateVerificationRow {
  id: string
  certificate_number: string | null
  issued_at: string | null
  status: string | null
  revoked_at: string | null
  courses?: { title: string | null } | { title: string | null }[] | null
  profiles?: { full_name: string | null } | { full_name: string | null }[] | null
}

/** Everything the public page is allowed to render, and nothing else. */
export interface PublicCertificateFacts {
  certificateId: string
  certificateNumber: string | null
  issuedAt: string | null
  courseTitle: string | null
  /** `null` when the holder has no name on file — never an email. */
  holderName: string | null
}

export type VerificationResult =
  /** No certificate carries this identifier. */
  | { outcome: 'unknown' }
  /**
   * A certificate exists but may not be presented as a credential. The reason
   * is deliberately not carried: a verifier needs the verdict, not the file
   * note behind it.
   */
  | { outcome: 'not-valid' }
  | { outcome: 'valid'; facts: PublicCertificateFacts }

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null)

const clean = (s: string | null | undefined): string | null => {
  const t = typeof s === 'string' ? s.trim() : ''
  return t.length > 0 ? t : null
}

/**
 * Is this row a credential the platform will vouch for publicly?
 *
 * BOTH signals must agree. `status` and `revoked_at` are separate columns an
 * administrator can set independently, and nothing in the schema keeps them
 * consistent — so a populated `revoked_at` disqualifies even if `status` still
 * reads 'valid', and a non-verifiable status disqualifies even if `revoked_at`
 * is null. Either one saying "no" is enough.
 */
export function isPubliclyVerifiable(row: CertificateVerificationRow | null | undefined): boolean {
  if (!row) return false
  if (row.revoked_at !== null && row.revoked_at !== undefined) return false
  return PUBLICLY_VERIFIABLE_STATUSES.includes(row.status ?? '')
}

/**
 * Turn a lookup into the one thing the page is allowed to say.
 *
 * `requestedId` is compared against the row so a mismatched join or a future
 * lookup by another key can never attest to the wrong certificate.
 */
export function evaluateCertificate(
  row: CertificateVerificationRow | null | undefined,
  requestedId?: string,
): VerificationResult {
  if (!row) return { outcome: 'unknown' }
  if (requestedId !== undefined && row.id !== requestedId) return { outcome: 'unknown' }
  if (!isPubliclyVerifiable(row)) return { outcome: 'not-valid' }

  return {
    outcome: 'valid',
    facts: {
      certificateId: row.id,
      certificateNumber: clean(row.certificate_number),
      issuedAt: row.issued_at ?? null,
      courseTitle: clean(one(row.courses)?.title ?? null),
      // No email fallback. A certificate with no name on file still verifies —
      // the course, number and date are what a third party is checking.
      holderName: clean(one(row.profiles)?.full_name ?? null),
    },
  }
}
