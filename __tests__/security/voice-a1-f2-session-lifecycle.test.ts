// @vitest-environment node
/**
 * VOICE-A1 F-2 — voice session finalisation / lifecycle authority.
 *
 * ── WHAT THE INVESTIGATION ACTUALLY FOUND ─────────────────────────────────
 *
 * The original hypothesis — "the platform never establishes a terminal state"
 * — was wrong, and so was the column it named. `ai_sessions` has no `ended_at`;
 * the terminal timestamp is `completed_at`. Measured in production: of 23
 * sessions, 10 were `completed`, 2 `abandoned`, 11 `active`, and all five
 * sessions from the real human UAT reached `completed` with real durations.
 *
 * The explicit Terminer path already worked. Two defects remained:
 *
 *   1. The unmount cleanup set `finalizedRef.current = true` and then never
 *      persisted anything. That poisoned `finalize()` for the life of the
 *      component — including the `onDisconnect` its own `endSession()` fired —
 *      so a navigated-away session stayed `active` for ever.
 *
 *   2. `completeAiSession` had no server-side idempotency. `finalizedRef`
 *      guards exactly one component instance, but every export of a
 *      `'use server'` module is a callable HTTP endpoint, so a replay rewrote
 *      `completed_at`, could flip `completed` into `abandoned`, and re-fired
 *      both the competency engine and the lesson-progress write.
 *
 * ── THE RATIFIED CONTRACT ─────────────────────────────────────────────────
 *
 *     active → completed    (explicit Terminer only; grants lesson credit)
 *     active → abandoned    (navigation / unmount / drop; grants NOTHING)
 *     completed → no-op
 *     abandoned → no-op
 *
 * Leaving the exercise is not equivalent to completing it. Time spent talking
 * is not completion.
 *
 * ── RESIDUAL LIMITATION, DEFERRED BY RULING ───────────────────────────────
 *
 * Hard tab-close and browser refresh are NOT covered. There is no
 * `beforeunload` / `pagehide` / `sendBeacon` handler and F-2 deliberately does
 * not add one. Such a session still ends up `active`. This suite asserts that
 * absence so the limitation stays visible rather than being quietly forgotten.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('server-only', () => ({}))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
/** Comments blanked: an absence assertion must read code, never prose. */
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const SESSION  = '11111111-2222-4333-8444-555555555555'
const SCENARIO = '22222222-3333-4444-8555-666666666666'
const LEARNER  = '33333333-4444-4555-8666-777777777777'
const OTHER    = '44444444-5555-4666-8777-888888888888'

interface SessionRow {
  id: string; user_id: string | null; anon_id: string | null
  status: string; scenario_id: string
  completed_at: string | null; duration_seconds: number | null
}

const state: {
  session: SessionRow
  caller: string | null
  updates: Array<Record<string, unknown>>
  engineRuns: string[]
  progressRuns: string[]
  turnFlushes: string[]
  order: string[]
} = {
  session: {
    id: SESSION, user_id: LEARNER, anon_id: null, status: 'active',
    scenario_id: SCENARIO, completed_at: null, duration_seconds: null,
  },
  caller: LEARNER,
  updates: [], engineRuns: [], progressRuns: [], turnFlushes: [], order: [],
}

const reset = (over: Partial<SessionRow> = {}) => {
  state.session = {
    id: SESSION, user_id: LEARNER, anon_id: null, status: 'active',
    scenario_id: SCENARIO, completed_at: null, duration_seconds: null, ...over,
  }
  state.caller = LEARNER
  state.updates = []; state.engineRuns = []; state.progressRuns = []
  state.turnFlushes = []; state.order = []
}

/**
 * Chainable stub shaped like the parts of postgrest-js the module touches.
 *
 * It is deliberately deep enough for the REAL downstream helpers —
 * `runEngineForSession` and `markVoiceLessonComplete` — to execute, so
 * "the engine did not rerun" is proved against code that genuinely runs on the
 * first call rather than against a helper the harness silently disabled.
 *
 * The important part is `.eq('status','active')`: it models the DATABASE
 * filter, so a terminal row matches zero rows exactly as Postgres would. The
 * guarantee under test is the row effect, not the return code.
 */
