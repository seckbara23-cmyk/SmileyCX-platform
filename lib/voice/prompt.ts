import 'server-only'
import { COMMON_AGENT_RULES, MAX_REPROMPTS } from '@/lib/voice/agent-rules'
import type { ObservationCriterion, VoicePersona } from '@/lib/voice/personas'

/**
 * XP-F2-01/02 — one builder turns any persona into its agent configuration.
 *
 * The output is what each ElevenLabs agent is provisioned with (F2-03): the
 * system prompt, the first message, the language, and the Analysis-tab
 * evaluation criteria that produce « success / failure / unknown + rationale »
 * per observation criterion. Nothing here is sent to the browser, and the
 * platform passes NO prompt override at session start: the agent's own
 * configuration is the only prompt that runs, so a client cannot rewrite it.
 */

const bullets = (items: readonly string[]) => items.map(i => `- ${i}`).join('\n')

export function buildSystemPrompt(p: VoicePersona): string {
  const c = p.customer
  const o = p.objective
  const sections = [
    `# Ton rôle\nTu es ${c.name}. ${c.identityFr}\n${c.situationFr}` +
      (c.learnerRoleFr ? `\nLa personne qui te répond est ${c.learnerRoleFr}` : '') +
      `\nTon état : ${p.emotion.stateFr}\n${p.emotion.reactionsFr}`,
    `# Ta première phrase (déjà prononcée)\n« ${p.openingLineFr} »`,
    `# Règles absolues\n${COMMON_AGENT_RULES.map((r, i) => `${i + 1}. ${r.textFr}`).join('\n')}`,
    `# L’objectif que le conseiller doit atteindre\n${o.keyBehaviourFr}\n${o.definitionFr}` +
      (o.confirmationCueFr ? `\nQuand c’est le cas, tu le confirmes simplement : « ${o.confirmationCueFr} »` : ''),
    `# Ce qui compte comme réussi (exemples)\n${bullets(o.examplesFr)}`,
    `# Ce qui ne compte PAS\n${bullets(o.nonExamplesFr)}` +
      (o.bannedPhrasesFr ? `\nPhrases à éviter par le conseiller : ${o.bannedPhrasesFr.map(b => `« ${b} »`).join(', ')}.` : ''),
    `# Relances\nSi l’objectif n’est pas atteint, relance au plus ${MAX_REPROMPTS} fois sur ce point précis, en restant dans ton rôle, puis conclus.`,
    `# Fin de l’échange\nSi l’objectif est atteint : ${p.endings.successFr}\nSinon : ${p.endings.failureFr}`,
    `# Limites\n${bullets(p.boundariesFr)}`,
  ]
  return sections.join('\n\n')
}

export function buildEvaluationPrompt(p: VoicePersona, criterion: ObservationCriterion): string {
  return [
    `Critère : ${criterion.labelFr}.`,
    `Évalue uniquement les propos du conseiller (l’utilisateur), jamais ceux du client simulé ${p.customer.name}.`,
    `Réussite : ${criterion.successWhenFr}`,
    `Échec : ${criterion.failureWhenFr}`,
    'Inconnu : la conversation ne permet pas d’en juger (trop courte, interrompue, ou le point n’a pas été abordé).',
    'Un simple « oui », « d’accord » ou « exactement » qui valide une phrase dite d’abord par le client ne compte jamais comme une réussite.',
    'Justifie en français, en une ou deux phrases, en citant entre « » uniquement des mots réellement prononcés par le conseiller. N’invente aucun propos et ne donne aucune note chiffrée.',
  ].join('\n')
}

export interface AgentConfig {
  readonly name: string
  readonly language: 'fr'
  readonly firstMessage: string
  readonly systemPrompt: string
  readonly evaluationCriteria: readonly { readonly id: string; readonly name: string; readonly conversationGoalPrompt: string }[]
}

export function buildAgentConfig(p: VoicePersona): AgentConfig {
  return {
    name: `XP Client Academy — F2 — ${p.customer.name}`,
    language: 'fr',
    firstMessage: p.openingLineFr,
    systemPrompt: buildSystemPrompt(p),
    evaluationCriteria: p.observationCriteria.map(c => ({
      id: c.id,
      name: c.labelFr,
      conversationGoalPrompt: buildEvaluationPrompt(p, c),
    })),
  }
}
