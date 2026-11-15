import 'server-only'
import { COMMON_BOUNDARIES_FR, VOICE_PERSONAS, type VoicePersona, type VoicePersonaId } from '@/lib/voice/personas'
import { COMMON_AGENT_RULES, MAX_REPROMPTS } from '@/lib/voice/agent-rules'
import { DROPPED_RATIONALE_FR, NO_EVIDENCE_FR, RESULT_LABEL_FR, feedbackSummaryFr } from '@/lib/voice/feedback'
import { GUARD_RATIONALE_FR } from '@/lib/voice/dialogue-guards'

/**
 * XP-F2-03 — the pedagogical approval dossier, in French, generated from the
 * persona registry so that what Marième approves is exactly what the agents run.
 *
 * `docs/voice/F2-DOSSIER-APPROBATION.md` is this function's output, kept equal
 * by a test. Any correction Marième makes goes into lib/voice/personas.ts (or the
 * common rules), and the document is regenerated, never edited by hand.
 */

/** Exact sentences of the source document, quoted by the dossier (English). */
export const SOURCE_COMMON_EN: readonly string[] = [
  'It does not score the learner\'s performance out of 10.',
  'It does not evaluate grammar or syntax.',
  'It does not compare the learner to an ideal script. It reacts consistently based on the register used by the learner (calm tone → customer calms down; defensive tone → customer escalates).',
  'It does not resolve the situation on the learner\'s behalf under any form — including disguised self-resolution, such as summarizing its own concern back as a closed yes/no question ("so if I understand correctly... is that right?") and accepting a simple "yes" as validation. This must be explicitly forbidden in every agent\'s system prompt.',
  'Strict, example-based validation criteria. Each agent\'s system prompt must define the target learner behavior (reformulation, acknowledgment, refusal, empathy, commitment, etc.) with a precise definition plus explicit examples of what does NOT count.',
  'No self-resolution, including disguised forms. The agent must never perform the learner\'s task on their own behalf. This includes summarizing its own concern as a closed question and treating a short "yes"/"okay" as valid learner input. A valid learner response must be spontaneous and not merely a confirmation of something the agent said first.',
  'Bounded retry loop. Each agent must re-prompt a limited number of times (2 to 4 exchanges depending on the scenario) if the objective isn\'t met, then close the conversation naturally and a little unresolved — never by explaining the answer itself, and never by softening the ending unless the objective was genuinely met.',
  'Warm/positive closings are strictly conditional. The agent may only close positively if the defined objective was actually met according to the strict criteria above — never based on a generally pleasant or competent-sounding exchange.',
  'Each agent must close the conversation naturally after a limited number of attempts (max 2 re-prompts, so 3 exchanges on the key point) if the learner doesn\'t meet the objective — the bot must never resolve the situation on the learner\'s behalf.',
]

export const SOURCE_FEEDBACK_EN =
  'After the conversation ends, the learner receives qualitative feedback (not a numeric score) based on the scenario\'s observation criteria — generated via the agent\'s Analysis tab (success / failure / unknown + rationale per criterion). The learner is then invited to retry the exercise if the objective wasn\'t met.'

