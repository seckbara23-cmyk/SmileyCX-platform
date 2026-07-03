'use server'

/**
 * AI Coach — Phase 2B: one-shot Claude evaluation of a completed voice session.
 *
 * Hard rules (task + AI_PRACTICE_ENGINE_PHASE_2_COACH.md):
 *   - Claude is called AT MOST once per completed session. Never during the
 *     live conversation. Never twice for the same session.
 *   - Idempotency is enforced by the existing unique (session_id, source) index
 *     plus an explicit pre-call check: if a source='claude' feedback row exists,
 *     the stored report is returned and Claude is NOT called again.
 *   - Everything fails safe to the deterministic coach: flag off, no API key,
 *     incomplete session, provider error, invalid/hallucinated JSON → no Claude
 *     row is written and the caller renders the deterministic report.
 *   - The ANTHROPIC_API_KEY, prompts, and model config never reach the browser.
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { createLogger } from '@/lib/logger'
import { AI_COACH_ENABLED, AI_COACH_CLAUDE_ENABLED } from '@/lib/ai/flags'
import {
  REPORT_JSON_SCHEMA,
  validateReport,
  COACH_PROMPT_VERSION,
  type ClaudeReport,
} from '@/lib/ai/claude-report'

const log = createLogger('actions/ai-coach')

const Uuid = z.string().uuid()
const InputSchema = z.object({ sessionId: Uuid, anonId: Uuid.optional() })

// Default to the current Opus tier; operators may set a cheaper tier (e.g.
// claude-sonnet-5) via env per the blueprint's configurable-model policy.
const COACH_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'

export type EvaluateResult =
  | { report: ClaudeReport }
  | { reason: 'disabled' | 'not_configured' | 'incomplete' | 'unauthorized' }
  | { error: string; detail?: string }

// ── Ownership (mirrors the ai-practice pattern; kept local to isolate the SDK) ─
async function authorizeSession(sessionId: string, anonId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = createAdminClient()
  const { data: session, error } = await admin
    .from('ai_sessions')
    .select('id, user_id, anon_id, status, scenario_id')
    .eq('id', sessionId)
    .single()
  if (error || !session) return null
  if (session.user_id) {
    if (!user || user.id !== session.user_id) return null
  } else {
    if (!anonId || session.anon_id !== anonId) return null
  }
  return session
}

// ── Read a stored Claude report (pure DB read, no LLM) ────────────────────────
export async function getSessionReport(
  input: { sessionId: string; anonId?: string }
): Promise<ClaudeReport | null> {
  if (!AI_COACH_ENABLED || !AI_COACH_CLAUDE_ENABLED) return null
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) return null
  const { sessionId, anonId } = parsed.data
  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return null
    const admin = createAdminClient()
    const { data } = await admin
      .from('ai_feedback')
      .select('report')
      .eq('session_id', sessionId)
      .eq('source', 'claude')
      .maybeSingle()
    return (data?.report as ClaudeReport | undefined) ?? null
  } catch (e) {
    log.error({ error: (e as Error).message }, 'getSessionReport failed')
    return null
  }
}

// ── One-shot Claude evaluation ────────────────────────────────────────────────
export async function evaluateSessionWithClaude(
  input: { sessionId: string; anonId?: string }
): Promise<EvaluateResult> {
  if (!AI_COACH_ENABLED || !AI_COACH_CLAUDE_ENABLED) return { reason: 'disabled' }
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) return { error: 'Données invalides.' }
  const { sessionId, anonId } = parsed.data

  try {
    const session = await authorizeSession(sessionId, anonId)
    if (!session) return { reason: 'unauthorized' }
    // Never evaluate an incomplete session.
    if (session.status !== 'completed') return { reason: 'incomplete' }

    const admin = createAdminClient()

    // Idempotency gate: return the stored report instead of calling Claude again.
    const { data: existing } = await admin
      .from('ai_feedback')
      .select('report')
      .eq('session_id', sessionId)
      .eq('source', 'claude')
      .maybeSingle()
    if (existing?.report) return { report: existing.report as ClaudeReport }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return { reason: 'not_configured' }

    // Throttle evaluations per identity (Claude is costly) — fails open.
    const rlKey = `ai_eval:${session.user_id ?? anonId}`
    const rl = await rateLimitDb(rlKey, { limit: 10, windowMs: 10 * 60 * 1000 })
    if (!rl.success) return { error: 'Trop de demandes. Réessayez dans quelques minutes.' }

    // ── Assemble the evaluation inputs (all from stored data) ────────────────
    const [{ data: turns }, { data: scenario }, { data: sessionRow }] = await Promise.all([
      admin.from('ai_turns')
        .select('turn_index, speaker, transcript')
        .eq('session_id', sessionId).order('turn_index'),
      admin.from('ai_scenarios')
        .select('title, persona_name, situation, objectives')
        .eq('id', session.scenario_id).single(),
      admin.from('ai_sessions').select('engine_signals').eq('id', sessionId).single(),
    ])
    if (!turns || turns.length === 0) return { error: 'Transcription introuvable.' }

    const { data: rubric } = await admin
      .from('ai_rubrics')
      .select('competency_key, weight, guidance_fr, ai_competencies(label_fr)')
      .eq('scenario_id', session.scenario_id)

    const validTurnIndexes = turns.map(t => t.turn_index as number)
    const knownCompetencyKeys = new Set((rubric ?? []).map(r => r.competency_key as string))

    const transcriptText = turns
      .map(t => `[${t.turn_index}] ${t.speaker === 'agent' ? (scenario?.persona_name ?? 'CLIENT') : 'APPRENANT'}: ${t.transcript}`)
      .join('\n')

    const rubricText = (rubric ?? [])
      .map(r => {
        const label = (r.ai_competencies as { label_fr?: string } | null)?.label_fr ?? r.competency_key
        return `- ${r.competency_key} (${label}, poids ${r.weight})${r.guidance_fr ? ` : ${r.guidance_fr}` : ''}`
      })
      .join('\n')

    const objectives = Array.isArray(scenario?.objectives) ? (scenario!.objectives as string[]) : []
    const engine = sessionRow?.engine_signals as { overallScore?: number } | null

    // ── One Claude call, structured JSON output ──────────────────────────────
    const anthropic = new Anthropic({ apiKey })

    let response
    try {
      response = await anthropic.messages.create({
        model: COACH_MODEL,
        max_tokens: 3000,
        system: [{
          type: 'text',
          text: COACH_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        }],
        output_config: { format: { type: 'json_schema', schema: REPORT_JSON_SCHEMA } },
        messages: [{
          role: 'user',
          content: buildUserPrompt({
            title: scenario?.title ?? '',
            persona: scenario?.persona_name ?? 'le client',
            situation: scenario?.situation ?? '',
            objectives,
            rubricText,
            engineOverall: engine?.overallScore ?? null,
            transcriptText,
            validTurnIndexes,
          }),
        }],
      })
    } catch (e) {
      const err = e as Error
      log.error({ sessionId, error: err.message }, 'Claude request failed')
      return { error: 'Analyse indisponible pour le moment.', detail: err.message }
    }

    if (response.stop_reason === 'refusal') {
      log.error({ sessionId }, 'Claude refused the evaluation')
      return { error: 'Analyse indisponible pour le moment.', detail: 'refusal' }
    }

    const textBlock = response.content.find(b => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { error: 'Analyse indisponible pour le moment.', detail: 'no text block' }
    }

    let raw: unknown
    try {
      raw = JSON.parse(textBlock.text)
    } catch {
      log.error({ sessionId, preview: textBlock.text.slice(0, 200) }, 'Claude returned non-JSON')
      return { error: 'Analyse indisponible pour le moment.', detail: 'non-JSON output' }
    }

    // Validate + reject hallucinated turn indexes BEFORE storing anything.
    const validation = validateReport(raw, validTurnIndexes)
    if (!validation.ok) {
      log.error({ sessionId, error: validation.error }, 'Claude report rejected')
      return { error: 'Analyse indisponible pour le moment.', detail: validation.error }
    }
    const report = validation.report

    // ── Store once (idempotent). Concurrent calls collapse on the unique index ─
    const { error: fbErr } = await admin
      .from('ai_feedback')
      .upsert(
        {
          session_id:     sessionId,
          source:         'claude',
          report,
          model:          COACH_MODEL,
          prompt_version: COACH_PROMPT_VERSION,
          input_tokens:   response.usage?.input_tokens ?? null,
          output_tokens:  response.usage?.output_tokens ?? null,
        },
        { onConflict: 'session_id,source', ignoreDuplicates: true }
      )
    if (fbErr) {
      log.error({ sessionId, error: fbErr.message }, 'ai_feedback claude upsert failed')
      // Fall back to returning the report anyway (the learner still sees it).
    }

    // Persist competency scores (source='claude') for history — only for keys
    // that exist in the catalog, to respect the FK.
    const scoreRows = report.competencies
      .filter(c => knownCompetencyKeys.has(c.key))
      .map(c => ({
        session_id:          sessionId,
        competency_key:      c.key,
        score:               c.score,
        source:              'claude',
        evidence_fr:         c.comment,
        evidence_turn_index: c.evidence_turn_indexes[0] ?? null,
      }))
    if (scoreRows.length > 0) {
      const { error: scErr } = await admin
        .from('ai_scores')
        .upsert(scoreRows, { onConflict: 'session_id,competency_key,source', ignoreDuplicates: true })
      if (scErr) log.error({ sessionId, error: scErr.message }, 'ai_scores claude upsert failed')
    }

    log.info(
      { sessionId, model: COACH_MODEL, input: response.usage?.input_tokens, output: response.usage?.output_tokens },
      'Claude evaluation stored'
    )
    return { report }
  } catch (e) {
    log.error({ error: (e as Error).message }, 'evaluateSessionWithClaude failed')
    return { error: 'Service indisponible.', detail: (e as Error).message }
  }
}

// ── Prompt (French coach persona + strict output contract) ────────────────────

const COACH_SYSTEM_PROMPT = `Tu es un coach expérimenté en relation client, exigeant mais bienveillant, formé au contexte francophone (Afrique de l'Ouest incluse). Tu observes une conversation DÉJÀ TERMINÉE entre un apprenant conseiller et un client joué par une IA ; tu n'as PAS participé à la conversation.

Ta mission : produire un bilan de coaching structuré, entièrement en français.

Règles impératives :
- Écris tout en français, dans un ton chaleureux mais précis.
- Ne cite jamais un numéro de tour (turn_index) qui n'existe pas dans la transcription fournie.
- Chaque point fort, faiblesse et annotation doit s'appuyer sur ce que l'apprenant a réellement dit.
- Les scores sont sur une échelle de 0 à 10 (0 = à retravailler entièrement, 5 = correct, 7 = bon, 9-10 = excellent).
- Ne félicite pas sans preuve et ne sois jamais blessant ; propose toujours une meilleure formulation quand c'est utile.
- Si la transcription est imparfaite (reconnaissance vocale), interprète avec bienveillance et ne pénalise pas les approximations de transcription.
- Réponds UNIQUEMENT avec l'objet JSON demandé, sans texte autour.`

function buildUserPrompt(p: {
  title: string
  persona: string
  situation: string
  objectives: string[]
  rubricText: string
  engineOverall: number | null
  transcriptText: string
  validTurnIndexes: number[]
}): string {
  return [
    `SCÉNARIO : ${p.title}`,
    `CLIENT : ${p.persona}`,
    p.situation ? `SITUATION : ${p.situation}` : '',
    p.objectives.length ? `OBJECTIFS DE L'APPRENANT :\n${p.objectives.map(o => `- ${o}`).join('\n')}` : '',
    p.rubricText ? `COMPÉTENCES À ÉVALUER (utilise EXACTEMENT ces clés dans "competencies") :\n${p.rubricText}` : '',
    p.engineOverall !== null ? `INDICATION AUTOMATIQUE (score indicatif calculé mécaniquement, à confirmer ou corriger) : ${p.engineOverall}/10` : '',
    `\nTRANSCRIPTION (chaque ligne commence par son numéro de tour entre crochets ; n'utilise que ces numéros dans "turn_index" et "evidence_turn_indexes") :\n${p.transcriptText}`,
    `\nProduis le bilan de coaching. Les annotations de relecture ("replay_annotations") doivent porter sur les tours de l'APPRENANT. Tours valides : ${p.validTurnIndexes.join(', ')}.`,
  ].filter(Boolean).join('\n')
}
