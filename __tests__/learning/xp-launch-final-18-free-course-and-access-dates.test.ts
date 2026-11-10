/**
 * XP-LAUNCH-FINAL-18 — the free course a learner starts themselves, and the
 * access end date the dashboard shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>
const state = {
  courses: [] as Row[],
  entitlements: [] as Row[],
  inserts: [] as { table: string; row: Row }[],
  upserts: [] as { table: string; row: Row; opts: unknown }[],
  insertError: null as null | { message: string },
  readError: null as null | { message: string },
  audits: [] as Row[],
  /** Runs inside insert(), before it answers: another request's row appearing in between. */
  onInsert: null as null | (() => void),
}

/** A minimal stand-in for the service client: eq / in filters, maybeSingle, insert, upsert. */
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  const rows = () => (table === 'courses' ? state.courses : table === 'entitlements' ? state.entitlements : [])
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { filters.push(r => r[col] === v); return q },
    in: (col: string, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return q },
    maybeSingle: async () => {
      const hit = rows().filter(r => filters.every(f => f(r)))
      return { data: hit[0] ?? null, error: null }
    },
    then: (resolve: (v: { data: Row[] | null; error: unknown }) => unknown) =>
      resolve(state.readError ? { data: null, error: state.readError } : { data: rows().filter(r => filters.every(f => f(r))), error: null }),
    insert: async (row: Row) => {
      state.inserts.push({ table, row })
      state.onInsert?.()
      if (state.insertError) return { error: state.insertError }
      if (table === 'entitlements') state.entitlements.push(row)
      return { error: null }
    },
    upsert: async (row: Row, opts: unknown) => { state.upserts.push({ table, row, opts }); return { error: null } },
  }
  return q
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => query(t) }) }))
vi.mock('@/lib/audit/log', () => ({ logAuditEvent: async (e: Row) => { state.audits.push(e); return true } }))

const FREE = { id: 'c-free', slug: 'free-course', is_free: true, is_published: true }
const PAID = { id: 'c-paid', slug: 'paid-course', is_free: false, is_published: true }
const DRAFT = { id: 'c-draft', slug: 'draft-free', is_free: true, is_published: false }
const U = 'user-1'

beforeEach(() => {
  state.courses = [FREE, PAID, DRAFT]
  state.entitlements = []
  state.inserts = []
  state.upserts = []
  state.insertError = null
  state.readError = null
  state.audits = []
  state.onInsert = null
})