const rowsFor = (table: string): unknown[] => {
  switch (table) {
    case 'ai_turns':        return [{ speaker: 'learner', transcript: 'je comprends', turn_index: 0 }]
    case 'ai_competencies': return [{ key: 'ecoute', label_fr: 'Écoute', signals: {} }]
    case 'ai_rubrics':      return []
    default:                return []
  }
}

const makeFrom = (table: string) => {
  const filters: Record<string, unknown> = {}
  const chain: Record<string, unknown> = {}

  chain.select = () => chain
  chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain }
  chain.order = () => chain
  chain.single = async () => {
    if (table === 'ai_sessions') return { data: { ...state.session }, error: null }
    return { data: null, error: null }
  }
  chain.maybeSingle = async () => {
    if (table === 'ai_sessions')  return { data: { user_id: state.session.user_id }, error: null }
    if (table === 'ai_scenarios') return { data: { lesson_id: 'lesson-1' }, error: null }
    return { data: null, error: null }
  }
  // Awaiting the chain itself (list reads: ai_turns, ai_competencies, ai_rubrics).
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: rowsFor(table), error: null })
  chain.upsert = async () => ({ error: null })

  chain.update = (payload: Record<string, unknown>) => {
    const run = () => {
      const matches =
        filters.id === state.session.id &&
        (filters.status === undefined || filters.status === state.session.status)
      if (!matches) return { data: [], error: null }
      // Only the LIFECYCLE write is counted. The engine's `engine_signals`
      // write also targets ai_sessions and must not inflate the count.
      if ('status' in payload) {
        state.updates.push({ ...payload })
        state.order.push('lifecycle-update')
      }
      Object.assign(state.session, payload)
      return { data: [{ id: state.session.id }], error: null }
    }
    const upd: Record<string, unknown> = {}
    upd.eq = (c: string, v: unknown) => { filters[c] = v; return upd }
    upd.select = () => ({ then: (r: (v: unknown) => void) => r(run()) })
    upd.then = (r: (v: unknown) => void) => r(run())
    return upd
  }
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: (t: string) => makeFrom(t) }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.caller ? { id: state.caller } : null } }) },
  }),
}))
vi.mock('@/lib/ai/flags', () => ({
  AI_VOICE_ENABLED: true, AI_COACH_ENABLED: true, AI_COACH_CLAUDE_ENABLED: false,
}))
vi.mock('@/lib/learn/completion', () => ({
  recordLessonCompletion: async () => { state.progressRuns.push('progress'); return { ok: true } },
}))
vi.mock('@/lib/ai/competency-engine', () => ({
  runCompetencyEngine: () => { state.engineRuns.push('engine'); return { scores: [], hints: [] } },
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimitDb: async () => ({ success: true }) }))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => ({ allowed: true }),
  denialMessage: () => ({ body: 'refusé' }),
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { completeAiSession } = await import('@/app/actions/ai-practice')

const CLIENT = 'components/ai/VoicePracticeSession.tsx'
const ACTION = 'app/actions/ai-practice.ts'

