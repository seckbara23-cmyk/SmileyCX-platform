/**
 * XP-F2-01/02 — the shared voice-training engine, as configuration and contracts.
 *
 * Source: « Voice Training Exercises — Training F2 » (Marième). The five opening
 * lines below are copied from the document character for character; any edit to
 * a persona's script must update them here, deliberately.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VOICE_PERSONAS, personaBySlug, publicPersona } from '@/lib/voice/personas'
import { COMMON_AGENT_RULES, MAX_REPROMPTS } from '@/lib/voice/agent-rules'
import { buildAgentConfig, buildSystemPrompt } from '@/lib/voice/prompt'
import { buildVoiceFeedback, sanitizeRationale } from '@/lib/voice/feedback'

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const DOCUMENT = {
  amara:    { lesson: 'F2-M2-L4', slug: 'amara-forfait-incompris', opening: "Bonjour, j'ai reçu un message disant que mon forfait allait changer, mais je ne comprends pas du tout ce que ça veut dire. Qu'est-ce qui va se passer exactement ?" },
  fatou:    { lesson: 'F2-M2-L5', slug: 'fatou-mobile-money-bloque', opening: "Ça fait 3 jours que j'attends ! À chaque fois on me dit que c'est en cours. C'est en cours depuis combien de temps ? J'en ai marre !" },
  ibrahima: { lesson: 'F2-M3-L2', slug: 'ibrahima-double-facturation', opening: "Je veux parler à votre responsable ! Vous m'avez prélevé deux fois ce mois-ci et personne ne fait rien ! C'est un scandale !" },
  kader:    { lesson: 'F2-M3-L4', slug: 'kader-remboursement-hors-contrat', opening: "Écoutez, je suis client depuis 5 ans. Je pense que vous pouvez faire une exception pour moi cette fois. Ce n'est pas grand-chose." },
  awa:      { lesson: 'F2-M4-L2', slug: 'awa-reclamation-consommation', opening: "Bonjour, je vous appelle encore pour ma réclamation sur ma consommation. J'ai déjà appelé la semaine dernière et personne ne m'a rappelée. J'en suis vraiment déçue." },
} as const

describe('the five personas, as the document defines them', () => {
  it('exactly five, one per lesson, in the document order', () => {
    expect(VOICE_PERSONAS.map(p => p.id)).toEqual(['amara', 'fatou', 'ibrahima', 'kader', 'awa'])
    expect(VOICE_PERSONAS.map(p => p.exercise.number)).toEqual([1, 2, 3, 4, 5])
  })

  it.each(Object.entries(DOCUMENT))('%s: lesson, scenario id and the exact French opening line', (id, d) => {
    const p = VOICE_PERSONAS.find(x => x.id === id)!
    expect(`F2-M${p.course.moduleOrder}-L${p.course.lessonNumber}`).toBe(d.lesson)
    expect(p.course.code).toBe('C1-F2')
    expect(p.scenarioSlug).toBe(d.slug)
    expect(personaBySlug(d.slug)).toBe(p)
    expect(p.openingLineFr).toBe(d.opening)
    expect(buildAgentConfig(p).firstMessage).toBe(d.opening)
  })

  it('every scenario id is the slug the database already seeds, attached to the same lesson', () => {
    const m024 = read('supabase/migrations/024_ai_practice_phase1.sql')
    const m033 = read('supabase/migrations/033_voice_practice_production.sql')
    for (const p of VOICE_PERSONAS) {
      expect(m024 + m033, p.scenarioSlug).toContain(`'${p.scenarioSlug}'`)
      expect(m033, `${p.id} lesson match`).toContain(`'${p.course.lessonTitleMatch}'`)
    }
  })

  it('each persona is complete: identity, emotion, objective, three criteria, boundaries, endings', () => {
    for (const p of VOICE_PERSONAS) {
      expect(p.customer.situationFr.length, p.id).toBeGreaterThan(20)
      expect(p.emotion.stateFr && p.emotion.reactionsFr, p.id).toBeTruthy()
      expect(p.objective.definitionFr.length, p.id).toBeGreaterThan(40)
      expect(p.objective.examplesFr.length, p.id).toBeGreaterThanOrEqual(1)
      expect(p.objective.nonExamplesFr.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.observationCriteria, p.id).toHaveLength(3)
      for (const id of p.objectiveCriterionIds) expect(p.observationCriteria.map(c => c.id), p.id).toContain(id)
      expect(p.boundariesFr.length, p.id).toBeGreaterThanOrEqual(4)
      expect(p.endings.successFr && p.endings.failureFr, p.id).toBeTruthy()
      expect(new Set(p.observationCriteria.map(c => c.id)).size, p.id).toBe(3)
    }
    const allIds = VOICE_PERSONAS.flatMap(p => p.observationCriteria.map(c => c.id))
    expect(new Set(allIds).size, 'criterion ids are unique across personas').toBe(allIds.length)
  })

  it('Awa is the F1 Awa, and the learner plays Moussa', () => {
    const awa = VOICE_PERSONAS.find(p => p.id === 'awa')!
    expect(awa.customer.identityFr).toContain('F1')
    expect(awa.customer.learnerRoleFr).toContain('Moussa')
  })

  it('the learner never receives agent material', () => {
    for (const p of VOICE_PERSONAS) {
      const pub = JSON.stringify(publicPersona(p))
      for (const hidden of [p.objective.definitionFr, ...p.objective.nonExamplesFr, p.endings.successFr, p.openingLineFr]) {
        expect(pub, p.id).not.toContain(hidden)
      }
    }
  })

  it('persona material stays on the server', () => {
    for (const f of ['lib/voice/personas.ts', 'lib/voice/prompt.ts', 'lib/voice/elevenlabs.ts', 'lib/voice/session-policy.ts']) {
      expect(read(f), f).toMatch(/^import 'server-only'/)
    }
  })
})

describe('the prompt contract every agent follows', () => {
  it.each(VOICE_PERSONAS.map(p => [p.id, p] as const))('%s: every common rule, the objective, the non-examples and the bounded re-prompts', (_id, p) => {
    const prompt = buildSystemPrompt(p)
    for (const rule of COMMON_AGENT_RULES) expect(prompt, rule.id).toContain(rule.textFr)
    expect(prompt).toContain(p.openingLineFr)
    expect(prompt).toContain(p.objective.definitionFr)
    for (const n of p.objective.nonExamplesFr) expect(prompt).toContain(n)
    expect(prompt).toContain(`relance au plus ${MAX_REPROMPTS} fois`)
    expect(prompt).toContain(p.endings.failureFr)
  })

  it('the ten rules of the brief are all there', () => {
    expect(COMMON_AGENT_RULES.map(r => r.id)).toEqual([
      'stay_in_character', 'react_without_taking_over', 'never_self_resolve', 'no_disguised_self_resolution',
      'observable_behaviour_only', 'bounded_reprompts', 'conditional_warm_closing', 'natural_unresolved_ending',
      'no_grades', 'evidence_based_analysis',
    ])
  })

  it('no agent may resolve its own complaint, including the disguised closed question', () => {
    const rule = COMMON_AGENT_RULES.find(r => r.id === 'no_disguised_self_resolution')!.textFr
    expect(rule).toContain('question fermée')
    expect(rule).toMatch(/simple « oui »/)
    for (const p of VOICE_PERSONAS) {
      expect(p.objective.nonExamplesFr.some(n => /Confirmer par « oui »/.test(n)), p.id).toBe(true)
    }
  })

  it('re-prompts are bounded at two for every persona', () => {
    expect(MAX_REPROMPTS).toBe(2)
    for (const p of VOICE_PERSONAS) expect(p.maxReprompts, p.id).toBe(2)
  })

  it('French only, no grades', () => {
    for (const p of VOICE_PERSONAS) {
      const cfg = buildAgentConfig(p)
      expect(cfg.language).toBe('fr')
      expect(cfg.systemPrompt).not.toMatch(/\/\s*10|sur 10|\bscore\b(?! ni)/i)
      expect(cfg.evaluationCriteria.map(c => c.id)).toEqual(p.observationCriteria.map(c => c.id))
      for (const c of cfg.evaluationCriteria) {
        expect(c.conversationGoalPrompt).toContain('Réussite')
        expect(c.conversationGoalPrompt).toContain('Inconnu')
        expect(c.conversationGoalPrompt).toContain('N’invente aucun propos')
      }
    }
  })
})

describe('qualitative feedback: success, failure, unknown — never a score, never invented', () => {
  const amara = VOICE_PERSONAS.find(p => p.id === 'amara')!
  const saidText = ['Si je comprends bien, vous avez reçu un SMS sur votre forfait et vous voulez savoir ce qui change ?']
  const said = saidText.map(text => ({ speaker: 'learner' as const, text }))
  const ok = (r: string) => ({ result: 'success', rationale: r })

  it('objective met: every objective criterion is a success, no retry, no digit', () => {
    const f = buildVoiceFeedback(amara, {
      amara_reformulation: ok('Le conseiller a reformulé : « vous avez reçu un SMS sur votre forfait ».'),
      amara_langage_simple: ok('Phrases courtes, sans jargon.'),
      amara_client_compris: ok('Amara a confirmé avoir été compris.'),
    }, said)
    expect(f.objectiveMet).toBe(true)
    expect(f.retryInvited).toBe(false)
    expect(f.summaryFr).toMatch(/^Objectif atteint/)
    expect(JSON.stringify(f)).not.toMatch(/\d+\s*\/\s*10|score/i)
  })

  it('objective not met: a failure on the key criterion invites a retry', () => {
    const f = buildVoiceFeedback(amara, {
      amara_reformulation: { result: 'failure', rationale: 'Le conseiller a répondu sans reformuler.' },
      amara_langage_simple: ok('Langage simple.'),
    }, said)
    expect(f.objectiveMet).toBe(false)
    expect(f.retryInvited).toBe(true)
    expect(f.criteria.find(c => c.id === 'amara_reformulation')!.resultLabelFr).toBe('À retravailler')
    expect(f.criteria.find(c => c.id === 'amara_client_compris')!.result).toBe('unknown')
  })

  it('a missing analysis is unknown everywhere, never a success', () => {
    const f = buildVoiceFeedback(amara, null, said)
    expect(f.criteria.every(c => c.result === 'unknown')).toBe(true)
    expect(f.objectiveMet).toBe(false)
  })

  it('an unexpected result value is unknown', () => {
    const f = buildVoiceFeedback(amara, { amara_reformulation: { result: 'excellent', rationale: 'x' } }, said)
    expect(f.criteria[0].result).toBe('unknown')
  })

  it('a rationale with a grade is dropped, and its verdict is not trusted', () => {
    expect(sanitizeRationale('Très bien, 8/10.', saidText)).toBeNull()
    expect(sanitizeRationale('Note de 4 sur ce point.', saidText)).toBeNull()
    expect(sanitizeRationale('Réussi à 75 %.', saidText)).toBeNull()
    const f = buildVoiceFeedback(amara, { amara_reformulation: ok('Reformulation réussie, 9/10.') }, said)
    expect(f.criteria[0].result).toBe('unknown')
    expect(f.objectiveMet).toBe(false)
  })

  it('a rationale quoting words the learner never said is dropped', () => {
    expect(sanitizeRationale('Le conseiller a dit « je vous rembourse tout de suite ».', saidText)).toBeNull()
    const f = buildVoiceFeedback(amara, { amara_reformulation: ok('Il a dit « je vous rembourse tout de suite ».') }, said)
    expect(f.criteria[0].result).toBe('unknown')
  })

  it('a rationale quoting the learner faithfully is kept, accents and case aside', () => {
    expect(sanitizeRationale('Il a dit « SI JE COMPRENDS BIEN, vous avez reçu un SMS ».', saidText)).not.toBeNull()
  })

  it('the objective needs every objective criterion', () => {
    const awa = VOICE_PERSONAS.find(p => p.id === 'awa')!
    const f = buildVoiceFeedback(awa, {
      awa_accueil_sans_justification: ok('Accueil sans justification.'),
      awa_empathie_sincere: ok('Déception reconnue.'),
      awa_engagement_precis: { result: 'failure', rationale: 'Aucun délai donné.' },
    }, [{ speaker: 'learner', text: 'Je suis désolé, je vous rappelle demain avant midi.' }])
    expect(f.objectiveMet).toBe(false)
  })
})

describe('migration 066: consent and session mode, never applied by this change', () => {
  const sql = read('supabase/migrations/066_voice_training_foundation.sql')

  it('the consent table has row security, own-row reads and server-only writes', () => {
    expect(sql).toContain('alter table public.voice_processing_consents enable row level security')
    expect(sql).toContain('revoke all on public.voice_processing_consents from public, anon, authenticated, service_role')
    expect(sql).toContain('grant select on public.voice_processing_consents to authenticated')
    expect(sql).toMatch(/using \(user_id = auth\.uid\(\)\)/)
    expect(sql).not.toMatch(/grant\s+(all|insert|update|delete)[^;]*to\s+(anon|authenticated)/i)
    // One policy in the whole migration, and it compares the row's learner with the caller.
    expect(sql.match(/create policy/gi)).toHaveLength(1)
  })

  it('one live VOICE session per learner; self-assessment is never constrained (XP-F2-03)', () => {
    expect(sql).toContain("check (mode in ('voice', 'self'))")
    expect(sql).toMatch(/create unique index if not exists ai_sessions_one_live_voice_per_user\s+on public\.ai_sessions \(user_id\)\s+where status = 'active' and user_id is not null and mode = 'voice';/)
    expect(sql).not.toContain('ai_sessions_one_live_per_user ')
    expect(sql).toContain('provider_conversation_id')
  })

  it('retention and erasure columns, nullable, never back-filled', () => {
    expect(sql).toContain('add column if not exists content_purged_at timestamptz')
    expect(sql).not.toContain('erasure_requested_at')
  })

  it('the attempt ledger holds no content, is server-only and append-only, and starts atomically (XP-F2-READY-01)', () => {
    const table = sql.slice(sql.indexOf('create table public.voice_attempts'), sql.indexOf('comment on table public.voice_attempts'))
    expect(table).toMatch(/user_id\s+uuid\s+not null references auth\.users\(id\) on delete cascade/)
    expect(table).not.toMatch(/transcript|provider|session_id|audio|\btext\b/)
    expect(sql).toContain('grant select, insert on public.voice_attempts to service_role')
    expect(sql).toContain("perform pg_advisory_xact_lock(hashtextextended('voice_start_attempt:' || p_user_id::text, 0))")
    expect(sql).toContain('revoke all on function public.voice_start_attempt(uuid, uuid, timestamptz, integer) from public, anon, authenticated')
    expect(sql).toContain("raise exception 'XP-F2-READY-01 066: voice_start_attempt must be executable by the server only'")
  })

  it('the provider erasure queue names no learner and is server-only (XP-F2-04)', () => {
    const table = sql.slice(sql.indexOf('create table public.voice_provider_erasures'), sql.indexOf('comment on table public.voice_provider_erasures'))
    expect(table).toContain('provider_conversation_id text        primary key')
    expect(table).not.toMatch(/user_id|anon_id|email|session_id|references/)
    expect(sql).toContain('alter table public.voice_provider_erasures enable row level security')
    expect(sql).toContain('revoke all on public.voice_provider_erasures from public, anon, authenticated, service_role')
    expect(sql).toContain('grant select, insert, update on public.voice_provider_erasures to service_role')
    expect(sql).not.toMatch(/create policy[^;]*voice_provider_erasures/i)
    expect(sql).toContain("raise exception 'XP-F2-04 066: the provider erasure queue is not server-only'")
  })

  it('changes no existing row of any table: no UPDATE, no DELETE, no INSERT', () => {
    // The start function's body runs when a learner starts, not when the migration is applied.
    const fn = sql.slice(sql.indexOf('as $fn$'), sql.lastIndexOf('$fn$;'))
    expect(fn.match(/insert into public\.(\w+)/g)).toEqual(['insert into public.ai_sessions', 'insert into public.voice_attempts'])
    const body = sql.split('-- ROLLBACK')[0].replace(fn, '').replace(/^\s*--.*$/gm, '')
    expect(body).not.toMatch(/\bupdate\s+public\./i)
    expect(body).not.toMatch(/\bdelete\s+from\b/i)
    expect(body).not.toMatch(/\binsert\s+into\b/i)
  })

  it('removes the browser roles\' write rights on the learner-owned AI tables, keeps their reads, and asserts it', () => {
    const tables = 'public.ai_sessions, public.ai_turns, public.ai_feedback, public.ai_scores, public.ai_recommendations'
    expect(sql).toContain(`revoke all on ${tables}\n  from anon;`)
    expect(sql).toContain(`revoke insert, update, delete, truncate, references, trigger\n  on ${tables}\n  from authenticated;`)
    expect(sql).toContain("has_table_privilege('authenticated', 'public.ai_sessions', 'TRUNCATE')")
    expect(sql).toContain("not has_table_privilege('authenticated', 'public.ai_sessions', 'SELECT')")
    expect(sql).not.toMatch(/revoke[^;]*ai_scenarios/i)
  })
})

describe('voice practice stays closed, whatever the configuration', () => {
  it('every voice action answers closed before doing anything', async () => {
    const actions = await import('@/app/actions/ai-practice')
    const S = '00000000-0000-4000-8000-000000000001'
    expect(await actions.fetchVoiceScenario(S)).toBeNull()
    expect((await actions.createAiSession({ scenarioId: S })).error).toMatch(/pas encore ouvert/)
    expect((await actions.startVoiceSession({ scenarioId: S })).error).toMatch(/pas encore ouvert/)
    expect((await actions.saveAiTurns({ sessionId: S, turns: [{ speaker: 'learner', transcript: 'x', turnIndex: 0 }] })).error).toMatch(/pas encore ouvert/)
    expect((await actions.completeAiSession({ sessionId: S })).error).toMatch(/pas encore ouvert/)
    expect((await actions.saveSelfAssessment({ sessionId: S, answers: {} })).error).toMatch(/pas encore ouvert/)
    expect(await actions.getSessionCoaching({ sessionId: S })).toBeNull()
    expect((await actions.getVoiceFeedback({ sessionId: S })).error).toMatch(/pas encore ouvert/)
    const consent = await import('@/app/actions/voice-consent')
    expect(await consent.getVoiceConsentStatus()).toBeNull()
    expect((await consent.acceptVoiceConsent({ version: 'voix-1.0', accepted: true })).error).toMatch(/pas encore ouvert/)
  })

  it('the legal conditions are still marked unbuilt', async () => {
    const flags = await import('@/lib/ai/flags')
    expect(flags.VOICE_LEGAL_CONDITIONS_BUILT).toBe(false)
    expect(flags.VOICE_PRACTICE_OPEN).toBe(false)
  })
})
