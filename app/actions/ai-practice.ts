'use server'

/**
 * AI Practice Engine — Phase 1 server actions.
 *
 * All writes go through these actions using the service-role (admin) client and
 * enforce ownership in code, so:
 *   - anonymous pilot learners can create/complete their own sessions and save
 *     feedback WITHOUT any anon SELECT exposure (RLS grants anon no reads);
 *   - authenticated learners' rows are always stamped with their user_id.
 *
 * Every action fails safe: if the Phase 1 tables are not yet applied, or any
 * query errors, actions return { error } / null and the lesson player is
 * unaffected. Reads of the scenario use the normal (RLS-bound) client and only
 * request learner-facing columns — agent_id and prompt_template never leave the
 * server.
 */

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { createLogger } from '@/lib/logger'
import { AI_COACH_ENABLED } from '@/lib/ai/flags'
import { resolveCourseAccessById, denialMessage } from '@/lib/auth/course-access'
import { recordLessonCompletion } from '@/lib/learn/completion'
import {
  runCompetencyEngine,
  type CompetencyConfig,
  type EngineResult,
  type EngineHint,
} from '@/lib/ai/competency-engine'

const log = createLogger('actions/ai-practice')

/**
 * Resolve scenario → lesson → module → course with the service client.
 *
 * The service client is required, not a shortcut: after migration 035 the
 * lessons and modules rows for a course the caller cannot access are invisible
 * to them, so an RLS-bound lookup would return null and the gate would deny
 * everyone — including entitled learners. Authorization is decided afterwards,
 * by resolveCourseAccessById(), on the caller's own identity.
 */
