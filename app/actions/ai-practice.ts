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

const log = createLogger('actions/ai-practice')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelfAssessmentQuestion {
  id:        string
  type:      'scale' | 'text'
  question:  string
  guidance?: string
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
    .select('id, user_id, anon_id, status')
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
    const supabase = await createClient()
    // agent_id and provider are read only to derive `voiceAvailable`; they are
    // never returned to the browser.
    const { data, error } = await supabase
      .from('ai_scenarios')
      .select('id, slug, title, persona_name, situation, objectives, self_assessment, agent_id, provider')
      .eq('lesson_id', lessonId)
      .eq('is_published', true)
      .limit(1)
      .maybeSingle()

    if (error) {
      log.error({ lessonId, error: error.message }, 'fetchVoiceScenario query failed')
      return null
    }
    if (!data) return null

    const voiceAvailable =
      data.provider === 'elevenlabs' &&
      typeof data.agent_id === 'string' &&
      data.agent_id.trim() !== '' &&
      !!process.env.ELEVENLABS_API_KEY

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
      .select('id, is_published, provider, agent_id')
      .eq('id', scenarioId)
      .single()
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
    return { ok: true }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'completeAiSession failed')
    return { error: 'Service indisponible.' }
  }
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
