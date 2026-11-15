'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'
import { VOICE_CLOSED_MESSAGE } from '@/lib/ai/flags'
import { voiceGateForCaller } from '@/lib/voice/access'
import { hasVoiceConsent, VOICE_CONSENT_TEXT_FR, VOICE_CONSENT_VERSION } from '@/lib/voice/session-policy'
import { eraseVoiceDataForUser } from '@/lib/voice/erasure'

/**
 * XP-F2-01 — the learner's consent to the voice processing, and their rights.
 *
 * Privacy policy art. 6: voice practice is usable only after accepting the
 * processing, and the learner may ask for their data to be deleted. One module
 * for the five personas:
 *   * accepting requires the current consent version and an explicit `true`,
 *     and only opens anything once voice practice itself is open;
 *   * withdrawing and deleting are ALWAYS available, even while voice practice
 *     is closed: a right does not depend on a feature flag;
 *   * every action concerns the signed-in learner's own rows, never anyone else's.
 */

const log = createLogger('actions/voice-consent')
const LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

const AcceptSchema = z.object({
  version:  z.literal(VOICE_CONSENT_VERSION),
  accepted: z.literal(true),
})

async function signedInLearner() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getVoiceConsentStatus(): Promise<{ accepted: boolean; version: string; textFr: string } | null> {
  if ((await voiceGateForCaller()) === 'closed') return null
  const user = await signedInLearner()
  if (!user) return null
  const accepted = await hasVoiceConsent(createAdminClient(), user.id)
  return { accepted: accepted === true, version: VOICE_CONSENT_VERSION, textFr: VOICE_CONSENT_TEXT_FR }
}

export async function acceptVoiceConsent(input: { version: string; accepted: boolean }): Promise<{ ok?: true; error?: string }> {
  if ((await voiceGateForCaller()) === 'closed') return { error: VOICE_CLOSED_MESSAGE }
  const parsed = AcceptSchema.safeParse(input)
  if (!parsed.success) return { error: 'Cochez la case pour accepter le traitement de votre voix.' }

  const user = await signedInLearner()
  if (!user) return { error: 'Connectez-vous pour continuer.' }
  const rl = await rateLimitDb(`voice_consent:${user.id}`, LIMIT)
  if (!rl.success) return { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }

  const { error } = await createAdminClient()
    .from('voice_processing_consents')
    .upsert(
      { user_id: user.id, consent_version: VOICE_CONSENT_VERSION, accepted_at: new Date().toISOString(), withdrawn_at: null },
      { onConflict: 'user_id,consent_version' },
    )
  if (error) {
    log.error({ userId: user.id, error: error.message }, 'voice consent not recorded')
    return { error: 'Votre accord n’a pas pu être enregistré.' }
  }
  await logAuditEvent({
    eventType: 'voice.consent_accepted', actorType: 'self', actorId: user.id, subjectUserId: user.id,
    method: 'voice_practice', outcome: 'success', metadata: { version: VOICE_CONSENT_VERSION },
  })
  return { ok: true }
}

export type ErasureStatus = 'complete' | 'pending_provider'

/**
 * Withdraws the consent (decision D2): no voice processing starts again without
 * a new consent, and the learner's existing voice data is erased at once — here,
 * and at the provider, where a copy that cannot be deleted now is queued and
 * retried. `erasure` says which: 'pending_provider' is never reported as done.
 * Safe to repeat. Always available, even while voice practice is closed.
 */
export async function withdrawVoiceConsent(): Promise<{ ok?: true; erasure?: ErasureStatus; providerNotDeleted?: number; withdrawn?: true; error?: string }> {
  const user = await signedInLearner()
  if (!user) return { error: 'Connectez-vous pour continuer.' }
  const rl = await rateLimitDb(`voice_consent:${user.id}`, LIMIT)
  if (!rl.success) return { error: 'Trop de tentatives. Réessayez dans quelques minutes.' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('voice_processing_consents')
    .update({ withdrawn_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('withdrawn_at', null)
  if (error) {
    log.error({ userId: user.id, error: error.message }, 'voice consent not withdrawn')
    return { error: 'Le retrait n’a pas pu être enregistré.' }
  }
  await logAuditEvent({
    eventType: 'voice.consent_withdrawn', actorType: 'self', actorId: user.id, subjectUserId: user.id,
    method: 'voice_practice', outcome: 'success',
  })

  // From here no new voice session can start: the server refuses without a current consent.
  const erased = await eraseAndRecord(admin, user.id, 'consent_withdrawal')
  if (!erased.ok) {
    return { withdrawn: true, error: 'Votre accord est retiré, mais la suppression de vos données vocales n’a pas pu être effectuée. Réessayez.' }
  }
  return { ok: true, erasure: erased.erasure, providerNotDeleted: erased.providerNotDeleted }
}

/** Runs the erasure for the signed-in learner and records the outcome (counts only). */
async function eraseAndRecord(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  reason: 'learner_request' | 'consent_withdrawal',
): Promise<{ ok: true; erasure: ErasureStatus; sessions: number; providerNotDeleted: number } | { ok: false }> {
  const outcome = await eraseVoiceDataForUser(admin, userId, { reason, apiKey: process.env.ELEVENLABS_API_KEY })
  if (!outcome.ok) {
    log.error({ userId, step: outcome.step, reason }, 'voice data not deleted')
    await logAuditEvent({
      eventType: 'voice.data_deleted', actorType: 'self', actorId: userId, subjectUserId: userId,
      method: 'voice_practice', outcome: 'failure', reason: `erasure_${outcome.step}`, metadata: { trigger: reason },
    })
    return { ok: false }
  }
  await logAuditEvent({
    eventType: 'voice.data_deleted', actorType: 'self', actorId: userId, subjectUserId: userId,
    method: 'voice_practice', outcome: 'success',
    metadata: { trigger: reason, sessions: outcome.sessions, providerDeleted: outcome.providerDeleted, providerNotDeleted: outcome.providerQueued },
  })
  return {
    ok: true,
    erasure: outcome.providerQueued > 0 ? 'pending_provider' : 'complete',
    sessions: outcome.sessions,
    providerNotDeleted: outcome.providerQueued,
  }
}

/**
 * Deletes the learner's voice-practice data: each conversation at the provider,
 * then their sessions here (turns, feedback and engine results go with them, by
 * cascade). The academic record of a completed lesson is kept.
 *
 * XP-F2-04: a conversation the provider cannot delete now is queued, without any
 * link to the learner, and retried until the provider confirms
 * (lib/voice/erasure.ts). `providerNotDeleted` counts those: the learner is told
 * the truth, never « deleted » for a copy that still exists.
 */
export async function deleteMyVoiceData(): Promise<{ ok?: true; erasure?: ErasureStatus; deletedSessions?: number; providerNotDeleted?: number; error?: string }> {
  const user = await signedInLearner()
  if (!user) return { error: 'Connectez-vous pour continuer.' }
  const rl = await rateLimitDb(`voice_delete:${user.id}`, { limit: 3, windowMs: 60 * 60 * 1000 })
  if (!rl.success) return { error: 'Trop de demandes. Réessayez plus tard.' }

  const erased = await eraseAndRecord(createAdminClient(), user.id, 'learner_request')
  if (!erased.ok) return { error: 'La suppression n’a pas pu être effectuée.' }
  return { ok: true, erasure: erased.erasure, deletedSessions: erased.sessions, providerNotDeleted: erased.providerNotDeleted }
}