async function courseIdForLesson(
  admin: ReturnType<typeof createAdminClient>,
  lessonId: string,
): Promise<string | null> {
  const { data: lesson } = await admin
    .from('lessons')
    .select('module_id')
    .eq('id', lessonId)
    .maybeSingle()
  if (!lesson?.module_id) return null

  const { data: mod } = await admin
    .from('modules')
    .select('course_id')
    .eq('id', lesson.module_id)
    .maybeSingle()
  return (mod?.course_id as string | undefined) ?? null
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelfAssessmentQuestion {
  id:        string
  type:      'scale' | 'text'
  question:  string
  guidance?: string
}

/** Coach briefing config (ai_scenarios.briefing jsonb) — pure configuration, no AI. */
export interface VoiceBriefing {
  objective_fr?:        string
  goals_fr?:            string[]
  duration_min?:        number
  difficulty?:          number   // 1–5
  success_criteria_fr?: string[]
}

export interface VoiceScenario {
  id:             string
  slug:           string
  title:          string
  personaName:    string
  situation:      string | null
  objectives:     string[]
  selfAssessment: SelfAssessmentQuestion[]
  /**
   * True when a live ElevenLabs voice session can be started: the scenario has
   * an agent configured AND the server has an API key. Derived server-side —
   * the agent id and API key are never sent to the browser. When false, the UI
   * shows a French setup notice and keeps the self-assessment fallback.
   */
  voiceAvailable: boolean
  /**
   * Coach briefing (Phase 2A). Populated only when the coach flag is on AND
   * the scenario has a briefing configured; null otherwise (UI falls back to
   * the Phase 1 intro).
   */
  briefing: VoiceBriefing | null
}

// ── Validation ────────────────────────────────────────────────────────────────

const Uuid = z.string().uuid()

const CreateSessionSchema = z.object({
  scenarioId: Uuid,
  anonId:     Uuid.optional(),
})

const CompleteSessionSchema = z.object({
  sessionId:       Uuid,
  anonId:          Uuid.optional(),
  status:          z.enum(['completed', 'abandoned']).default('completed'),
  durationSeconds: z.number().int().nonnegative().max(60 * 60).optional(),
})

const TurnSchema = z.object({
  speaker:    z.enum(['learner', 'agent']),
  transcript: z.string().min(1).max(8000),
  turnIndex:  z.number().int().nonnegative(),
  latencyMs:  z.number().int().nonnegative().optional(),
})

const SaveTurnsSchema = z.object({
  sessionId: Uuid,
  anonId:    Uuid.optional(),
  turns:     z.array(TurnSchema).min(1).max(100),
})

const SelfAssessmentSchema = z.object({
  sessionId: Uuid,
  anonId:    Uuid.optional(),
  answers:   z.record(z.string(), z.union([z.number(), z.string()])),
})

// ── Ownership helper ──────────────────────────────────────────────────────────
// Loads a session with the admin client and confirms the caller owns it:
//   - authenticated → session.user_id must equal auth.uid()
//   - pilot/anon    → session.anon_id must equal the provided anonId
// Returns the session row or null (unauthorized / missing / table absent).

async function authorizeSession(sessionId: string, anonId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const admin = createAdminClient()
  const { data: session, error } = await admin
    .from('ai_sessions')
    .select('id, user_id, anon_id, status, scenario_id')
    .eq('id', sessionId)
    .single()

  if (error || !session) return null

  if (session.user_id) {
    if (!user || user.id !== session.user_id) return null
  } else {
    if (!anonId || session.anon_id !== anonId) return null
  }
  return session
}

// ── Fetch scenario for a configured lesson ────────────────────────────────────
// Read-only, RLS-bound (published rows only), learner-facing columns only.
// Returns null on any error so the caller renders nothing.

export async function fetchVoiceScenario(lessonId: string): Promise<VoiceScenario | null> {
  if (!Uuid.safeParse(lessonId).success) return null

  try {
    // XPA-5A: reads the LEARNER-SAFE VIEW, not the base table.
    //
    // The base table is revoked from anon/authenticated in migration 034, so
    // this must not query it. More importantly the view is the structural
    // guarantee: it cannot return prompt_template, agent_id or
    // coach_prompt_overrides because it does not select them. The explicit
    // mapping below is now a second layer, not the only one.
    //
    // The view already filters to published rows; the eq() below is kept as a
    // belt-and-braces assertion of the same intent.
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('public_voice_scenarios')
      .select('*')
      .eq('lesson_id', lessonId)
      .order('order_index', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) {
      log.error({ lessonId, error: error.message }, 'fetchVoiceScenario query failed')
      return null
    }
    if (!data) return null

    // XPA-5A: the view exposes `voice_configured` — a boolean derived in the
    // database from provider + agent_id — so the agent id itself never has to
    // travel, not even inside this server process. The API-key check stays
    // here because the database cannot see it.
    const voiceAvailable = data.voice_configured === true && !!process.env.ELEVENLABS_API_KEY

    return {
      id:             data.id,
      slug:           data.slug,
      title:          data.title,
      personaName:    data.persona_name,
      situation:      data.situation,
      objectives:     Array.isArray(data.objectives) ? (data.objectives as string[]) : [],
      selfAssessment: Array.isArray(data.self_assessment)
        ? (data.self_assessment as SelfAssessmentQuestion[])
        : [],
      voiceAvailable,
      briefing:
        AI_COACH_ENABLED && data.briefing && typeof data.briefing === 'object'
          ? (data.briefing as VoiceBriefing)
          : null,
    }
  } catch (e) {
    log.error({ lessonId, error: (e as Error).message }, 'fetchVoiceScenario failed')
    return null
  }
}

// ── Create a practice session ─────────────────────────────────────────────────

export async function createAiSession(
  input: { scenarioId: string; anonId?: string }
): Promise<{ sessionId?: string; error?: string }> {
  const parsed = CreateSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { scenarioId, anonId } = parsed.data

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Identity: authenticated user OR pilot anon id (never both).
    if (!user && !anonId) return { error: 'Session non identifiée.' }

    // Throttle session creation per identity (fails open on infra errors).
    const rlKey = `ai_session:${user?.id ?? anonId}`
    const rl = await rateLimitDb(rlKey, { limit: 20, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }

    const admin = createAdminClient()

    // Scenario must exist and be published.
    const { data: scenario, error: scErr } = await admin
      .from('ai_scenarios')
      .select('id, is_published')
      .eq('id', scenarioId)
      .single()
    if (scErr || !scenario || !scenario.is_published) {
      return { error: 'Scénario indisponible.' }
    }

    const { data: session, error: insErr } = await admin
      .from('ai_sessions')
      .insert({
        scenario_id: scenarioId,
        user_id:     user ? user.id : null,
        anon_id:     user ? null : anonId,
        status:      'active',
      })
      .select('id')
      .single()

    if (insErr || !session) {
      log.error({ scenarioId, error: insErr?.message }, 'createAiSession insert failed')
      return { error: 'Impossible de démarrer la session.' }
    }
    return { sessionId: session.id }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'createAiSession failed')
    return { error: 'Service indisponible.' }
  }
}

