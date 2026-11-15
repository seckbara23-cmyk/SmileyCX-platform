/**
 * XP-VOICE-FIX-01 — the hard-coded voice blocker is replaced by a reviewed,
 * environment-controlled switch, and the F2 exercises are complete enough to
 * render for an authorised learner.
 *
 * The switch: `VOICE_PRACTICE_OPEN` = the feature flag AND the published legal
 * texts' version, which must name the consent version learners accept. Every
 * combination short of both stays closed, a stale version included.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VOICE_PERSONAS } from '@/lib/voice/personas'
import { personaSelfAssessment, SELF_ASSESSMENT_SCALE_FR, SELF_ASSESSMENT_OPEN_QUESTION_FR } from '@/lib/voice/self-assessment'
import { VOICE_CONSENT_VERSION } from '@/lib/voice/consent-version'

vi.mock('server-only', () => ({}))

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

async function flagsWith(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return import('@/lib/ai/flags')
}

describe('the public switch: feature flag AND the published legal texts\' version', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  const cases: [string, Record<string, string>, boolean][] = [
    ['nothing set', { NEXT_PUBLIC_AI_VOICE_ENABLED: '', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: '' }, false],
    ['the feature flag alone', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: '' }, false],
    ['the legal version alone', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'false', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: VOICE_CONSENT_VERSION }, false],
    ['a stale legal version', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: 'voix-0.9' }, false],
    ['a version the code has not activated yet', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: 'voix-1.1' }, false],
    ['a near miss in spelling', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: ` ${VOICE_CONSENT_VERSION}` }, false],
    ['a flag that is not exactly "true"', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'TRUE', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: VOICE_CONSENT_VERSION }, false],
    ['both, with the current version', { NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: VOICE_CONSENT_VERSION }, true],
  ]
  for (const [name, env, open] of cases) {
    it(`${name}: ${open ? 'open' : 'closed'}`, async () => {
      const flags = await flagsWith({ NEXT_PUBLIC_VOICE_UAT: '', ...env })
      expect(flags.VOICE_PRACTICE_OPEN).toBe(open)
      expect(flags.VOICE_LESSON_PROBE).toBe(open)
    })
  }

  it('opened publicly, the server gate answers « open » without reading any UAT list', async () => {
    await flagsWith({ NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: VOICE_CONSENT_VERSION, VOICE_UAT_USER_IDS: '' })
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => { throw new Error('must not be read') } }))
    const access = await import('@/lib/voice/access')
    expect(await access.voiceGateForCaller()).toBe('open')
    expect(access.voiceGateFor(null)).toBe('open')
    vi.doUnmock('@/lib/supabase/server')
  })

  it('closed publicly and no UAT list: « closed » for everyone', async () => {
    await flagsWith({ NEXT_PUBLIC_AI_VOICE_ENABLED: 'true', NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION: '', VOICE_UAT_USER_IDS: '' })
    const access = await import('@/lib/voice/access')
    expect(await access.voiceGateForCaller()).toBe('closed')
  })

  it('the hard-coded blocker is gone, and nothing else forces the switch', () => {
    const src = read('lib/ai/flags.ts')
    expect(src).not.toMatch(/VOICE_LEGAL_CONDITIONS_BUILT/)
    expect(src).toContain('export const VOICE_PRACTICE_OPEN = AI_VOICE_ENABLED && VOICE_LEGAL_TEXTS_PUBLISHED')
    expect(src).toContain('process.env.NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION === VOICE_CONSENT_VERSION')
    const all = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true })
      .flatMap(d => d.isDirectory() ? all(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : [])
    for (const f of [...all('app'), ...all('lib'), ...all('components')]) {
      expect(read(f), f).not.toMatch(/VOICE_PRACTICE_OPEN\s*=\s*true|VOICE_LEGAL_TEXTS_PUBLISHED\s*=\s*true/)
    }
  })

  it('the consent version is one constant: the switch and the server policy read the same value', async () => {
    expect(read('lib/voice/consent-version.ts')).not.toMatch(/^import/m)
    const policy = await import('@/lib/voice/session-policy')
    expect(policy.VOICE_CONSENT_VERSION).toBe(VOICE_CONSENT_VERSION)
    expect(read('lib/voice/session-policy.ts')).not.toMatch(/VOICE_CONSENT_VERSION\s*=\s*'/)
  })

  it('the variable is documented, and the example leaves voice closed', () => {
    const env = read('.env.example')
    expect(env).toMatch(/^NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION=$/m)
    expect(env).toMatch(/^NEXT_PUBLIC_AI_VOICE_ENABLED=false$/m)
  })
})

describe('the self-assessment after each of the five exercises', () => {
  it('one scale question per reviewed criterion, then one open question, in French', () => {
    for (const p of VOICE_PERSONAS) {
      const qs = personaSelfAssessment(p)
      expect(qs).toHaveLength(p.observationCriteria.length + 1)
      expect(new Set(qs.map(q => q.id)).size).toBe(qs.length)
      p.observationCriteria.forEach((c, i) => {
        expect(qs[i]).toMatchObject({ id: c.id, type: 'scale' })
        expect(qs[i].question).toMatch(/^Pendant l’échange, avez-vous su [a-zéèêàç]/)
        expect(qs[i].question.endsWith(' ?')).toBe(true)
      })
      expect(qs.at(-1)).toEqual({ id: `${p.id}_prochain_essai`, type: 'text', question: SELF_ASSESSMENT_OPEN_QUESTION_FR })
      expect(qs.map(q => q.question).join(' ')).not.toMatch(/\b(Did|they|the customer)\b/)
    }
  })

  it('the dossier states the same scale as the form', () => {
    const form = read('components/ai/SelfAssessmentForm.tsx')
    expect(form).toContain(`const SCALE_LABELS = [${SELF_ASSESSMENT_SCALE_FR.map(l => `'${l}'`).join(', ')}]`)
  })

  it('the approval dossier lists every question for Marième', () => {
    const dossier = read('docs/voice/F2-DOSSIER-APPROBATION.md')
    for (const p of VOICE_PERSONAS) for (const q of personaSelfAssessment(p)) expect(dossier).toContain(q.question)
  })
})

describe('no server secret can reach the browser', () => {
  const clientFiles = [
    ...readdirSync(join(process.cwd(), 'components/ai')).map(f => `components/ai/${f}`),
    'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx',
    'lib/ai/flags.ts',
    'lib/voice/consent-version.ts',
  ]

  it('client code imports no server-only voice module and reads no provider key', () => {
    for (const f of clientFiles) {
      const src = read(f)
      expect(src, f).not.toMatch(/process\.env(\.|\[\s*['"])(ELEVENLABS_API_KEY|ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VOICE_UAT_USER_IDS)/)
      expect(src, f).not.toMatch(/from '@\/lib\/voice\/(session-policy|elevenlabs|access|erasure|retention)'/)
      expect(src, f).not.toMatch(/from '@\/lib\/supabase\/admin'/)
    }
  })

  it('no public variable carries a key, a secret or the UAT list', () => {
    const publicNames = new Set<string>()
    const scan = (dir: string): void => {
      for (const d of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        if (d.isDirectory()) scan(join(dir, d.name))
        else if (/\.(ts|tsx)$/.test(d.name)) for (const m of read(join(dir, d.name)).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) publicNames.add(m[0])
      }
    }
    for (const dir of ['app', 'lib', 'components']) scan(dir)
    expect([...publicNames].filter(n => /KEY|SECRET|TOKEN|PASSWORD|USER_IDS/.test(n) && n !== 'NEXT_PUBLIC_SUPABASE_ANON_KEY')).toEqual([])
  })

  it('the scenario the page receives carries no agent id, prompt or key', () => {
    const src = read('app/actions/ai-practice.ts')
    const fetchFn = src.slice(src.indexOf('export async function fetchVoiceScenario('), src.indexOf('export async function createAiSession('))
    expect(fetchFn).toContain(".from('public_voice_scenarios')")
    const returned = fetchFn.slice(fetchFn.indexOf('return {'))
    expect(returned).not.toMatch(/agent_id|prompt_template|apiKey|ELEVENLABS_API_KEY\b(?!.*voiceAvailable)/)
  })
})
