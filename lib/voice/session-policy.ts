import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { isEntitlementAccessible, type EntitlementLike } from '@/lib/entitlements'

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
 *   4. attempts: a bounded number of started voice sessions per lesson within the
 *      learner's current access period (decision D9: five, expiring with access).
 *
 * Requires migration 066 (consents table, `ai_sessions.mode`). Voice practice is
 * closed in code (`VOICE_PRACTICE_OPEN`), so nothing here runs in production.
 */

type Db = ReturnType<typeof createAdminClient>

export const VOICE_CONSENT_VERSION = 'voix-1.0'
export const ACTIVE_SESSION_TIMEOUT_MS = 15 * 60 * 1000

export const VOICE_CONSENT_TEXT_FR =
  'J’accepte que ma voix et le texte de mes échanges soient traités par ElevenLabs pour simuler le client et me donner un retour, ' +
  'et, selon l’exercice, par Anthropic pour analyser mon entraînement. J’accepte que la plateforme conserve la transcription et l’analyse ' +
  'de mes entraînements. Je peux retirer cet accord et demander la suppression de ces données à tout moment.'

export type StartRefusal = 'consent_required' | 'session_in_progress' | 'attempts_exhausted' | 'unavailable'

export const START_REFUSAL_FR: Record<StartRefusal, string> = {
  consent_required:    'Pour utiliser l’entraînement vocal, acceptez d’abord le traitement de votre voix.',
  session_in_progress: 'Un entraînement vocal est déjà en cours. Terminez-le avant d’en commencer un autre.',
  attempts_exhausted:  'Vous avez utilisé tous les essais prévus pour cette leçon pendant votre période d’accès.',
  unavailable:         'L’entraînement vocal est momentanément indisponible.',
}

export type StartCheck =
  | { ok: true; attemptsUsed: number; attemptsRemaining: number }
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

/** Closes this learner's sessions still « active » after the time-out. Returns false if the write failed. */
export async function closeStaleSessions(db: Db, userId: string, now: Date): Promise<boolean> {
  const { error } = await db
    .from('ai_sessions')
    .update({ status: 'abandoned', completed_at: now.toISOString() })
    .eq('user_id', userId)
    .eq('status', 'active')
    .lt('started_at', new Date(now.getTime() - ACTIVE_SESSION_TIMEOUT_MS).toISOString())
  return !error
}

export async function countLiveSessions(db: Db, userId: string): Promise<number | null> {
  const { count, error } = await db
    .from('ai_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active')
  return error ? null : (count ?? 0)
}

/** Start of the learner's current access to the course: the latest accessible entitlement's start. */
export async function accessPeriodStart(db: Db, userId: string, courseId: string, now: Date): Promise<string | null> {
  const { data, error } = await db
    .from('entitlements')
    .select('status, starts_at, expires_at, revoked_at, created_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
  if (error || !data) return null
  const open = (data as (EntitlementLike & { created_at: string })[]).filter(e => isEntitlementAccessible(e, now))
  if (open.length === 0) return null
  return open.map(e => e.starts_at ?? e.created_at).sort().pop() ?? null
}

export async function countVoiceAttempts(db: Db, userId: string, scenarioId: string, since: string): Promise<number | null> {
  const { count, error } = await db
    .from('ai_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('scenario_id', scenarioId)
    .eq('mode', 'voice')
    .gte('started_at', since)
  return error ? null : (count ?? 0)
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

  const since = await accessPeriodStart(db, input.userId, input.courseId, now)
  if (!since) return { ok: false, refusal: 'unavailable' }
  const used = await countVoiceAttempts(db, input.userId, input.scenarioId, since)
  if (used === null) return { ok: false, refusal: 'unavailable' }
  if (used >= input.attemptsPerLesson) return { ok: false, refusal: 'attempts_exhausted' }

  return { ok: true, attemptsUsed: used, attemptsRemaining: input.attemptsPerLesson - used }
}
