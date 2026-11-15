import type { VoicePersona } from '@/lib/voice/personas'

/**
 * XP-F2-03 — deterministic checks on the transcript that can only LOWER a
 * verdict, never raise one.
 *
 * The provider's post-call analysis is a language model's judgement. These
 * guards stop it from turning into a success what the transcript plainly
 * contradicts, the document's two firmest rules first:
 *   * « a simple "yes"/"okay" is not valid learner input »: if the learner never
 *     said anything beyond bare confirmations, the objective is not met;
 *   * Fatou's forbidden phrases: if the learner said one, the negative-phrasing
 *     criterion is a failure, quoting the phrase they actually said.
 * Two conservative caps follow (Kader's refusal, Awa's time frame): a success the
 * transcript cannot support becomes « unknown », never a failure.
 */

export interface TranscriptTurn {
  readonly speaker: 'learner' | 'agent'
  readonly text: string
}

export interface GuardOverride {
  readonly criterionId: string
  /** 'failure' always applies; 'unknown' only caps a provider success. */
  readonly result: 'failure' | 'unknown'
  readonly rationaleFr: string
}

/** The learner-facing wording of each guard, shown in the feedback (PROPOSED, in the approval dossier). */
export const GUARD_RATIONALE_FR = {
  noLearnerTurn: 'Aucune intervention de votre part n’a été enregistrée.',
  bareConfirmations: 'Vos interventions se limitaient à des confirmations (« oui », « d’accord ») : l’objectif demande une réponse formulée par vous.',
  bannedPhrase: (phrase: string) => `Vous avez employé une phrase à éviter : « ${phrase} ».`,
  noRefusal: 'Aucun refus explicite n’a été repéré dans vos propos.',
  noTimeFrame: 'Aucun délai précis n’a été repéré dans vos propos.',
} as const

export function normalizeText(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONFIRMATION_WORDS = [
  'oui', 'ouais', "d'accord", 'ok', 'okay', 'exactement', 'exact', 'tout a fait', 'absolument',
  'effectivement', 'voila', "c'est ca", "c'est bien ca", "c'est exact", 'je vois', 'bien sur',
  'entendu', 'tres bien', 'hum', 'mmh', 'madame', 'monsieur',
]
const BARE_CONFIRMATION = new RegExp(`^(?:(?:${CONFIRMATION_WORDS.join('|')})\\s?)+$`)

/** « Oui », « D’accord, madame », « Exactement, c’est ça » — nothing of the learner's own. */
export function isBareConfirmation(text: string): boolean {
  const n = normalizeText(text)
  return n.length === 0 || BARE_CONFIRMATION.test(n)
}

/** The forbidden phrases (as listed for the persona) found in the learner's words. */
export function findBannedPhrases(learnerTexts: readonly string[], phrases: readonly string[]): string[] {
  const said = normalizeText(learnerTexts.join(' \n '))
  return phrases.filter(p => said.includes(normalizeText(p)))
}

/** An explicit refusal: « non », « je ne peux (malheureusement) pas », « le contrat ne couvre pas »… */
const REFUSAL = /\b(non|(?:ne )?(?:peux|pourrai|pouvons|pourrons)(?: \w+)? pas|ne vais pas|pas possible|impossible|pas en mesure|ne couvre pas|n'est pas couvert|pas couvert|pas pris en charge|ne prend pas en charge)\b/
/** A committed time frame: « demain avant midi », « d'ici 48 heures », « vendredi »… Not « la semaine dernière ». */
const TIME_FRAME = /\b(aujourd'hui|demain|ce soir|ce matin|cet apres midi|d'ici|sous \d+|dans (?:les )?\d+|\d+ ?h(?:eures?)?|\d+ ?minutes?|\d+ ?jours?|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|cette semaine|semaine prochaine|fin de (?:la )?(?:journee|semaine)|midi)\b/

export function dialogueGuards(persona: VoicePersona, turns: readonly TranscriptTurn[]): GuardOverride[] {
  const learner = turns.filter(t => t.speaker === 'learner').map(t => t.text)
  const out: GuardOverride[] = []

  if (learner.length === 0) {
    for (const id of persona.objectiveCriterionIds) {
      out.push({ criterionId: id, result: 'unknown', rationaleFr: GUARD_RATIONALE_FR.noLearnerTurn })
    }
    return out
  }

  if (learner.every(isBareConfirmation)) {
    for (const id of persona.objectiveCriterionIds) {
      out.push({ criterionId: id, result: 'failure', rationaleFr: GUARD_RATIONALE_FR.bareConfirmations })
    }
  }

  if (persona.id === 'fatou' && persona.objective.bannedPhrasesFr) {
    const found = findBannedPhrases(learner, persona.objective.bannedPhrasesFr)
    if (found.length > 0) {
      out.push({ criterionId: 'fatou_sans_formulation_negative', result: 'failure', rationaleFr: GUARD_RATIONALE_FR.bannedPhrase(found[0]) })
    }
  }

  if (persona.id === 'kader' && !learner.some(t => REFUSAL.test(normalizeText(t)))) {
    out.push({ criterionId: 'kader_non_clair', result: 'unknown', rationaleFr: GUARD_RATIONALE_FR.noRefusal })
  }

  if (persona.id === 'awa' && !learner.some(t => TIME_FRAME.test(normalizeText(t)))) {
    out.push({ criterionId: 'awa_engagement_precis', result: 'unknown', rationaleFr: GUARD_RATIONALE_FR.noTimeFrame })
  }

  return out
}