// ── Start a live ElevenLabs voice session ─────────────────────────────────────
// Validates + rate-limits, exchanges the server-only ELEVENLABS_API_KEY for a
// short-lived signed WebSocket URL (client-safe), then creates the session row.
// The agent id and API key never reach the browser. `reason: 'not_configured'`
// lets the UI show a French setup notice instead of an error.

const SIGNED_URL_ENDPOINT =
  'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url'

export async function startVoiceSession(
  input: { scenarioId: string; anonId?: string }
): Promise<{
  sessionId?: string
  signedUrl?: string
  error?: string
  reason?: 'not_configured'
  /**
   * Diagnostic detail for the exact failing step (HTTP status, provider
   * response body, exception message). Never contains the API key. Logged
   * to the browser console by the client; rendered in the UI in dev only.
   */
  detail?: string
}> {
  const parsed = CreateSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.', detail: 'input validation failed' }
  const { scenarioId, anonId } = parsed.data

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user && !anonId) return { error: 'Session non identifiée.', detail: 'no user and no anonId' }

    // Throttle voice sessions per identity (voice is costly) — fails open.
    const rlKey = `ai_voice:${user?.id ?? anonId}`
    const rl = await rateLimitDb(rlKey, { limit: 10, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de sessions. Réessayez dans quelques minutes.', detail: 'rate limited' }

    const apiKey = process.env.ELEVENLABS_API_KEY
    log.info(
      { scenarioId, hasApiKey: !!apiKey, apiKeyLength: apiKey?.length ?? 0 },
      'startVoiceSession: begin'
    )
    if (!apiKey) {
      return {
        reason: 'not_configured',
        error:  'Pratique vocale indisponible.',
        detail: 'ELEVENLABS_API_KEY is not set in this environment',
      }
    }

    const admin = createAdminClient()
    const { data: scenario, error: scErr } = await admin
      .from('ai_scenarios')
      .select('id, lesson_id, is_published, provider, agent_id')
      .eq('id', scenarioId)
      .single()

    // ── XPA-6A: Voice Practice is course material ────────────────────────
    // Starting a session mints a signed ElevenLabs URL — the expensive,
    // protected action. Registration alone must not reach it. Resolved from
    // the SCENARIO, never from client input, so the caller cannot nominate a
    // course they happen to be enrolled in.
    //
    // This closes the pilot's anonymous voice path. The 11 existing pilot
    // sessions and 36 turns are untouched historical records.
    if (scenario?.lesson_id) {
      const courseId = await courseIdForLesson(admin, scenario.lesson_id as string)
      const access = courseId
        ? await resolveCourseAccessById(courseId)
        : { allowed: false, reason: 'course_not_found' as const }

      if (!access.allowed) {
        log.warn(
          { scenarioId, reason: access.reason },
          'startVoiceSession: refused — no course access',
        )
        return {
          error:  denialMessage(access.reason ?? 'not_entitled').body,
          detail: `course access denied: ${access.reason}`,
        }
      }
    }

    if (scErr || !scenario || !scenario.is_published) {
      log.error({ scenarioId, dbError: scErr?.message, found: !!scenario }, 'startVoiceSession: scenario unavailable')
      return {
        error:  'Scénario indisponible.',
        detail: `scenario lookup: ${scErr?.message ?? (scenario ? 'not published' : 'not found')}`,
      }
    }
    if (scenario.provider !== 'elevenlabs' || !scenario.agent_id) {
      return {
        reason: 'not_configured',
        error:  'Pratique vocale indisponible.',
        detail: `provider=${scenario.provider}, agent_id ${scenario.agent_id ? 'set' : 'missing'}`,
      }
    }
    log.info({ scenarioId, agentId: scenario.agent_id }, 'startVoiceSession: requesting signed URL')

    // Exchange the API key for a signed URL (server-only).
    let signedUrl: string
    try {
      const res = await fetch(
        `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(scenario.agent_id)}`,
        { headers: { 'xi-api-key': apiKey }, cache: 'no-store' }
      )
      // Read the body as text first so error bodies are always captured.
      const bodyText = await res.text()
      log.info(
        { scenarioId, status: res.status, ok: res.ok, bodyPreview: bodyText.slice(0, 500) },
        'startVoiceSession: ElevenLabs signed-url response'
      )
      if (!res.ok) {
        log.error(
          { scenarioId, agentId: scenario.agent_id, status: res.status, body: bodyText.slice(0, 1000) },
          'ElevenLabs signed-url request failed'
        )
        return {
          error:  'Connexion à la pratique vocale impossible.',
          detail: `ElevenLabs get-signed-url HTTP ${res.status} — ${bodyText.slice(0, 300)}`,
        }
      }
      let body: { signed_url?: string }
      try {
        body = JSON.parse(bodyText) as { signed_url?: string }
      } catch {
        log.error({ scenarioId, body: bodyText.slice(0, 500) }, 'ElevenLabs signed-url: non-JSON 200 response')
        return {
          error:  'Connexion à la pratique vocale impossible.',
          detail: `ElevenLabs returned 200 but non-JSON body — ${bodyText.slice(0, 200)}`,
        }
      }
      if (!body.signed_url) {
        log.error({ scenarioId, body: bodyText.slice(0, 500) }, 'ElevenLabs signed-url: missing signed_url field')
        return {
          error:  'Connexion à la pratique vocale impossible.',
          detail: `ElevenLabs 200 but no signed_url field — ${bodyText.slice(0, 200)}`,
        }
      }
      signedUrl = body.signed_url
      // Log destination without the query string (the token lives there).
      try {
        const u = new URL(signedUrl)
        log.info({ scenarioId, wsHost: u.host, wsPath: u.pathname }, 'startVoiceSession: signed URL obtained')
      } catch { /* diagnostic only */ }
    } catch (e) {
      const err = e as Error
      log.error(
        { scenarioId, error: err.message, stack: err.stack?.slice(0, 800) },
        'ElevenLabs signed-url fetch threw'
      )
      return {
        error:  'Connexion à la pratique vocale impossible.',
        detail: `fetch to ElevenLabs threw: ${err.message}`,
      }
    }

    // Signed URL obtained → create the session row.
    const { data: session, error: insErr } = await admin
      .from('ai_sessions')
      .insert({
        scenario_id: scenarioId,
        user_id:     user ? user.id : null,
        anon_id:     user ? null : anonId,
        status:      'active',
      })
      .select('id')
      .single()

    if (insErr || !session) {
      log.error({ scenarioId, error: insErr?.message }, 'startVoiceSession insert failed')
      return { error: 'Impossible de démarrer la session.', detail: `ai_sessions insert: ${insErr?.message}` }
    }
    log.info({ scenarioId, sessionId: session.id }, 'startVoiceSession: session created')
    return { sessionId: session.id, signedUrl }
  } catch (e) {
    const err = e as Error
    log.error({ error: err.message, stack: err.stack?.slice(0, 800) }, 'startVoiceSession failed')
    return { error: 'Service indisponible.', detail: `unhandled: ${err.message}` }
  }
}