/** Questions specific to each exercise, for Marième (PROPOSED choices to confirm). */
const PERSONA_QUESTIONS_FR: Record<VoicePersonaId, readonly string[]> = {
  amara: [
    'La confirmation d’Amara quand la reformulation est présente : « Oui, c’est ça. » (le document donne « Yes, that’s right »).',
    'Seul le critère « Reformuler avant de répondre » décide de l’objectif. « Langage simple » et « Client compris » sont observés et commentés, sans bloquer.',
    'Les exemples de jargon cités dans le critère « Langage simple » : « migration d’offre », « bundle », « data ».',
  ],
  fatou: [
    'La traduction française des quatre phrases à éviter.',
    'Le repérage automatique de ces phrases est littéral : une variante proche n’est pas repérée automatiquement (l’analyse la juge), et « Ce n’est pas possible » compte même dans une phrase compatissante. Ce niveau de rigueur vous convient-il ?',
    'Les quatre reformulations positives, à aligner sur la fiche PDF « Cheat sheet — banned phrases / positive rephrasings » (la fiche ne nous a pas été transmise).',
    'L’objectif est décidé par « Éviter les formulations négatives » et « Reconnaître la frustration ». « Ton calme et bienveillant » est observé, sans bloquer.',
  ],
  ibrahima: [
    'L’objectif est décidé par « Reconnaître l’émotion avant de répondre » et « Laisser le client s’exprimer ». « Garder un ton calme » est observé sans bloquer, parce que l’analyse lit la transcription et n’entend pas la voix. Le document place « rester calme » dans l’objectif : faut-il rendre ce critère bloquant ?',
    'Ibrahima ne demande le responsable que dans sa première phrase et n’exige pas de transfert ensuite.',
    'L’agent Ibrahima déjà en service garde son contenu actuel tant que ce dossier n’est pas approuvé et que la mise à jour n’est pas autorisée.',
  ],
  kader: [
    'L’objectif est décidé par « Dire non clairement » et « Expliquer la raison sans blâmer ». L’alternative est observée sans bloquer, puisque le document dit « offering an alternative if possible ».',
    'Les deux relances d’insistance de Kader, et la règle : il n’insiste pas plus de deux fois après le premier refus.',
    'Les trois alternatives acceptables : sont-elles réalistes pour un contrat d’assurance ?',
    'Si aucun refus explicite n’est repéré dans les propos de l’apprenant (« non », « je ne peux pas », « ce n’est pas couvert »…), une réussite annoncée par l’analyse devient « Pas assez d’éléments ».',
  ],
  awa: [
    'Les trois critères décident de l’objectif.',
    'Le document demande aussi de reformuler et de s’excuser pour l’absence de rappel. Il n’y a pas de critère séparé : les excuses sont rattachées à « Montrer une empathie sincère », la reformulation figure dans la définition. Faut-il un quatrième critère ?',
    'L’apprenant joue Moussa, et Awa appelle le conseiller par le prénom qu’il donne.',
    'Ce dont Awa se souvient de la formation F1 : nous gardons la même histoire et la même déception, sans détail supplémentaire.',
    'Si aucun délai n’est repéré dans les propos de l’apprenant (« demain », « d’ici 48 heures », « vendredi »…), une réussite annoncée sur « Prendre un engagement précis » devient « Pas assez d’éléments ».',
  ],
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const list = (items: readonly string[]) => items.map(i => `- ${i}`).join('\n')
/** « de Fatou », « d’Amara ». */
const ofName = (name: string) => (/^[AEIOUÉ]/.test(name) ? `d’${name}` : `de ${name}`)
/** The register table's first column already says « Si le conseiller… ». */
const afterAdvisor = (s: string) => s.replace(/^Le conseiller /, '')

function exerciseSection(p: VoicePersona): string {
  const c = p.course
  const o = p.objective
  const decisive = new Set(p.objectiveCriterionIds)
  const specificBoundaries = p.boundariesFr.filter(b => !(COMMON_BOUNDARIES_FR as readonly string[]).includes(b))
  const lines: string[] = []

  lines.push(`## Exercice ${p.exercise.number} · ${p.exercise.kindFr} · ${p.customer.name}`)
  lines.push('')
  lines.push(`Leçon : formation F2 · Module ${c.moduleOrder} « ${c.moduleTitleEn} » · Leçon ${c.lessonNumber} « ${c.lessonTitleEn} » (titres du document source).`)
  lines.push('')
  lines.push('### Texte source exact')
  lines.push('')
  lines.push('| Élément | Texte du document (anglais, sauf la phrase d’ouverture) |')
  lines.push('|---|---|')
  lines.push(`| Exercice | ${cell(p.exercise.kindEn)} |`)
  lines.push(`| Client simulé | ${cell(p.customer.identityEn)} |`)
  lines.push(`| Émotion / ton | ${cell(p.emotion.sourceEn)} |`)
  lines.push(`| Situation | ${cell(p.customer.situationEn)} |`)
  lines.push(`| Phrase d’ouverture, en français, telle qu’implémentée | « ${cell(p.openingLineFr)} » |`)
  lines.push(`| Objectif d’apprentissage | ${cell(o.sourceEn)} ${cell(p.emotion.reactionSourceEn)} |`)
  lines.push(`| Critères d’observation | ${p.observationCriteria.map((x, i) => `${i + 1}. ${cell(x.sourceEn)}`).join('<br>')} |`)
  if (p.associatedPdfEn) lines.push(`| PDF associé | ${cell(p.associatedPdfEn)} |`)
  lines.push('')
  lines.push('### Proposition à valider')
  lines.push('')
  lines.push(`**Client simulé** : ${p.customer.identityFr}`)
  lines.push('')
  lines.push(`**Situation** : ${p.customer.situationFr}`)
  if (p.customer.learnerRoleFr) { lines.push(''); lines.push(`**Rôle de l’apprenant** : ${p.customer.learnerRoleFr}`) }
  if (p.customer.continuityFr) { lines.push(''); lines.push(`**Continuité avec F1** : ${p.customer.continuityFr}`) }
  lines.push('')
  lines.push(`**Émotion** : ${p.emotion.stateFr} ${p.emotion.reactionsFr}`)
  lines.push('')
  lines.push(`**Objectif clé** : ${o.keyBehaviourFr}`)
  lines.push('')
  lines.push(`**Définition stricte** : ${o.definitionFr}`)
  if (o.confirmationCueFr) { lines.push(''); lines.push(`**Ce que dit ${p.customer.name} quand c’est réussi** : « ${o.confirmationCueFr} »`) }
  lines.push('')
  lines.push('**Compte comme réussi (exemples)**')
  lines.push('')
  lines.push(list(o.examplesFr))
  lines.push('')
  lines.push('**Ne compte pas (contre-exemples)**')
  lines.push('')
  lines.push(list(o.nonExamplesFr))
  if (o.bannedPhrasesFr && o.bannedPhrasesEn) {
    lines.push('')
    lines.push('**Phrases à éviter**')
    lines.push('')
    lines.push('| Texte source exact | Proposition française |')
    lines.push('|---|---|')
    o.bannedPhrasesEn.forEach((en, i) => lines.push(`| « ${cell(en)} » | « ${cell(o.bannedPhrasesFr![i])} » |`))
  }
  if (o.positiveRephrasingsFr) {
    lines.push('')
    lines.push('**Reformulations positives**')
    lines.push('')
    lines.push(list(o.positiveRephrasingsFr))
  }
  if (o.insistenceLinesFr) {
    lines.push('')
    lines.push(`**Comment ${p.customer.name} insiste (une ou deux fois au plus)**`)
    lines.push('')
    lines.push(list(o.insistenceLinesFr))
  }
  if (o.alternativeExamplesFr) {
    lines.push('')
    lines.push('**Alternatives acceptables**')
    lines.push('')
    lines.push(list(o.alternativeExamplesFr))
  }
  lines.push('')
  lines.push(`**Réactions ${ofName(p.customer.name)} selon le comportement du conseiller**`)
  lines.push('')
  lines.push(`| Si le conseiller… | ${p.customer.name}… |`)
  lines.push('|---|---|')
  for (const r of p.emotion.registerResponsesFr) lines.push(`| ${cell(afterAdvisor(r.whenFr))} | ${cell(r.reactionFr)} |`)
  lines.push('')
  lines.push('**Critères d’observation**')
  lines.push('')
  p.observationCriteria.forEach((x, i) => {
    lines.push(`${i + 1}. **${x.labelFr}** (source : « ${x.sourceEn} »). ${decisive.has(x.id) ? 'Décide de l’objectif.' : 'Observé et commenté, ne bloque pas l’objectif.'}`)
    lines.push(`   - ${RESULT_LABEL_FR.success} si : ${x.successWhenFr}`)
    lines.push(`   - ${RESULT_LABEL_FR.failure} si : ${x.failureWhenFr}`)
  })
  lines.push('')
  lines.push('**Fin de l’échange**')
  lines.push('')
  lines.push(`- Objectif atteint : ${p.endings.successFr} Par exemple : ${p.closingLinesFr.successFr.join(' ')}`)
  lines.push(`- Objectif non atteint après ${MAX_REPROMPTS} relances : ${p.endings.failureFr} Par exemple : ${p.closingLinesFr.failureFr.join(' ')}`)
  if (specificBoundaries.length > 0) {
    lines.push('')
    lines.push(`**Limite propre à ${p.customer.name}** : ${specificBoundaries.join(' ')}`)
  }
  lines.push('')
  lines.push('### Points à confirmer')
  lines.push('')
  lines.push(list(PERSONA_QUESTIONS_FR[p.id].map(q => `[ ] ${q}`)))
  return lines.join('\n')
}

export function buildApprovalDossierFr(): string {
  const fatou = VOICE_PERSONAS.find(p => p.id === 'fatou')!
  const out: string[] = []
  out.push('# Entraînement vocal F2 · dossier d’approbation pédagogique')
  out.push('')
  out.push('**Statut : proposition, non approuvée.** Ce dossier présente les cinq exercices vocaux de la formation F2 tels que la plateforme les fera jouer. Rien n’est mis en service avant votre approbation et l’autorisation explicite du propriétaire.')
  out.push('')
  out.push('Deux sortes de texte sont séparées partout :')
  out.push('')
  out.push('- **Texte source exact** : copié mot pour mot du document « Voice Training Exercises — Training F2 » (version anglaise, lue en entier le 11 novembre 2026). Les phrases d’ouverture y sont déjà en français et sont reprises à l’identique.')
  out.push('- **Proposition à valider** : rédigée à partir des règles du document. Toutes les traductions, définitions, exemples, contre-exemples, réactions et phrases de clôture sont des propositions.')
  out.push('')
  out.push('Pour chaque point, il suffit d’indiquer : approuvé, corrigé (avec la formulation souhaitée) ou refusé.')
  out.push('')
  out.push('## 1. Décisions communes à confirmer')
  out.push('')
  out.push(list([
    `[ ] Relances : ${MAX_REPROMPTS} relances au plus sur le point clé, donc trois échanges, pour les cinq exercices. Le document dit à un endroit « 2 to 4 exchanges depending on the scenario » et ailleurs « max 2 re-prompts, so 3 exchanges on the key point ».`,
    '[ ] Les dix règles communes ci-dessous (section 2).',
    '[ ] Pour chaque exercice, les critères qui décident de « objectif atteint » (indiqués critère par critère).',
    `[ ] Les trois mentions du retour : « ${RESULT_LABEL_FR.success} », « ${RESULT_LABEL_FR.failure} », « ${RESULT_LABEL_FR.unknown} ».`,
    '[ ] Les contrôles automatiques sur la transcription (section 4).',
    '[ ] Le nombre d’essais : cinq conversations vocales par leçon et par période d’accès (décision déjà prise, rappelée ici).',
  ]))
  out.push('')
  out.push('## 2. Règles communes aux cinq clients simulés')
  out.push('')
  out.push('### Texte source exact')
  out.push('')
  out.push(SOURCE_COMMON_EN.map(s => `> ${s}`).join('\n>\n'))
  out.push('')
  out.push('### Proposition à valider : les règles données à chaque client simulé')
  out.push('')
  out.push(COMMON_AGENT_RULES.map((r, i) => `${i + 1}. ${r.textFr}`).join('\n'))
  out.push('')
  out.push('Limites communes :')
  out.push('')
  out.push(list(COMMON_BOUNDARIES_FR))
  out.push('')
  for (const p of VOICE_PERSONAS) {
    out.push(exerciseSection(p))
    out.push('')
  }
  out.push('## 3. Le retour donné à l’apprenant')
  out.push('')
  out.push('### Texte source exact')
  out.push('')
  out.push(`> ${SOURCE_FEEDBACK_EN}`)
  out.push('')
  out.push('### Proposition à valider')
  out.push('')
  out.push('Aucune note, aucun pourcentage. Pour chaque critère, l’apprenant lit une mention et une justification courte, qui ne cite que ses propres paroles.')
  out.push('')
  out.push('| Résultat de l’analyse | Mention affichée |')
  out.push('|---|---|')
  out.push(`| success | ${RESULT_LABEL_FR.success} |`)
  out.push(`| failure | ${RESULT_LABEL_FR.failure} |`)
  out.push(`| unknown | ${RESULT_LABEL_FR.unknown} |`)
  out.push('')
  out.push('Phrase de synthèse quand l’objectif est atteint (tous les critères qui décident de l’objectif sont « Réussi ») :')
  out.push('')
  out.push(list(VOICE_PERSONAS.map(p => `${p.customer.name} : « ${feedbackSummaryFr(p, true)} »`)))
  out.push('')
  out.push(`Sinon, l’apprenant est invité à recommencer : « ${feedbackSummaryFr(VOICE_PERSONAS[0], false)} » (avec le prénom du client de l’exercice).`)
  out.push('')
  out.push('Justifications remplacées :')
  out.push('')
  out.push(list([
    `Le point n’a pas pu être jugé : « ${NO_EVIDENCE_FR} »`,
    `La justification de l’analyse contenait une note, ou citait des paroles que l’apprenant n’a pas prononcées : elle n’est pas affichée, le résultat devient « ${RESULT_LABEL_FR.unknown} », et l’apprenant lit « ${DROPPED_RATIONALE_FR} »`,
  ]))
  out.push('')
  out.push('## 4. Contrôles automatiques sur la transcription')
  out.push('')
  out.push('L’analyse après l’appel est faite par un modèle de langage. Ces contrôles, appliqués ensuite à la transcription, ne peuvent qu’abaisser un résultat, jamais l’élever.')
  out.push('')
  out.push('| Situation repérée | Effet | Message affiché |')
  out.push('|---|---|---|')
  out.push(`| L’apprenant n’a rien dit | Les critères qui décident de l’objectif deviennent « ${RESULT_LABEL_FR.unknown} » | ${cell(GUARD_RATIONALE_FR.noLearnerTurn)} |`)
  out.push(`| L’apprenant n’a dit que des confirmations (« oui », « d’accord », « exactement »…) | Les critères qui décident de l’objectif deviennent « ${RESULT_LABEL_FR.failure} » | ${cell(GUARD_RATIONALE_FR.bareConfirmations)} |`)
  out.push(`| Fatou : une phrase à éviter a été prononcée | « Éviter les formulations négatives » devient « ${RESULT_LABEL_FR.failure} » | ${cell(GUARD_RATIONALE_FR.bannedPhrase(fatou.objective.bannedPhrasesFr![3]))} (exemple) |`)
  out.push(`| Kader : aucun refus explicite repéré | Une réussite sur « Dire non clairement » devient « ${RESULT_LABEL_FR.unknown} » | ${cell(GUARD_RATIONALE_FR.noRefusal)} |`)
  out.push(`| Awa : aucun délai repéré | Une réussite sur « Prendre un engagement précis » devient « ${RESULT_LABEL_FR.unknown} » | ${cell(GUARD_RATIONALE_FR.noTimeFrame)} |`)
  out.push('')
  out.push('## 5. Hors de ce dossier')
  out.push('')
  out.push('La conservation des transcriptions, le consentement et la suppression des données relèvent d’un document séparé et d’une décision du propriétaire. Le choix des voix et les réglages techniques des agents ne sont pas pédagogiques et ne figurent pas ici.')
  out.push('')
  out.push('## Approbation')
  out.push('')
  out.push('Nom :')
  out.push('')
  out.push('Date :')
  out.push('')
  out.push('Décision : approuvé tel quel / approuvé avec les corrections indiquées / à revoir')
  out.push('')
  out.push('---')
  out.push('')
  out.push('Document généré à partir de la configuration de la plateforme (lib/voice/personas.ts, lib/voice/agent-rules.ts, lib/voice/feedback.ts, lib/voice/dialogue-guards.ts). Les corrections sont reportées dans la configuration, puis le document est régénéré.')
  out.push('')
  return out.join('\n')
}
