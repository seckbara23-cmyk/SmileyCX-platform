/**
 * XP-F2-01/02/03 — the voice engine's server-side controls, with voice practice OPEN.
 *
 * Production keeps voice practice closed (pinned in xp-f2-voice-engine.test.ts);
 * these tests open it in-process to prove what the server enforces once it is
 * opened: signed-in learner, course access, consent, one live session, attempts
 * per lesson, ownership, no provider call on any refusal, no token in the logs.
 * XP-F2-04 adds the erasure queue, the admin account deletion, the retention
 * route and the restricted-UAT gate. XP-F2-03 adds: self-assessment is never constrained by the voice policy, the
 * reviewed brief reaches the learner, the transcript guards in the feedback,
 * the erasure retry, and the (unscheduled) retention purge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { personaById } from '@/lib/voice/personas'
import { GUARD_RATIONALE_FR } from '@/lib/voice/dialogue-guards'

type Row = Record<string, unknown>
const T = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()

const state = {
  user: { id: 'U1', email: 'u1@example.test' } as { id: string; email: string } | null,
  access: { allowed: true } as { allowed: boolean; reason?: string },
  db: {} as Record<string, Row[]>,
  failRead: new Set<string>(),
  failWrite: new Set<string>(),
  /** Simulates a database before migration 066: the voice columns do not exist. */
  pre066: false,
  /** `VOICE_PRACTICE_OPEN` as the mocked flags module reports it. */
  open: true,
  events: [] as string[],
  deleteUserError: null as string | null,
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
  let cols = ''
  let ignoreDuplicates = false
  const rows = () => (state.db[table] ??= [])
  const exec = () => {
    if (op === 'select' && state.failRead.has(table)) return { data: null, error: { message: 'boom' }, count: null }
    if (op === 'select' && state.pre066 && table === 'ai_sessions' && /provider_conversation_id|content_purged_at|mode/.test(cols)) {
      return { data: null, error: { code: '42703', message: 'column does not exist' }, count: null }
    }
    if (op !== 'select' && state.failWrite.has(table)) return { data: null, error: { message: 'write refused' } }
    if (op === 'insert') {
      const add = (Array.isArray(payload) ? payload : [payload]).map(p => ({ id: crypto.randomUUID(), started_at: new Date().toISOString(), ...(p as Row) }))
      // Mirrors migration 066's index: one live VOICE session per learner.
      if (table === 'ai_sessions' && add.some(a => a.status === 'active' && a.mode === 'voice' && rows().some(r => r.user_id === a.user_id && r.status === 'active' && r.mode === 'voice'))) {
        return { data: null, error: { message: 'duplicate key: ai_sessions_one_live_voice_per_user' } }
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
      if (found) { if (!ignoreDuplicates) Object.assign(found, p) } else rows().push({ requested_at: new Date().toISOString(), ...p })
      return { data: [p], error: null }
    }
    return head ? { data: null, error: null, count: hit.length } : { data: hit, error: null }
  }
  const q: Record<string, unknown> = {
    select: (c?: string, o?: { head?: boolean }) => { cols = c ?? ''; if (o?.head) head = true; return q },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
    in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
    lt: (c: string, v: string) => { filters.push(r => String(r[c]) < v); return q },
    gte: (c: string, v: string) => { filters.push(r => String(r[c]) >= v); return q },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return q },
    not: (c: string, op: string, v: unknown) => { if (op !== 'is') throw new Error(`fake not.${op}`); filters.push(r => (r[c] ?? null) !== v); return q },
    order: () => q,
    limit: () => q,
    insert: (p: unknown) => { op = 'insert'; payload = p; return q },
    update: (p: unknown) => { op = 'update'; payload = p; return q },
    upsert: (p: unknown, o: { onConflict: string; ignoreDuplicates?: boolean }) => { op = 'upsert'; payload = p; conflict = o.onConflict; ignoreDuplicates = !!o.ignoreDuplicates; return q },
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
  VOICE_LEGAL_CONDITIONS_BUILT: true, get VOICE_PRACTICE_OPEN() { return state.open }, VOICE_CLOSED_MESSAGE: 'closed',
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from,
    auth: { admin: { deleteUser: async (id: string) => {
      state.events.push(`deleteUser:${id}`)
      if (state.deleteUserError) return { error: { message: state.deleteUserError } }
      // The real foreign keys cascade: the account's sessions go with it.
      state.db.ai_sessions = (state.db.ai_sessions ?? []).filter(r => r.user_id !== id)
      return { error: null }
    } } },
  }),
}))
vi.mock('@/lib/auth/session', () => ({ requirePlatformAdmin: async () => ({ id: 'ADMIN', email: 'admin@example.test' }) }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { state.events.push(`redirect:${to}`) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) }, from }) }))
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
  state.failWrite = new Set()
  state.pre066 = false
  state.open = true
  state.events = []
  state.deleteUserError = null
  vi.unstubAllEnvs()
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
    if (init?.method === 'DELETE') state.events.push(`providerDelete:${url.split('/').pop()}`)
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

