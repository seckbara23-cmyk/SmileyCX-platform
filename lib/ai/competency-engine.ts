/**
 * Deterministic Competency Engine — AI Practice Engine Phase 2A.
 *
 * Pure functions, no LLM, no network, no database. Measures a completed
 * conversation transcript against admin-configured French lexicons
 * (ai_competencies.signals) and produces:
 *   - conversation-shape signals (turn counts, talk share, questions…)
 *   - provisional 0–10 competency scores (source = 'engine')
 *   - per-turn coaching hints for the replay view
 *
 * Design (blueprint §6): lexicons live in the database and are passed in;
 * nothing French is hardcoded here. Matching is case- and accent-insensitive.
 * Engine scores are provisional — Phase 2B's Claude scores supersede them for
 * display; both are kept for calibration.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EngineTurn {
  turnIndex:  number
  speaker:    'learner' | 'agent'
  transcript: string
}

export interface MarkerDef {
  pattern:    string
  hint_fr?:   string
  better_fr?: string
}

export interface CompetencyConfig {
  key:     string
  labelFr: string
  signals: {
    positive?: MarkerDef[]
    negative?: MarkerDef[]
  }
}

export interface EngineHint {
  turnIndex:     number
  kind:          'positive' | 'negative'
  competencyKey: string
  quote:         string
  commentFr:     string
  betterFr?:     string
}

export interface EngineScore {
  key:               string
  labelFr:           string
  score:             number            // 0–10
  positiveHits:      number
  negativeHits:      number
  evidenceFr:        string | null
  evidenceTurnIndex: number | null
}

export interface EngineSignals {
  turnCount:      number
  learnerTurns:   number
  agentTurns:     number
  learnerShare:   number               // 0–1 share of characters spoken by the learner
  avgLearnerChars: number
  questionCount:  number               // '?' in learner turns
  hasGreeting:    boolean
  hasClosing:     boolean
  forbiddenHits:  number               // total negative-marker matches
}

export interface EngineResult {
  version: 'engine/1'
  signals: EngineSignals
  scores:  EngineScore[]
  hints:   EngineHint[]
  /** Rubric-weighted overall score, 0–10 (weights default to 1). */
  overallScore: number
}

// ── Normalization ─────────────────────────────────────────────────────────────
// Lowercase, strip diacritics, unify apostrophes, collapse whitespace — so
// "Calmez-VOUS", "calmez vous" and "désolé"/"desole" all match lexicon entries.