// ── Save conversation turns (foundation for live voice / Phase 1b) ────────────

export async function saveAiTurns(
  input: { sessionId: string; anonId?: string; turns: z.infer<typeof TurnSchema>[] }
): Promise<{ ok?: true; error?: string }> {
  const parsed = SaveTurnsSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId, turns } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { error: 'Session introuvable.' }

    const admin = createAdminClient()
    const { error } = await admin.from('ai_turns').insert(
      turns.map(t => ({
        session_id: sessionId,
        speaker:    t.speaker,
        transcript: t.transcript,
        turn_index: t.turnIndex,
        latency_ms: t.latencyMs ?? null,
      }))
    )
    if (error) {
      log.error({ sessionId, error: error.message }, 'saveAiTurns insert failed')
      return { error: 'Enregistrement impossible.' }
    }
    return { ok: true }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'saveAiTurns failed')
    return { error: 'Service indisponible.' }
  }
}

// ── Complete (or abandon) a session ───────────────────────────────────────────

export async function completeAiSession(
  input: { sessionId: string; anonId?: string; status?: 'completed' | 'abandoned'; durationSeconds?: number }
): Promise<{ ok?: true; error?: string }> {
  const parsed = CompleteSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId, status, durationSeconds } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { error: 'Session introuvable.' }

    const admin = createAdminClient()
    const { error } = await admin
      .from('ai_sessions')
      .update({
        status,
        completed_at:     new Date().toISOString(),
        duration_seconds: durationSeconds ?? null,
      })
      .eq('id', sessionId)

    if (error) {
      log.error({ sessionId, error: error.message }, 'completeAiSession failed')
      return { error: 'Mise à jour impossible.' }
    }

    // Phase 2A: deterministic Competency Engine (no LLM). Gated on the coach
    // flag and never fatal — completion succeeds even if the engine or its
    // tables (migration 025) are unavailable.
    if (AI_COACH_ENABLED && status === 'completed') {
      try {
        await runEngineForSession(sessionId, session.scenario_id as string)
      } catch (e) {
        log.error({ sessionId, error: (e as Error).message }, 'competency engine run failed (non-fatal)')
      }
    }

    // XPA-5: a completed voice exercise now counts as lesson activity.
    // Non-fatal by design — the session is already recorded, and failing to
    // mark progress must never lose a learner's completed conversation.
    if (status === 'completed') {
      try {
        await markVoiceLessonComplete(sessionId, session.scenario_id as string)
      } catch (e) {
        log.error({ sessionId, error: (e as Error).message }, 'voice lesson progress failed (non-fatal)')
      }
    }

    return { ok: true }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'completeAiSession failed')
    return { error: 'Service indisponible.' }
  }
}