describe('XP-F2-03: self-assessment is not a voice session', () => {
  it('an old self-assessment left active neither blocks a voice start nor gets closed', async () => {
    state.db.ai_sessions.push({ id: 'SELF', user_id: 'U1', scenario_id: SCENARIO, status: 'active', mode: 'self', started_at: T(120) })
    const r = await (await actions()).startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toBeUndefined()
    expect(state.db.ai_sessions.find(s => s.id === 'SELF')!.status).toBe('active')
  })

  it('a self-assessment starts while a voice session is live, is stored as « self », and closes nothing', async () => {
    state.db.ai_sessions.push({ id: 'V', user_id: 'U1', scenario_id: SCENARIO, status: 'active', mode: 'voice', started_at: T(30) })
    const r = await (await actions()).createAiSession({ scenarioId: SCENARIO })
    expect(r.error).toBeUndefined()
    expect(state.db.ai_sessions.find(s => s.id === r.sessionId)).toMatchObject({ mode: 'self', status: 'active', user_id: 'U1' })
    expect(state.db.ai_sessions.find(s => s.id === 'V')!.status).toBe('active')
    expect(providerCalls()).toEqual([])
  })
})

describe('XP-F2-03: the learner reads the reviewed brief, not the older database text', () => {
  const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  it('Ibrahima: situation and criteria from the approved document, nothing of the agent\'s material', async () => {
    const ibrahima = personaById('ibrahima')
    state.db.lessons.push({ id: LESSON, module_id: 'M1' })
    state.db.public_voice_scenarios = [{
      id: SCENARIO, slug: 'ibrahima-double-facturation', lesson_id: LESSON, title: 'Client en colère', persona_name: 'Ibrahima',
      situation: 'Ancien texte de la base.', objectives: ['Ancien objectif'], self_assessment: [], voice_configured: true, order_index: 0,
    }]
    const v = await (await actions()).fetchVoiceScenario(LESSON)
    expect(v?.situation).toBe(ibrahima.customer.situationFr)
    expect(v?.objectives).toEqual(ibrahima.observationCriteria.map(c => c.labelFr))
    expect(v?.voiceAvailable).toBe(true)
    const shown = JSON.stringify(v)
    for (const hidden of [ibrahima.objective.definitionFr, ibrahima.endings.failureFr, ...ibrahima.objective.nonExamplesFr]) expect(shown).not.toContain(hidden)
    expect(shown).not.toContain('Ancien')
  })
})

describe('XP-F2-03: feedback goes through the transcript guards, and stops once content is purged', () => {
  const S = '44444444-4444-4444-8444-444444444444'
  beforeEach(() => {
    state.db.ai_sessions.push({ id: S, user_id: 'U1', anon_id: null, scenario_id: SCENARIO, status: 'completed', mode: 'voice', started_at: T(5), provider_conversation_id: 'conv_guarded_1' })
  })

  it('a learner who only said « oui » does not meet the objective, whatever the analysis says', async () => {
    state.db.ai_turns.push(
      { session_id: S, speaker: 'agent', transcript: 'Donc vous allez m’expliquer mon nouveau forfait, c’est ça ?', turn_index: 0 },
      { session_id: S, speaker: 'learner', transcript: 'Oui, c’est ça.', turn_index: 1 },
    )
    state.conversation = { agent_id: 'AGENT-AMARA', status: 'done', analysis: { evaluation_criteria_results: {
      amara_reformulation: { criteria_id: 'amara_reformulation', result: 'success', rationale: 'Le conseiller a validé la demande.' },
    } } }
    const r = await (await actions()).getVoiceFeedback({ sessionId: S })
    expect(r.feedback?.objectiveMet).toBe(false)
    expect(r.feedback?.retryInvited).toBe(true)
    expect(r.feedback?.criteria[0]).toMatchObject({ result: 'failure', rationaleFr: GUARD_RATIONALE_FR.bareConfirmations })
  })

  it('a purged session gives no feedback and the provider is not asked again', async () => {
    Object.assign(state.db.ai_sessions.find(s => s.id === S)!, { content_purged_at: T(1) })
    const r = await (await actions()).getVoiceFeedback({ sessionId: S })
    expect(r.error).toBe('Le détail de cet entraînement n’est plus conservé.')
    expect(providerCalls()).toEqual([])
  })
})

