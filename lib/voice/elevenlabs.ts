import 'server-only'
import { z } from 'zod'
import type { ProviderCriterionEvaluation } from '@/lib/voice/feedback'

/**
 * XP-F2-01/02 — the three ElevenLabs calls the voice engine makes, server-side.
 *
 * The API key never leaves the server, every call has a timeout, and nothing
 * here logs a response body: the signed URL carries a session token, and a
 * conversation carries a learner's transcript.
 */

const API = 'https://api.elevenlabs.io/v1/convai'
const TIMEOUT_MS = 10_000

/** ElevenLabs conversation ids are short opaque tokens. */
export const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)

async function call(url: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      headers: { 'xi-api-key': apiKey, ...(init.headers ?? {}) },
      cache: 'no-store',
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export type SignedUrlResult =
  | { ok: true; signedUrl: string }
  | { ok: false; status: number | 'timeout' | 'network' | 'malformed' }

/** A short-lived signed WebSocket URL for one agent. No prompt override is ever requested. */
export async function requestSignedUrl(agentId: string, apiKey: string): Promise<SignedUrlResult> {
  try {
    const res = await call(`${API}/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, apiKey)
    if (!res.ok) return { ok: false, status: res.status }
    const body = (await res.json().catch(() => null)) as { signed_url?: unknown } | null
    const url = typeof body?.signed_url === 'string' ? body.signed_url : null
    if (!url || !url.startsWith('wss://')) return { ok: false, status: 'malformed' }
    return { ok: true, signedUrl: url }
  } catch (e) {
    return { ok: false, status: (e as Error).name === 'AbortError' ? 'timeout' : 'network' }
  }
}

const ConversationSchema = z.object({
  agent_id: z.string(),
  status: z.string().optional(),
  analysis: z.object({
    evaluation_criteria_results: z.record(z.string(), z.object({
      criteria_id: z.string().optional(),
      result: z.string().optional(),
      rationale: z.string().optional(),
    })).optional().nullable(),
  }).optional().nullable(),
}).passthrough()

export type AnalysisResult =
  | { ok: true; ready: boolean; evaluations: Record<string, ProviderCriterionEvaluation> | null }
  | { ok: false; reason: 'agent_mismatch' | 'not_found' | 'unavailable' }

/**
 * The post-call analysis of one conversation. Refused unless the conversation
 * belongs to the agent the caller's scenario uses, so a learner can never read
 * another exercise's or another learner's conversation through a forged id.
 */
export async function fetchConversationAnalysis(
  conversationId: string,
  expectedAgentId: string,
  apiKey: string,
): Promise<AnalysisResult> {
  if (!ConversationId.safeParse(conversationId).success) return { ok: false, reason: 'not_found' }
  try {
    const res = await call(`${API}/conversations/${encodeURIComponent(conversationId)}`, apiKey)
    if (res.status === 404) return { ok: false, reason: 'not_found' }
    if (!res.ok) return { ok: false, reason: 'unavailable' }
    const parsed = ConversationSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success) return { ok: false, reason: 'unavailable' }
    if (parsed.data.agent_id !== expectedAgentId) return { ok: false, reason: 'agent_mismatch' }
    const evaluations = parsed.data.analysis?.evaluation_criteria_results ?? null
    const ready = parsed.data.status === 'done' || parsed.data.status === 'failed' || !!evaluations
    return { ok: true, ready, evaluations }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/** Deletes a conversation (audio and transcript) at the provider, for a learner's erasure request. */
export async function deleteConversation(conversationId: string, apiKey: string): Promise<boolean> {
  if (!ConversationId.safeParse(conversationId).success) return false
  try {
    const res = await call(`${API}/conversations/${encodeURIComponent(conversationId)}`, apiKey, { method: 'DELETE' })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}
