/**
 * XP-LAUNCH-FINAL-18 — the published texts promise only what the platform does.
 *
 *   * Certificates (CGU art. 6): every lesson completed, plus the final
 *     evaluation only where the course has one — the rule
 *     `resolveCertificateEligibility` applies. No artificial exam requirement.
 *   * Voice practice (CGU art. 7, CGV art. 8, privacy policy art. 3 and 6): not
 *     open yet. No five-attempt counter and no consent step exist, so the texts
 *     promise neither as a present feature, and the code keeps voice practice
 *     closed whatever the environment flag says.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CGU, CGV, PRIVACY, legalTextPlain } from '@/lib/legal/documents'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const section = (doc: typeof CGU, id: string) => {
  const s = doc.sections.find(x => x.id === id)
  if (!s) throw new Error(`no section ${id}`)
  return JSON.stringify(s.blocks)
}

describe('certificates: the CGU state the rule the platform applies', () => {
  const art6 = section(CGU, 'article-6')

  it('a certificate follows the completion of every lesson, and the final evaluation only where the course has one', () => {
    expect(art6).toContain('suivi toutes les leçons')
    expect(art6).toContain('si cette formation comporte une évaluation finale')
    expect(art6).not.toMatch(/À la fin d’une formation et après réussite à l’évaluation finale/)
  })

  it('keeps what was already true: QR verification, not a state diploma, valid after access ends', () => {
    expect(art6).toContain('QR code')
    expect(art6).toContain('ni d’un diplôme d’État')
    expect(art6).toContain('reste valide après la fin de votre accès')
  })

  it('matches the code: lessons first, the exam only when requires_final_exam is set', () => {
    const src = read('lib/learn/assessment.ts')
    expect(src).toContain('lessons_incomplete')
    expect(src).toMatch(/if \(!requiresExam\)/)
  })
})

describe('voice practice: no text promises it as a present feature', () => {
  const all = [legalTextPlain(CGU), legalTextPlain(CGV), legalTextPlain(PRIVACY)].join('\n')

  it('nowhere a five-attempt counter or a remaining-attempts display', () => {
    expect(all).not.toMatch(/5 essais/)
    expect(all).not.toMatch(/compteur/i)
    expect(all).not.toMatch(/essais restants/)
  })

  it('each voice passage says it is not open yet', () => {
    for (const s of [section(CGU, 'article-7'), section(CGV, 'article-8'), section(PRIVACY, 'entrainement-vocal')]) {
      expect(s).toContain('n’est pas encore ouvert')
    }
  })

  it('consent is a condition of the future opening, and the conditions come in a new version of the texts', () => {
    expect(section(PRIVACY, 'entrainement-vocal')).toContain('Vous ne pourrez utiliser l’entraînement qu’après avoir accepté ce traitement')
    expect(section(CGU, 'article-7')).toContain('seront publiées dans une nouvelle version')
    expect(section(CGV, 'article-8')).toContain('ne réduiront rien de ce qui a déjà été acheté')
  })
})

describe('identity: XP CLIENT SUARL is the entity, XP Client Consulting its brand (XP-LAUNCH-FINAL-19)', () => {
  it('the CGU and the legal notice name the entity with its registration and the brand as commercial name', async () => {
    const { LEGAL_NOTICE } = await import('@/lib/legal/documents')
    for (const s of [section(CGU, 'article-1'), section(LEGAL_NOTICE, 'editeur')]) {
      expect(s).toContain('XP CLIENT')
      expect(s).toContain('SUARL')
      expect(s).toContain('SN.DKR.2026.B.38780')
      expect(s).toContain('Nom commercial : XP Client Consulting')
      expect(s).not.toContain('Nom commercial : XP Client Academy')
    }
  })

  it('the footer shows the brand beside the entity; certificates keep the brand as issuer', async () => {
    const brand = await import('@/lib/brand')
    expect(brand.BRAND_LEGAL_NAME).toBe('XP Client Consulting')
    expect(brand.BRAND_LEGAL_ENTITY).toBe('XP CLIENT SUARL')
    expect(read('components/layout/Footer.tsx')).toContain('© {year} {BRAND_LEGAL_NAME} — {BRAND_LEGAL_ENTITY}.')
    expect(read('lib/pdf/CertificatePDF.tsx')).toContain('XP Client Consulting')
    expect(read('app/(platform)/certificates/[certificateId]/CertificateView.tsx')).toContain('XP Client Consulting')
  })
})

describe('voice practice is closed in code, whatever the environment says', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('the legal conditions are not built, so the switch is off even with the env flag on', async () => {
    vi.stubEnv('NEXT_PUBLIC_AI_VOICE_ENABLED', 'true')
    vi.resetModules()
    const flags = await import('@/lib/ai/flags')
    expect(flags.AI_VOICE_ENABLED).toBe(true)
    expect(flags.VOICE_LEGAL_CONDITIONS_BUILT).toBe(false)
    expect(flags.VOICE_PRACTICE_OPEN).toBe(false)
  })

  it('the lesson page consults only the closed switch', () => {
    const page = read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx')
    expect(page).toContain('VOICE_PRACTICE_OPEN')
    expect(page).not.toMatch(/\bAI_VOICE_ENABLED\b/)
  })

  it('both actions that open a voice session refuse first, before any identity or provider call', () => {
    const src = read('app/actions/ai-practice.ts')
    for (const fn of ['createAiSession', 'startVoiceSession']) {
      const body = src.slice(src.indexOf(`export async function ${fn}(`))
      const guard = body.indexOf('if (!VOICE_PRACTICE_OPEN) return')
      expect(guard, fn).toBeGreaterThan(-1)
      expect(guard, fn).toBeLessThan(body.indexOf('createClient()'))
      expect(guard, fn).toBeLessThan(body.indexOf('safeParse('))
    }
  })
})