const providerDown = () => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  state.fetches.push({ url, init })
  if (init?.method === 'DELETE') state.events.push(`providerDelete:${url.split('/').pop()}`)
  return new Response('', { status: init?.method === 'DELETE' ? 503 : 404 })
}))

describe('XP-F2-04: a learner\'s erasure when the provider cannot delete yet', () => {
  beforeEach(() => {
    state.db.ai_sessions.push(
      { id: 'A', user_id: 'U1', provider_conversation_id: 'conv_fails_123', status: 'completed', engine_signals: { hints: [{ quote: 'mes propres mots' }] } },
      { id: 'B', user_id: 'U1', provider_conversation_id: null, status: 'completed' },
      { id: 'C', user_id: 'U2', provider_conversation_id: 'conv_theirs_12', status: 'completed' },
    )
    state.db.voice_provider_erasures = []
  })

  it('the sessions go at once; the provider reference is queued, with nothing about the learner; the learner is told', async () => {
    providerDown()
    const r = await (await consentActions()).deleteMyVoiceData()
    expect(r).toMatchObject({ ok: true, deletedSessions: 2, providerNotDeleted: 1 })
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['C'])
    expect(state.db.voice_provider_erasures).toHaveLength(1)
    const q = state.db.voice_provider_erasures[0]
    expect(q).toMatchObject({ provider_conversation_id: 'conv_fails_123', reason: 'learner_request' })
    expect(Object.keys(q).sort()).toEqual(['provider_conversation_id', 'reason', 'requested_at'])
    expect(JSON.stringify(q)).not.toContain('U1')
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'voice.data_deleted', outcome: 'success', metadata: { sessions: 2, providerDeleted: 0, providerNotDeleted: 1 } })
    expect(JSON.stringify(state.audits)).not.toContain('mes propres mots')
  })

  it('if the reference cannot be queued, nothing is deleted and nothing is called a success', async () => {
    providerDown()
    state.failWrite.add('voice_provider_erasures')
    const r = await (await consentActions()).deleteMyVoiceData()
    expect(r.ok).toBeUndefined()
    expect(r.error).toMatch(/n’a pas pu être effectuée/)
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['A', 'B', 'C'])
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'voice.data_deleted', outcome: 'failure', reason: 'erasure_queue' })
  })

  it('repeating the request is safe: one queue row, no error', async () => {
    providerDown()
    await (await consentActions()).deleteMyVoiceData()
    state.db.ai_sessions.push({ id: 'A2', user_id: 'U1', provider_conversation_id: 'conv_fails_123', status: 'completed' })
    expect((await (await consentActions()).deleteMyVoiceData()).ok).toBe(true)
    expect(state.db.voice_provider_erasures).toHaveLength(1)
  })
})

