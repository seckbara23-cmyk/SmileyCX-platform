import type { VoicePersona } from '@/lib/voice/personas'

/**
 * XP-F2-01/02 — qualitative feedback from the agent's post-call analysis.
 *
 * The document: « After the conversation ends, the learner receives qualitative
 * feedback (not a numeric score) based on the scenario's observation criteria —
 * generated via the agent's Analysis tab (success / failure / unknown +
 * rationale per criterion). The learner is then invited to retry the exercise
 * if the objective wasn't met. »
 *
 * One function for all five personas. It trusts nothing it cannot check:
 *   * a criterion the provider did not report, or reported with an unknown
 *     value, is « inconnu », never a success;
 *   * a rationale carrying a number grade is dropped (no score, ever);
 *   * a rationale quoting words the learner never said is dropped (feedback
 *     must not invent learner statements);
 *   * the objective is met only if EVERY objective criterion is a success.
 */

export type CriterionResult = 'success' | 'failure' | 'unknown'

/** One entry of ElevenLabs' `analysis.evaluation_criteria_results`. */
export interface ProviderCriterionEvaluation {
  readonly criteria_id?: string
  readonly result?: string
  readonly rationale?: string
}

export interface CriterionFeedback {
  readonly id: string
  readonly labelFr: string
  readonly result: CriterionResult
  readonly resultLabelFr: string
  readonly rationaleFr: string
}

export interface VoiceFeedback {
  readonly personaId: VoicePersona['id']
  readonly objectiveMet: boolean
  readonly criteria: readonly CriterionFeedback[]
  readonly summaryFr: string
  readonly retryInvited: boolean
}

const RESULT_LABEL_FR: Record<CriterionResult, string> = {
  success: 'Réussi',
  failure: 'À retravailler',
  unknown: 'Pas assez d’éléments',
}

const NO_EVIDENCE_FR = 'La conversation ne permet pas d’en juger.'
const DROPPED_RATIONALE_FR = 'L’analyse automatique de ce point n’est pas affichée, car elle ne s’appuyait pas sur vos propos.'

/** « 7/10 », « 8 sur 10 », « 75 % », « note de 4 », « score : 3 »: any number grade. */
const GRADE_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:\/|sur)\s*\d+\b|\b\d+(?:[.,]\d+)?\s*%|\b(?:note|score|points?)\s*(?:de|:)?\s*\d/i

/** Text inside « », " " or “ ”. */
const QUOTE_PATTERN = /«\s*([^»]+?)\s*»|"([^"]+)"|“([^”]+)”/g

export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Keep a provider rationale only if it is gradeless and every quotation in it
 * (of four characters or more) is something the learner actually said.
 */
export function sanitizeRationale(rationale: string | undefined, learnerTurns: readonly string[]): string | null {
  const text = (rationale ?? '').trim().slice(0, 600)
  if (!text) return null
  if (GRADE_PATTERN.test(text)) return null
  const said = normalizeForQuote(learnerTurns.join(' \n '))
  for (const m of text.matchAll(QUOTE_PATTERN)) {
    const quoted = normalizeForQuote(m[1] ?? m[2] ?? m[3] ?? '')
    if (quoted.length >= 4 && !said.includes(quoted)) return null
  }
  return text
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

function asResult(v: string | undefined): CriterionResult {
  return v === 'success' || v === 'failure' || v === 'unknown' ? v : 'unknown'
}

export function buildVoiceFeedback(
  persona: VoicePersona,
  evaluations: Readonly<Record<string, ProviderCriterionEvaluation>> | null | undefined,
  learnerTurns: readonly string[],
): VoiceFeedback {
  const criteria = persona.observationCriteria.map((c): CriterionFeedback => {
    const ev = evaluations?.[c.id]
    const result = asResult(ev?.result)
    const kept = result === 'unknown' ? null : sanitizeRationale(ev?.rationale, learnerTurns)
    // A verdict whose justification cannot be shown is not trusted either.
    const finalResult: CriterionResult = result !== 'unknown' && kept === null ? 'unknown' : result
    return {
      id: c.id,
      labelFr: c.labelFr,
      result: finalResult,
      resultLabelFr: RESULT_LABEL_FR[finalResult],
      rationaleFr: finalResult === 'unknown'
        ? (result !== 'unknown' ? DROPPED_RATIONALE_FR : NO_EVIDENCE_FR)
        : (kept as string),
    }
  })

  const objectiveMet = persona.objectiveCriterionIds.every(id => criteria.find(c => c.id === id)?.result === 'success')

  return {
    personaId: persona.id,
    objectiveMet,
    criteria,
    summaryFr: objectiveMet
      ? `Objectif atteint : ${lowerFirst(persona.objective.keyBehaviourFr.replace(/\.$/, ''))}.`
      : `Objectif pas encore atteint. Relisez les points ci-dessous, puis recommencez l’exercice avec ${persona.customer.name}.`,
    retryInvited: !objectiveMet,
  }
}
