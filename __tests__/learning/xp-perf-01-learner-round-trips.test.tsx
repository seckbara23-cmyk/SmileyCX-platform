/**
 * XP-PERF-01 — the learner's waits are counted, and the answers do not move.
 *
 * Every Supabase call from a server function is a full network round trip, and
 * a page waits for the SUM of its sequential round trips. These tests run the
 * real dashboard and the real access seam against a fake client whose every
 * call takes the same fixed time, then read how many times the page had to
 * wait in a row. They pin two things together:
 *
 *   1. the number of sequential round trips (the latency), and
 *   2. the decision and the numbers the learner sees (the behaviour).
 *
 * A future change that quietly reintroduces a per-course query or a
 * one-after-the-other read fails here with a number, not a feeling.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

type Row = Record<string, unknown>

// One fixed delay for every call: the elapsed time divided by it is the number
// of round trips the caller waited for one after the other.
const D = 100

const state = vi.hoisted(() => ({
  pilot: true,
  user: null as Row | null,
  tables: {} as Record<string, Row[]>,
  calls: [] as { name: string; at: number }[],
}))

function delayed<T>(name: string, value: T): Promise<T> {
  state.calls.push({ name, at: Date.now() })
  return new Promise(resolve => setTimeout(() => resolve(value), D))
}

/** A chainable PostgREST stand-in that honours the filters these paths use. */
function query(table: string, kind: string) {
  const filters: ((r: Row) => boolean)[] = []
  let single = false
  const b: Record<string, unknown> = {}
  const chain = () => b
  Object.assign(b, {
    select: chain,
    order: chain,
    limit: chain,
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b },
    in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return b },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return b },
    single: () => { single = true; return b },
    maybeSingle: () => { single = true; return b },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const rows = (state.tables[table] ?? []).filter(r => filters.every(f => f(r)))
      return delayed(`${kind}:${table}`, { data: single ? rows[0] ?? null : rows, error: null }).then(ok, ko)
    },
  })
  return b
}

