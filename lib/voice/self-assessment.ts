import type { VoicePersona } from './personas'

/**
 * XP-VOICE-FIX-01 — the self-assessment a learner answers after an F2 exercise.
 *
 * Only Ibrahima's database row carries self-assessment questions; the four
 * other scenarios have none, so the form after their conversation (or their
 * self-assessment fallback) was empty. The questions are derived from the
 * persona's reviewed observation criteria, the same ones the learner sees as
 * objectives and receives feedback on: one scale question per criterion, then
 * one open question. They are listed in the approval dossier for Marième's
 * validation. As with the brief (XP-F2-03), they replace the older questions in
 * Ibrahima's database row, so what is approved is what runs; the row is untouched.
 */

export interface DerivedSelfAssessmentQuestion {
  readonly id: string
  readonly type: 'scale' | 'text'
  readonly question: string
}

/** The scale the self-assessment form shows (components/ai/SelfAssessmentForm.tsx), for the dossier. */
export const SELF_ASSESSMENT_SCALE_FR = ['Pas du tout', 'Un peu', 'Plutôt oui', 'Tout à fait'] as const

export const SELF_ASSESSMENT_OPEN_QUESTION_FR = 'Que feriez-vous différemment lors de votre prochain essai ?'

const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase('fr-FR') + s.slice(1)

export function personaSelfAssessment(p: VoicePersona): DerivedSelfAssessmentQuestion[] {
  return [
    ...p.observationCriteria.map(c => ({
      id: c.id,
      type: 'scale' as const,
      question: `Pendant l’échange, avez-vous su ${lowerFirst(c.labelFr)} ?`,
    })),
    { id: `${p.id}_prochain_essai`, type: 'text' as const, question: SELF_ASSESSMENT_OPEN_QUESTION_FR },
  ]
}
