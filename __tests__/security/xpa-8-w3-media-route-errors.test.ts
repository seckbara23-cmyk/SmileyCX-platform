// @vitest-environment node
/**
 * XPA-8 W3 — the media routes must distinguish "no such asset" from "broken".
 *
 * ── WHY THIS TEST EXISTS ──────────────────────────────────────────────────
 *
 * The first version of the lesson route destructured only `data`:
 *
 *     const { data: lesson } = await admin.from('lessons')…
 *     if (!lesson) return notFound()
 *
 * so ANY query failure became a 404 indistinguishable from a missing asset.
 * That is not hypothetical — during W3 production verification the route
 * returned 404 for one lesson and 401 for every other, and the 404 was a stale
 * cached row rather than a content problem. It cost a diagnosis that a 503
 * would have made immediate.
 *
 * The 503 branch cannot be induced safely against production — there is no way
 * to make Supabase fail on demand without breaking it for real learners — so it
 * is proved here, by making the client fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// `lib/media/storage.ts` opens with `import 'server-only'`, which is a Next.js
// build-time guard with no Node resolution. Stubbing it lets the real module
// load here — the guard itself is asserted separately in the W3 suite.
vi.mock('server-only', () => ({}))

const state: {
  lessonResult: { data: unknown; error: unknown }
  certResult: { data: unknown; error: unknown }
  access: { allowed: boolean; reason?: string }
  signed: string | null
  owner: unknown
  user: unknown
} = {
  lessonResult: { data: null, error: null },
  certResult: { data: null, error: null },
  access: { allowed: true },
  signed: 'https://example.supabase.co/storage/v1/object/sign/course-content/video/x.mp4?token=t',
  owner: null,
  user: { id: 'user-1', email: 'learner@example.com' },
}

// A chainable stub shaped like the bits of postgrest-js the routes touch.
const makeFrom = (table: string) => {
  const result = table === 'lessons' ? state.lessonResult : state.certResult
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.maybeSingle = async () => result
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: (t: string) => makeFrom(t) }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => state.access,
}))
vi.mock('@/lib/auth/owner', () => ({
  getOwnerSession: async () => state.owner,
}))
vi.mock('@/lib/media/storage', async (orig) => {
  const actual = await orig<typeof import('@/lib/media/storage')>()
  return { ...actual, signObject: async () => state.signed }
})

const { GET: lessonGET } = await import('@/app/api/media/lesson/[lessonId]/[kind]/route')
const { GET: certGET } = await import('@/app/api/media/certificate/[certificateId]/route')

const UUID = '11111111-2222-4333-8444-555555555555'
const req = new Request('https://x.test/api/media') as never

beforeEach(() => {
  state.lessonResult = { data: null, error: null }
  state.certResult = { data: null, error: null }
  state.access = { allowed: true }
  state.signed = 'https://example.supabase.co/storage/v1/object/sign/course-content/video/x.mp4?token=t'
  state.owner = null
  state.user = { id: 'user-1', email: 'learner@example.com' }
})

const okLesson = {
  id: UUID,
  video_object_path: 'video/x.mp4',
  pdf_object_path: null,
  subtitle_object_path: null,
  modules: { course_id: 'course-1' },
}

describe('XPA-8 W3 lesson media route — 404 vs 503', () => {
  it('a query FAILURE is 503, not 404', async () => {
    state.lessonResult = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/indisponible/i)
  })

  it('a MISSING lesson is 404', async () => {
    state.lessonResult = { data: null, error: null }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(404)
  })

  it('a lesson with no asset of that kind is 404, not 503', async () => {
    state.lessonResult = { data: { ...okLesson, video_object_path: null }, error: null }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(404)
  })

  it('an un-migrated lesson (path still NULL) is 404 — the W3 window', async () => {
    state.lessonResult = { data: { ...okLesson, video_object_path: null }, error: null }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(404)
  })

  it('an authorized caller gets a 302 to the signed URL', async () => {
    state.lessonResult = { data: okLesson, error: null }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/object/sign/course-content/')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('an unauthenticated caller gets 401', async () => {
    state.lessonResult = { data: okLesson, error: null }
    state.access = { allowed: false, reason: 'not_authenticated' }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(401)
  })

  it('an unentitled caller gets 403', async () => {
    state.lessonResult = { data: okLesson, error: null }
    state.access = { allowed: false, reason: 'not_entitled' }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(403)
  })

  it('an expired entitlement gets 403', async () => {
    state.lessonResult = { data: okLesson, error: null }
    state.access = { allowed: false, reason: 'access_ended' }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(403)
  })

  it('a signing failure is 404, never a 500 naming the bucket', async () => {
    state.lessonResult = { data: okLesson, error: null }
    state.signed = null
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(404)
  })

  it('the access check runs AFTER the asset is known to exist', async () => {
    // A missing asset must answer 404 for everyone, so the route cannot be used
    // to enumerate which lessons carry video.
    state.lessonResult = { data: { ...okLesson, video_object_path: null }, error: null }
    state.access = { allowed: false, reason: 'not_entitled' }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'video' }) })
    expect(res.status).toBe(404)
  })

  it('an invalid kind never reaches the database', async () => {
    state.lessonResult = { data: null, error: { code: 'X', message: 'should not be consulted' } }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: UUID, kind: 'exe' }) })
    expect(res.status).toBe(404)   // not 503 — the query was never issued
  })

  it('a malformed id never reaches the database', async () => {
    state.lessonResult = { data: null, error: { code: 'X', message: 'should not be consulted' } }
    const res = await lessonGET(req, { params: Promise.resolve({ lessonId: 'not-a-uuid', kind: 'video' }) })
    expect(res.status).toBe(404)
  })
})

describe('XPA-8 W3 certificate route — 404 vs 503', () => {
  const cert = { id: UUID, user_id: 'user-1', certificate_number: 'XP-1', pdf_object_path: 'user-1/c.pdf' }

  it('a query FAILURE is 503', async () => {
    state.certResult = { data: null, error: { code: '08006', message: 'connection failure' } }
    const res = await certGET(req, { params: Promise.resolve({ certificateId: UUID }) })
    expect(res.status).toBe(503)
  })

  it('the owner gets a 302', async () => {
    state.certResult = { data: cert, error: null }
    const res = await certGET(req, { params: Promise.resolve({ certificateId: UUID }) })
    expect(res.status).toBe(302)
  })

  it("another learner gets 404, not 403 — no existence oracle", async () => {
    state.certResult = { data: { ...cert, user_id: 'someone-else' }, error: null }
    const res = await certGET(req, { params: Promise.resolve({ certificateId: UUID }) })
    expect(res.status).toBe(404)
  })

  it('an anonymous caller gets 401', async () => {
    state.user = null
    state.certResult = { data: cert, error: null }
    const res = await certGET(req, { params: Promise.resolve({ certificateId: UUID }) })
    expect(res.status).toBe(401)
  })

  it('the administration portal may retrieve any certificate', async () => {
    state.user = null
    state.owner = { user: { email: 'owner@example.com' } }
    state.certResult = { data: { ...cert, user_id: 'someone-else' }, error: null }
    const res = await certGET(req, { params: Promise.resolve({ certificateId: UUID }) })
    expect(res.status).toBe(302)
  })
})
