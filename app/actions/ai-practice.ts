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
import { withinInputBounds } from '@/lib/validation/input-bounds'
import { createLogger } from '@/lib/logger'
import { AI_COACH_ENABLED, VOICE_PRACTICE_OPEN, VOICE_CLOSED_MESSAGE } from '@/lib/ai/flags'
import { personaBySlug, publicPersona, type PublicVoicePersona } from '@/lib/voice/personas'
import { checkVoiceStart, closeStaleSessions, countLiveSessions, START_REFUSAL_FR } from '@/lib/voice/session-policy'
import { requestSignedUrl, fetchConversationAnalysis, ConversationId } from '@/lib/voice/elevenlabs'
import { buildVoiceFeedback, type VoiceFeedback } from '@/lib/voice/feedback'
import { resolveCourseAccessById, denialMessage } from '@/lib/auth/course-access'
import { recordLessonCompletion } from '@/lib/learn/completion'
import {
  runCompetencyEngine,
  type CompetencyConfig,
  type EngineResult,
  type EngineHint,
} from '@/lib/ai/competency-engine'

const log = createLogger('actions/ai-practice')

/** Diagnostic detail for the browser console in development only: never a provider body, key or token. */
const devDetail = (d: string): string | undefined => (process.env.NODE_ENV === 'production' ? undefined : d)

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
  /**
   * XP-F2-01: the reviewed persona configuration this scenario runs, as the
   * learner may see it (objective, criteria labels, attempts). Null when the
   * scenario has no persona in lib/voice/personas.ts: such a scenario never
   * starts a voice session.
   */
  persona: PublicVoicePersona | null
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
  /** XP-F2-01: the provider's conversation id, kept to fetch the post-call analysis. */
  providerConversationId: ConversationId.optional(),
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

/**
 * What each of these can legitimately receive, checked before Zod. See input-bounds.
 * A batch is at most 100 turns of 4 fields, each with a transcript of at most 8 000
 * characters. A self-assessment is a short form, with free text in a few of its answers.
 */
