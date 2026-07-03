import { describe, it, expect } from 'vitest'
import { validateReport, type ClaudeReport } from '@/lib/ai/claude-report'

function baseReport(): ClaudeReport {
  return {
    overall_score: 7,
    summary: 'Bonne gestion globale.',
    strengths: ['Écoute'],
    areas_to_improve: ['Proposer un délai'],
    competencies: [
      { key: 'empathie', score: 8, comment: 'Bien.', evidence_turn_indexes: [1] },
    ],
    replay_annotations: [
      { turn_index: 3, type: 'warning', comment: 'À éviter.', suggested_phrase: 'Je comprends.' },
    ],
    improvement_plan: {
      priority: 'Empathie',
      recommended_lessons: [],
      recommended_scenarios: [],
      next_practice_goal: 'Reformuler plus tôt.',
    },
  }
}

const VALID_TURNS = [0, 1, 2, 3, 4, 5]

describe('validateReport', () => {
  it('accepts a well-formed report referencing existing turns', () => {
    const res = validateReport(baseReport(), VALID_TURNS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.report.overall_score).toBe(7)
      expect(res.report.competencies[0].key).toBe('empathie')
    }
  })

  it('rejects a hallucinated turn_index in replay_annotations', () => {
    const r = baseReport()
    r.replay_annotations[0].turn_index = 99
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('99')
  })

  it('rejects a hallucinated evidence turn_index in a competency', () => {
    const r = baseReport()
    r.competencies[0].evidence_turn_indexes = [1, 42]
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('42')
  })

  it('clamps out-of-range scores to 0–10', () => {
    const r = baseReport()
    r.overall_score = 130          // model returned 0–100 by mistake
    r.competencies[0].score = -3
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.report.overall_score).toBe(10)
      expect(res.report.competencies[0].score).toBe(0)
    }
  })

  it('rejects malformed JSON (missing required field)', () => {
    const bad = { summary: 'x' } // no overall_score, improvement_plan, etc.
    const res = validateReport(bad, VALID_TURNS)
    expect(res.ok).toBe(false)
  })

  it('rejects an invalid annotation type', () => {
    const r = baseReport() as unknown as Record<string, unknown>
    ;(r.replay_annotations as unknown[])[0] = {
      turn_index: 2, type: 'bogus', comment: 'x', suggested_phrase: null,
    }
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(false)
  })

  it('accepts null suggested_phrase and empty evidence arrays', () => {
    const r = baseReport()
    r.replay_annotations[0].suggested_phrase = null
    r.competencies[0].evidence_turn_indexes = []
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(true)
  })

  it('rounds fractional scores', () => {
    const r = baseReport()
    r.overall_score = 6.7
    const res = validateReport(r, VALID_TURNS)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.report.overall_score).toBe(7)
  })
})
