/**
 * XP-F2-03 — the five voice scenarios, complete: source fidelity, persona
 * contracts, dialogues that pass and dialogues that must not, the transcript
 * guards, bounded retries and endings, the agent manifest and the approval
 * dossier.
 *
 * The SOURCE constants below are copied from « Voice Training Exercises —
 * Training F2 » (English version, read in full on 2026-11-11). They are the
 * yardstick: a persona that drifts from the document fails here.
 *
 * Golden files: lib/voice/agents.manifest.json and
 * docs/voice/F2-DOSSIER-APPROBATION.md are generated. After a deliberate change
 * to a persona, regenerate them with
 *   VOICE_GOLDEN_WRITE=1 npx vitest run __tests__/learning/xp-f2-03-scenarios.test.ts
 * and review the diff.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VOICE_PERSONAS, personaById, type VoicePersona } from '@/lib/voice/personas'
import { COMMON_AGENT_RULES, MAX_REPROMPTS } from '@/lib/voice/agent-rules'
import { buildSystemPrompt } from '@/lib/voice/prompt'
import { buildVoiceFeedback, RESULT_LABEL_FR, type ProviderCriterionEvaluation } from '@/lib/voice/feedback'
import { dialogueGuards, findBannedPhrases, GUARD_RATIONALE_FR, isBareConfirmation, type TranscriptTurn } from '@/lib/voice/dialogue-guards'
import { buildAgentManifest, canonicalJson, payloadFingerprint, toAgentPayload } from '@/lib/voice/provisioning'
import { buildApprovalDossierFr } from '@/lib/voice/approval-dossier'

const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const WRITE = process.env.VOICE_GOLDEN_WRITE === '1'

// ── The source document, exactly ─────────────────────────────────────────────
const SOURCE = {
  amara: {
    lesson: [2, 'Communicating well with the client', 4, 'Rephrasing to show understanding'],
    customer: 'Amara, customer of a telecom operator.',
    emotion: 'Confused, puzzled, a bit lost.',
    situation: 'Amara received an SMS about a change to his phone plan. He doesn\'t understand what it means or what he needs to do.',
    objective: 'The learner must rephrase Amara\'s concern before answering.',
    reaction: 'The bot confirms if the rephrasing is present ("Yes, that\'s right") or prompts again if it\'s missing.',
    criteria: ['Did they rephrase before answering?', 'Did they use simple language?', 'Did the customer feel understood?'],
    pdf: undefined,
  },
  fatou: {
    lesson: [2, 'Communicating well with the client', 5, 'Words that soothe, words to avoid'],
    customer: 'Fatou, mobile banking customer.',
    emotion: 'Frustrated, impatient.',
    situation: 'Fatou has been waiting 3 days for her Mobile Money account to be unblocked. She has already called twice with no resolution.',
    objective: 'The learner must avoid banned phrases ("It\'s not my fault," "That\'s not possible," "You have to wait," "Calm down") and use a positive rephrasing instead.',
    reaction: 'The bot reacts differently depending on the register used.',
    criteria: ['Did they avoid negative phrasing?', 'Did they acknowledge the frustration before offering a solution?', 'Was the tone calm and caring?'],
    pdf: 'Cheat sheet — banned phrases / positive rephrasings',
  },
  ibrahima: {
    lesson: [3, 'Handling difficult customers', 2, 'Staying calm and defusing tension'],
    customer: 'Ibrahima, customer of a telecom operator.',
    emotion: 'Angry, raised voice.',
    situation: 'Ibrahima was charged twice for the same bill. He demands an immediate refund and threatens to switch to a competitor.',
    objective: 'The learner must stay calm, avoid defending themselves right away, acknowledge the anger, and defuse the situation before proposing an action.',
    reaction: 'The bot escalates if the learner justifies themselves too quickly or interrupts.',
    criteria: ['Did they keep a calm tone?', 'Did they let the customer speak?', 'Did they acknowledge the emotion before responding?'],
    pdf: undefined,
  },
  kader: {
    lesson: [3, 'Handling difficult customers', 4, 'Saying no without alienating the customer'],
    customer: 'Kader, insurance customer.',
    emotion: 'Insistent, persuasive.',
    situation: 'Kader is asking for a reimbursement that isn\'t covered by his contract. He insists and argues his case.',
    objective: 'The learner must say no clearly and firmly, without aggression, offering an alternative if possible.',
    reaction: 'The bot tests the learner\'s resolve with one or two further attempts.',
    criteria: ['Did they say no clearly?', 'Did they explain the reason without blaming the customer?', 'Did they offer an alternative or compensation?'],
    pdf: undefined,
  },
  awa: {
    lesson: [4, 'Handling a request or complaint', 2, 'Handling a complaint from start to finish, with empathy'],
    customer: 'Awa, customer of a telecom operator (the same Awa as in Training F1 — narrative continuity).',
    emotion: 'Frustrated, disappointed.',
    situation: 'Awa is calling about her consumption complaint, already experienced from the customer\'s side in F1. This time, Moussa — the learner — is the one taking the call. She already called last week and was never called back.',
    objective: 'The learner (Moussa) must welcome the customer without getting defensive, show empathy, rephrase the situation, apologize for the lack of follow-up, and offer a clear action with a committed timeframe.',
    reaction: 'The bot calms down if the empathy is genuine; it stays disappointed if the learner justifies themselves or stays overly formal.',
    criteria: ['Did they welcome the customer without getting defensive?', 'Did they show genuine empathy, not just formal apologies?', 'Did they make a specific commitment?'],
    pdf: 'Checklist — complaint handling',
  },
} as const

const learner = (...texts: string[]): TranscriptTurn[] => texts.map(text => ({ speaker: 'learner', text }))
const turns = (...pairs: [TranscriptTurn['speaker'], string][]): TranscriptTurn[] => pairs.map(([speaker, text]) => ({ speaker, text }))
const all = (p: VoicePersona, result: string, rationale = 'Constat sur les propos du conseiller.') =>
  Object.fromEntries(p.observationCriteria.map(c => [c.id, { result, rationale }])) as Record<string, ProviderCriterionEvaluation>

describe('source fidelity: every persona says what the document says', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: lesson, customer, emotion, situation, objective, criteria, PDF', (id, p) => {
    const s = SOURCE[id]
    expect([p.course.moduleOrder, p.course.moduleTitleEn, p.course.lessonNumber, p.course.lessonTitleEn]).toEqual(s.lesson)
    expect(p.customer.identityEn).toBe(s.customer)
    expect(p.emotion.sourceEn).toBe(s.emotion)
    expect(p.customer.situationEn).toBe(s.situation)
    expect(p.objective.sourceEn).toBe(s.objective)
    expect(p.emotion.reactionSourceEn).toBe(s.reaction)
    expect(p.observationCriteria.map(c => c.sourceEn)).toEqual(s.criteria)
    expect(p.associatedPdfEn).toBe(s.pdf)
  })

  it('the five exercises are spread across the document\'s three modules', () => {
    expect(VOICE_PERSONAS.map(p => `M${p.course.moduleOrder}-L${p.course.lessonNumber}`)).toEqual(['M2-L4', 'M2-L5', 'M3-L2', 'M3-L4', 'M4-L2'])
  })
})

describe('persona contracts: complete content for each of the five', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: register responses, closings, criteria definitions, boundaries', (_id, p) => {
    expect(p.emotion.registerResponsesFr.length).toBeGreaterThanOrEqual(4)
    for (const r of p.emotion.registerResponsesFr) {
      expect(r.whenFr.length).toBeGreaterThan(15)
      expect(r.reactionFr.length).toBeGreaterThan(10)
    }
    expect(p.closingLinesFr.successFr.length).toBeGreaterThanOrEqual(1)
    expect(p.closingLinesFr.failureFr.length).toBeGreaterThanOrEqual(1)
    for (const c of p.observationCriteria) {
      expect(c.successWhenFr.length, c.id).toBeGreaterThan(30)
      expect(c.failureWhenFr.length, c.id).toBeGreaterThan(20)
      expect(c.successWhenFr, c.id).not.toBe(c.failureWhenFr)
    }
    expect(p.objectiveCriterionIds.length).toBeGreaterThanOrEqual(1)
    expect(p.boundariesFr.length).toBeGreaterThan(4)
  })

  it('Amara confirms simply when the rephrasing is present, as the document says', () => {
    expect(personaById('amara').objective.confirmationCueFr).toBe('Oui, c’est ça.')
    expect(buildSystemPrompt(personaById('amara'))).toContain('tu le confirmes simplement : « Oui, c’est ça. »')
    expect(personaById('amara').objectiveCriterionIds).toEqual(['amara_reformulation'])
  })

  it('Fatou: the four forbidden phrases of the document, each with a French form and a positive rephrasing', () => {
    const o = personaById('fatou').objective
    expect(o.bannedPhrasesEn).toEqual(['It\'s not my fault', 'That\'s not possible', 'You have to wait', 'Calm down'])
    expect(o.bannedPhrasesFr).toEqual(['Ce n’est pas de ma faute', 'Ce n’est pas possible', 'Il faut attendre', 'Calmez-vous'])
    expect(o.positiveRephrasingsFr).toHaveLength(4)
    o.bannedPhrasesFr!.forEach((b, i) => expect(o.positiveRephrasingsFr![i]).toMatch(new RegExp(`^Au lieu de « ${b} » : « .+ »$`)))
    expect(personaById('fatou').objectiveCriterionIds).toEqual(['fatou_sans_formulation_negative', 'fatou_frustration_reconnue'])
  })

  it('Ibrahima: the anger is acknowledged before any justification or action', () => {
    const p = personaById('ibrahima')
    expect(p.objective.definitionFr).toMatch(/reconnaît explicitement sa colère, et seulement ensuite propose une action/)
    expect(p.objectiveCriterionIds).toContain('ibrahima_emotion_reconnue')
    expect(p.objective.nonExamplesFr).toContain('Proposer tout de suite un remboursement sans avoir reconnu l’émotion.')
  })

  it('Kader: a clear, reasoned refusal plus an alternative, tested once or twice', () => {
    const p = personaById('kader')
    expect(p.objective.insistenceLinesFr!.length).toBeGreaterThanOrEqual(1)
    expect(p.objective.insistenceLinesFr!.length).toBeLessThanOrEqual(2)
    expect(p.objective.alternativeExamplesFr!.length).toBeGreaterThanOrEqual(2)
    expect(p.boundariesFr.join(' ')).toContain('n’insiste pas plus de deux fois')
    expect(p.objectiveCriterionIds).toEqual(['kader_non_clair', 'kader_raison_sans_blame'])
  })

  it('Awa: empathy, ownership of the complaint, a dated commitment, and the F1 continuity', () => {
    const p = personaById('awa')
    expect(p.objective.definitionFr).toMatch(/s’excuse pour l’absence de rappel/)
    expect(p.objective.definitionFr).toMatch(/action précise avec un délai/)
    expect(p.objectiveCriterionIds).toEqual(['awa_accueil_sans_justification', 'awa_empathie_sincere', 'awa_engagement_precis'])
    expect(p.customer.continuityFr).toMatch(/formation F1/)
    expect(buildSystemPrompt(p)).toContain(p.customer.continuityFr!)
    expect(buildSystemPrompt(p)).toContain('Moussa')
  })
})

describe('the prompt carries each scenario\'s own material', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s', (_id, p) => {
    const prompt = buildSystemPrompt(p)
    for (const r of p.emotion.registerResponsesFr) expect(prompt).toContain(r.reactionFr)
    for (const l of [...p.closingLinesFr.successFr, ...p.closingLinesFr.failureFr]) expect(prompt).toContain(l)
    for (const e of p.objective.examplesFr) expect(prompt).toContain(e)
    for (const b of p.objective.bannedPhrasesFr ?? []) expect(prompt).toContain(`« ${b} »`)
    for (const r of p.objective.positiveRephrasingsFr ?? []) expect(prompt).toContain(r)
    for (const l of p.objective.insistenceLinesFr ?? []) expect(prompt).toContain(l)
    for (const a of p.objective.alternativeExamplesFr ?? []) expect(prompt).toContain(a)
    for (const b of p.boundariesFr) expect(prompt).toContain(b)
    // Bounded retry and termination.
    expect(prompt).toContain(`relance au plus ${MAX_REPROMPTS} fois sur ce point précis`)
    expect(prompt).toContain(`Si l’objectif est atteint : ${p.endings.successFr}`)
    expect(prompt).toContain(`Sinon : ${p.endings.failureFr}`)
    for (const id of ['no_disguised_self_resolution', 'conditional_warm_closing', 'natural_unresolved_ending'] as const) {
      expect(prompt).toContain(COMMON_AGENT_RULES.find(r => r.id === id)!.textFr)
    }
  })
})

// ── Dialogues ────────────────────────────────────────────────────────────────
// Each case: a transcript, the provider's analysis (sometimes deliberately
// wrong), and the feedback the learner must get.

describe('dialogues that meet the objective', () => {
  const CASES: Record<VoicePersona['id'], { transcript: TranscriptTurn[]; quote: string }> = {
    amara: {
      transcript: turns(
        ['agent', personaById('amara').openingLineFr],
        ['learner', 'Bonjour monsieur. Si je comprends bien, vous avez reçu un SMS qui annonce un changement de forfait, et vous voulez savoir ce qui va changer pour vous ?'],
        ['agent', 'Oui, c’est ça.'],
        ['learner', 'À partir du premier décembre, vous aurez plus d’internet pour le même prix. Vous n’avez rien à faire.'],
      ),
      quote: 'vous avez reçu un SMS qui annonce un changement de forfait',
    },
    fatou: {
      transcript: turns(
        ['agent', personaById('fatou').openingLineFr],
        ['learner', 'Je comprends votre agacement, trois jours c’est long. Je regarde tout de suite où en est le déblocage de votre compte.'],
      ),
      quote: 'trois jours c’est long',
    },
    ibrahima: {
      transcript: turns(
        ['agent', personaById('ibrahima').openingLineFr],
        ['learner', 'Je comprends votre colère : être prélevé deux fois, c’est inacceptable. Je vous écoute.'],
        ['agent', 'Ça fait deux semaines que j’attends !'],
        ['learner', 'Je note. Je vérifie les deux prélèvements et je lance le remboursement du doublon.'],
      ),
      quote: 'Je comprends votre colère',
    },
    kader: {
      transcript: turns(
        ['agent', personaById('kader').openingLineFr],
        ['learner', 'Je comprends, et je vous remercie de votre fidélité. Votre contrat ne couvre pas ce remboursement, je ne peux malheureusement pas faire d’exception.'],
        ['agent', personaById('kader').objective.insistenceLinesFr![0]],
        ['learner', 'Votre fidélité compte, mais ma réponse reste la même. En revanche, je peux vous présenter l’option qui couvrirait ce cas à l’avenir.'],
      ),
      quote: 'Votre contrat ne couvre pas ce remboursement',
    },
    awa: {
      transcript: turns(
        ['agent', personaById('awa').openingLineFr],
        ['learner', 'Je suis vraiment désolé qu’on ne vous ait pas rappelée, je comprends votre déception. Vous attendez toujours une réponse sur votre consommation, c’est bien ça ? Je m’en occupe et je vous rappelle demain avant midi.'],
      ),
      quote: 'je vous rappelle demain avant midi',
    },
  }

  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: objective met, warm summary, no retry', (id, p) => {
    const c = CASES[id]
    expect(dialogueGuards(p, c.transcript)).toEqual([])
    const f = buildVoiceFeedback(p, all(p, 'success', `Le conseiller a dit « ${c.quote} ».`), c.transcript)
    expect(f.objectiveMet).toBe(true)
    expect(f.retryInvited).toBe(false)
    expect(f.criteria.every(x => x.result === 'success' && x.resultLabelFr === RESULT_LABEL_FR.success)).toBe(true)
    expect(f.summaryFr).toMatch(/^Objectif atteint : /)
  })

  it('Kader in spoken French, without « ne », is still a refusal', () => {
    expect(dialogueGuards(personaById('kader'), learner('Je peux pas faire d’exception, monsieur.'))).toEqual([])
  })
})

describe('dialogues that must not meet the objective', () => {
  it('Amara: a direct explanation without rephrasing', () => {
    const p = personaById('amara')
    const t = learner('Votre offre migre vers un bundle data de dix gigas.')
    const f = buildVoiceFeedback(p, { amara_reformulation: { result: 'failure', rationale: 'Il a dit « Votre offre migre vers un bundle data » sans reformuler.' } }, t)
    expect(f.objectiveMet).toBe(false)
    expect(f.retryInvited).toBe(true)
    expect(f.criteria[0].rationaleFr).toContain('Votre offre migre vers un bundle data')
    expect(f.summaryFr).toContain('recommencez l’exercice avec Amara')
  })

  it('Fatou: a forbidden phrase is a failure even when the analysis calls it a success, and the phrase is quoted', () => {
    const p = personaById('fatou')
    const t = learner('Madame, calmez vous. Il faut attendre que le service technique traite le dossier.')
    const f = buildVoiceFeedback(p, all(p, 'success'), t)
    const c = f.criteria.find(x => x.id === 'fatou_sans_formulation_negative')!
    expect(c.result).toBe('failure')
    expect(c.rationaleFr).toBe(GUARD_RATIONALE_FR.bannedPhrase('Il faut attendre'))
    expect(f.objectiveMet).toBe(false)
  })

  it('Fatou: case, accents, apostrophes and hyphens do not hide a forbidden phrase', () => {
    const banned = personaById('fatou').objective.bannedPhrasesFr!
    expect(findBannedPhrases(['CE N\'EST PAS DE MA FAUTE !'], banned)).toEqual(['Ce n’est pas de ma faute'])
    expect(findBannedPhrases(['Calmez-vous, madame.'], banned)).toEqual(['Calmez-vous'])
    expect(findBannedPhrases(['Ce n’est pas possible, désolé.'], banned)).toEqual(['Ce n’est pas possible'])
    // Literal matching, as the dossier tells Marième: a near variant is left to the analysis.
    expect(findBannedPhrases(['Ce n’est pas ma faute.'], banned)).toEqual([])
  })

  it('Ibrahima: justifying before acknowledging the anger', () => {
    const p = personaById('ibrahima')
    const t = learner('Monsieur, le double prélèvement vient d’un incident technique chez notre partenaire.')
    const f = buildVoiceFeedback(p, {
      ibrahima_ton_calme: { result: 'success', rationale: 'Ton posé.' },
      ibrahima_laisse_parler: { result: 'success', rationale: 'Il ne l’a pas interrompu.' },
      ibrahima_emotion_reconnue: { result: 'failure', rationale: 'Il a dit « le double prélèvement vient d’un incident technique » sans reconnaître la colère.' },
    }, t)
    expect(f.objectiveMet).toBe(false)
    expect(f.retryInvited).toBe(true)
  })

  it('Ibrahima: the calm-tone criterion is observed but does not decide the objective (to confirm with Marième)', () => {
    const p = personaById('ibrahima')
    const t = learner('Je comprends votre colère, je vous écoute.')
    const f = buildVoiceFeedback(p, { ...all(p, 'success'), ibrahima_ton_calme: { result: 'failure', rationale: 'Réponse sèche.' } }, t)
    expect(f.objectiveMet).toBe(true)
    expect(f.criteria.find(c => c.id === 'ibrahima_ton_calme')!.result).toBe('failure')
  })

  it('Kader: a vague answer is no refusal, whatever the analysis says', () => {
    const p = personaById('kader')
    const t = learner('Je vais voir ce que je peux faire, ça devrait être possible.')
    const f = buildVoiceFeedback(p, all(p, 'success'), t)
    const c = f.criteria.find(x => x.id === 'kader_non_clair')!
    expect(c.result).toBe('unknown')
    expect(c.rationaleFr).toBe(GUARD_RATIONALE_FR.noRefusal)
    expect(f.objectiveMet).toBe(false)
  })

  it('Kader: giving in on the second insistence is a failure the analysis reports, and it stands', () => {
    const p = personaById('kader')
    const t = learner('Non, ce n’est pas couvert.', 'Bon, d’accord, je vais faire une exception pour vous.')
    const f = buildVoiceFeedback(p, { ...all(p, 'success'), kader_non_clair: { result: 'failure', rationale: 'Il a dit « je vais faire une exception pour vous ».' } }, t)
    expect(f.criteria.find(x => x.id === 'kader_non_clair')!.result).toBe('failure')
    expect(f.objectiveMet).toBe(false)
  })

  it('Awa: a vague commitment is no commitment; « la semaine dernière » is not a time frame', () => {
    const p = personaById('awa')
    const t = learner('Je suis désolé. Vous avez appelé la semaine dernière, quelqu’un va regarder votre dossier.')
    const f = buildVoiceFeedback(p, all(p, 'success'), t)
    const c = f.criteria.find(x => x.id === 'awa_engagement_precis')!
    expect(c.result).toBe('unknown')
    expect(c.rationaleFr).toBe(GUARD_RATIONALE_FR.noTimeFrame)
    expect(f.objectiveMet).toBe(false)
  })

  it('Awa: justifying the missed call fails the welcome criterion', () => {
    const p = personaById('awa')
    const t = learner('Nous avons beaucoup d’appels en ce moment. Je vous rappelle demain.')
    const f = buildVoiceFeedback(p, { ...all(p, 'success'), awa_accueil_sans_justification: { result: 'failure', rationale: 'Il a dit « Nous avons beaucoup d’appels en ce moment ».' } }, t)
    expect(f.objectiveMet).toBe(false)
  })
})

describe('no self-resolution, including the disguised closed question', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: confirming the customer\'s own summary never meets the objective', (_id, p) => {
    const t = turns(
      ['agent', p.openingLineFr],
      ['agent', 'Donc si je comprends bien, vous allez régler mon problème, c’est bien ça ?'],
      ['learner', 'Oui, c’est ça.'],
      ['learner', 'D’accord, madame.'],
      ['learner', 'Exactement.'],
    )
    const f = buildVoiceFeedback(p, all(p, 'success'), t)
    expect(f.objectiveMet).toBe(false)
    expect(f.retryInvited).toBe(true)
    for (const id of p.objectiveCriterionIds) {
      const c = f.criteria.find(x => x.id === id)!
      expect(c.result, id).toBe('failure')
      expect(c.rationaleFr).toBe(GUARD_RATIONALE_FR.bareConfirmations)
    }
  })

  it('bare confirmations are recognised, sentences of the learner\'s own are not', () => {
    for (const s of ['Oui.', 'D’accord', 'Ok, ok.', 'Exactement, c’est ça.', 'Tout à fait, monsieur.', 'Hum… oui.']) expect(isBareConfirmation(s), s).toBe(true)
    for (const s of ['Oui, je comprends votre colère.', 'D’accord, je vous rappelle demain.', 'Je vois que vous avez reçu un SMS.']) expect(isBareConfirmation(s), s).toBe(false)
  })

  it('no learner words at all: the objective is « unknown », never met', () => {
    for (const p of VOICE_PERSONAS) {
      const f = buildVoiceFeedback(p, all(p, 'success'), turns(['agent', p.openingLineFr]))
      expect(f.objectiveMet, p.id).toBe(false)
      for (const id of p.objectiveCriterionIds) expect(f.criteria.find(c => c.id === id)!.rationaleFr).toBe(GUARD_RATIONALE_FR.noLearnerTurn)
    }
  })
})

describe('the guards only ever lower a verdict', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: a failure or an unknown from the analysis is never raised', (_id, p) => {
    const strong = learner(...p.objective.examplesFr.map(e => e.replace(/^«\s*|\s*»$/g, '')))
    const failed = buildVoiceFeedback(p, all(p, 'failure'), strong)
    expect(failed.criteria.every(c => c.result === 'failure')).toBe(true)
    const unknown = buildVoiceFeedback(p, null, strong)
    expect(unknown.criteria.every(c => c.result === 'unknown')).toBe(true)
    expect(unknown.objectiveMet).toBe(false)
  })
})

// ── Provisioning readiness ───────────────────────────────────────────────────

describe('agent manifest: deterministic, reviewable, never sent anywhere by the code', () => {
  const manifest = buildAgentManifest()

  it('the same registry always gives the same manifest, and key order does not matter', () => {
    expect(buildAgentManifest()).toEqual(manifest)
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  })

  it('one entry per persona, five distinct fingerprints, opening lines as first messages', () => {
    expect(manifest.personas.map(e => e.personaId)).toEqual(['amara', 'fatou', 'ibrahima', 'kader', 'awa'])
    expect(new Set(manifest.personas.map(e => e.fingerprint)).size).toBe(5)
    for (const e of manifest.personas) {
      const p = personaById(e.personaId)
      expect(e.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(e.payload.conversation_config.agent.first_message).toBe(p.openingLineFr)
      expect(e.payload.conversation_config.agent.language).toBe('fr')
      expect(e.payload.platform_settings.evaluation.criteria.map(c => c.id)).toEqual(p.observationCriteria.map(c => c.id))
    }
  })

  it('any change to a persona changes its fingerprint', () => {
    const p = personaById('ibrahima')
    const edited = { ...p, objective: { ...p.objective, nonExamplesFr: [...p.objective.nonExamplesFr, 'Une ligne de plus.'] } }
    expect(payloadFingerprint(toAgentPayload(edited))).not.toBe(payloadFingerprint(toAgentPayload(p)))
  })

  it('no retention, privacy, voice or override setting rides along with the payload', () => {
    for (const e of manifest.personas) {
      expect(Object.keys(e.payload).sort()).toEqual(['conversation_config', 'name', 'platform_settings'])
      expect(Object.keys(e.payload.platform_settings)).toEqual(['evaluation'])
      expect(JSON.stringify(e.payload)).not.toMatch(/retention_days|zero_retention|"privacy"|"overrides"|"voice_id"/)
    }
  })

  it('the committed manifest is exactly the builder\'s output', () => {
    const expected = `${JSON.stringify(manifest, null, 2)}\n`
    if (WRITE) writeFileSync(join(root, 'lib/voice/agents.manifest.json'), expected, 'utf8')
    expect(read('lib/voice/agents.manifest.json').replace(/\r\n/g, '\n')).toBe(expected)
  })

  it('nothing in the repository creates or updates an ElevenLabs agent', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(root, rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && read(rel).includes('/convai/agents')) hits.push(rel)
      }
    }
    for (const d of ['app', 'lib', 'scripts', 'components']) walk(d)
    expect(hits).toEqual(['scripts/voice/compare-agents.mjs'])
    const script = read('scripts/voice/compare-agents.mjs')
    expect(script).not.toMatch(/method\s*:/)
    expect(script).not.toMatch(/agents\/create|PATCH|POST|PUT|DELETE/)
  })
})

describe('compare-agents: a read-only diff that prints hashes, never text', () => {
  const load = async () => import(/* @vite-ignore */ pathToFileURL(join(root, 'scripts/voice/compare-agents.mjs')).href)
  const entry = buildAgentManifest().personas.find(e => e.personaId === 'ibrahima')!

  it('identical agent: every field matches', async () => {
    const { compareAgent } = await load()
    const rows = compareAgent(entry.payload, structuredClone(entry.payload))
    expect(rows.length).toBe(3 + 3)
    expect(rows.every((r: { match: boolean }) => r.match)).toBe(true)
  })

  it('a different prompt, a missing criterion and an extra one are all reported, without their text', async () => {
    const { compareAgent } = await load()
    const live = structuredClone(entry.payload) as Record<string, any>
    live.conversation_config.agent.prompt.prompt = 'Ancien prompt de l’agent en service.'
    live.platform_settings.evaluation.criteria = [
      ...live.platform_settings.evaluation.criteria.slice(1),
      { id: 'old_criterion', conversation_goal_prompt: 'x' },
    ]
    const rows = compareAgent(entry.payload, live) as { field: string; expected: string; live: string; match: boolean }[]
    expect(rows.find(r => r.field === 'prompt')!.match).toBe(false)
    expect(rows.find(r => r.field === 'criterion ibrahima_ton_calme')!.live).toBe('absent')
    expect(rows.find(r => r.field === 'criterion old_criterion')!.live).toBe('extra')
    const printed = JSON.stringify(rows)
    expect(printed).not.toContain('Ancien prompt')
    expect(printed).not.toContain(entry.payload.conversation_config.agent.prompt.prompt.slice(0, 40))
  })

  it('arguments are persona=agent pairs only', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['ibrahima=agent_01abcdEF'])).toEqual([{ personaId: 'ibrahima', agentId: 'agent_01abcdEF' }])
    expect(parseArgs([])).toBeNull()
    expect(parseArgs(['ibrahima=../../etc'])).toBeNull()
    expect(parseArgs(['--write', 'ibrahima=agent_01abcdEF'])).toBeNull()
  })
})