/**
 * Record lesson completion for a finished voice exercise (XPA-5).
 *
 * This is the productization step: before XPA-5 a completed conversation
 * updated `ai_sessions` and stopped, so Voice Practice was a demo rather than a
 * lesson activity. It now feeds the SAME progress engine every other activity
 * uses — `lesson_progress` — so module, course and certificate eligibility all
 * follow automatically. No parallel progress model is introduced.
 *
 * Server-authoritative and idempotent:
 *   * the lesson is resolved from the SCENARIO, never from client input, so a
 *     learner cannot complete an arbitrary lesson by forging a payload;
 *   * the write is an upsert on the existing UNIQUE(user_id, lesson_id)
 *     constraint, so replays and double-submits collapse to one row.
 *
 * Anonymous pilot sessions have no user_id and are skipped: `lesson_progress`
 * requires a profile, and pilot progress lives in localStorage.
 *
 * ── XPA-8 B-2.6: the write moved, the guarantees did not ──────────────────
 *
 * The audit's compliment to this function was also its indictment of the video
 * path: "that protection exists for voice and not for video". Fixing video by
 * building a SECOND server-authoritative writer would have left two writers
 * free to drift, so both now go through `recordLessonCompletion`, and voice
 * gains the one thing it was missing — an entitlement check. It never had one:
 * a learner with no entitlement who reached a scenario could complete its
 * lesson, exactly as they could through the player.
 *
 * `expectedCourseId` is `null` here on purpose. The player passes the course it
 * believes it is showing so the server can catch a disagreement; this path has
 * no independent claim to check — the lesson came from the scenario, which came
 * from the session, all server-side.
 *
 * The caller is safe to resolve from cookies inside `recordLessonCompletion`
 * because `authorizeSession` has already refused unless `user.id ===
 * session.user_id`; the session owner and the authenticated caller are the same
 * account by the time this runs.
 */
