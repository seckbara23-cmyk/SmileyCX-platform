/**
 * XP-F2-01/02 — the voice engine's server-side controls, with voice practice OPEN.
 *
 * Production keeps voice practice closed (pinned in xp-f2-voice-engine.test.ts);
 * these tests open it in-process to prove what the server enforces once it is
 * opened: signed-in learner, course access, consent, one live session, attempts
 * per lesson, ownership, no provider call on any refusal, no token in the logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
const T = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()

const state = {
  user: { id: 'U1', email: 'u1@example.test' } as { id: string; email: string } | null,
  access: { allowed: true } as { allowed: boolean; reason?: string },
  db: {} as Record<string, Row[]>,
  failRead: new Set<string>(),
  audits: [] as Row[],
  logs: [] as string[],
  fetches: [] as { url: string; init?: RequestInit }[],
  conversation: { agent_id: 'AGENT-AMARA', status: 'done', analysis: { evaluation_criteria_results: {} } } as Row,
}

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  let payload: unknown
  let conflict = ''
  let head = false
  const rows = () => (state.db[table] ??= [])
  const exec = () => {
    if (op === 'select' && state.failRead.has(table)) return { data: null, error: { message: 'boom' }, count: null }
    if (op === 'insert') {
      const add = (Array.isArray(payload) ? payload : [payload]).map(p => ({ id: crypto.randomUUID(), started_at: new Date().toISOString(), ...(p as Row) }))
      if (table === 'ai_sessions' && add.some(a => a.status === 'active' && rows().some(r => r.user_id === a.user_id && r.status === 'active'))) {
        return { data: null, error: { message: 'duplicate key: ai_sessions_one_live_per_user' } }
      }
      rows().push(...add)
      return { data: add, error: null }
    }
    const hit = rows().filter(r => filters.every(f => f(r)))
    if (op === 'update') { hit.forEach(r => Object.assign(r, payload as Row)); return { data: hit, error: null } }
    if (op === 'delete') { state.db[table] = rows().filter(r => !hit.includes(r)); return { data: hit, error: null } }
    if (op === 'upsert') {
      const p = payload as Row
      const keys = conflict.split(',')
      const found = rows().find(r => keys.every(k => r[k] === p[k]))
      if (found) Object.assign(found, p); else rows().push({ ...p })
      return { data: [p], error: null }
    }
    return head ? { data: null, error: null, count: hit.length } : { data: hit, error: null }
  }
  const q: Record<string, unknown> = {
    select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return q },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
    in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
    lt: (c: string, v: string) => { filters.push(r => String(r[c]) < v); return q },
    gte: (c: string, v: string) => { filters.push(r => String(r[c]) >= v); return q },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return q },
    order: () => q,
    limit: () => q,
    insert: (p: unknown) => { op = 'insert'; payload = p; return q },
    update: (p: unknown) => { op = 'update'; payload = p; return q },
    upsert: (p: unknown, o: { onConflict: string }) => { op = 'upsert'; payload = p; conflict = o.onConflict; return q },
    delete: () => { op = 'delete'; return q },
    maybeSingle: async () => { const r = exec(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } },
    single: async () => { const r = exec(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return d ? { data: d, error: null } : { data: null, error: r.error ?? { message: 'no rows' } } },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
  }
  return q
}

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/ai/flags', () => ({
  AI_VOICE_ENABLED: true, AI_COACH_ENABLED: false, AI_COACH_CLAUDE_ENABLED: false,
  VOICE_LEGAL_CONDITIONS_BUILT: true, VOICE_PRACTICE_OPEN: true, VOICE_CLOSED_MESSAGE: 'closed',
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => state.access,
  denialMessage: (r: string) => ({ body: `refused:${r}` }),
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimitDb: async () => ({ success: true }) }))
vi.mock('@/lib/audit/log', () => ({ logAuditEvent: async (e: Row) => { state.audits.push(e); return true } }))
vi.mock('@/lib/learn/completion', () => ({ recordLessonCompletion: async () => ({ ok: true }) }))
vi.mock('@/lib/logger', () => {
  const capture = (...a: unknown[]) => { state.logs.push(JSON.stringify(a)) }
  return { createLogger: () => ({ info: capture, warn: capture, error: capture, debug: capture }) }
})

const SCENARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeEach(() => {
  state.user = { id: 'U1', email: 'u1@example.test' }
  state.access = { allowed: true }
  state.failRead = new Set()
  state.audits = []
  state.logs = []
  state.fetches = []
  state.conversation = { agent_id: 'AGENT-AMARA', status: 'done', analysis: { evaluation_criteria_results: {} } }
  state.db = {
    ai_scenarios: [
      { id: SCENARIO, slug: 'amara-forfait-incompris', lesson_id: 'L1', is_published: true, provider: 'elevenlabs', agent_id: 'AGENT-AMARA' },
      { id: OTHER, slug: 'not-a-reviewed-persona', lesson_id: 'L1', is_published: true, provider: 'elevenlabs', agent_id: 'AGENT-X' },
    ],
    lessons: [{ id: 'L1', module_id: 'M1' }],
    modules: [{ id: 'M1', course_id: 'C2' }],
    entitlements: [{ user_id: 'U1', course_id: 'C2', status: 'ACTIVE', starts_at: T(60 * 24), expires_at: null, revoked_at: null, created_at: T(60 * 24) }],
    voice_processing_consents: [{ user_id: 'U1', consent_version: 'voix-1.0', accepted_at: T(60), withdrawn_at: null }],
    ai_sessions: [],
    ai_turns: [],
  }
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    state.fetches.push({ url, init })
    if (url.includes('get-signed-url')) return new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=SECRET-TOKEN' }), { status: 200 })
    if (init?.method === 'DELETE') return new Response('', { status: 200 })
    if (url.includes('/conversations/')) return new Response(JSON.stringify(state.conversation), { status: 200 })
    return new Response('', { status: 404 })
  }))
})

const actions = () => import('@/app/actions/ai-practice')
const consentActions = () => import('@/app/actions/voice-consent')
const providerCalls = () => state.fetches.filter(f => f.url.includes('elevenlabs'))

describe('starting a voice session', () => {
  it('a signed-in, entitled, consenting learner gets a session, an attempt counter and a signed URL without any override', async () => {
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toBeUndefined()
    expect(r.signedUrl).toContain('wss://')
    expect(r.attemptsRemaining).toBe(4)
    const s = state.db.ai_sessions[0]
    expect(s).toMatchObject({ user_id: 'U1', anon_id: null, status: 'active', mode: 'voice', scenario_id: SCENARIO })
    expect(providerCalls()).toHaveLength(1)
    expect(providerCalls()[0].url).toContain('get-signed-url?agent_id=AGENT-AMARA')
    expect(providerCalls()[0].url).not.toMatch(/override|prompt|first_message/)
    expect((providerCalls()[0].init?.headers as Record<string, string>)['xi-api-key']).toBe('test-key')
  })

  it('the signed URL and its token never reach the logs', async () => {
    await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(state.logs.join('\n')).not.toContain('SECRET-TOKEN')
    expect(state.logs.join('\n')).not.toContain('wss://')
  })

  it('no signed-in learner: refused, nothing created, the provider never called', async () => {
    state.user = null
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO, anonId: '11111111-1111-4111-8111-111111111111' })
    expect(r.error).toBe('Session non identifiée.')
    expect(state.db.ai_sessions).toEqual([])
    expect(providerCalls()).toEqual([])
  })

  it('no consent, or a withdrawn one: refused with consent_required', async () => {
    state.db.voice_processing_consents = []
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('consent_required')
    state.db.voice_processing_consents = [{ user_id: 'U1', consent_version: 'voix-1.0', accepted_at: T(60), withdrawn_at: T(5) }]
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('consent_required')
    state.db.voice_processing_consents = [{ user_id: 'U1', consent_version: 'voix-0.9', accepted_at: T(60), withdrawn_at: null }]
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('consent_required')
    expect(providerCalls()).toEqual([])
  })

  it('a consent that cannot be read fails closed', async () => {
    state.failRead.add('voice_processing_consents')
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toMatch(/indisponible/)
    expect(r.reason).toBeUndefined()
    expect(providerCalls()).toEqual([])
  })

  it('no course access: refused before the provider is called', async () => {
    state.access = { allowed: false, reason: 'not_entitled' }
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toBe('refused:not_entitled')
    expect(providerCalls()).toEqual([])
  })

  it('a scenario without a reviewed persona never starts', async () => {
    const r = await (await actions()).startVoiceSession({ scenarioId: OTHER })
    expect(r.reason).toBe('not_configured')
    expect(providerCalls()).toEqual([])
  })

  it('one live session at a time', async () => {
    state.db.ai_sessions.push({ id: 'S0', user_id: 'U1', scenario_id: SCENARIO, status: 'active', mode: 'voice', started_at: T(2) })
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.reason).toBe('session_in_progress')
    expect(providerCalls()).toEqual([])
  })

  it('a session a closed tab left open is closed after the time-out, and the learner can start again', async () => {
    state.db.ai_sessions.push({ id: 'S0', user_id: 'U1', scenario_id: SCENARIO, status: 'active', mode: 'voice', started_at: T(20) })
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toBeUndefined()
    expect(state.db.ai_sessions.find(s => s.id === 'S0')!.status).toBe('abandoned')
  })

  it('five attempts per lesson within the access period; earlier periods do not count', async () => {
    for (let i = 0; i < 5; i++) state.db.ai_sessions.push({ id: `S${i}`, user_id: 'U1', scenario_id: SCENARIO, status: 'completed', mode: 'voice', started_at: T(30 + i) })
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('attempts_exhausted')
    expect(providerCalls()).toEqual([])
    // A renewed access starts a new period: the same five attempts no longer count.
    state.db.entitlements = [{ user_id: 'U1', course_id: 'C2', status: 'ACTIVE', starts_at: T(10), expires_at: null, revoked_at: null, created_at: T(10) }]
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).error).toBeUndefined()
  })

  it('self-assessment sessions are not voice attempts', async () => {
    for (let i = 0; i < 5; i++) state.db.ai_sessions.push({ id: `S${i}`, user_id: 'U1', scenario_id: SCENARIO, status: 'completed', mode: 'self', started_at: T(30 + i) })
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).attemptsRemaining).toBe(4)
  })
})

describe('turns, completion and ownership', () => {
  beforeEach(() => {
    state.db.ai_sessions.push(
      { id: '22222222-2222-4222-8222-222222222222', user_id: 'U1', anon_id: null, scenario_id: SCENARIO, status: 'active', mode: 'voice', started_at: T(1) },
      { id: '33333333-3333-4333-8333-333333333333', user_id: 'U2', anon_id: null, scenario_id: SCENARIO, status: 'completed', mode: 'voice', started_at: T(1), provider_conversation_id: 'conv_other_learner' },
    )
  })
  const MINE = '22222222-2222-4222-8222-222222222222'
  const THEIRS = '33333333-3333-4333-8333-333333333333'

  it('turns are stored once, even when a batch is replayed', async () => {
    const a = await actions()
    const batch = [{ speaker: 'learner' as const, transcript: 'Bonjour', turnIndex: 0 }, { speaker: 'agent' as const, transcript: 'Oui ?', turnIndex: 1 }]
    expect((await a.saveAiTurns({ sessionId: MINE, turns: batch })).ok).toBe(true)
    expect((await a.saveAiTurns({ sessionId: MINE, turns: [...batch, { speaker: 'learner', transcript: 'Encore', turnIndex: 2 }] })).ok).toBe(true)
    expect(state.db.ai_turns.map(t => t.turn_index)).toEqual([0, 1, 2])
  })

  it('no turn on a finished session, and none on another learner\'s', async () => {
    const a = await actions()
    expect((await a.saveAiTurns({ sessionId: THEIRS, turns: [{ speaker: 'learner', transcript: 'x', turnIndex: 0 }] })).error).toBe('Session introuvable.')
    state.db.ai_sessions[0].status = 'completed'
    expect((await a.saveAiTurns({ sessionId: MINE, turns: [{ speaker: 'learner', transcript: 'x', turnIndex: 0 }] })).error).toBe('Session terminée.')
    expect(state.db.ai_turns).toEqual([])
  })

  it('completion keeps the provider conversation id; a malformed id is refused', async () => {
    const a = await actions()
    expect((await a.completeAiSession({ sessionId: MINE, status: 'completed', providerConversationId: 'bad id!' })).error).toBe('Données invalides.')
    expect((await a.completeAiSession({ sessionId: MINE, status: 'completed', providerConversationId: 'conv_abc12345' })).ok).toBe(true)
    expect(state.db.ai_sessions[0]).toMatchObject({ status: 'completed', provider_conversation_id: 'conv_abc12345' })
  })

  it('feedback: only the session\'s own learner, never through another learner\'s session', async () => {
    const r = await (await actions()).getVoiceFeedback({ sessionId: THEIRS })
    expect(r.error).toBe('Session introuvable.')
    expect(providerCalls()).toEqual([])
  })

  it('feedback: pending while the session is live, then qualitative per criterion', async () => {
    const a = await actions()
    expect((await a.getVoiceFeedback({ sessionId: MINE })).pending).toBe(true)
    Object.assign(state.db.ai_sessions[0], { status: 'completed', provider_conversation_id: 'conv_abc12345' })
    state.db.ai_turns.push({ session_id: MINE, speaker: 'learner', transcript: 'Si je comprends bien, vous avez reçu un SMS sur votre forfait', turn_index: 0 })
    state.conversation = { agent_id: 'AGENT-AMARA', status: 'done', analysis: { evaluation_criteria_results: {
      amara_reformulation: { criteria_id: 'amara_reformulation', result: 'success', rationale: 'Il a dit « vous avez reçu un SMS sur votre forfait ».' },
    } } }
    const r = await a.getVoiceFeedback({ sessionId: MINE })
    expect(r.feedback?.objectiveMet).toBe(true)
    expect(r.feedback?.criteria.map(c => c.result)).toEqual(['success', 'unknown', 'unknown'])
  })

  it('feedback: a conversation of another agent is refused', async () => {
    Object.assign(state.db.ai_sessions[0], { status: 'completed', provider_conversation_id: 'conv_abc12345' })
    state.conversation = { agent_id: 'SOMEONE-ELSE', status: 'done', analysis: {} }
    expect((await (await actions()).getVoiceFeedback({ sessionId: MINE })).error).toMatch(/pas disponible/)
  })
})

describe('consent and the learner\'s rights', () => {
  it('accepting needs the current version and an explicit yes', async () => {
    state.db.voice_processing_consents = []
    const c = await consentActions()
    expect((await c.acceptVoiceConsent({ version: 'voix-1.0', accepted: false })).error).toMatch(/Cochez/)
    expect((await c.acceptVoiceConsent({ version: 'voix-0.1', accepted: true })).error).toMatch(/Cochez/)
    expect(state.db.voice_processing_consents).toEqual([])
    expect((await c.acceptVoiceConsent({ version: 'voix-1.0', accepted: true })).ok).toBe(true)
    expect(state.db.voice_processing_consents[0]).toMatchObject({ user_id: 'U1', consent_version: 'voix-1.0', withdrawn_at: null })
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'voice.consent_accepted', subjectUserId: 'U1' })
  })

  it('no signed-in learner, no consent recorded', async () => {
    state.user = null
    state.db.voice_processing_consents = []
    expect((await (await consentActions()).acceptVoiceConsent({ version: 'voix-1.0', accepted: true })).error).toBeTruthy()
    expect(state.db.voice_processing_consents).toEqual([])
  })

  it('withdrawing stops the next start', async () => {
    expect((await (await consentActions()).withdrawVoiceConsent()).ok).toBe(true)
    expect((await (await actions()).startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('consent_required')
  })

  it('erasure deletes the learner\'s own sessions and their provider conversations, and nobody else\'s', async () => {
    state.db.ai_sessions.push(
      { id: 'A', user_id: 'U1', provider_conversation_id: 'conv_mine_123', status: 'completed' },
      { id: 'B', user_id: 'U2', provider_conversation_id: 'conv_theirs_12', status: 'completed' },
    )
    const r = await (await consentActions()).deleteMyVoiceData()
    expect(r).toMatchObject({ ok: true, deletedSessions: 1, providerNotDeleted: 0 })
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['B'])
    const deletes = state.fetches.filter(f => f.init?.method === 'DELETE').map(f => f.url)
    expect(deletes).toEqual(['https://api.elevenlabs.io/v1/convai/conversations/conv_mine_123'])
  })
})