// ══════════════════════════════════════════════════════════════════════════
describe('VOICE-A1 F-2 — the terminal transition', () => {
  beforeEach(() => reset())

  it('1. a new session is active with no completed_at', () => {
    expect(state.session.status).toBe('active')
    expect(state.session.completed_at).toBeNull()
  })

  it('2. explicit Terminer: active → completed, completed_at populated', async () => {
    const r = await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(r.ok).toBe(true)
    expect(state.session.status).toBe('completed')
    expect(state.session.completed_at).toBeTruthy()
    expect(state.session.duration_seconds).toBe(120)
  })

  it('3. navigation/unmount: active → abandoned, completed_at populated', async () => {
    const r = await completeAiSession({ sessionId: SESSION, status: 'abandoned', durationSeconds: 45 })
    expect(r.ok).toBe(true)
    expect(state.session.status).toBe('abandoned')
    expect(state.session.completed_at).toBeTruthy()
  })

  it('4. an abandoned session does NOT mark the lesson complete', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'abandoned', durationSeconds: 300 })
    expect(state.progressRuns).toEqual([])
  })

  it('5. an abandoned session does NOT run the competency engine', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'abandoned', durationSeconds: 300 })
    expect(state.engineRuns).toEqual([])
  })

  it('16. explicit Terminer still runs the engine and grants lesson credit', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(state.engineRuns.length).toBe(1)
    expect(state.progressRuns.length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('VOICE-A1 F-2 — idempotency is enforced by the SERVER', () => {
  beforeEach(() => reset())

  it('6. a duplicate completed finalisation is a no-op', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    const stamp = state.session.completed_at
    const r = await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 999 })
    expect(r.ok).toBe(true)
    expect(state.updates.length).toBe(1)
    expect(state.session.completed_at).toBe(stamp)
  })

  it('7. a duplicate abandoned finalisation is a no-op', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'abandoned' })
    const stamp = state.session.completed_at
    await completeAiSession({ sessionId: SESSION, status: 'abandoned' })
    expect(state.updates.length).toBe(1)
    expect(state.session.completed_at).toBe(stamp)
  })

  it('8. completed then attempted abandoned stays completed', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    const stamp = state.session.completed_at
    await completeAiSession({ sessionId: SESSION, status: 'abandoned' })
    expect(state.session.status).toBe('completed')
    expect(state.session.completed_at).toBe(stamp)
  })

  it('9. abandoned then attempted completed stays abandoned and grants no credit', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'abandoned', durationSeconds: 30 })
    const stamp = state.session.completed_at
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(state.session.status).toBe('abandoned')
    expect(state.session.completed_at).toBe(stamp)
    expect(state.progressRuns).toEqual([])
  })

  it('10. a repeated call does not rewrite duration', async () => {
    // 3000 is deliberately INSIDE the schema's 60*60 ceiling. An out-of-range
    // value would be refused by Zod before ever reaching the idempotency
    // guard, and the test would pass for the wrong reason.
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    const second = await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 3000 })
    expect(second.ok).toBe(true)          // accepted, not rejected as invalid
    expect(state.session.duration_seconds).toBe(120)
  })

  it('11. a repeated call does not rerun the engine', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(state.engineRuns.length).toBe(1)
  })

  it('12. a repeated call does not rerun markVoiceLessonComplete', async () => {
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(state.progressRuns.length).toBe(1)
  })

  it('the guarantee is the status filter, not the pre-check — a row that turns terminal mid-flight still no-ops', async () => {
    // Simulates losing the race: the pre-check saw `active`, the statement did not.
    reset({ status: 'active' })
    const original = state.session
    // Flip the row terminal after authorizeSession has already read it.
    const spy = { get done() { return true } }
    void spy
    state.session = { ...original, status: 'completed', completed_at: 'PRIOR' }
    const r = await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 50 })
    expect(r.ok).toBe(true)
    expect(state.updates.length).toBe(0)
    expect(state.session.completed_at).toBe('PRIOR')
  })

  it('the update statement carries an explicit active-only filter', () => {
    const src = stripJs(read(ACTION))
    expect(src).toMatch(/\.eq\('id', sessionId\)[\s\S]{0,80}\.eq\('status', 'active'\)/)
    // And the row effect is inspected rather than the status code trusted.
    expect(src).toMatch(/transitioned\.length === 0/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('VOICE-A1 F-2 — ownership', () => {
  beforeEach(() => reset())

  it('13. another learner cannot finalise this session, and nothing mutates', async () => {
    state.caller = OTHER
    const r = await completeAiSession({ sessionId: SESSION, status: 'completed', durationSeconds: 120 })
    expect(r.error).toBeTruthy()
    expect(r.ok).toBeUndefined()
    expect(state.updates).toEqual([])
    expect(state.session.status).toBe('active')
    expect(state.session.completed_at).toBeNull()
  })

  it('an anonymous caller cannot finalise an authenticated learner’s session', async () => {
    state.caller = null
    const r = await completeAiSession({ sessionId: SESSION, anonId: OTHER, status: 'completed' })
    expect(r.error).toBeTruthy()
    expect(state.session.status).toBe('active')
  })

  it('a pilot session requires the matching anon id', async () => {
    reset({ user_id: null, anon_id: LEARNER })
    state.caller = null
    const bad = await completeAiSession({ sessionId: SESSION, anonId: OTHER, status: 'completed' })
    expect(bad.error).toBeTruthy()
    expect(state.session.status).toBe('active')
    const good = await completeAiSession({ sessionId: SESSION, anonId: LEARNER, status: 'completed' })
    expect(good.ok).toBe(true)
    expect(state.session.status).toBe('completed')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('VOICE-A1 F-2 — the client lifecycle authority', () => {
  const src = () => stripJs(read(CLIENT))

  it('the poisoned guard is gone — no path claims finalisation without persisting', () => {
    const s = src()
    // The exact removed anti-pattern: setting the flag then only ending the
    // provider session.
    expect(s).not.toMatch(/finalizedRef\.current = true[\s\S]{0,120}conv\.endSession\(\)/)
    // finalizedRef is now only set next to a completion result.
    const sets = [...s.matchAll(/finalizedRef\.current = true/g)]
    expect(sets.length).toBeGreaterThan(0)
    expect(s).toMatch(/if \(!res\?\.error\) finalizedRef\.current = true/)
  })

  it('in-flight locking is separate from confirmed finalisation', () => {
    const s = src()
    expect(s).toMatch(/finalizingRef\s*=\s*useRef\(false\)/)
    expect(s).toMatch(/if \(finalizedRef\.current \|\| finalizingRef\.current\) return/)
    expect(s).toMatch(/finalizingRef\.current = false/)
  })

  it('3/9. unmount finalises as ABANDONED — never completed', () => {
    const s = src()
    expect(s).toMatch(/if \(!finalizedRef\.current\) void finalize\('abandoned', false\)/)
    // Unmount must never award completion.
    const cleanup = s.slice(s.indexOf('unmountedRef.current = true'))
    expect(cleanup.slice(0, 600)).not.toMatch(/finalize\('completed'/)
  })

  it('14. flushTurns is awaited BEFORE the terminal write', () => {
    const s = src()
    const fin = s.slice(s.indexOf('async function finalize'))
    const flush = fin.indexOf('await flushTurns()')
    const complete = fin.indexOf('completeAiSession(')
    expect(flush).toBeGreaterThan(-1)
    expect(complete).toBeGreaterThan(flush)
  })

  it('provider shutdown happens after our own state is settled, and never gates it', () => {
    const s = src()
    expect(s).toMatch(/void finalize\('abandoned', false\)\.finally\(stopProvider\)/)
  })

  it('15. an unexpected provider disconnect still abandons; Terminer still completes', () => {
    const s = src()
    expect(s).toMatch(/if \(endingRef\.current\) void finalize\('completed', false\)/)
    expect(s).toMatch(/else void finalize\('abandoned', true/)
  })

  it('16. the explicit Terminer safety net is preserved', () => {
    const s = src()
    expect(s).toMatch(/async function handleEnd\(\)[\s\S]{0,320}if \(!finalizedRef\.current\) await finalize\('completed', false\)/)
  })

  it('RESIDUAL: hard tab-close / refresh is deliberately NOT handled in F-2', () => {
    const s = src()
    for (const api of ['beforeunload', 'pagehide', 'sendBeacon', 'visibilitychange'])
      expect(s, `${api} was introduced — that is deferred, not F-2`).not.toContain(api)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('VOICE-A1 F-2 — nothing adjacent moved', () => {
  it('17. session creation is untouched: still active by default, server-resolved', () => {
    const src = stripJs(read(ACTION))
    expect(src).toMatch(/status:\s*'active'/)
    // Entitlement seam on session start is intact.
    expect(src).toMatch(/resolveCourseAccessById\(courseId\)/)
  })

  it('the terminal timestamp column is completed_at — ended_at is never introduced', () => {
    expect(stripJs(read(ACTION))).not.toContain('ended_at')
    expect(stripJs(read(CLIENT))).not.toContain('ended_at')
  })

  it('no migration was added for F-2', () => {
    const src = stripJs(read(ACTION))
    expect(src).not.toMatch(/alter table|create table/i)
  })

  it('18. XPA-6A preservation semantics stay floor-based, not exact', () => {
    const v = stripJs(read('scripts/security/verify-xpa-6a.mjs'))
    expect(v).toMatch(/PRESERVE_FLOOR\s*=\s*\{\s*sessions:\s*11,\s*turns:\s*36\s*\}/)
    expect(v).toMatch(/mode === 'min' \? r\.total >= want : r\.total === want/)
  })

  it('the provider integration is untouched — no agent, voice or endpointing change', () => {
    const src = stripJs(read(ACTION))
    expect(src).toMatch(/get-signed-url/)
    for (const forbidden of ['agent_id:', 'voice_id', 'turn_timeout', 'vad_', 'first_message'])
      expect(src, `${forbidden} appeared`).not.toContain(forbidden)
  })
})