async function markVoiceLessonComplete(sessionId: string, scenarioId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: sess } = await admin
    .from('ai_sessions')
    .select('user_id')
    .eq('id', sessionId)
    .maybeSingle()

  const userId = sess?.user_id as string | null
  if (!userId) return // anonymous pilot session — nothing to attribute

  const { data: scenario } = await admin
    .from('ai_scenarios')
    .select('lesson_id')
    .eq('id', scenarioId)
    .maybeSingle()

  const lessonId = scenario?.lesson_id as string | null
  if (!lessonId) return

  const result = await recordLessonCompletion(lessonId, null)

  if (!result.ok) {
    // Non-fatal, exactly as the upsert failure was: the conversation is already
    // recorded on `ai_sessions`, and a refused completion must not lose it.
    log.warn({ sessionId, lessonId, reason: result.reason }, 'voice lesson completion refused')
    return
  }

  log.info({ sessionId, lessonId, userId, already: result.already }, 'voice exercise completed lesson')
}

// ── Deterministic Competency Engine hook (Phase 2A — no LLM) ──────────────────
// Loads the transcript + admin-configured lexicons, runs the pure engine, and
// stores the full result on the session (engine_signals) plus one ai_scores
// row per competency (source='engine'). Called only from completeAiSession.

async function runEngineForSession(sessionId: string, scenarioId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: turns } = await admin
    .from('ai_turns')
    .select('speaker, transcript, turn_index')
    .eq('session_id', sessionId)
    .order('turn_index')
  if (!turns || turns.length === 0) return // self-assessment-only sessions have no transcript

  const { data: comps } = await admin
    .from('ai_competencies')
    .select('key, label_fr, signals')
    .eq('is_active', true)
    .order('order_index')
  if (!comps || comps.length === 0) return

  const { data: rubric } = await admin
    .from('ai_rubrics')
    .select('competency_key, weight')
    .eq('scenario_id', scenarioId)

  const rubricKeys = new Set((rubric ?? []).map(r => r.competency_key as string))
  const weights = Object.fromEntries(
    (rubric ?? []).map(r => [r.competency_key as string, Number(r.weight)])
  )

  const configs: CompetencyConfig[] = comps
    .filter(c => rubricKeys.size === 0 || rubricKeys.has(c.key as string))
    .map(c => ({
      key:     c.key as string,
      labelFr: c.label_fr as string,
      signals: (c.signals ?? {}) as CompetencyConfig['signals'],
    }))
  if (configs.length === 0) return

  const result = runCompetencyEngine(
    turns.map(t => ({
      turnIndex:  t.turn_index as number,
      speaker:    t.speaker as 'learner' | 'agent',
      transcript: t.transcript as string,
    })),
    configs,
    weights,
  )

  // Full result on the session: one jsonb read powers replay + summary.
  const { error: upErr } = await admin
    .from('ai_sessions')
    .update({ engine_signals: result })
    .eq('id', sessionId)
  if (upErr) log.error({ sessionId, error: upErr.message }, 'engine_signals update failed')

  const { error: scErr } = await admin.from('ai_scores').upsert(
    result.scores.map(s => ({
      session_id:          sessionId,
      competency_key:      s.key,
      score:               s.score,
      source:              'engine',
      evidence_fr:         s.evidenceFr,
      evidence_turn_index: s.evidenceTurnIndex,
    })),
    { onConflict: 'session_id,competency_key,source' }
  )
  if (scErr) log.error({ sessionId, error: scErr.message }, 'ai_scores upsert failed')

  log.info(
    { sessionId, scores: result.scores.length, hints: result.hints.length, overall: result.overallScore },
    'competency engine stored'
  )
}