const SAVE_TURNS_BOUNDS = { maxNodes: 600, maxDepth: 3, maxChars: 810_000 }
const SELF_ASSESSMENT_BOUNDS = { maxNodes: 300, maxDepth: 2, maxChars: 100_000 }

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
  // XP-F2-01: nothing to show while voice practice is closed, even on a direct call.
  if (!VOICE_PRACTICE_OPEN) return null
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

    // XP-F2-01: the exercise is course material — no access, no scenario.
    const courseId = await courseIdForLesson(createAdminClient(), lessonId)
    const access = courseId ? await resolveCourseAccessById(courseId) : { allowed: false }
    if (!access.allowed) return null
    const persona = personaBySlug(data.slug as string)

    // XPA-5A: the view exposes `voice_configured` — a boolean derived in the
    // database from provider + agent_id — so the agent id itself never has to
    // travel, not even inside this server process. The API-key check stays
    // here because the database cannot see it.
    const voiceAvailable = data.voice_configured === true && !!process.env.ELEVENLABS_API_KEY && !!persona

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
      persona: persona ? publicPersona(persona) : null,
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
  // XP-LAUNCH-FINAL-18: no voice session while voice practice is closed.
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE }
  const parsed = CreateSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { scenarioId } = parsed.data

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // XP-F2-01: a session belongs to a signed-in learner; the pilot's anonymous path is closed.
    if (!user) return { error: 'Session non identifiée.' }

    // Throttle session creation per learner (fails open on infra errors).
    const rl = await rateLimitDb(`ai_session:${user.id}`, { limit: 20, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }

    const admin = createAdminClient()

    // Scenario must exist and be published.
    const { data: scenario, error: scErr } = await admin
      .from('ai_scenarios')
      .select('id, lesson_id, is_published')
      .eq('id', scenarioId)
      .single()
    if (scErr || !scenario || !scenario.is_published) {
      return { error: 'Scénario indisponible.' }
    }

    // XP-F2-01: the self-assessment is course material too.
    const courseId = scenario.lesson_id ? await courseIdForLesson(admin, scenario.lesson_id as string) : null
    const access = courseId ? await resolveCourseAccessById(courseId) : { allowed: false, reason: 'course_not_found' as const }
    if (!access.allowed) return { error: denialMessage(access.reason ?? 'not_entitled').body }

    // One live session per learner: close the ones a closed tab left open, then check.
    if (!(await closeStaleSessions(admin, user.id, new Date()))) return { error: START_REFUSAL_FR.unavailable }
    const live = await countLiveSessions(admin, user.id)
    if (live === null) return { error: START_REFUSAL_FR.unavailable }
    if (live > 0) return { error: START_REFUSAL_FR.session_in_progress }

    const { data: session, error: insErr } = await admin
      .from('ai_sessions')
      .insert({
        scenario_id: scenarioId,
        user_id:     user.id,
        anon_id:     null,
        status:      'active',
        mode:        'self',
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

export async function startVoiceSession(
  input: { scenarioId: string; anonId?: string }
): Promise<{
  sessionId?: string
  signedUrl?: string
  /** Voice attempts left for this lesson in the current access period, after this one. */
  attemptsRemaining?: number
  error?: string
  reason?: 'not_configured' | 'consent_required' | 'session_in_progress' | 'attempts_exhausted'
  /** Development only (see devDetail): never a provider body, key or token. */
  detail?: string
}> {
  // XP-LAUNCH-FINAL-18: no voice session while voice practice is closed.
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE, detail: 'voice practice closed' }
  const parsed = CreateSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.', detail: devDetail('input validation failed') }
  const { scenarioId } = parsed.data

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    // XP-F2-01: a voice session belongs to a signed-in learner; the pilot's anonymous path is closed.
    if (!user) return { error: 'Session non identifiée.', detail: devDetail('no user') }

    // Throttle voice sessions per learner (voice is costly) — fails open; the policy below does not.
    const rl = await rateLimitDb(`ai_voice:${user.id}`, { limit: 10, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de sessions. Réessayez dans quelques minutes.', detail: devDetail('rate limited') }

    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      return { reason: 'not_configured', error: 'Pratique vocale indisponible.', detail: devDetail('ELEVENLABS_API_KEY is not set') }
    }

    const admin = createAdminClient()
    const { data: scenario, error: scErr } = await admin
      .from('ai_scenarios')
      .select('id, slug, lesson_id, is_published, provider, agent_id')
      .eq('id', scenarioId)
      .single()
    if (scErr || !scenario || !scenario.is_published) {
      return { error: 'Scénario indisponible.', detail: devDetail('scenario not found or not published') }
    }

    // ── XPA-6A: Voice Practice is course material ────────────────────────
    // Resolved from the SCENARIO, never from client input, so the caller cannot
    // nominate a course they happen to be enrolled in.
    const courseId = scenario.lesson_id ? await courseIdForLesson(admin, scenario.lesson_id as string) : null
    const access = courseId
      ? await resolveCourseAccessById(courseId)
      : { allowed: false, reason: 'course_not_found' as const }
    if (!courseId || !access.allowed) {
      log.warn({ scenarioId, reason: access.reason }, 'startVoiceSession: refused — no course access')
      return { error: denialMessage(access.reason ?? 'not_entitled').body, detail: devDetail(`course access denied: ${access.reason}`) }
    }

    // XP-F2-01: only a reviewed persona runs (lib/voice/personas.ts).
    const persona = personaBySlug(scenario.slug as string)
    if (!persona || scenario.provider !== 'elevenlabs' || !scenario.agent_id) {
      return { reason: 'not_configured', error: 'Pratique vocale indisponible.', detail: devDetail('persona or agent not configured') }
    }

    // XP-F2-01: consent, stale sessions, one live session, attempts per lesson.
    const check = await checkVoiceStart(admin, {
      userId: user.id, scenarioId, courseId, attemptsPerLesson: persona.attemptsPerLesson,
    })
    if (!check.ok) {
      return {
        error: START_REFUSAL_FR[check.refusal],
        ...(check.refusal === 'unavailable' ? {} : { reason: check.refusal }),
        detail: devDetail(`start refused: ${check.refusal}`),
      }
    }

    // The signed URL is the agent's own configuration: no prompt override is
    // requested, so the browser cannot rewrite the persona.
    const signed = await requestSignedUrl(scenario.agent_id as string, apiKey)
    if (!signed.ok) {
      // Status only: a provider body can carry a token.
      log.error({ scenarioId, status: signed.status }, 'startVoiceSession: signed URL refused')
      return { error: 'Connexion à la pratique vocale impossible.', detail: devDetail(`signed url: ${signed.status}`) }
    }

    const { data: session, error: insErr } = await admin
      .from('ai_sessions')
      .insert({ scenario_id: scenarioId, user_id: user.id, anon_id: null, status: 'active', mode: 'voice' })
      .select('id')
      .single()
    if (insErr || !session) {
      // Migration 066's one-live-session index refuses a concurrent second start.
      log.error({ scenarioId, error: insErr?.message }, 'startVoiceSession insert failed')
      return { error: 'Impossible de démarrer la session.', detail: devDetail('ai_sessions insert failed') }
    }
    log.info({ scenarioId, sessionId: session.id, persona: persona.id }, 'startVoiceSession: session created')
    return { sessionId: session.id, signedUrl: signed.signedUrl, attemptsRemaining: check.attemptsRemaining - 1 }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'startVoiceSession failed')
    return { error: 'Service indisponible.', detail: devDetail('unhandled') }
  }
}

// ── Save conversation turns (foundation for live voice / Phase 1b) ────────────

export async function saveAiTurns(
  input: { sessionId: string; anonId?: string; turns: z.infer<typeof TurnSchema>[] }
): Promise<{ ok?: true; error?: string }> {
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE }
  if (!withinInputBounds(input, SAVE_TURNS_BOUNDS)) return { error: 'Données invalides.' }
  const parsed = SaveTurnsSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId, turns } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { error: 'Session introuvable.' }
    // XP-F2-01: turns belong to a live session only.
    if (session.status !== 'active') return { error: 'Session terminée.' }

    const rl = await rateLimitDb(`ai_turns:${sessionId}`, { limit: 200, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de messages. Réessayez dans un instant.' }

    const admin = createAdminClient()
    // A replayed batch must not duplicate turns: keep the indexes not stored yet, once each.
    const indexes = turns.map(t => t.turnIndex)
    const { data: stored } = await admin
      .from('ai_turns')
      .select('turn_index')
      .eq('session_id', sessionId)
      .in('turn_index', indexes)
    const seen = new Set(((stored ?? []) as { turn_index: number }[]).map(r => r.turn_index))
    const fresh = turns.filter((t, i) => !seen.has(t.turnIndex) && indexes.indexOf(t.turnIndex) === i)
    if (fresh.length === 0) return { ok: true }

    const { error } = await admin.from('ai_turns').insert(
      fresh.map(t => ({
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
  input: { sessionId: string; anonId?: string; status?: 'completed' | 'abandoned'; durationSeconds?: number; providerConversationId?: string }
): Promise<{ ok?: true; error?: string }> {
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE }
  const parsed = CompleteSessionSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId, status, durationSeconds, providerConversationId } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { error: 'Session introuvable.' }

    const admin = createAdminClient()

    // ── VOICE-A1 F-2: the SERVER is the idempotency boundary ───────────────
    //
    // The client used to be the only guard (`finalizedRef`), which holds for
    // exactly one component instance. Every export of a `'use server'` module
    // is a callable HTTP endpoint, so a replay — a double click, a retried
    // request, a second tab — reached this update unguarded and rewrote
    // `completed_at`, could flip `completed` into `abandoned`, and re-fired
    // both the competency engine and the lesson-progress write.
    //
    // The transition is therefore filtered on `status = 'active'` and executed
    // as ONE statement, so Postgres decides the winner rather than a
    // read-then-write in application code. Two concurrent finalisations cannot
    // both succeed: the loser matches zero rows.
    //
    // A cheap pre-check first, so the common replay costs no write at all.
    // It is an optimisation, NOT the guarantee — the guarantee is the
    // `.eq('status', 'active')` filter below.
    if (session.status !== 'active') {
      log.info(
        { sessionId, currentStatus: session.status, requested: status },
        'completeAiSession: already terminal — no-op',
      )
      return { ok: true }
    }

    const { data: transitioned, error } = await admin
      .from('ai_sessions')
      .update({
        status,
        completed_at:     new Date().toISOString(),
        duration_seconds: durationSeconds ?? null,
        ...(providerConversationId ? { provider_conversation_id: providerConversationId } : {}),
      })
      .eq('id', sessionId)
      .eq('status', 'active')
      .select('id')

    if (error) {
      log.error({ sessionId, error: error.message }, 'completeAiSession failed')
      return { error: 'Mise à jour impossible.' }
    }

    // Zero rows means the row was already terminal when the statement ran —
    // another caller won the race between the pre-check and here. Success, but
    // WE did not perform the transition, so nothing downstream may run: the
    // engine and the lesson-progress write belong to the caller that actually
    // moved the row out of `active`.
    //
    // A 2xx is not evidence. The row effect is.
    if (!transitioned || transitioned.length === 0) {
      log.info({ sessionId, requested: status }, 'completeAiSession: lost the finalisation race — no-op')
      return { ok: true }
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
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE }
  if (!withinInputBounds(input, SELF_ASSESSMENT_BOUNDS)) return { error: 'Données invalides.' }
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
  if (!VOICE_PRACTICE_OPEN || !AI_COACH_ENABLED) return null
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


// ── XP-F2-01: qualitative feedback from the agent's post-call analysis ────────

const VoiceFeedbackSchema = z.object({ sessionId: Uuid })

/**
 * The learner's feedback for one finished voice session: per observation
 * criterion, réussi / à retravailler / pas assez d'éléments, with a rationale
 * that never invents their words, and no score. Only the learner who held the
 * session can read it. `pending` while the provider is still analysing.
 */
export async function getVoiceFeedback(
  input: { sessionId: string }
): Promise<{ feedback?: VoiceFeedback; pending?: true; error?: string }> {
  if (!VOICE_PRACTICE_OPEN) return { error: VOICE_CLOSED_MESSAGE }
  const parsed = VoiceFeedbackSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId } = parsed.data

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Session introuvable.' }

    const rl = await rateLimitDb(`ai_feedback:${user.id}`, { limit: 30, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de demandes. Réessayez dans quelques minutes.' }

    const admin = createAdminClient()
    const { data: session } = await admin
      .from('ai_sessions')
      .select('id, user_id, status, mode, scenario_id, provider_conversation_id')
      .eq('id', sessionId)
      .maybeSingle()
    // Ownership: the learner who held the session, and no one else.
    if (!session || session.user_id !== user.id) return { error: 'Session introuvable.' }
    if (session.status === 'active') return { pending: true }
    if (session.mode !== 'voice' || !session.provider_conversation_id) {
      return { error: 'Aucun retour n’est disponible pour cette session.' }
    }

    const { data: scenario } = await admin
      .from('ai_scenarios')
      .select('slug, agent_id')
      .eq('id', session.scenario_id)
      .maybeSingle()
    const persona = personaBySlug(scenario?.slug as string | undefined)
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!persona || !scenario?.agent_id || !apiKey) return { error: 'Retour indisponible.' }

    const analysis = await fetchConversationAnalysis(
      session.provider_conversation_id as string, scenario.agent_id as string, apiKey,
    )
    if (!analysis.ok) {
      log.warn({ sessionId, reason: analysis.reason }, 'getVoiceFeedback: analysis unavailable')
      return { error: 'Le retour n’est pas disponible pour le moment.' }
    }
    if (!analysis.ready) return { pending: true }

    const { data: turns } = await admin
      .from('ai_turns')
      .select('transcript')
      .eq('session_id', sessionId)
      .eq('speaker', 'learner')
      .order('turn_index', { ascending: true })
    const learnerTurns = ((turns ?? []) as { transcript: string }[]).map(t => t.transcript)

    return { feedback: buildVoiceFeedback(persona, analysis.evaluations, learnerTurns) }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'getVoiceFeedback failed')
    return { error: 'Service indisponible.' }
  }
}
