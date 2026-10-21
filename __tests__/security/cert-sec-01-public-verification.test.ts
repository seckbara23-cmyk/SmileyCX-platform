// @vitest-environment node
/**
 * CERT-SEC-01 — the public certificate verification contract.
 *
 * ── THE TWO DEFECTS ────────────────────────────────────────────────────────
 *
 * `/verify-certificate/<id>` is the only certificate surface with no viewer:
 * anyone with the link reads it, and what it says is the platform attesting to
 * a credential. Both defects were found during MEDIA-INTRO-09.
 *
 *   1. Validity was never checked. The page selected neither `status` nor
 *      `revoked_at`, filtered on nothing but the id, and computed
 *      `isValid = !!cert` — so a REVOKED certificate rendered the green
 *      "Certificat valide" badge with the holder's name, course, date and
 *      number. Revocation is a built feature (admin filter, badge, reason
 *      field), so the page was contradicting the platform's own records.
 *
 *   2. The learner's email was selected into the public page and displayed as
 *      the holder's name whenever `full_name` was absent.
 *
 * RLS cannot police this surface: `certificates_select_own` (013) returns
 * nothing to anon, so the page uses the service-role client by necessity.
 * Application code is the only control, which is what these tests pin.
 *
 * ── WHY THE MOCK IS STRICT ─────────────────────────────────────────────────
 *
 * MEDIA-INTRO-06 shipped a doomed statement to production behind 38 green
 * tests because the harness was more permissive than the database. So here the
 * mock returns ONLY the columns the page actually selected, and rejects any
 * status outside migration 019's CHECK constraint. If the page ever selects
 * `email` again, these tests see it; if it stops selecting `status`, the row
 * arrives without one and cannot be verifiable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CERTIFICATE_STATUSES,
  PUBLICLY_VERIFIABLE_STATUSES,
  PUBLIC_VERIFICATION_COLUMNS,
  isPubliclyVerifiable,
  evaluateCertificate,
} from '@/lib/certificates/verification'

// ── fixture ────────────────────────────────────────────────────────────────

const CERT_ID = '11111111-1111-4111-8111-111111111111'
const LEARNER_EMAIL = 'apprenante.privee@example.com'
const LEARNER_ID = '99999999-9999-4999-8999-999999999999'
const COURSE = 'Les fondamentaux de l’expérience client'
const NUMBER = 'XPCA-2026-000042'
const REASON = 'Révoqué après contestation interne — note administrative'

/** Every column the table really has, including the ones the page must not read. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: CERT_ID,
    user_id: LEARNER_ID,
    course_id: '22222222-2222-4222-8222-222222222222',
    certificate_number: NUMBER,
    issued_at: '2026-09-14T13:49:01.764Z',
    status: 'valid',
    revoked_at: null,
    revoked_reason: null,
    pdf_url: null,
    pdf_object_path: null,
    courses: { title: COURSE },
    profiles: { full_name: 'Awa Diallo', email: LEARNER_EMAIL },
    ...over,
  }
}

const state: { rows: Record<string, unknown>[]; selected: string[] } = { rows: [], selected: [] }

/**
 * Return only what was asked for — a projection, as PostgREST performs one.
 * Nested `courses(title)` / `profiles(full_name)` are honoured field by field,
 * so selecting `profiles(full_name)` cannot smuggle an email through.
 */
function project(r: Record<string, unknown>, columns: string) {
  const out: Record<string, unknown> = {}
  const top = columns.split(',').map(s => s.trim())
  for (const spec of top) {
    const nested = /^([a-z_]+)\(([^)]*)\)$/.exec(spec)
    if (nested) {
      const [, rel, fields] = nested
      const src = r[rel] as Record<string, unknown> | null
      if (src == null) { out[rel] = null; continue }
      const sub: Record<string, unknown> = {}
      for (const f of fields.split(',').map(s => s.trim())) {
        if (f in src) sub[f] = src[f]
      }
      out[rel] = sub
    } else if (spec in r) {
      out[spec] = r[spec]
    }
  }
  return out
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let columns = '*'
      let wanted: string | null = null
      const api = {
        select(c: string) { columns = c; state.selected.push(c); return api },
        eq(_col: string, v: string) { wanted = v; return api },
        maybeSingle: async () => {
          const hit = state.rows.find(r => r.id === wanted)
          return { data: hit ? project(hit, columns) : null, error: null }
        },
        single: async () => {
          const hit = state.rows.find(r => r.id === wanted)
          return hit
            ? { data: project(hit, columns), error: null }
            : { data: null, error: { code: 'PGRST116' } }
        },
      }
      return api
    },
  }),
}))

