import 'server-only'
import { createHash } from 'node:crypto'
import { VOICE_PERSONAS, type VoicePersona } from '@/lib/voice/personas'
import { buildAgentConfig } from '@/lib/voice/prompt'
import { APPROVED_TRANSCRIPT_RETENTION_DAYS } from '@/lib/voice/retention'

/**
 * XP-F2-03 — the exact ElevenLabs agent payload for each persona, reproducibly.
 *
 * Deterministic: built only from lib/voice/personas.ts and the common rules, no
 * date, no random, keys in a fixed order. `lib/voice/agents.manifest.json` is the
 * committed output, kept equal to this builder by a test, so a reviewer sees the
 * exact text an agent will run and its fingerprint changes with any edit.
 *
 * NOTHING here calls ElevenLabs. Provisioning (creating or updating the five
 * agents) waits for Marième's pedagogical approval and the owner's explicit
 * authorization. `scripts/voice/compare-agents.mjs` compares this manifest with
 * live agents, read-only.
 *
 * Retention (decision D1): `platform_settings.privacy.retention_days` = 30, the
 * same period as the platform, so the provider also deletes on its own even if
 * a delete call failed. Whether to apply it to an existing agent's past
 * conversations is a provisioning decision, taken in the dashboard.
 * Deliberately absent: voice choice, turn-taking, audio saving and Zero
 * Retention Mode, which wait for the provider's written answers.
 */

export const AGENT_MANIFEST_VERSION = 'f2-agents-2'

export interface ElevenLabsAgentPayload {
  readonly name: string
  readonly conversation_config: {
    readonly agent: {
      readonly first_message: string
      readonly language: 'fr'
      readonly prompt: { readonly prompt: string }
    }
  }
  readonly platform_settings: {
    readonly privacy: { readonly retention_days: number }
    readonly evaluation: {
      readonly criteria: readonly {
        readonly id: string
        readonly name: string
        readonly type: 'prompt'
        readonly conversation_goal_prompt: string
      }[]
    }
  }
}

export function toAgentPayload(p: VoicePersona): ElevenLabsAgentPayload {
  const cfg = buildAgentConfig(p)
  return {
    name: cfg.name,
    conversation_config: {
      agent: {
        first_message: cfg.firstMessage,
        language: cfg.language,
        prompt: { prompt: cfg.systemPrompt },
      },
    },
    platform_settings: {
      privacy: { retention_days: APPROVED_TRANSCRIPT_RETENTION_DAYS },
      evaluation: {
        criteria: cfg.evaluationCriteria.map(c => ({
          id: c.id,
          name: c.name,
          type: 'prompt' as const,
          conversation_goal_prompt: c.conversationGoalPrompt,
        })),
      },
    },
  }
}

/** JSON with object keys sorted, so the same content always serialises the same way. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function payloadFingerprint(payload: ElevenLabsAgentPayload): string {
  return sha256(canonicalJson(payload))
}

export interface AgentManifest {
  readonly version: string
  readonly personas: readonly {
    readonly personaId: VoicePersona['id']
    readonly scenarioSlug: string
    readonly fingerprint: string
    readonly promptSha256: string
    readonly payload: ElevenLabsAgentPayload
  }[]
}

export function buildAgentManifest(): AgentManifest {
  return {
    version: AGENT_MANIFEST_VERSION,
    personas: VOICE_PERSONAS.map(p => {
      const payload = toAgentPayload(p)
      return {
        personaId: p.id,
        scenarioSlug: p.scenarioSlug,
        fingerprint: payloadFingerprint(payload),
        promptSha256: sha256(payload.conversation_config.agent.prompt.prompt),
        payload,
      }
    }),
  }
}
