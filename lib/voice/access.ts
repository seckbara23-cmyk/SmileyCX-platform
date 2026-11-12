import 'server-only'
import { VOICE_PRACTICE_OPEN } from '@/lib/ai/flags'
import { createClient } from '@/lib/supabase/server'

/**
 * XP-F2-04 — who voice practice is open for.
 *
 * Normal production: `VOICE_PRACTICE_OPEN` is false, the list below is empty,
 * and every voice action answers « closed » before doing anything, exactly as
 * before this file existed.
 *
 * Restricted UAT: the server-only variable `VOICE_UAT_USER_IDS` names up to
 * `MAX_UAT_USERS` accounts by their user id. For those accounts, and no one
 * else, the voice actions run — still behind sign-in, course access, consent,
 * the attempt and session limits, and only for the five reviewed F2 scenarios.
 * Everyone else keeps getting « closed ». The list is read on the server at
 * each call and never reaches the browser: emptying it closes the UAT at once,
 * without a deployment of code.
 *
 * Fails closed: a malformed id is ignored, and a list longer than the maximum
 * is treated as empty — a wide list is not a restricted UAT.
 */

export const VOICE_UAT_ENV = 'VOICE_UAT_USER_IDS'
export const MAX_UAT_USERS = 5

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type VoiceGate = 'open' | 'uat' | 'closed'

export function voiceUatUserIds(raw: string | undefined = process.env[VOICE_UAT_ENV]): ReadonlySet<string> {
  const ids = (raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(s => UUID.test(s))
  const unique = new Set(ids)
  return unique.size > MAX_UAT_USERS ? new Set() : unique
}

export function voiceGateFor(userId: string | null | undefined): VoiceGate {
  if (VOICE_PRACTICE_OPEN) return 'open'
  return !!userId && voiceUatUserIds().has(userId.toLowerCase()) ? 'uat' : 'closed'
}

/** The gate for whoever is calling. Touches the session only when a UAT list exists. */
export async function voiceGateForCaller(): Promise<VoiceGate> {
  if (VOICE_PRACTICE_OPEN) return 'open'
  if (voiceUatUserIds().size === 0) return 'closed'
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return voiceGateFor(user?.id)
  } catch {
    return 'closed'
  }
}
