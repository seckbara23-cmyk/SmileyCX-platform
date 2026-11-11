import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { logAuditEvent } from '@/lib/audit/log'
import { deleteConversation as deleteProviderConversation } from '@/lib/voice/elevenlabs'

/**
 * XP-F2-03 — transcript retention, as a tested mechanism. NOT SCHEDULED.
 *
 * The 30-day period is a PROPOSAL (docs/voice/XP-F2-03-RETENTION.md), not an
 * approved policy: nothing in the platform calls `purgeExpiredVoiceContent`,
 * there is no cron and no production setting. The caller must always pass the
 * period.
 *
 * What a purge removes, for every session started before the period:
 *   1. here: the transcript turns, the self-assessment answers and coaching
 *      reports (ai_feedback), the engine scores and recommendations, and the
 *      engine result kept on the session (`engine_signals`, which quotes the
 *      learner) — everything that can carry the learner's words — and it stamps
 *      `content_purged_at`;
 *   2. at the provider: the conversation (audio, transcript, analysis), through
 *      ElevenLabs' delete endpoint, once the local content is gone. On success
 *      the conversation id is forgotten; on failure it is kept and retried on
 *      the next run. A row kept only because a learner's erasure could not
 *      reach the provider (`erasure_requested_at`) is deleted once it does.
 * What it keeps: the session row itself (scenario, learner, dates, status,
 * mode), because attempts per lesson and lesson completion depend on it. It
 * contains no words of the learner.
 *
 * Auditable: one audit record per run, with counts only.
 */

type Db = ReturnType<typeof createAdminClient>

/** The period under review. Not used by default anywhere. */
export const PROPOSED_TRANSCRIPT_RETENTION_DAYS = 30

/** Every table whose rows can carry the learner's words, keyed by session. */
export const CONTENT_TABLES = ['ai_turns', 'ai_feedback', 'ai_scores', 'ai_recommendations'] as const

export interface PurgeResult {
  readonly sessionsPurged: number
  readonly providerDeleted: number
  readonly providerPending: number
  readonly erasuresCompleted: number
  readonly errors: number
}

/** Deletes the content rows of one session. Returns false if any delete failed. */
export async function purgeSessionContent(db: Db, sessionId: string): Promise<boolean> {
  let ok = true
  for (const table of CONTENT_TABLES) {
    const { error } = await db.from(table).delete().eq('session_id', sessionId)
    if (error) ok = false
  }
  return ok
}

export async function purgeExpiredVoiceContent(
  db: Db,
  opts: {
    retentionDays: number
    now?: Date
    apiKey?: string
    batchSize?: number
    deleteConversation?: (conversationId: string, apiKey: string) => Promise<boolean>
  },
): Promise<PurgeResult> {
  if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) {
    throw new Error('purgeExpiredVoiceContent: retentionDays must be a whole number of days, at least 1')
  }
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - opts.retentionDays * 86_400_000).toISOString()
  const limit = opts.batchSize ?? 200
  const remove = opts.deleteConversation ?? deleteProviderConversation
  let sessionsPurged = 0
  let providerDeleted = 0
  let providerPending = 0
  let erasuresCompleted = 0
  let errors = 0

  // 1. Local content of sessions started before the period. A session lasts
  //    minutes, so a start that old means the session is over, whatever status a
  //    closed tab left it in.
  const { data: due, error: readError } = await db
    .from('ai_sessions')
    .select('id')
    .is('content_purged_at', null)
    .lt('started_at', cutoff)
    .limit(limit)
  if (readError) errors++
  for (const s of (due ?? []) as { id: string }[]) {
    let ok = await purgeSessionContent(db, s.id)
    if (ok) {
      const { error } = await db
        .from('ai_sessions')
        .update({ content_purged_at: now.toISOString(), engine_signals: null })
        .eq('id', s.id)
      if (error) ok = false
    }
    if (ok) sessionsPurged++
    else errors++
  }

  // 2. Provider conversations of purged sessions (retention or erasure), retried until done.
  const { data: remote, error: remoteError } = await db
    .from('ai_sessions')
    .select('id, provider_conversation_id, erasure_requested_at')
    .not('content_purged_at', 'is', null)
    .not('provider_conversation_id', 'is', null)
    .limit(limit)
  if (remoteError) errors++
  for (const s of (remote ?? []) as { id: string; provider_conversation_id: string; erasure_requested_at: string | null }[]) {
    const done = opts.apiKey ? await remove(s.provider_conversation_id, opts.apiKey) : false
    if (!done) {
      providerPending++
      continue
    }
    const { error } = s.erasure_requested_at
      ? await db.from('ai_sessions').delete().eq('id', s.id)
      : await db.from('ai_sessions').update({ provider_conversation_id: null }).eq('id', s.id)
    if (error) errors++
    else {
      providerDeleted++
      if (s.erasure_requested_at) erasuresCompleted++
    }
  }

  await logAuditEvent({
    eventType: 'voice.retention_purged',
    actorType: 'system',
    method: 'voice_retention',
    outcome: errors === 0 ? 'success' : 'failure',
    metadata: { retentionDays: opts.retentionDays, sessionsPurged, providerDeleted, providerPending, erasuresCompleted, errors },
  })

  return { sessionsPurged, providerDeleted, providerPending, erasuresCompleted, errors }
}
