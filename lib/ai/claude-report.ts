/**
 * Claude coaching report — schema, JSON-schema (for structured output), and
 * deterministic validation. Pure module: no network, no SDK, no DB — so it is
 * unit-testable and safe to import from client components for types.
 *
 * Contract (AI_PRACTICE_ENGINE_PHASE_2_COACH.md §8; task Phase 2B):
 * Claude must return strict JSON matching REPORT_JSON_SCHEMA; we then validate
 * it with Zod, clamp scores to 0–10, and REJECT any report that cites a
 * turn_index that does not exist in the stored transcript.
 */

import { z } from 'zod'

export const COACH_PROMPT_VERSION = 'coach/2b-1'

// Scores are on a 0–10 scale, consistent with the deterministic engine and the
// ai_scores CHECK constraint.
export const SCORE_MIN = 0
export const SCORE_MAX = 10

// ── Zod schema ────────────────────────────────────────────────────────────────

const AnnotationType = z.enum(['positive', 'warning', 'improvement'])

const CompetencySchema = z.object({
  key:                   z.string().min(1),
  score:                 z.number(),
  comment:               z.string(),
  evidence_turn_indexes: z.array(z.number().int()).default([]),
})

const ReplayAnnotationSchema = z.object({
  turn_index:       z.number().int(),
  type:             AnnotationType,
  comment:          z.string(),
  suggested_phrase: z.string().nullable().default(null),
})

const ImprovementPlanSchema = z.object({
  priority:               z.string(),
  recommended_lessons:    z.array(z.string()).default([]),
  recommended_scenarios:  z.array(z.string()).default([]),
  next_practice_goal:     z.string(),
})

export const ClaudeReportSchema = z.object({
  overall_score:      z.number(),
  summary:            z.string(),
  strengths:          z.array(z.string()).default([]),
  areas_to_improve:   z.array(z.string()).default([]),
  competencies:       z.array(CompetencySchema).default([]),
  replay_annotations: z.array(ReplayAnnotationSchema).default([]),
  improvement_plan:   ImprovementPlanSchema,
})

export type ClaudeReport      = z.infer<typeof ClaudeReportSchema>
export type ReplayAnnotation  = z.infer<typeof ReplayAnnotationSchema>
export type ReportCompetency  = z.infer<typeof CompetencySchema>

// ── JSON schema for output_config.format (structured outputs) ────────────────
// Constrains Claude's output at generation time. Every object sets
// additionalProperties:false and lists required keys (structured-output rules).

export const REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overall_score', 'summary', 'strengths', 'areas_to_improve',
    'competencies', 'replay_annotations', 'improvement_plan',
  ],
  properties: {
    overall_score:    { type: 'integer' },
    summary:          { type: 'string' },
    strengths:        { type: 'array', items: { type: 'string' } },
    areas_to_improve: { type: 'array', items: { type: 'string' } },
    competencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'score', 'comment', 'evidence_turn_indexes'],
        properties: {
          key:                   { type: 'string' },
          score:                 { type: 'integer' },
          comment:               { type: 'string' },
          evidence_turn_indexes: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    replay_annotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['turn_index', 'type', 'comment', 'suggested_phrase'],
        properties: {
          turn_index:       { type: 'integer' },
          type:             { type: 'string', enum: ['positive', 'warning', 'improvement'] },
          comment:          { type: 'string' },
          suggested_phrase: { type: ['string', 'null'] },
        },
      },
    },
    improvement_plan: {
      type: 'object',
      additionalProperties: false,
      required: ['priority', 'recommended_lessons', 'recommended_scenarios', 'next_practice_goal'],
      properties: {
        priority:              { type: 'string' },
        recommended_lessons:   { type: 'array', items: { type: 'string' } },
        recommended_scenarios: { type: 'array', items: { type: 'string' } },
        next_practice_goal:    { type: 'string' },
      },
    },
  },
} as const

// ── Validation ────────────────────────────────────────────────────────────────

function clampScore(n: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(n)))
}

export type ReportValidation =
  | { ok: true;  report: ClaudeReport }
  | { ok: false; error: string }

/**
 * Parse + validate a raw model output against the schema, clamp all scores to
 * 0–10, and reject any report that references a turn_index not present in
 * `validTurnIndexes`. A rejected report is never stored — the UI falls back to
 * the deterministic coach.
 */
export function validateReport(raw: unknown, validTurnIndexes: number[]): ReportValidation {
  const parsed = ClaudeReportSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
  }
  const report = parsed.data
  const valid = new Set(validTurnIndexes)

  // Reject hallucinated turn indexes (task requirement).
  for (const a of report.replay_annotations) {
    if (!valid.has(a.turn_index)) {
      return { ok: false, error: `hallucinated turn_index ${a.turn_index} in replay_annotations` }
    }
  }
  for (const c of report.competencies) {
    for (const idx of c.evidence_turn_indexes) {
      if (!valid.has(idx)) {
        return { ok: false, error: `hallucinated turn_index ${idx} in competency '${c.key}'` }
      }
    }
  }

  // Clamp scores consistently to 0–10.
  const clamped: ClaudeReport = {
    ...report,
    overall_score: clampScore(report.overall_score),
    competencies:  report.competencies.map(c => ({ ...c, score: clampScore(c.score) })),
  }
  return { ok: true, report: clamped }
}