describe('grantFreeCourseAccess — free and published courses only, idempotent, audited', async () => {
  const { grantFreeCourseAccess } = await import('@/lib/learn/free-course')
  const grant = (courseId: string) => grantFreeCourseAccess({ userId: U, email: 'l@example.test', courseId })

  it('grants one ACTIVE PROMOTIONAL_GRANT with no end date, an enrollment and an audit record', async () => {
    expect(await grant('c-free')).toEqual({ ok: true, created: true, slug: 'free-course' })
    const ent = state.inserts.filter(i => i.table === 'entitlements')
    expect(ent).toHaveLength(1)
    expect(ent[0].row).toMatchObject({ user_id: U, course_id: 'c-free', source: 'PROMOTIONAL_GRANT', status: 'ACTIVE' })
    expect(ent[0].row).not.toHaveProperty('expires_at')
    expect(state.upserts).toEqual([{ table: 'enrollments', row: { user_id: U, course_id: 'c-free', payment_id: null, status: 'active' }, opts: { onConflict: 'user_id,course_id', ignoreDuplicates: true } }])
    expect(state.audits).toEqual([expect.objectContaining({ eventType: 'entitlement.granted', actorType: 'self', method: 'free_course_self_service', subjectUserId: U })])
  })

  it('a second request changes nothing', async () => {
    await grant('c-free')
    expect(await grant('c-free')).toEqual({ ok: true, created: false, slug: 'free-course' })
    expect(state.inserts.filter(i => i.table === 'entitlements')).toHaveLength(1)
    expect(state.audits).toHaveLength(1)
  })

  it('never opens a priced course or an unpublished one', async () => {
    expect(await grant('c-paid')).toEqual({ ok: false, reason: 'not_free' })
    expect(await grant('c-draft')).toEqual({ ok: false, reason: 'not_found' })
    expect(await grant('c-missing')).toEqual({ ok: false, reason: 'not_found' })
    expect(state.inserts).toEqual([])
  })

  it('never overrides a suspension', async () => {
    state.entitlements = [{ user_id: U, course_id: 'c-free', status: 'SUSPENDED', starts_at: null, expires_at: null, revoked_at: null }]
    expect(await grant('c-free')).toEqual({ ok: false, reason: 'not_accessible' })
    expect(state.inserts).toEqual([])
  })

  it('a concurrent request that already created it is a success, not a failure', async () => {
    // The other request's row appears between our check and our insert, and the unique index refuses ours.
    state.insertError = { message: 'duplicate key value violates unique constraint' }
    state.onInsert = () => { state.entitlements.push({ user_id: U, course_id: 'c-free', status: 'ACTIVE', starts_at: null, expires_at: null, revoked_at: null }) }
    expect(await grant('c-free')).toEqual({ ok: true, created: false, slug: 'free-course' })
    expect(state.inserts).toHaveLength(1)
    expect(state.audits).toEqual([])
  })

  it('a real insert failure is reported, never a silent success', async () => {
    state.insertError = { message: 'boom' }
    expect(await grant('c-free')).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('learnerAccessEndDates — the date the dashboard shows', async () => {
  const { learnerAccessEndDates } = await import('@/lib/entitlements/access-end-dates')
  const NOW = new Date('2026-11-10T12:00:00Z')
  const ent = (course_id: string, expires_at: string | null, status = 'ACTIVE', revoked_at: string | null = null) =>
    ({ user_id: U, course_id, status, starts_at: '2026-11-01T00:00:00Z', expires_at, revoked_at })

  it('six months for a purchase, « no limit » for a grant without end, nothing for a closed access', async () => {
    state.entitlements = [
      ent('bought', '2027-05-10T12:00:00Z'),
      ent('granted', null),
      ent('expired', '2026-11-01T00:00:00Z'),
      ent('revoked', null, 'REVOKED', '2026-11-05T00:00:00Z'),
      { ...ent('other-learner', null), user_id: 'someone-else' },
    ]
    const ends = await learnerAccessEndDates(U, NOW)
    expect(Object.fromEntries(ends)).toEqual({ bought: '2027-05-10T12:00:00Z', granted: null })
  })

  it('a failed read shows no date rather than a wrong one', async () => {
    state.readError = { message: 'boom' }
    expect((await learnerAccessEndDates(U, NOW)).size).toBe(0)
  })
})

describe('the pages use them', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

  it('the new entitlement writer writes one kind of grant only, for free published courses, and is no server action', () => {
    const src = read('lib/learn/free-course.ts')
    const sources = [...src.matchAll(/source:\s*'([A-Z_]+)'/g)].map(m => m[1])
    expect(sources.length).toBeGreaterThan(0)
    expect(new Set(sources)).toEqual(new Set(['PROMOTIONAL_GRANT']))
    expect(src).not.toMatch(/expires_at:/)
    expect(src).toContain("course.is_free !== true")
    expect(src).toContain("course.is_published !== true")
    expect(src).not.toMatch(/^'use server'/m)
    expect(src).toMatch(/^import 'server-only'/m)
  })

  it('the course page offers the free start only to a signed-in learner without access to a FREE course, as a form', () => {
    const page = read('app/(public)/courses/[slug]/page.tsx')
    expect(page).toContain('const freeStart = isFree && !!user && !ctaAccess.allowed')
    expect(page.match(/<FreeCourseStartForm/g)).toHaveLength(2)
    const form = read('components/learn/FreeCourseStartForm.tsx')
    expect(form).toContain('<form action={startFreeCourse}>')
    expect(form).toContain('Commencer gratuitement')
  })

  it('the action needs a signed-in learner and grants through the one function', () => {
    const action = read('app/actions/free-course.ts')
    expect(action.indexOf('auth.getUser()')).toBeLessThan(action.indexOf('grantFreeCourseAccess('))
    expect(action).toContain("if (!user) redirect(")
    expect(action).toContain('rateLimitDb(')
    expect(action).not.toMatch(/from\('entitlements'\)/)
  })

  it('the dashboard shows the end date on every open course and a renewal link on a closed one', () => {
    const page = read('app/(platform)/dashboard/page.tsx')
    expect(page.match(/<AccessEndNote end=\{accessEnds\.get\(enrollment\.course_id\)\} \/>/g)).toHaveLength(2)
    expect(page).toContain('Accès jusqu’au')
    expect(page).toContain('Accès sans limite de durée')
    expect(page).toContain('Renouveler mon accès (6 mois)')
  })
})
