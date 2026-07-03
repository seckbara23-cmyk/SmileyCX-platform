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
    const { data, error } = await supabase
      .from('ai_scenarios')
      .select('id, slug, title, persona_name, situation, objectives, self_assessment')
      .eq('lesson_id', lessonId)
      .eq('is_published', true)
      .limit(1)
      .maybeSingle()

    if (error || !data) return null

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