// ── Save the deterministic self-assessment (Phase 1a) ─────────────────────────

export async function saveSelfAssessment(
  input: { sessionId: string; anonId?: string; answers: Record<string, number | string> }
): Promise<{ ok?: true; error?: string }> {
  const parsed = SelfAssessmentSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId, answers } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { error: 'Session introuvable.' }

    const admin = createAdminClient()
    // One self-assessment per session (unique index (session_id, source)).
    const { error } = await admin
      .from('ai_feedback')
      .upsert(
        { session_id: sessionId, source: 'self', answers },
        { onConflict: 'session_id,source' }
      )

    if (error) {
      log.error({ sessionId, error: error.message }, 'saveSelfAssessment failed')
      return { error: 'Enregistrement impossible.' }
    }
    return { ok: true }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'saveSelfAssessment failed')
    return { error: 'Service indisponible.' }
  }
}

// ── Read coaching data for the debrief (Phase 2A — pure DB read, no LLM) ──────

export interface CoachingScoreView {
  key:               string
  labelFr:           string
  score:             number
  evidenceFr:        string | null
  evidenceTurnIndex: number | null
}

export interface CoachingData {
  turns:        { turnIndex: number; speaker: 'learner' | 'agent'; transcript: string }[]
  overallScore: number
  scores:       CoachingScoreView[]
  hints:        EngineHint[]
  /** Competencies scoring ≥ 7 (top 3) — deterministic strengths. */
  strengths:    CoachingScoreView[]
  /** Competencies scoring ≤ 5 (bottom 3) — deterministic areas to improve. */
  improvements: CoachingScoreView[]
}

const GetCoachingSchema = z.object({
  sessionId: Uuid,
  anonId:    Uuid.optional(),
})

/**
 * Returns the stored transcript + deterministic engine output for a session
 * the caller owns. Null when the coach flag is off, the session is not owned,
 * or the engine has no stored result (e.g. migration 025 not applied) — the
 * UI then skips the coach debrief and goes straight to the self-assessment.
 */
export async function getSessionCoaching(
  input: { sessionId: string; anonId?: string }
): Promise<CoachingData | null> {
  if (!AI_COACH_ENABLED) return null
  const parsed = GetCoachingSchema.safeParse(input)
  if (!parsed.success) return null
  const { sessionId, anonId } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return null

    const admin = createAdminClient()
    const [{ data: sessionRow }, { data: turns }] = await Promise.all([
      admin.from('ai_sessions').select('engine_signals').eq('id', sessionId).single(),
      admin.from('ai_turns')
        .select('speaker, transcript, turn_index')
        .eq('session_id', sessionId)
        .order('turn_index'),
    ])

    const engine = sessionRow?.engine_signals as EngineResult | null | undefined
    if (!engine || !Array.isArray(engine.scores) || !turns || turns.length === 0) return null

    const scores: CoachingScoreView[] = engine.scores.map(s => ({
      key:               s.key,
      labelFr:           s.labelFr,
      score:             s.score,
      evidenceFr:        s.evidenceFr,
      evidenceTurnIndex: s.evidenceTurnIndex,
    }))

    const strengths = scores.filter(s => s.score >= 7).sort((a, b) => b.score - a.score).slice(0, 3)
    const improvements = scores.filter(s => s.score <= 5).sort((a, b) => a.score - b.score).slice(0, 3)

    return {
      turns: turns.map(t => ({
        turnIndex:  t.turn_index as number,
        speaker:    t.speaker as 'learner' | 'agent',
        transcript: t.transcript as string,
      })),
      overallScore: engine.overallScore ?? 0,
      scores,
      hints: Array.isArray(engine.hints) ? engine.hints : [],
      strengths,
      improvements,
    }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'getSessionCoaching failed')
    return null
  }
}