describe('the approval dossier for Marième', () => {
  const dossier = buildApprovalDossierFr()

  it('separates exact source text from proposals for every exercise, and asks the open questions', () => {
    expect(dossier.match(/^### Texte source exact$/gm)).toHaveLength(7)
    expect(dossier.match(/^### Proposition à valider$/gm)).toHaveLength(6)
    expect(dossier.match(/^### Points à confirmer$/gm)).toHaveLength(5)
    expect(dossier).toContain('**Statut : proposition, non approuvée.**')
    for (const p of VOICE_PERSONAS) {
      expect(dossier).toContain(`« ${p.openingLineFr} »`)
      for (const c of p.observationCriteria) {
        expect(dossier).toContain(`**${c.labelFr}** (source : « ${c.sourceEn} »)`)
        expect(dossier).toContain(c.successWhenFr)
        expect(dossier).toContain(c.failureWhenFr)
      }
      for (const n of p.objective.nonExamplesFr) expect(dossier).toContain(n)
      expect(dossier).toContain(p.endings.failureFr)
    }
  })

  it('lists Fatou\'s forbidden phrases with their source, and every feedback wording', () => {
    const o = personaById('fatou').objective
    o.bannedPhrasesEn!.forEach((en, i) => expect(dossier).toContain(`| « ${en} » | « ${o.bannedPhrasesFr![i]} » |`))
    for (const l of Object.values(RESULT_LABEL_FR)) expect(dossier).toContain(l)
    expect(dossier).toContain(GUARD_RATIONALE_FR.bareConfirmations)
    expect(dossier).toContain(GUARD_RATIONALE_FR.noRefusal)
    expect(dossier).toContain(GUARD_RATIONALE_FR.noTimeFrame)
  })

  it('reads without code: no identifiers, no file names except the generation note', () => {
    const body = dossier.split('\n---\n')[0]
    expect(body).not.toMatch(/\b[a-z]+_[a-z_]+\b/)
    expect(body).not.toMatch(/lib\/|\.ts\b|ElevenLabs|agent_id/)
  })

  it('the committed dossier is exactly the generated one', () => {
    if (WRITE) writeFileSync(join(root, 'docs/voice/F2-DOSSIER-APPROBATION.md'), dossier, 'utf8')
    expect(read('docs/voice/F2-DOSSIER-APPROBATION.md').replace(/\r\n/g, '\n')).toBe(dossier)
  })
})
