import { describe, it, expect } from 'vitest'
import {
  runCompetencyEngine,
  normalizeFr,
  type EngineTurn,
  type CompetencyConfig,
} from '@/lib/ai/competency-engine'

// Test lexicons mirroring the migration-025 seed shape (subset).
const COMPETENCIES: CompetencyConfig[] = [
  {
    key: 'empathie',
    labelFr: 'Empathie',
    signals: {
      positive: [
        { pattern: 'je comprends', hint_fr: 'Très bien : vous reconnaissez l’émotion du client.' },
        { pattern: 'je suis desole' },
      ],
      negative: [
        {
          pattern:   'calmez-vous',
          hint_fr:   'Évitez de demander à un client en colère de se calmer.',
          better_fr: 'Je comprends votre frustration, et je vais m’occuper de votre problème tout de suite.',
        },
      ],
    },
  },
  {
    key: 'ecoute',
    labelFr: 'Écoute active',
    signals: { positive: [{ pattern: 'si je comprends bien' }] },
  },
  {
    key: 'resolution',
    labelFr: 'Résolution',
    signals: { positive: [{ pattern: 'remboursement' }, { pattern: 'sous 48' }] },
  },
  {
    key: 'professionnalisme',
    labelFr: 'Communication professionnelle',
    signals: { positive: [{ pattern: 'bonjour' }, { pattern: 'merci' }] },
  },
]

const GOLDEN_TRANSCRIPT: EngineTurn[] = [
  { turnIndex: 0, speaker: 'agent',   transcript: "C'est inadmissible ! J'ai été facturé DEUX FOIS ce mois-ci !" },
  { turnIndex: 1, speaker: 'learner', transcript: 'Bonjour Ibrahima, je comprends votre frustration. Pouvez-vous me préciser le montant ?' },
  { turnIndex: 2, speaker: 'agent',   transcript: 'Deux fois 15 000 francs ! Cinq ans que je suis client !' },
  { turnIndex: 3, speaker: 'learner', transcript: 'Si je comprends bien, vous avez été débité deux fois de 15 000 FCFA ce mois-ci ?' },
  { turnIndex: 4, speaker: 'agent',   transcript: 'Exactement ! Et je veux une solution MAINTENANT.' },
  { turnIndex: 5, speaker: 'learner', transcript: 'CALMEZ-VOUS, monsieur, ça ne sert à rien de crier.' },
  { turnIndex: 6, speaker: 'agent',   transcript: 'Pardon ?! Ne me dites pas de me calmer !' },
  { turnIndex: 7, speaker: 'learner', transcript: 'Je suis désolé. Je lance le remboursement du montant en double, vous le recevrez sous 48 heures. Merci de votre patience.' },
]

describe('normalizeFr', () => {
  it('is case- and accent-insensitive and unifies apostrophes/hyphens', () => {
    expect(normalizeFr('Désolé')).toBe('desole')
    expect(normalizeFr('CALMEZ-VOUS')).toBe('calmez vous')
    expect(normalizeFr('c’est   frustrant')).toBe("c'est frustrant")
  })
})

describe('runCompetencyEngine', () => {
  const result = runCompetencyEngine(GOLDEN_TRANSCRIPT, COMPETENCIES, {
    empathie: 1.5, ecoute: 1, resolution: 1.5, professionnalisme: 0.8,
  })

  it('computes conversation-shape signals', () => {
    expect(result.signals.turnCount).toBe(8)
    expect(result.signals.learnerTurns).toBe(4)
    expect(result.signals.agentTurns).toBe(4)
    expect(result.signals.questionCount).toBe(2)
    expect(result.signals.hasGreeting).toBe(true)
    expect(result.signals.forbiddenHits).toBe(1)
    expect(result.signals.learnerShare).toBeGreaterThan(0)
    expect(result.signals.learnerShare).toBeLessThan(1)
  })

  it('scores every competency in [0, 10]', () => {
    expect(result.scores).toHaveLength(4)
    for (const s of result.scores) {
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.score).toBeLessThanOrEqual(10)
    }
  })

  it('penalizes the forbidden phrase and rewards positive markers (empathie)', () => {
    const empathie = result.scores.find(s => s.key === 'empathie')!
    // 3 positives: "je comprends" (turn 1), "je comprends" inside
    // "si je comprends bien" (turn 3), "je suis désolé" (turn 7).
    // base 5 + 3 − 2 × 1 negative = 6
    expect(empathie.positiveHits).toBe(3)
    expect(empathie.negativeHits).toBe(1)
    expect(empathie.score).toBe(6)
    // Negative evidence takes precedence: points at the "calmez-vous" turn.
    expect(empathie.evidenceTurnIndex).toBe(5)
  })

  it('applies the ecoute question boost', () => {
    const ecoute = result.scores.find(s => s.key === 'ecoute')!
    // base 5 + 1 positive ("si je comprends bien") + floor(2 questions / 2) = 7
    expect(ecoute.score).toBe(7)
  })

  it('detects resolution markers with evidence', () => {
    const resolution = result.scores.find(s => s.key === 'resolution')!
    expect(resolution.positiveHits).toBe(2) // "remboursement" + "sous 48"
    expect(resolution.score).toBe(7)
    expect(resolution.evidenceTurnIndex).toBe(7)
  })

  it('produces a negative replay hint with a better response for calmez-vous', () => {
    const negative = result.hints.filter(h => h.kind === 'negative')
    expect(negative).toHaveLength(1)
    expect(negative[0].turnIndex).toBe(5)
    expect(negative[0].competencyKey).toBe('empathie')
    expect(negative[0].betterFr).toContain('Je comprends votre frustration')
  })

  it('caps hints and orders them by turn', () => {
    expect(result.hints.length).toBeLessThanOrEqual(6)
    const idx = result.hints.map(h => h.turnIndex)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('computes a rubric-weighted overall score in [0, 10]', () => {
    expect(result.overallScore).toBeGreaterThan(0)
    expect(result.overallScore).toBeLessThanOrEqual(10)
  })

  it('is deterministic (same input, same output)', () => {
    const again = runCompetencyEngine(GOLDEN_TRANSCRIPT, COMPETENCIES, {
      empathie: 1.5, ecoute: 1, resolution: 1.5, professionnalisme: 0.8,
    })
    expect(again).toEqual(result)
  })

  it('handles an empty transcript without crashing', () => {
    const empty = runCompetencyEngine([], COMPETENCIES)
    expect(empty.signals.turnCount).toBe(0)
    expect(empty.scores.every(s => s.score >= 0 && s.score <= 10)).toBe(true)
    expect(empty.hints).toHaveLength(0)
  })
})
