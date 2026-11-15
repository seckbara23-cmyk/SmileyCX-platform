import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { isEntitlementAccessible, type EntitlementLike } from '@/lib/entitlements'
import { VOICE_CONSENT_VERSION } from './consent-version'

/**
 * XP-F2-01/02 — what must hold before a learner's voice session may start.
 *
 * One policy for the five personas, checked by the server on every start, in
 * this order, and failing CLOSED whenever the database cannot answer:
 *   1. consent: the learner accepted the current version of the voice-processing
 *      consent and has not withdrawn it (privacy policy art. 6);
 *   2. hygiene: their sessions left « active » for longer than the time-out are
 *      closed as abandoned (a closed tab or a crash leaves them open);
 *   3. concurrency: at most one live voice session per learner;
 *   4. attempts: a bounded number of started voice attempts per lesson within the
 *      learner's current access period (decision D9: five, expiring with access).
 *      They are counted in `voice_attempts`, a ledger that a voluntary erasure of
 *      voice data does not touch (decision D3). The final count and the session
 *      are written together by `voice_start_attempt` (migration 066), under a
 *      per-learner lock: the check here is the early answer, the function is the
 *      authority.
 *
 * Access period: it starts at the latest accessible entitlement's start. A
 * renewal is a new entitlement, so a new period with five new attempts; an
 * expired access has no period, and nothing starts.
 *
 * Requires migration 066 (consents table, `ai_sessions.mode`). Nothing here runs
 * while voice practice is closed (`lib/voice/access.ts`).
 */

type Db = ReturnType<typeof createAdminClient>

// Defined in a client-safe module: the public opening switch compares the legal texts' version with it.
export { VOICE_CONSENT_VERSION }
export const ACTIVE_SESSION_TIMEOUT_MS = 15 * 60 * 1000

export const VOICE_CONSENT_TEXT_FR =
  'J’accepte que ma voix et le texte de mes échanges soient traités par ElevenLabs pour simuler le client et me donner un retour, ' +
  'et, selon l’exercice, par Anthropic pour analyser mon entraînement. J’accepte que la plateforme conserve la transcription et l’analyse ' +
  'de mes entraînements. Je peux retirer cet accord et demander la suppression de ces données à tout moment.'

/**
 * XP-F2-READY-01 — the NEXT consent version, PREPARED, NOT ACTIVE. It states
 * decisions D1 (30 days), D2 (withdrawal erases) and D3 (attempts stay counted).
 * Activating it means setting VOICE_CONSENT_VERSION (lib/voice/consent-version.ts)
 * and VOICE_CONSENT_TEXT_FR to these values, in the same reviewed change that publishes the new legal
 * pages (docs/voice/F2-04-TEXTES-JURIDIQUES-PROPOSES.md). Every learner then
 * accepts again before their next voice session, because consent is per version.
 */
export const VOICE_CONSENT_NEXT = {
  version: 'voix-1.1',
  textFr:
    'J’accepte que ma voix et le texte de mes échanges soient traités par ElevenLabs pour simuler le client et me donner un retour, ' +
    'et, selon l’exercice, par Anthropic pour analyser mon entraînement. Mes transcriptions et mes retours sont conservés 30 jours. ' +
    'Je peux retirer cet accord à tout moment depuis « Mes données vocales » : le traitement s’arrête et mes entraînements vocaux sont supprimés. ' +
    'Le nombre d’essais déjà utilisés reste décompté.',
} as const

export type StartRefusal = 'consent_required' | 'session_in_progress' | 'attempts_exhausted' | 'no_access_period' | 'unavailable'

export const START_REFUSAL_FR: Record<StartRefusal, string> = {
  consent_required:    'Pour utiliser l’entraînement vocal, acceptez d’abord le traitement de votre voix.',
  session_in_progress: 'Un entraînement vocal est déjà en cours. Terminez-le avant d’en commencer un autre.',
  attempts_exhausted:  'Vous avez utilisé tous les essais prévus pour cette leçon pendant votre période d’accès.',
  // XP-VOICE-FIX-01: the attempts belong to an access period, and only an active
  // inscription to the course opens one. An administrator reaches the lesson
  // without an inscription, and used to be told « momentanément indisponible ».
  no_access_period:    'L’entraînement vocal est lié à une inscription active à ce cours. Contactez l’équipe XP CLIENT si vous pensez qu’il s’agit d’une erreur.',
  unavailable:         'L’entraînement vocal est momentanément indisponible.',
}

export type StartCheck =
  | { ok: true; attemptsUsed: number; attemptsRemaining: number; since: string }
  | { ok: false; refusal: StartRefusal }

export async function hasVoiceConsent(db: Db, userId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from('voice_processing_consents')
    .select('consent_version, withdrawn_at')
    .eq('user_id', userId)
    .eq('consent_version', VOICE_CONSENT_VERSION)
    .maybeSingle()
  if (error) return null
  return !!data && !data.withdrawn_at
}

/**
 * Closes this learner's VOICE sessions still « active » after the time-out.
 * Self-assessment sessions are never touched (XP-F2-03): a long self-assessment
 * must still complete its lesson. Returns false if the write failed.
 */
export async function closeStaleSessions(db: Db, userId: string, now: Date): Promise<boolean> {
  const { error } = await db
    .from('ai_sessions')
    .update({ status: 'abandoned', completed_at: now.toISOString() })
    .eq('user_id', userId)
    .eq('mode', 'voice')
    .eq('status', 'active')
    .lt('started_at', new Date(now.getTime() - ACTIVE_SESSION_TIMEOUT_MS).toISOString())
  return !error
}

