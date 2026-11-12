import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { deleteConversation as deleteProviderConversation } from '@/lib/voice/elevenlabs'

/**
 * XP-F2-04 — erasing a learner's voice data, here and at the provider.
 *
 * One procedure for every way a learner's voice data goes: their own request and
 * their withdrawal of consent (decision D2, app/actions/voice-consent.ts), an
 * administrator's erasure request, and the deletion of their account. In all,
 * the sessions are deleted here, and each conversation is deleted at the
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
  const { data, error } = await db
    .from('ai_sessions')
    .select('id, provider_conversation_id')
    .eq('user_id', userId)

  let rows: { id: string; provider_conversation_id: string | null }[]
  let schema: 'ready' | 'pre_066' = 'ready'
  if (error) {
    if ((error as { code?: string }).code !== UNDEFINED_COLUMN) return { ok: false, step: 'read' }
    // Before migration 066 no conversation id was ever stored: there is nothing to erase at the provider.
    schema = 'pre_066'
    const plain = await db.from('ai_sessions').select('id').eq('user_id', userId)
    if (plain.error) return { ok: false, step: 'read' }
    rows = ((plain.data ?? []) as { id: string }[]).map(r => ({ id: r.id, provider_conversation_id: null }))
  } else {
    rows = (data ?? []) as { id: string; provider_conversation_id: string | null }[]
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
    const { error: deleteError } = await db.from('ai_sessions').delete().eq('user_id', userId)
    if (deleteError) return { ok: false, step: 'delete' }
  }
  return { ok: true, schema, sessions: rows.length, providerDeleted, providerQueued }
}