describe('XP-F2-04: deleting an account does not leave provider conversations behind', () => {
  const form = (id: string) => { const f = new FormData(); f.set('userId', id); return f }
  const deleteUser = async (id: string) => (await import('@/app/(admin)/admin/users/[id]/actions')).deleteUser(form(id))

  beforeEach(() => {
    state.db.profiles = [{ id: 'U1', email: 'u1@example.test', full_name: 'Learner One', platform_role: 'learner', created_at: T(1000) }]
    state.db.ai_sessions.push(
      { id: 'A', user_id: 'U1', provider_conversation_id: 'conv_first_123', status: 'completed' },
      { id: 'B', user_id: 'U1', provider_conversation_id: 'conv_second_12', status: 'completed' },
      { id: 'N', user_id: 'U1', provider_conversation_id: null, status: 'completed' },
      { id: 'C', user_id: 'U2', provider_conversation_id: 'conv_theirs_12', status: 'completed' },
    )
    state.db.voice_provider_erasures = []
  })

  it('the provider copies are deleted first, then the account; the audit carries the counts', async () => {
    await deleteUser('U1')
    expect(state.events).toEqual(['providerDelete:conv_first_123', 'providerDelete:conv_second_12', 'deleteUser:U1', 'redirect:/admin/users'])
    expect(state.db.voice_provider_erasures).toEqual([])
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['C'])
    const audit = state.audits.find(a => a.eventType === 'user.deleted')!
    expect(audit).toMatchObject({ outcome: 'success', metadata: { voiceErasure: { sessions: 3, providerDeleted: 2, providerQueued: 0 } } })
  })

  it('provider unavailable: the account is deleted, and every reference survives it in the queue', async () => {
    providerDown()
    await deleteUser('U1')
    expect(state.events.at(-2)).toBe('deleteUser:U1')
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['C'])
    expect(state.db.voice_provider_erasures.map(q => [q.provider_conversation_id, q.reason])).toEqual([
      ['conv_first_123', 'account_deletion'], ['conv_second_12', 'account_deletion'],
    ])
    expect(JSON.stringify(state.db.voice_provider_erasures)).not.toMatch(/U1|u1@example/)
    expect(state.audits.find(a => a.eventType === 'user.deleted')).toMatchObject({
      outcome: 'success', metadata: { voiceErasure: { sessions: 3, providerDeleted: 0, providerQueued: 2 } },
    })
  })

  it('no API key is a provider failure like any other: queued, never reported as deleted', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    await deleteUser('U1')
    expect(providerCalls()).toEqual([])
    expect(state.db.voice_provider_erasures).toHaveLength(2)
  })

  it('a reference that can be neither deleted nor queued blocks the deletion, and says so', async () => {
    providerDown()
    state.failWrite.add('voice_provider_erasures')
    await expect(deleteUser('U1')).rejects.toThrow(/Account not deleted/)
    expect(state.events.some(e => e.startsWith('deleteUser'))).toBe(false)
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['A', 'B', 'N', 'C'])
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'user.deleted', outcome: 'failure', reason: 'voice_erasure_queue' })
  })

  it('sessions that cannot be read block the deletion too', async () => {
    state.failRead.add('ai_sessions')
    await expect(deleteUser('U1')).rejects.toThrow(/Account not deleted/)
    expect(state.events).toEqual([])
  })

  it('before migration 066 there is nothing at the provider to erase: account deletion works as it always has', async () => {
    state.pre066 = true
    await deleteUser('U1')
    expect(providerCalls()).toEqual([])
    expect(state.events).toEqual(['deleteUser:U1', 'redirect:/admin/users'])
    expect(state.audits.find(a => a.eventType === 'user.deleted')).toMatchObject({ outcome: 'success', metadata: { voiceErasure: { providerDeleted: 0, providerQueued: 0 } } })
  })

  it('an account-deletion failure after the erasure is reported as a failure; a retry is safe', async () => {
    state.deleteUserError = 'auth unavailable'
    await expect(deleteUser('U1')).rejects.toThrow(/Failed to delete user/)
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'user.deleted', outcome: 'failure' })
    state.deleteUserError = null
    await deleteUser('U1')
    expect(state.db.ai_sessions.map(s => s.id)).toEqual(['C'])
  })

  it('the queue is completed by a later run, with the attempts counted', async () => {
    providerDown()
    await deleteUser('U1')
    const { runVoiceRetention } = await import('@/lib/voice/retention')
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const now = new Date()
    const down = await runVoiceRetention(createAdminClient() as never, { retentionDays: null, now, apiKey: 'test-key', deleteConversation: async () => false })
    expect(down).toMatchObject({ queueCompleted: 0, queuePending: 2, sessionsPurged: 0 })
    expect(state.db.voice_provider_erasures.every(q => q.attempts === 1 && !q.completed_at)).toBe(true)
    const up = await runVoiceRetention(createAdminClient() as never, { retentionDays: null, now, apiKey: 'test-key', deleteConversation: async () => true })
    expect(up).toMatchObject({ queueCompleted: 2, queuePending: 0, overdue: 0, errors: 0 })
    expect(state.db.voice_provider_erasures.every(q => q.attempts === 2 && q.completed_at === now.toISOString())).toBe(true)
    expect(await runVoiceRetention(createAdminClient() as never, { retentionDays: null, now, apiKey: 'test-key', deleteConversation: async () => { throw new Error('must not be called') } }))
      .toMatchObject({ queueCompleted: 0, queuePending: 0 })
  })
})