beforeEach(() => { state.rows = []; state.selected = [] })

function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  const el = node as { props?: { children?: unknown } }
  if (el.props && 'children' in el.props) textOf(el.props.children, out)
  return out
}

/**
 * Source with comments stripped.
 *
 * A guard that greps raw source matches the very prose that documents the
 * rule — the first draft of the two tests below failed because this file's
 * own explanation of "no expiry" and "never revoked_reason" contains those
 * words. Assert against code, not against documentation.
 */
function codeOf(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

async function render(id = CERT_ID) {
  const mod = await import('@/app/(public)/verify-certificate/[certificateId]/page')
  const tree = await mod.default({ params: Promise.resolve({ certificateId: id }) })
  return textOf(tree).join(' \u0001 ')
}

// ═══════════════════════════════════════════════════════════════════════════
describe('CERT-SEC-01 · the validity policy, from the schema', () => {
  it('knows exactly the four statuses migration 019 allows', () => {
    expect([...CERTIFICATE_STATUSES]).toEqual(['valid', 'revoked', 'pilot', 'duplicate'])
  })

  it('publishes only `valid` — revoked, pilot and duplicate are not credentials', () => {
    expect([...PUBLICLY_VERIFIABLE_STATUSES]).toEqual(['valid'])
    for (const s of ['revoked', 'pilot', 'duplicate']) {
      expect(PUBLICLY_VERIFIABLE_STATUSES).not.toContain(s)
    }
  })

  it.each([
    ['valid',     null, true],
    ['valid',     '2026-10-01T00:00:00Z', false],   // revoked_at outranks status
    ['revoked',   '2026-10-01T00:00:00Z', false],
    ['revoked',   null, false],                      // status outranks a null revoked_at
    ['pilot',     null, false],
    ['duplicate', null, false],
  ] as const)('status=%s revoked_at=%s -> verifiable=%s', (status, revoked_at, expected) => {
    expect(isPubliclyVerifiable(row({ status, revoked_at }))).toBe(expected)
  })

  it('an unknown or missing status is never verifiable', () => {
    expect(isPubliclyVerifiable(row({ status: 'something-new' }))).toBe(false)
    expect(isPubliclyVerifiable(row({ status: null }))).toBe(false)
    expect(isPubliclyVerifiable(null)).toBe(false)
    expect(isPubliclyVerifiable(undefined)).toBe(false)
  })

  it('refuses a row whose id is not the one requested', () => {
    expect(evaluateCertificate(row(), 'a-different-id').outcome).toBe('unknown')
    expect(evaluateCertificate(row(), CERT_ID).outcome).toBe('valid')
  })

  it('applies NO expiry rule, because the schema has no expiry column', () => {
    // Inventing one would refuse credentials the product never time-limited.
    const ancient = evaluateCertificate(row({ issued_at: '2019-01-01T00:00:00Z' }), CERT_ID)
    expect(ancient.outcome).toBe('valid')
    expect(codeOf('lib/certificates/verification.ts'))
      .not.toMatch(/expires_at|expiry|expiration_date/)
  })

  it('the public column list excludes email, user_id and revoked_reason', () => {
    expect(PUBLIC_VERIFICATION_COLUMNS).not.toMatch(/email/)
    expect(PUBLIC_VERIFICATION_COLUMNS).not.toMatch(/user_id/)
    expect(PUBLIC_VERIFICATION_COLUMNS).not.toMatch(/revoked_reason/)
    // and does include what the verdict needs
    for (const c of ['status', 'revoked_at', 'certificate_number', 'issued_at']) {
      expect(PUBLIC_VERIFICATION_COLUMNS).toContain(c)
    }
  })

  it('the facts it hands the page carry no email and no learner id', () => {
    const r = evaluateCertificate(row(), CERT_ID)
    expect(r.outcome).toBe('valid')
    if (r.outcome !== 'valid') return
    expect(Object.keys(r.facts).sort()).toEqual(
      ['certificateId', 'certificateNumber', 'courseTitle', 'holderName', 'issuedAt'])
    expect(JSON.stringify(r.facts)).not.toContain(LEARNER_EMAIL)
    expect(JSON.stringify(r.facts)).not.toContain(LEARNER_ID)
  })

  it('never falls back to the email when there is no name on file', () => {
    const r = evaluateCertificate(row({ profiles: { full_name: null, email: LEARNER_EMAIL } }), CERT_ID)
    if (r.outcome !== 'valid') throw new Error('expected valid')
    expect(r.facts.holderName).toBeNull()
    expect(r.facts.courseTitle).toBe(COURSE)      // still verifiable
  })

  it('treats a blank name as absent rather than rendering whitespace', () => {
    const r = evaluateCertificate(row({ profiles: { full_name: '   ' } }), CERT_ID)
    if (r.outcome !== 'valid') throw new Error('expected valid')
    expect(r.facts.holderName).toBeNull()
  })

  it('a non-valid certificate yields a bare verdict, with no facts attached', () => {
    const r = evaluateCertificate(row({ status: 'revoked', revoked_at: '2026-10-01T00:00:00Z', revoked_reason: REASON }), CERT_ID)
    expect(r).toEqual({ outcome: 'not-valid' })
    expect(JSON.stringify(r)).not.toContain(REASON)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CERT-SEC-01 · the rendered public page', () => {
  it('a VALID issued certificate verifies, showing name, course, number and date', async () => {
    state.rows = [row()]
    const out = await render()
    expect(out).toContain('Certificat valide')
    expect(out).toContain('Awa Diallo')
    expect(out).toContain(COURSE)
    expect(out).toContain(NUMBER)
    expect(out).toMatch(/2026/)
    expect(out).not.toContain('Certificat introuvable')
  })

  it('a REVOKED certificate is NOT presented as valid', async () => {
    state.rows = [row({ status: 'revoked', revoked_at: '2026-10-01T00:00:00Z', revoked_reason: REASON })]
    const out = await render()
    expect(out, 'a revoked certificate was confirmed as valid').not.toContain('Certificat valide')
    expect(out).toContain('non valide')
    expect(out).toContain('ne peut pas attester')
  })

  it('a revoked certificate leaks neither the holder, the course, nor the reason', async () => {
    state.rows = [row({ status: 'revoked', revoked_at: '2026-10-01T00:00:00Z', revoked_reason: REASON })]
    const out = await render()
    expect(out).not.toContain('Awa Diallo')
    expect(out).not.toContain(COURSE)
    expect(out).not.toContain(NUMBER)
    expect(out, 'an administrative note reached a public page').not.toContain(REASON)
  })

  it('revoked_at alone disqualifies, even while status still reads valid', async () => {
    state.rows = [row({ status: 'valid', revoked_at: '2026-10-01T00:00:00Z' })]
    const out = await render()
    expect(out).not.toContain('Certificat valide')
    expect(out).toContain('non valide')
  })

  it('a null revoked_at with status valid verifies', async () => {
    state.rows = [row({ status: 'valid', revoked_at: null })]
    expect(await render()).toContain('Certificat valide')
  })

  for (const status of ['pilot', 'duplicate'] as const) {
    it(`status '${status}' is not publicly presented as a credential`, async () => {
      state.rows = [row({ status })]
      const out = await render()
      expect(out).not.toContain('Certificat valide')
      expect(out).toContain('non valide')
      expect(out).not.toContain('Awa Diallo')
    })
  }

  it('an UNKNOWN identifier reports not found, and says nothing else', async () => {
    state.rows = []
    const out = await render('00000000-0000-4000-8000-000000000000')
    expect(out).toContain('Certificat introuvable')
    expect(out).not.toContain('Certificat valide')
    expect(out).not.toContain('Awa Diallo')
    expect(out).not.toContain(COURSE)
  })

  it('distinguishes "not valid" from "not found" — both are accurate, neither confirms', async () => {
    state.rows = [row({ status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' })]
    const revoked = await render()
    state.rows = []
    const missing = await render('00000000-0000-4000-8000-000000000000')
    expect(revoked).not.toBe(missing)
    expect(revoked).toContain('non valide')
    expect(missing).toContain('introuvable')
    for (const out of [revoked, missing]) expect(out).not.toContain('Certificat valide')
  })

  // ── privacy ──────────────────────────────────────────────────────────────

  it('NEVER renders the learner email — the central privacy defect', async () => {
    for (const over of [
      {},
      { profiles: { full_name: null, email: LEARNER_EMAIL } },
      { status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' },
    ]) {
      state.rows = [row(over)]
      const out = await render()
      expect(out, `email leaked with ${JSON.stringify(over)}`).not.toContain(LEARNER_EMAIL)
      expect(out).not.toMatch(/@example\.com/)
    }
  })

  it('does not select the email column at all', async () => {
    state.rows = [row()]
    await render()
    expect(state.selected.length).toBeGreaterThan(0)
    for (const c of state.selected) {
      expect(c, 'the public query asked for an email').not.toMatch(/email/)
      expect(c).not.toMatch(/user_id/)
      expect(c).not.toMatch(/revoked_reason/)
    }
  })

  it('exposes no internal learner identifier', async () => {
    state.rows = [row()]
    const out = await render()
    expect(out).not.toContain(LEARNER_ID)
    expect(out).not.toContain('22222222-2222-4222-8222-222222222222')  // course_id
    // The certificate id is in the URL already and is the verification handle.
    expect(out).toContain(CERT_ID)
  })

  it('verifies a certificate with no name on file, without inventing one', async () => {
    state.rows = [row({ profiles: { full_name: null, email: LEARNER_EMAIL } })]
    const out = await render()
    expect(out).toContain('Certificat valide')
    expect(out).toContain(COURSE)
    expect(out).toContain(NUMBER)
    expect(out).not.toContain(LEARNER_EMAIL)
    expect(out).toContain('atteste de la réussite')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CERT-SEC-01 · compatibility', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('existing verification links keep working: same route, same id, same number', async () => {
    state.rows = [row()]
    const out = await render(CERT_ID)
    expect(out).toContain('Certificat valide')
    expect(out).toContain(NUMBER)
    expect(out).toContain(CERT_ID)
  })

  it('the learner-facing certificate page is untouched and still ownership-checked', () => {
    const own = read('app/(platform)/certificates/[certificateId]/page.tsx')
    expect(own).toMatch(/cert\.user_id !== user!?\.id/)
    expect(own).toMatch(/redirect\('\/dashboard'\)/)
    // Showing a learner their OWN email on their own page is legitimate.
    expect(own).toMatch(/full_name, email/)
  })

  it('the certificate PDF routes remain authenticated and owner-only', () => {
    const pdf = read('app/api/certificates/[id]/pdf/route.ts')
    expect(pdf).toMatch(/status: 401/)
    expect(pdf).toMatch(/cert\.user_id !== user\.id/)
    expect(pdf).toMatch(/status: 403/)

    const media = read('app/api/media/certificate/[certificateId]/route.ts')
    expect(media).toMatch(/status: 401/)
    expect(media).toMatch(/cert\.user_id === user\.id/)
  })

  it('this slice changed no certificate issuance, revocation, schema or RLS', () => {
    const page = codeOf('app/(public)/verify-certificate/[certificateId]/page.tsx')
    // The public page reads. It must never write or revoke.
    expect(page).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/)
    expect(page, 'the administrative reason reached the page code').not.toMatch(/revoked_reason/)
    const policy = codeOf('lib/certificates/verification.ts')
    expect(policy).not.toMatch(/\.insert\(|\.update\(|\.delete\(|createAdminClient/)
  })
})