export function normalizeFr(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matches(normalizedTranscript: string, pattern: string): boolean {
  return normalizedTranscript.includes(normalizeFr(pattern))
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// Simple, transparent formula (documented so trainers can reason about it):
//   score = 5 (neutral base) + min(positives, 4) − 2 × negatives, clamped 0–10.
// Competency-specific boosts:
//   ecoute            +1 per 2 learner questions (max +2)
//   professionnalisme +1 greeting present, +1 closing present

const BASE_SCORE   = 5
const MAX_POSITIVE = 4
const NEGATIVE_PENALTY = 2
const MAX_HINTS = 6

const GREETING_MARKERS = ['bonjour', 'bonsoir']
const CLOSING_MARKERS  = ['au revoir', 'bonne journee', 'bonne soiree', 'merci de votre appel']

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ── Engine ────────────────────────────────────────────────────────────────────

export function runCompetencyEngine(
  turns: EngineTurn[],
  competencies: CompetencyConfig[],
  weights: Record<string, number> = {},
): EngineResult {
  const learner = turns.filter(t => t.speaker === 'learner')
  const agent   = turns.filter(t => t.speaker === 'agent')

  const learnerChars = learner.reduce((s, t) => s + t.transcript.length, 0)
  const agentChars   = agent.reduce((s, t) => s + t.transcript.length, 0)
  const totalChars   = learnerChars + agentChars

  const normalizedLearner = learner.map(t => ({
    turn: t,
    norm: normalizeFr(t.transcript),
  }))

  const questionCount = learner.reduce(
    (s, t) => s + (t.transcript.match(/\?/g)?.length ?? 0), 0)

  const firstNorm = normalizedLearner[0]?.norm ?? ''
  const lastNorms = normalizedLearner.slice(-2).map(x => x.norm).join(' ')
  const hasGreeting = GREETING_MARKERS.some(m => firstNorm.includes(normalizeFr(m)))
  const hasClosing  = CLOSING_MARKERS.some(m => lastNorms.includes(normalizeFr(m)))

  const hints:  EngineHint[]  = []
  const scores: EngineScore[] = []
  let forbiddenHits = 0

  for (const comp of competencies) {
    let positives = 0
    let negatives = 0
    let evidenceFr: string | null = null
    let evidenceTurnIndex: number | null = null

    for (const { turn, norm } of normalizedLearner) {
      for (const marker of comp.signals.positive ?? []) {
        if (!matches(norm, marker.pattern)) continue
        positives++
        if (evidenceFr === null) {
          evidenceFr = turn.transcript
          evidenceTurnIndex = turn.turnIndex
        }
        if (marker.hint_fr) {
          hints.push({
            turnIndex: turn.turnIndex, kind: 'positive', competencyKey: comp.key,
            quote: turn.transcript, commentFr: marker.hint_fr,
          })
        }
      }
      for (const marker of comp.signals.negative ?? []) {
        if (!matches(norm, marker.pattern)) continue
        negatives++
        forbiddenHits++
        // Negative evidence takes precedence — it is the coaching moment.
        evidenceFr = turn.transcript
        evidenceTurnIndex = turn.turnIndex
        hints.push({
          turnIndex: turn.turnIndex, kind: 'negative', competencyKey: comp.key,
          quote: turn.transcript,
          commentFr: marker.hint_fr ?? 'Formulation à éviter dans ce contexte.',
          betterFr:  marker.better_fr,
        })
      }
    }

    let score = BASE_SCORE + Math.min(positives, MAX_POSITIVE) - NEGATIVE_PENALTY * negatives
    if (comp.key === 'ecoute')            score += Math.min(2, Math.floor(questionCount / 2))
    if (comp.key === 'professionnalisme') score += (hasGreeting ? 1 : 0) + (hasClosing ? 1 : 0)

    scores.push({
      key: comp.key,
      labelFr: comp.labelFr,
      score: clamp(Math.round(score), 0, 10),
      positiveHits: positives,
      negativeHits: negatives,
      evidenceFr,
      evidenceTurnIndex,
    })
  }

  // Deduplicate hints per (turnIndex, competencyKey), keep negatives first,
  // cap at MAX_HINTS so the replay stays focused.
  const seen = new Set<string>()
  const orderedHints = [...hints]
    .sort((a, b) => (a.kind === b.kind ? a.turnIndex - b.turnIndex : a.kind === 'negative' ? -1 : 1))
    .filter(h => {
      const k = `${h.turnIndex}:${h.competencyKey}:${h.kind}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, MAX_HINTS)
    .sort((a, b) => a.turnIndex - b.turnIndex)

  // Rubric-weighted overall (weights default to 1).
  const totalWeight = scores.reduce((s, sc) => s + (weights[sc.key] ?? 1), 0)
  const overallScore = totalWeight > 0
    ? clamp(Math.round(
        (scores.reduce((s, sc) => s + sc.score * (weights[sc.key] ?? 1), 0) / totalWeight) * 10
      ) / 10, 0, 10)
    : 0

  return {
    version: 'engine/1',
    signals: {
      turnCount:      turns.length,
      learnerTurns:   learner.length,
      agentTurns:     agent.length,
      learnerShare:   totalChars > 0 ? Math.round((learnerChars / totalChars) * 100) / 100 : 0,
      avgLearnerChars: learner.length > 0 ? Math.round(learnerChars / learner.length) : 0,
      questionCount,
      hasGreeting,
      hasClosing,
      forbiddenHits,
    },
    scores,
    hints: orderedHints,
    overallScore,
  }
}