describe('XP-F2-04: transcript retention, configurable, alerting, and scheduled by nothing', () => {
  const NOW = new Date('2026-12-20T12:00:00Z')
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
  const run = async (opts: Record<string, unknown> = {}) => {
    const { runVoiceRetention } = await import('@/lib/voice/retention')
    const { createAdminClient } = await import('@/lib/supabase/admin')
    return runVoiceRetention(createAdminClient() as never, { retentionDays: 30, now: NOW, apiKey: 'test-key', ...opts })
  }

  beforeEach(() => {
    state.db.ai_sessions.push(
      { id: 'OLD', user_id: 'U1', scenario_id: SCENARIO, status: 'completed', mode: 'voice', started_at: daysAgo(40), completed_at: daysAgo(40), provider_conversation_id: 'conv_old_1234', engine_signals: { hints: [{ quote: 'vieux mots' }] } },
      { id: 'STUCK', user_id: 'U1', scenario_id: SCENARIO, status: 'active', mode: 'self', started_at: daysAgo(90) },
      { id: 'NEW', user_id: 'U1', scenario_id: SCENARIO, status: 'completed', mode: 'voice', started_at: daysAgo(5), completed_at: daysAgo(5), provider_conversation_id: 'conv_new_1234', engine_signals: { hints: [{ quote: 'mots récents' }] } },
    )
    state.db.ai_turns = [{ session_id: 'OLD', transcript: 'vieux mots' }, { session_id: 'NEW', transcript: 'mots récents' }]
    state.db.ai_feedback = [{ session_id: 'STUCK', answers: 'réponse ancienne' }, { session_id: 'NEW', answers: 'réponse récente' }]
    state.db.ai_scores = [{ session_id: 'OLD', evidence: 'vieux mots' }]
    state.db.ai_recommendations = [{ session_id: 'OLD', text: 'conseil' }]
    state.db.voice_provider_erasures = []
  })

  it('the period is configuration: unset, malformed or out of range means no purge', async () => {
    const { configuredRetentionDays, PROPOSED_TRANSCRIPT_RETENTION_DAYS } = await import('@/lib/voice/retention')
    expect(PROPOSED_TRANSCRIPT_RETENTION_DAYS).toBe(30)
    for (const raw of [undefined, '', '0', '-5', '30.5', '30 jours', 'abc', '99999', '3651']) expect(configuredRetentionDays(raw), String(raw)).toBeNull()
    expect(configuredRetentionDays('30')).toBe(30)
    expect(configuredRetentionDays(' 7 ')).toBe(7)
    expect(configuredRetentionDays()).toBeNull()
  })

  it('with no period, nothing is purged, however old', async () => {
    expect(await run({ retentionDays: null })).toMatchObject({ retentionDays: null, sessionsPurged: 0, providerDeleted: 0 })
    expect(state.db.ai_turns).toHaveLength(2)
    expect(state.db.ai_sessions.find(s => s.id === 'OLD')).toMatchObject({ provider_conversation_id: 'conv_old_1234' })
  })

  it('past the period: every content row and the engine quotes go, the session row stays; recent sessions are untouched', async () => {
    const r = await run()
    expect(r).toMatchObject({ retentionDays: 30, sessionsPurged: 2, providerDeleted: 1, providerPending: 0, queueCompleted: 0, queuePending: 0, overdue: 0, errors: 0 })
    expect(state.db.ai_turns).toEqual([{ session_id: 'NEW', transcript: 'mots récents' }])
    expect(state.db.ai_feedback).toEqual([{ session_id: 'NEW', answers: 'réponse récente' }])
    expect(state.db.ai_scores).toEqual([])
    expect(state.db.ai_recommendations).toEqual([])
    const old = state.db.ai_sessions.find(s => s.id === 'OLD')!
    expect(old).toMatchObject({ status: 'completed', mode: 'voice', engine_signals: null, provider_conversation_id: null, content_purged_at: NOW.toISOString() })
    expect(state.db.ai_sessions.find(s => s.id === 'NEW')).toMatchObject({ provider_conversation_id: 'conv_new_1234', engine_signals: { hints: [{ quote: 'mots récents' }] } })
    expect(state.db.ai_sessions.find(s => s.id === 'NEW')!.content_purged_at).toBeUndefined()
    expect(state.fetches.filter(f => f.init?.method === 'DELETE').map(f => f.url)).toEqual(['https://api.elevenlabs.io/v1/convai/conversations/conv_old_1234'])
    // Purged sessions still count as attempts: the rows stay.
    expect(state.db.ai_sessions.map(s => s.id).sort()).toEqual(['NEW', 'OLD', 'STUCK'])
  })

  it('a provider failure is retried on the next run, never forgotten; a second clean run finds nothing to do', async () => {
    expect(await run({ deleteConversation: async () => false })).toMatchObject({ sessionsPurged: 2, providerDeleted: 0, providerPending: 1, overdue: 0 })
    expect(state.db.ai_sessions.find(s => s.id === 'OLD')!.provider_conversation_id).toBe('conv_old_1234')
    const ok = vi.fn(async () => true)
    expect(await run({ deleteConversation: ok })).toMatchObject({ sessionsPurged: 0, providerDeleted: 1, providerPending: 0 })
    expect(ok).toHaveBeenCalledWith('conv_old_1234', 'test-key')
    expect(await run()).toMatchObject({ sessionsPurged: 0, providerDeleted: 0, providerPending: 0, errors: 0 })
  })

  it('without a provider key nothing is lost: the conversation stays pending', async () => {
    expect(await run({ apiKey: undefined })).toMatchObject({ providerDeleted: 0, providerPending: 1 })
  })

  it('overdue provider copies raise an alert: an error log with a code, and a failed audit record', async () => {
    await run({ deleteConversation: async () => false })
    state.db.voice_provider_erasures.push({ provider_conversation_id: 'conv_queued_old', reason: 'account_deletion', requested_at: daysAgo(10), attempts: 4 })
    state.logs = []
    state.audits = []
    const later = new Date(NOW.getTime() + 5 * 86_400_000)
    const r = await run({ now: later, deleteConversation: async () => false })
    expect(r).toMatchObject({ providerPending: 1, queuePending: 1, overdue: 2 })
    expect(state.logs.join('\n')).toContain('VOICE_ERASURE_OVERDUE')
    expect(state.audits.at(-1)).toMatchObject({ eventType: 'voice.retention_purged', outcome: 'failure', reason: 'provider_erasure_overdue' })
    for (const leak of ['conv_queued_old', 'conv_old_1234', 'vieux mots']) expect(state.logs.join('\n') + JSON.stringify(state.audits)).not.toContain(leak)
  })

  it('a database failure is counted and alerted, not swallowed', async () => {
    state.failWrite.add('ai_turns')
    const r = await run()
    expect(r.errors).toBeGreaterThan(0)
    expect(state.logs.join('\n')).toContain('VOICE_RETENTION_ERRORS')
    expect(state.db.ai_sessions.find(s => s.id === 'OLD')!.content_purged_at).toBeUndefined()
  })

  it('auditable: one record per run, counts only, no id and no learner words', async () => {
    await run()
    const audit = state.audits.filter(a => a.eventType === 'voice.retention_purged')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'system', outcome: 'success', metadata: { retentionDays: 30, sessionsPurged: 2, providerDeleted: 1, providerPending: 0, queueCompleted: 0, queuePending: 0, overdue: 0, errors: 0 } })
    const text = JSON.stringify(audit)
    for (const leak of ['OLD', 'STUCK', 'conv_old_1234', 'vieux mots', 'U1']) expect(text).not.toContain(leak)
  })

  it('the period is null or a whole number of days', async () => {
    await expect(run({ retentionDays: 0 })).rejects.toThrow(/at least 1/)
    await expect(run({ retentionDays: 1.5 })).rejects.toThrow(/whole number/)
  })

  describe('the route', () => {
    const call = async (auth?: string) => {
      const { GET } = await import('@/app/api/voice/retention/route')
      return GET(new Request('https://example.test/api/voice/retention', { headers: auth ? { authorization: auth } : {} }))
    }
    const SECRET = 'cron-secret-of-sufficient-length'

    it('refuses everything without a configured secret, and anything without the right one', async () => {
      vi.stubEnv('CRON_SECRET', '')
      expect((await call(`Bearer ${SECRET}`)).status).toBe(503)
      vi.stubEnv('CRON_SECRET', SECRET)
      expect((await call()).status).toBe(401)
      expect((await call('Bearer wrong')).status).toBe(401)
      expect(state.db.ai_turns).toHaveLength(2)
      expect(providerCalls()).toEqual([])
    })

    it('authorised but with no period configured: retries only, no purge', async () => {
      vi.stubEnv('CRON_SECRET', SECRET)
      const res = await call(`Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, retentionDays: null, sessionsPurged: 0 })
      expect(state.db.ai_turns).toHaveLength(2)
    })

    it('authorised with a period: purges, and answers with counts only', async () => {
      vi.stubEnv('CRON_SECRET', SECRET)
      vi.stubEnv('VOICE_TRANSCRIPT_RETENTION_DAYS', '30')
      // « Now » is the real clock here: age the fixtures against it.
      for (const s of state.db.ai_sessions) if (s.id !== 'NEW') s.started_at = T(60 * 24 * 400)
      const res = await call(`Bearer ${SECRET}`)
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body).toMatchObject({ ok: true, retentionDays: 30, sessionsPurged: 2, providerDeleted: 1 })
      expect(JSON.stringify(body)).not.toMatch(/conv_|vieux|U1/)
    })

    it('answers 500 when a provider copy is overdue, so a scheduler notices', async () => {
      vi.stubEnv('CRON_SECRET', SECRET)
      providerDown()
      state.db.voice_provider_erasures.push({ provider_conversation_id: 'conv_queued_old', reason: 'learner_request', requested_at: T(60 * 24 * 10), attempts: 9 })
      const res = await call(`Bearer ${SECRET}`)
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ ok: false, overdue: 1 })
    })
  })

  it('nothing schedules the run: one unlisted route calls it, and no cron', () => {
    const root = process.cwd()
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(root, rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && /runVoiceRetention\(/.test(readFileSync(join(root, rel), 'utf8'))) hits.push(rel)
      }
    }
    for (const d of ['app', 'lib', 'scripts', 'components']) walk(d)
    expect(hits.sort()).toEqual(['app/api/voice/retention/route.ts', 'lib/voice/retention.ts'])
    const crons = (JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).crons ?? []) as { path: string }[]
    expect(crons.map(c => c.path)).toEqual(['/api/payments/paytech/reconcile'])
    // The proposal is a named constant only: no default period is wired anywhere.
    const src = readFileSync(join(root, 'lib/voice/retention.ts'), 'utf8')
    expect(src.match(/PROPOSED_TRANSCRIPT_RETENTION_DAYS/g)).toHaveLength(1)
  })
})

describe('XP-F2-04: restricted UAT — voice closed for everyone except the listed accounts', () => {
  const TESTER = '9f8b7c6d-1234-4abc-8def-0123456789ab'
  const OTHER_LEARNER = '11111111-2222-4333-8444-555555555555'
  const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  beforeEach(() => {
    state.open = false
    state.user = { id: TESTER, email: 'tester@example.test' }
    state.db.entitlements = [{ user_id: TESTER, course_id: 'C2', status: 'ACTIVE', starts_at: T(60 * 24), expires_at: null, revoked_at: null, created_at: T(60 * 24) }]
    state.db.voice_processing_consents = [{ user_id: TESTER, consent_version: 'voix-1.0', accepted_at: T(60), withdrawn_at: null }]
    state.db.lessons.push({ id: LESSON, module_id: 'M1' })
    state.db.public_voice_scenarios = [{ id: SCENARIO, slug: 'amara-forfait-incompris', lesson_id: LESSON, title: 'Client confus', persona_name: 'Amara', situation: 'x', objectives: [], self_assessment: [], voice_configured: true, order_index: 0 }]
  })

  it('the list: valid ids only, case-insensitive, and a list that is too long opens nothing', async () => {
    const { voiceUatUserIds, MAX_UAT_USERS } = await import('@/lib/voice/access')
    expect([...voiceUatUserIds(undefined)]).toEqual([])
    expect([...voiceUatUserIds(` ${TESTER.toUpperCase()} , not-an-id, *, ${TESTER}`)]).toEqual([TESTER])
    const many = Array.from({ length: MAX_UAT_USERS + 1 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`).join(',')
    expect(voiceUatUserIds(many).size).toBe(0)
  })

  it('no list: closed for everyone, and the session is not even read', async () => {
    const a = await actions()
    expect(await a.fetchVoiceScenario(LESSON)).toBeNull()
    expect((await a.startVoiceSession({ scenarioId: SCENARIO })).error).toBe('closed')
    expect((await a.createAiSession({ scenarioId: SCENARIO })).error).toBe('closed')
    expect(await (await consentActions()).getVoiceConsentStatus()).toBeNull()
    expect(providerCalls()).toEqual([])
    expect(state.db.ai_sessions).toEqual([])
  })

  it('a listed account gets the exercise, behind the same consent, access and limits', async () => {
    vi.stubEnv('VOICE_UAT_USER_IDS', TESTER)
    const a = await actions()
    expect((await a.fetchVoiceScenario(LESSON))?.personaName).toBe('Amara')
    const r = await a.startVoiceSession({ scenarioId: SCENARIO })
    expect(r.error).toBeUndefined()
    expect(r.attemptsRemaining).toBe(4)
    expect(state.db.ai_sessions[0]).toMatchObject({ user_id: TESTER, mode: 'voice' })
    // One live session, consent and course access still apply to the tester.
    expect((await a.startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('session_in_progress')
    state.db.ai_sessions = []
    state.db.voice_processing_consents = []
    expect((await a.startVoiceSession({ scenarioId: SCENARIO })).reason).toBe('consent_required')
    state.access = { allowed: false, reason: 'not_entitled' }
    expect(await a.fetchVoiceScenario(LESSON)).toBeNull()
  })

  it('any other signed-in learner, and a signed-out visitor, stay closed while the UAT runs', async () => {
    vi.stubEnv('VOICE_UAT_USER_IDS', TESTER)
    const a = await actions()
    for (const who of [{ id: OTHER_LEARNER, email: 'other@example.test' }, null]) {
      state.user = who
      expect(await a.fetchVoiceScenario(LESSON)).toBeNull()
      expect((await a.startVoiceSession({ scenarioId: SCENARIO })).error).toBe('closed')
      expect((await a.createAiSession({ scenarioId: SCENARIO })).error).toBe('closed')
      expect((await a.saveAiTurns({ sessionId: SCENARIO, turns: [{ speaker: 'learner', transcript: 'x', turnIndex: 0 }] })).error).toBe('closed')
      expect((await a.getVoiceFeedback({ sessionId: SCENARIO })).error).toBe('closed')
      expect((await (await consentActions()).acceptVoiceConsent({ version: 'voix-1.0', accepted: true })).error).toBe('closed')
    }
    expect(providerCalls()).toEqual([])
    expect(state.db.ai_sessions).toEqual([])
  })

  it('the UAT covers the five reviewed scenarios only', async () => {
    vi.stubEnv('VOICE_UAT_USER_IDS', TESTER)
    state.db.public_voice_scenarios = [{ id: OTHER, slug: 'not-a-reviewed-persona', lesson_id: LESSON, title: 'x', persona_name: 'X', situation: 'x', objectives: [], self_assessment: [], voice_configured: true, order_index: 0 }]
    const a = await actions()
    expect(await a.fetchVoiceScenario(LESSON)).toBeNull()
    expect((await a.createAiSession({ scenarioId: OTHER })).error).toBe('Scénario indisponible.')
    expect((await a.startVoiceSession({ scenarioId: OTHER })).reason).toBe('not_configured')
    expect(state.db.ai_sessions).toEqual([])
  })

  it('emptying the list ends the UAT at once; the tester can still withdraw and delete', async () => {
    vi.stubEnv('VOICE_UAT_USER_IDS', TESTER)
    const a = await actions()
    expect((await a.startVoiceSession({ scenarioId: SCENARIO })).error).toBeUndefined()
    vi.stubEnv('VOICE_UAT_USER_IDS', '')
    expect((await a.startVoiceSession({ scenarioId: SCENARIO })).error).toBe('closed')
    expect((await a.saveAiTurns({ sessionId: String(state.db.ai_sessions[0].id), turns: [{ speaker: 'learner', transcript: 'x', turnIndex: 0 }] })).error).toBe('closed')
    const c = await consentActions()
    expect((await c.withdrawVoiceConsent()).ok).toBe(true)
    expect((await c.deleteMyVoiceData()).ok).toBe(true)
    expect(state.db.ai_sessions).toEqual([])
  })

  it('the list is server-only: no public variable, nothing in the page', () => {
    const access = readFileSync(join(process.cwd(), 'lib/voice/access.ts'), 'utf8')
    expect(access).toMatch(/^import 'server-only'/)
    expect(access).not.toContain('NEXT_PUBLIC')
    const page = readFileSync(join(process.cwd(), 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'), 'utf8')
    expect(page).not.toMatch(/VOICE_UAT_USER_IDS|voice\/access/)
  })
})
