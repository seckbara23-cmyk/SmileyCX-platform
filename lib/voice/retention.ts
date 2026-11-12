import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { logAuditEvent } from '@/lib/audit/log'
import { createLogger } from '@/lib/logger'
import { deleteConversation as deleteProviderConversation } from '@/lib/voice/elevenlabs'
import { ERASURE_QUEUE } from '@/lib/voice/erasure'

/**
 * XP-F2-03/04 — transcript retention and provider erasure, as a tested
 * mechanism. NOT SCHEDULED: the only caller is the route
 * `app/api/voice/retention`, which no cron lists.
 *
 * POLICY (owner decision D1, 2026-11-12): voice content is kept 30 days.
 * `APPROVED_TRANSCRIPT_RETENTION_DAYS` is that period. The environment variable
 * `VOICE_TRANSCRIPT_RETENTION_DAYS` may only SHORTEN it (1 to 30), for a test;
 * a longer or malformed value is refused as a misconfiguration and nothing is
 * purged until it is fixed — never silently a different period.
 *
 * What the period covers, and when it runs (docs/voice/XP-F2-READY-01-POLICY.md):
 *   * starts: `ai_sessions.started_at`. A voice session is closed after 15
 *     minutes at most (lib/voice/session-policy.ts), so the start and the end of
 *     a conversation are minutes apart;
 *   * expires: start + 30 days; the next run after that deletes;
 *   * here: transcript turns, self-assessment answers and coaching reports,
 *     engine scores, recommendations and the engine result on the session
 *     (it quotes the learner);
 *   * at the provider: the conversation, through the delete endpoint. What that
 *     endpoint removes, and its backups, are the provider's: never claimed here.
 *   * NOT covered: the session row without words, the consent record, the
 *     attempt ledger (decision D3), and the audit log, which hold no learner words.
 *
 * `runVoiceRetention` does three things, each safe to repeat:
 *   1. PURGE (only when a period is configured). For every session started
 *      before the period: delete the transcript turns, the self-assessment
 *      answers and coaching reports, the engine scores and recommendations,
 *      clear the engine result kept on the session (it quotes the learner),
 *      and stamp `content_purged_at`. The session row stays, without any words:
 *      attempts per lesson and lesson completion depend on it.
 *   2. PROVIDER COPIES of purged sessions: delete each conversation at the
 *      provider; on success forget its id, on failure keep it for the next run.
 *   3. ERASURE QUEUE (always): conversations a learner's erasure or an account
 *      deletion could not delete at the time (lib/voice/erasure.ts). Each attempt
 *      is counted; success stamps `completed_at`.
 * Then it measures what is OVERDUE — a provider copy still pending after
 * `overdueAfterDays` — writes one audit record with counts only, and raises an
 * error-level log (`VOICE_ERASURE_OVERDUE`, `VOICE_RETENTION_ERRORS`) when
 * something is overdue or failed. No transcript, quote or learner id is logged.
 */

type Db = ReturnType<typeof createAdminClient>

const log = createLogger('voice/retention')

/** Decision D1: 30 days. */
export const APPROVED_TRANSCRIPT_RETENTION_DAYS = 30
export const RETENTION_ENV = 'VOICE_TRANSCRIPT_RETENTION_DAYS'
export const DEFAULT_OVERDUE_AFTER_DAYS = 3

/** Every table whose rows can carry the learner's words, keyed by session. */
export const CONTENT_TABLES = ['ai_turns', 'ai_feedback', 'ai_scores', 'ai_recommendations'] as const

/**
 * The period to apply: the approved 30 days when unset; a shorter whole number
 * of days when set (1 to 30); null when the setting is malformed or longer than
 * the policy allows — a misconfiguration, on which nothing is purged.
 */