/** Live VOICE sessions of this learner (migration 066's index enforces at most one). */
export async function countLiveSessions(db: Db, userId: string): Promise<number | null> {
  const { count, error } = await db
    .from('ai_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('mode', 'voice')
    .eq('status', 'active')
  return error ? null : (count ?? 0)
}

/**
 * Start of the learner's current access to the course: the latest accessible
 * entitlement's start. `'none'` when no entitlement is accessible (an
 * administrator reaches every course without one); null when the database
 * cannot answer.
 */
export async function accessPeriodStart(db: Db, userId: string, courseId: string, now: Date): Promise<string | 'none' | null> {
  const { data, error } = await db
    .from('entitlements')
    .select('status, starts_at, expires_at, revoked_at, created_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
  if (error || !data) return null
  const open = (data as (EntitlementLike & { created_at: string })[]).filter(e => isEntitlementAccessible(e, now))
  if (open.length === 0) return 'none'
  return open.map(e => e.starts_at ?? e.created_at).sort().pop() ?? 'none'
}

/** Attempts recorded in the ledger for this lesson's scenario since the period started. */
export async function countVoiceAttempts(db: Db, userId: string, scenarioId: string, since: string): Promise<number | null> {
  const { count, error } = await db
    .from('voice_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('scenario_id', scenarioId)
    .gte('started_at', since)
  return error ? null : (count ?? 0)
}

export type AttemptStart =
  | { ok: true; sessionId: string; attemptsUsed: number }
  | { ok: false; refusal: 'attempts_exhausted' | 'session_in_progress' | 'unavailable' }

/**
 * Starts the voice session and records the attempt in one database transaction
 * (migration 066, `voice_start_attempt`). Concurrent starts by one learner are
 * serialised there; the limit cannot be exceeded and no attempt is recorded
 * without its session, nor a session without its attempt.
 */
export async function startVoiceAttempt(
  db: Db,
  input: { userId: string; scenarioId: string; since: string; limit: number },
): Promise<AttemptStart> {
  const { data, error } = await db.rpc('voice_start_attempt', {
    p_user_id: input.userId,
    p_scenario_id: input.scenarioId,
    p_since: input.since,
    p_limit: input.limit,
  })
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; session_id?: string | null; attempts_used?: number } | null
  if (error || !row) return { ok: false, refusal: 'unavailable' }
  if (row.outcome === 'started' && row.session_id) return { ok: true, sessionId: row.session_id, attemptsUsed: Number(row.attempts_used) }
  if (row.outcome === 'attempts_exhausted' || row.outcome === 'session_in_progress') return { ok: false, refusal: row.outcome }
  return { ok: false, refusal: 'unavailable' }
}

export async function checkVoiceStart(
  db: Db,
  input: { userId: string; scenarioId: string; courseId: string; attemptsPerLesson: number; now?: Date },
): Promise<StartCheck> {
  const now = input.now ?? new Date()

  const consent = await hasVoiceConsent(db, input.userId)
  if (consent === null) return { ok: false, refusal: 'unavailable' }
  if (!consent) return { ok: false, refusal: 'consent_required' }

  if (!(await closeStaleSessions(db, input.userId, now))) return { ok: false, refusal: 'unavailable' }
  const live = await countLiveSessions(db, input.userId)
  if (live === null) return { ok: false, refusal: 'unavailable' }
  if (live > 0) return { ok: false, refusal: 'session_in_progress' }

  const attempts = await voiceAttemptStatus(db, { ...input, now })
  if (!attempts) return { ok: false, refusal: 'unavailable' }
  if (attempts.state !== 'available') return { ok: false, refusal: attempts.state }

  return { ok: true, attemptsUsed: attempts.used, attemptsRemaining: attempts.remaining, since: attempts.since }
}

export type AttemptStatus =
  | { state: 'available'; used: number; remaining: number; limit: number; since: string }
  | { state: 'attempts_exhausted'; used: number; remaining: 0; limit: number; since: string }
  | { state: 'no_access_period'; used: 0; remaining: 0; limit: number }

/**
 * XP-VOICE-FIX-01 — where the learner stands for this lesson, read-only, so the
 * page can say it BEFORE the learner starts (and is asked for the microphone).
 * When an attempt is consumed: when the server has the signed URL and records
 * the session with its attempt (`voice_start_attempt`), before the browser
 * connects. A refusal, a denied microphone or a provider error before that
 * point consumes nothing. Null when the database cannot answer.
 */
export async function voiceAttemptStatus(
  db: Db,
  input: { userId: string; scenarioId: string; courseId: string; attemptsPerLesson: number; now?: Date },
): Promise<AttemptStatus | null> {
  const limit = input.attemptsPerLesson
  const since = await accessPeriodStart(db, input.userId, input.courseId, input.now ?? new Date())
  if (since === null) return null
  if (since === 'none') return { state: 'no_access_period', used: 0, remaining: 0, limit }
  const used = await countVoiceAttempts(db, input.userId, input.scenarioId, since)
  if (used === null) return null
  if (used >= limit) return { state: 'attempts_exhausted', used, remaining: 0, limit, since }
  return { state: 'available', used, remaining: limit - used, limit, since }
}