const client = (kind: string) => ({
  auth: { getUser: () => delayed(`${kind}:auth.getUser`, { data: { user: state.user } }) },
  from: (t: string) => query(t, kind),
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client('session') }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client('admin') }))
vi.mock('@/lib/pilot', () => ({ get PILOT_MODE() { return state.pilot } }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`) },
}))
vi.mock('@/app/(platform)/dashboard/ResendVerificationButton', () => ({ default: () => null }))

import DashboardPage from '@/app/(platform)/dashboard/page'
import { resolveCourseAccess, resolveCourseAccessById } from '@/lib/auth/course-access'

/** Run an async server path to completion on the virtual clock. */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; waits: number; calls: string[] }> {
  state.calls = []
  const start = Date.now()
  const p = run()
  p.catch(() => {}) // observed below; keeps a redirect from being reported as unhandled
  await vi.runAllTimersAsync()
  const value = await p
  return { value, waits: Math.round((Date.now() - start) / D), calls: state.calls.map(c => c.name) }
}

const LEARNER = { id: 'u1', email: 'learner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }

function course(id: string, slug: string, modules: { id: string; lessons: string[] }[]) {
  return { id, slug, title: `Formation ${slug.toUpperCase()}`, modules: modules.map(m => ({ id: m.id, lessons: m.lessons.map(l => ({ id: l })) })) }
}

const A = course('cA', 'a', [{ id: 'm1', lessons: ['l1', 'l2'] }, { id: 'm2', lessons: ['l3'] }])
const B = course('cB', 'b', [{ id: 'm3', lessons: ['l4'] }])
const C = course('cC', 'c', [{ id: 'm4', lessons: ['l5'] }])

function seedDashboard(extraCompleted: string[] = []) {
  state.user = LEARNER
  state.tables = {
    profiles: [{ id: 'u1', first_name: 'Awa', email: LEARNER.email, account_status: 'active', platform_role: 'user' }],
    my_course_access: [
      { course_id: 'cA', has_access: true, access_ended: false },
      { course_id: 'cB', has_access: true, access_ended: false },
      { course_id: 'cC', has_access: false, access_ended: true },
    ],
    enrollments: [
      { id: 'eA', user_id: 'u1', course_id: 'cA', enrolled_at: '2026-11-03', courses: A },
      { id: 'eB', user_id: 'u1', course_id: 'cB', enrolled_at: '2026-11-02', courses: B },
      { id: 'eC', user_id: 'u1', course_id: 'cC', enrolled_at: '2026-11-01', courses: C },
    ],
    entitlements: [
      { user_id: 'u1', course_id: 'cA', status: 'ACTIVE', starts_at: '2026-11-01T00:00:00Z', expires_at: '2027-05-01T00:00:00Z', revoked_at: null },
      { user_id: 'u1', course_id: 'cB', status: 'ACTIVE', starts_at: '2026-11-01T00:00:00Z', expires_at: null, revoked_at: null },
    ],
    certificates: [],
    // l9 belongs to no enrolled course: it must never count toward any course.
    lesson_progress: ['l1', 'l2', 'l4', 'l9', ...extraCompleted].map(l => ({ user_id: 'u1', lesson_id: l, is_completed: true })),
    quizzes: [
      { id: 'q-m2', module_id: 'm2', course_id: null },
      { id: 'final-a', module_id: null, course_id: 'cA' },
      { id: 'final-b', module_id: null, course_id: 'cB' },
    ],
    quiz_attempts: [{ user_id: 'u1', quiz_id: 'final-b', passed: true }],
  }
}

const html = async () => {
  const r = await timed(() => DashboardPage())
  return { ...r, html: renderToStaticMarkup(r.value as ReactElement) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'))
  state.pilot = true
})
afterEach(() => vi.useRealTimers())

describe('XP-PERF-01 · dashboard: one wait after the identity check', () => {
  it('pilot mode (production today): two sequential round trips and seven calls, whatever the number of courses', async () => {
    seedDashboard()
    const r = await html()
    expect(r.waits).toBe(2)
    expect(r.calls[0]).toBe('session:auth.getUser')
    expect(r.calls).toHaveLength(7)
    expect(r.calls).toContain('admin:entitlements')
    expect(r.calls.filter(c => c === 'session:lesson_progress')).toHaveLength(1)
    expect(r.calls.some(c => c.endsWith(':quizzes') || c.endsWith(':quiz_attempts'))).toBe(false)
  })

  it('pilot mode: the learner sees the same numbers as before', async () => {
    seedDashboard()
    const { html: page } = await html()
    // A: l1 and l2 of three lessons. The stray l9 counts nowhere.
    expect(page).toContain('2 / 3 étapes')
    expect(page).toContain('67%')
    expect(page).toContain('href="/learn/a/m2/l3"')
    // B: its only lesson is done, so it is a finished course.
    expect(page).toContain('Formations terminées')
    expect(page).toContain('1 / 1 étapes complétées')
    // C: the ended access is named, not silently dropped.
    expect(page).toContain('Accès terminés')
    expect(page).toContain('Formation C')
    // Access end dates still come from the server-side entitlement read.
    expect(page).toContain('Accès jusqu’au')
    expect(page).toContain('Accès sans limite de durée')
  })

  it('outside the pilot: three sequential round trips, quizzes for every course in one of them', async () => {
    state.pilot = false
    seedDashboard()
    const r = await html()
    expect(r.waits).toBe(3)
    expect(r.calls.filter(c => c === 'session:quizzes')).toHaveLength(2)
    expect(r.calls.filter(c => c === 'session:quiz_attempts')).toHaveLength(1)
    // A: 3 lessons + 1 module quiz + 1 final exam, 2 lessons done.
    expect(r.html).toContain('2 / 5 étapes')
    expect(r.html).toContain('40%')
    // B: 1 lesson + its passed final exam: finished.
    expect(r.html).toContain('2 / 2 étapes complétées')
  })

  it('outside the pilot: a finished course with a pending module quiz sends the learner to that quiz', async () => {
    state.pilot = false
    seedDashboard(['l3'])
    const { html: page } = await html()
    expect(page).toContain('3 / 5 étapes')
    expect(page).toContain('href="/learn/a/m2/quiz"')
    expect(page).toContain('Passer le quiz')
  })

  it('an anonymous caller is sent to sign in after a single round trip', async () => {
    seedDashboard()
    state.user = null
    await expect(timed(() => DashboardPage())).rejects.toThrow('REDIRECT /login?next=/dashboard')
    expect(state.calls.map(c => c.name)).toEqual(['session:auth.getUser'])
  })
})

describe('XP-PERF-01 · access seam: same answers, fewer waits', () => {
  const seed = (opts: { user?: Row | null; profile?: Row | null; access?: Row | null }) => {
    state.user = opts.user === undefined ? LEARNER : opts.user
    state.tables = {
      courses: [{ id: 'cA', slug: 'a' }],
      profiles: opts.profile === null ? [] : [{ id: 'u1', platform_role: 'user', account_status: 'active', ...(opts.profile ?? {}) }],
      my_course_access: opts.access === null ? [] : [{ course_id: 'cA', has_access: true, access_ended: false, ...(opts.access ?? {}) }],
    }
  }

  it.each([
    ['anonymous',                       { user: null },                                         { allowed: false, reason: 'not_authenticated' }],
    ['email not confirmed',             { user: { ...LEARNER, email_confirmed_at: null } },     { allowed: false, reason: 'email_unverified' }],
    ['platform admin, no access row',   { profile: { platform_role: 'super_admin' }, access: null }, { allowed: true }],
    ['suspended, even with access',     { profile: { account_status: 'suspended' } },          { allowed: false, reason: 'account_inactive' }],
    ['entitled',                        {},                                                     { allowed: true }],
    ['access ended',                    { access: { has_access: false, access_ended: true } },  { allowed: false, reason: 'access_ended' }],
    ['never entitled',                  { access: null },                                       { allowed: false, reason: 'not_entitled' }],
    ['no profile row, entitled',        { profile: null },                                      { allowed: true }],
  ] as const)('%s', async (_label, opts, expected) => {
    seed(opts as Parameters<typeof seed>[0])
    const { value, waits } = await timed(() => resolveCourseAccessById('cA'))
    expect(value).toMatchObject({ ...expected, courseId: 'cA' })
    if (!('reason' in expected)) expect(value.reason).toBeUndefined()
    expect(waits).toBeLessThanOrEqual(2)
  })

  it('an entitled learner costs two sequential round trips, not three', async () => {
    seed({})
    const { waits, calls } = await timed(() => resolveCourseAccessById('cA'))
    expect(waits).toBe(2)
    expect(calls[0]).toBe('session:auth.getUser')
    expect(calls.slice(1).sort()).toEqual(['session:my_course_access', 'session:profiles'])
  })

  it('refusals that need no database read still make none', async () => {
    seed({ user: null })
    expect((await timed(() => resolveCourseAccessById('cA'))).calls).toEqual(['session:auth.getUser'])
    seed({ user: { ...LEARNER, email_confirmed_at: null } })
    expect((await timed(() => resolveCourseAccessById('cA'))).calls).toEqual(['session:auth.getUser'])
  })

  it('by slug: an unknown course is still "not found", and a known one costs three waits', async () => {
    seed({})
    const missing = await timed(() => resolveCourseAccess('nope'))
    expect(missing.value).toEqual({ allowed: false, reason: 'course_not_found' })
    const found = await timed(() => resolveCourseAccess('a'))
    expect(found.value).toMatchObject({ allowed: true, courseId: 'cA', userId: 'u1' })
    expect(found.waits).toBe(3)
  })
})

describe('XP-PERF-01 · lesson player: the outline travels with the decision', () => {
  const src = readFileSync(join(process.cwd(), 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'), 'utf8')
  const body = src.slice(src.indexOf('const loadCourse = useCallback'), src.indexOf('const loadUserProgress'))

  it('requests the modules before awaiting the access decision', () => {
    const requested = body.indexOf('const modsRequest = supabase')
    const decided   = body.indexOf('const access = await canOpenCourse(course.id)')
    expect(requested).toBeGreaterThan(-1)
    expect(decided).toBeGreaterThan(requested)
  })

  it('still refuses before using them, and still initialises the enrollment only after the decision', () => {
    const decided  = body.indexOf('const access = await canOpenCourse(course.id)')
    const refused  = body.indexOf('if (!access.allowed)')
    const ensured  = body.indexOf('void ensureAcademicEnrollment(course.id)')
    const consumed = body.indexOf('await modsRequest')
    expect(refused).toBeGreaterThan(decided)
    expect(ensured).toBeGreaterThan(refused)
    expect(consumed).toBeGreaterThan(ensured)
  })
})

// ─── The login button stays busy through the redirect ──────────────────────
const auth = vi.hoisted(() => ({ result: { data: {}, error: null as unknown }, settled: 0 }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signInWithPassword: async () => { auth.settled++; return auth.result } },
  }),
}))
import LoginForm from '@/app/(auth)/login/LoginForm'

describe('XP-PERF-01 · login: no idle form while the dashboard loads', () => {
  beforeEach(() => {
    vi.useRealTimers()
    auth.settled = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** Submit, then wait until the sign-in answer has been fully handled. */
  const submitAndSettle = async () => {
    render(<LoginForm />)
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'learner@example.test' } })
    fireEvent.change(screen.getByLabelText(/mot de passe/i), { target: { value: 'x' } })
    fireEvent.submit(screen.getByRole('button', { name: /se connecter/i }).closest('form')!)
    await waitFor(() => expect(auth.settled).toBe(1))
    // Let the handler run to its end after the answer: the state it leaves is
    // what the learner looks at for the whole dashboard load.
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  }

  it('a successful sign-in keeps the button busy until the next page replaces this one', async () => {
    auth.result = { data: {}, error: null }
    await submitAndSettle()
    expect(screen.getByRole('button', { name: /connexion en cours/i })).toBeDisabled()
  })

  it('a failed sign-in releases the button and says why', async () => {
    auth.result = { data: {}, error: { message: 'Invalid login credentials' } }
    await submitAndSettle()
    expect(screen.getByRole('button', { name: /se connecter/i })).toBeEnabled()
    expect(screen.getByText(/Email ou mot de passe incorrect/)).toBeInTheDocument()
  })

  it('a page restored from the back-forward cache is usable again', async () => {
    auth.result = { data: {}, error: null }
    await submitAndSettle()
    expect(screen.getByRole('button', { name: /connexion en cours/i })).toBeDisabled()
    act(() => {
      const e = new Event('pageshow') as Event & { persisted?: boolean }
      Object.defineProperty(e, 'persisted', { value: true })
      window.dispatchEvent(e)
    })
    expect(screen.getByRole('button', { name: /se connecter/i })).toBeEnabled()
  })
})