export function configuredRetentionDays(raw: string | undefined = process.env[RETENTION_ENV]): number | null {
  const v = (raw ?? '').trim()
  if (v === '') return APPROVED_TRANSCRIPT_RETENTION_DAYS
  if (!/^\d{1,3}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= APPROVED_TRANSCRIPT_RETENTION_DAYS ? n : null
}

export interface RetentionResult {
  /** True when nothing was written or deleted: the counts say what a real run would do. */
  readonly dryRun: boolean
  readonly retentionDays: number | null
  readonly sessionsPurged: number
  readonly providerDeleted: number
  readonly providerPending: number
  readonly queueCompleted: number
  readonly queuePending: number
  readonly overdue: number
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

export async function runVoiceRetention(
  db: Db,
  opts: {
    /** null: no purge this run; the provider retries still happen. */
    retentionDays: number | null
    now?: Date
    apiKey?: string
    batchSize?: number
    overdueAfterDays?: number
    /** Count only: no delete, no update, no provider call. */
    dryRun?: boolean
    deleteConversation?: (conversationId: string, apiKey: string) => Promise<boolean>
  },
): Promise<RetentionResult> {
  const dry = opts.dryRun === true
  const days = opts.retentionDays
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new Error('runVoiceRetention: retentionDays must be null or a whole number of days, at least 1')
  }
  const now = opts.now ?? new Date()
  const limit = opts.batchSize ?? 200
  const remove = opts.deleteConversation ?? deleteProviderConversation
  const overdueBefore = new Date(now.getTime() - (opts.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS) * 86_400_000).toISOString()
  let sessionsPurged = 0
  let providerDeleted = 0
  let providerPending = 0
  let queueCompleted = 0
  let queuePending = 0
  let overdue = 0
  let errors = 0

  // 1. Local content of sessions started before the period. A session lasts
  //    minutes, so a start that old means the session is over, whatever status a
  //    closed tab left it in.
  if (days !== null) {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
    const { data: due, error: readError } = await db
      .from('ai_sessions')
      .select('id, provider_conversation_id')
      .is('content_purged_at', null)
      .lt('started_at', cutoff)
      .limit(limit)
    if (readError) errors++
    for (const s of (due ?? []) as { id: string; provider_conversation_id: string | null }[]) {
      if (dry) {
        sessionsPurged++
        if (s.provider_conversation_id) providerPending++
        continue
      }
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
  }

  // 2. Provider conversations of purged sessions, retried until done.
  const { data: remote, error: remoteError } = await db
    .from('ai_sessions')
    .select('id, provider_conversation_id, content_purged_at')
    .not('content_purged_at', 'is', null)
    .not('provider_conversation_id', 'is', null)
    .limit(limit)
  if (remoteError) errors++
  for (const s of (remote ?? []) as { id: string; provider_conversation_id: string; content_purged_at: string }[]) {
    const done = !dry && opts.apiKey ? await remove(s.provider_conversation_id, opts.apiKey) : false
    if (!done) {
      providerPending++
      if (s.content_purged_at < overdueBefore) overdue++
      continue
    }
    const { error } = await db.from('ai_sessions').update({ provider_conversation_id: null }).eq('id', s.id)
    if (error) errors++
    else providerDeleted++
  }

  // 3. The erasure queue: conversations whose session, or whose learner's account, is already gone.
  const { data: queued, error: queueError } = await db
    .from(ERASURE_QUEUE)
    .select('provider_conversation_id, requested_at, attempts')
    .is('completed_at', null)
    .limit(limit)
  if (queueError) errors++
  for (const q of (queued ?? []) as { provider_conversation_id: string; requested_at: string; attempts: number | null }[]) {
    if (dry) {
      queuePending++
      if (q.requested_at < overdueBefore) overdue++
      continue
    }
    const done = opts.apiKey ? await remove(q.provider_conversation_id, opts.apiKey) : false
    const { error } = await db
      .from(ERASURE_QUEUE)
      .update({
        attempts: (q.attempts ?? 0) + 1,
        last_attempt_at: now.toISOString(),
        ...(done ? { completed_at: now.toISOString() } : {}),
      })
      .eq('provider_conversation_id', q.provider_conversation_id)
    if (error) errors++
    if (done && !error) queueCompleted++
    else {
      queuePending++
      if (q.requested_at < overdueBefore) overdue++
    }
  }

  const counts = { dryRun: dry, retentionDays: days, sessionsPurged, providerDeleted, providerPending, queueCompleted, queuePending, overdue, errors }
  if (dry) {
    // A dry run changes nothing and alerts no one: it reports what a run would do.
    log.info(counts, 'voice retention dry run')
    return counts
  }
  if (overdue > 0) log.error({ code: 'VOICE_ERASURE_OVERDUE', ...counts }, 'provider erasure overdue')
  if (errors > 0) log.error({ code: 'VOICE_RETENTION_ERRORS', ...counts }, 'voice retention run had errors')

  await logAuditEvent({
    eventType: 'voice.retention_purged',
    actorType: 'system',
    method: 'voice_retention',
    outcome: errors === 0 && overdue === 0 ? 'success' : 'failure',
    reason: overdue > 0 ? 'provider_erasure_overdue' : errors > 0 ? 'errors' : undefined,
    metadata: counts,
  })

  return counts
}
