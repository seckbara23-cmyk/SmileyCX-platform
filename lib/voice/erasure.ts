import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { deleteConversation as deleteProviderConversation } from '@/lib/voice/elevenlabs'

/**
 * XP-F2-04 — erasing a learner's voice data, here and at the provider.
 *
 * One procedure for every way a learner's voice data goes: their own request and
 * their withdrawal of consent (decision D2, app/actions/voice-consent.ts), an
 * administrator's erasure request, and the deletion of their account. The first
 * three erase VOICE sessions only (XP-F2-READY-03): self-assessment history is
 * not voice data. The account deletion is the distinct, admin-only workflow that
 * removes everything. In all, each provider conversation is deleted at the
 * provider. The attempt ledger is NOT touched (decision D3): erasing voice data
 * does not give attempts back. Only the account deletion removes it, by cascade.
 *
 * The provider can fail or be unreachable. A reference to a conversation it
 * still holds must then survive the deletion of the session, and of the account,
 * that pointed to it. So a conversation that could not be deleted is first
 * written to `voice_provider_erasures`, a queue that carries the provider's
 * conversation id and nothing about the learner; only then are the sessions
 * deleted. The queue is retried by `retryProviderErasures` (lib/voice/retention.ts)
 * until the provider confirms.
 *
 * Fails closed: if a pending reference cannot be queued, nothing is deleted and
 * the caller is told the erasure did not complete. Safe to repeat: a
 * conversation already gone at the provider counts as deleted, and queueing the
 * same conversation twice keeps one row.
 */

type Db = ReturnType<typeof createAdminClient>

export const ERASURE_QUEUE = 'voice_provider_erasures'
export type ErasureReason = 'learner_request' | 'consent_withdrawal' | 'account_deletion' | 'admin_request'

export type ErasureOutcome =
  | {
      ok: true
      /** 'pre_066': the voice columns do not exist yet, so no provider conversation was ever recorded. */
      schema: 'ready' | 'pre_066'
      sessions: number
      providerDeleted: number
      providerQueued: number
    }
  | { ok: false; step: 'read' | 'queue' | 'delete' }

/** PostgreSQL « undefined column », as PostgREST reports it. */
const UNDEFINED_COLUMN = '42703'

/**
 * Which sessions an erasure covers (XP-F2-READY-03).
 *   * 'voice' — the learner's request, their withdrawal of consent, an
 *     administrator's request: VOICE sessions only (`mode = 'voice'`). Their
 *     self-assessment history is not voice data and stays. On a database without
 *     migration 066 no voice session can exist, so nothing is deleted.
 *   * 'account' — the deletion of the account: every session goes with it by
 *     cascade; here, only the provider copies are dealt with first.
 */
export function erasureScope(reason: ErasureReason): 'voice' | 'account' {
  return reason === 'account_deletion' ? 'account' : 'voice'
}

export async function eraseVoiceDataForUser(
  db: Db,
  userId: string,
  opts: {
    reason: ErasureReason
    apiKey?: string
    /** When false, the session rows are left to the caller (an account deletion cascades to them). */
    deleteSessions?: boolean
    deleteConversation?: (conversationId: string, apiKey: string) => Promise<boolean>
  },
): Promise<ErasureOutcome> {
  const remove = opts.deleteConversation ?? deleteProviderConversation
  const scope = erasureScope(opts.reason)

  let query = db.from('ai_sessions').select('id, mode, provider_conversation_id').eq('user_id', userId)
  if (scope === 'voice') query = query.eq('mode', 'voice')
  const { data, error } = await query

  let rows: { id: string; mode?: string; provider_conversation_id: string | null }[]
  let schema: 'ready' | 'pre_066' = 'ready'
  if (error) {
    if ((error as { code?: string }).code !== UNDEFINED_COLUMN) return { ok: false, step: 'read' }
    // Before migration 066 no conversation id was ever stored, and no session is a voice session.
    schema = 'pre_066'
    if (scope === 'voice') return { ok: true, schema, sessions: 0, providerDeleted: 0, providerQueued: 0 }
    const plain = await db.from('ai_sessions').select('id').eq('user_id', userId)
    if (plain.error) return { ok: false, step: 'read' }
    rows = ((plain.data ?? []) as { id: string }[]).map(r => ({ id: r.id, provider_conversation_id: null }))
  } else {
    rows = (data ?? []) as { id: string; mode?: string; provider_conversation_id: string | null }[]
    // Second guard: a voice-scoped erasure never acts on a non-voice row, even if the filter were dropped.
    if (scope === 'voice') rows = rows.filter(r => r.mode === 'voice')
  }

  let providerDeleted = 0
  let providerQueued = 0
  for (const r of rows) {
    if (!r.provider_conversation_id) continue
    const done = opts.apiKey ? await remove(r.provider_conversation_id, opts.apiKey) : false
    if (done) {
      providerDeleted++
      continue
    }
    const { error: queueError } = await db
      .from(ERASURE_QUEUE)
      .upsert(
        { provider_conversation_id: r.provider_conversation_id, reason: opts.reason },
        { onConflict: 'provider_conversation_id', ignoreDuplicates: true },
      )
    // The reference is not safe: stop before anything that would lose it.
    if (queueError) return { ok: false, step: 'queue' }
    providerQueued++
  }

  if (opts.deleteSessions !== false && rows.length > 0) {
    // By id, and for a voice erasure also by mode: only the rows read above can go.
    let del = db.from('ai_sessions').delete().eq('user_id', userId).in('id', rows.map(r => r.id))
    if (scope === 'voice') del = del.eq('mode', 'voice')
    const { error: deleteError } = await del
    if (deleteError) return { ok: false, step: 'delete' }
  }
  return { ok: true, schema, sessions: rows.length, providerDeleted, providerQueued }
}
