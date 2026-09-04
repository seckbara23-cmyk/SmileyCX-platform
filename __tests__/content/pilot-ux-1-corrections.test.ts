/**
 * PILOT-UX-1 — learner-facing corrections from Marième's pilot document
 * ("XP CLIENT ACADEMY — Corrections Following the Pilot Phase").
 *
 * Scope is the NON-AI UX/content deltas only:
 *
 *   · the three journeys read "Fondations" / "Intermédiaire" / "Avancé"
 *   · the narrow persona list is replaced by the role-agnostic wording
 *   · the "Ce que nous offrons" section carries the approved copy, with the
 *     label large enough to read as a section title
 *
 * Quizzes, PDF resources, the final exam/certificate, payments, domain and
 * contact infrastructure, and the whole voicebot programme are separate phases
 * and are deliberately NOT asserted here.
 *
 * ── WHY THE COMMENT STRIPPING MATTERS ─────────────────────────────────────
 *
 * The implementation comments quote the obsolete strings in order to explain
 * why they were replaced. An absence assertion that read raw source would pass
 * against prose that says the opposite of what it is checking — the exact
 * false-pass that a B-2.1 assertion once produced. Every absence check below
 * reads comment-stripped source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  PARCOURS, PRICING_PLANS, STATIC_CATALOG, levelLabel, type ParcoursId,
} from '@/app/(public)/courses/content'
import { LEVEL_LABELS } from '@/lib/utils/cn'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const HOME    = 'app/page.tsx'
const CONTENT = 'app/(public)/courses/content.ts'
const COURSES = 'app/(public)/courses/page.tsx'

const OBSOLETE_AUDIENCE = 'Agents, assistants, clients, entrepreneurs'
const APPROVED_AUDIENCE = 'Toute personne en contact avec des clients, quel que soit son métier'
const APPROVED_LEAD     = 'Choisissez un parcours de formation adapt'

// ══════════════════════════════════════════════════════════════════════════
describe('PILOT-UX-1 — journey terminology', () => {
  it('the three journeys read Fondations / Intermédiaire / Avancé', () => {
    expect(PARCOURS.map(p => p.label)).toEqual(['Fondations', 'Intermédiaire', 'Avancé'])
  })

  it('no journey is still labelled "Débutant" anywhere learner-facing', () => {
    for (const p of PARCOURS) {
      expect(p.label).not.toBe('Débutant')
      expect(p.badge).not.toContain('Débutant')
    }
    for (const plan of PRICING_PLANS) expect(plan.name).not.toContain('Débutant')
    for (const c of STATIC_CATALOG) expect(c.level).not.toBe('Débutant')
  })

  it('the first journey badge and pricing plan both say Fondations', () => {
    expect(PARCOURS[0].badge).toBe('Parcours Fondations')
    expect(PRICING_PLANS[0].name).toBe('Parcours Fondations')
  })

  it('INTERNAL ids are untouched — presentation must not become schema', () => {
    const ids: ParcoursId[] = ['debutant', 'intermediaire', 'avance']
    expect(PARCOURS.map(p => p.id)).toEqual(ids)
    expect(PRICING_PLANS.map(p => p.id)).toEqual(ids)
    // The catalogue mapping still keys off the internal ids.
    expect(stripJs(read(COURSES))).toMatch(/C1:\s*'debutant'/)
  })

  it('levelLabel resolves the DB value and the legacy label to Fondations', () => {
    expect(levelLabel('beginner')).toBe('Fondations')
    expect(levelLabel('Débutant')).toBe('Fondations')   // legacy input still resolves
    expect(levelLabel('Fondations')).toBe('Fondations')
    expect(levelLabel('intermediate')).toBe('Intermédiaire')
    expect(levelLabel('advanced')).toBe('Avancé')
  })

  it('the shared LEVEL_LABELS map agrees, so cards and detail pages match', () => {
    expect(LEVEL_LABELS.beginner).toBe('Fondations')
    expect(LEVEL_LABELS.intermediate).toBe('Intermédiaire')
    expect(LEVEL_LABELS.advanced).toBe('Avancé')
  })

  it('every static Fondations course carries the new level label', () => {
    const first = STATIC_CATALOG.filter(c => c.parcours === 'debutant')
    expect(first.length).toBeGreaterThan(0)
    for (const c of first) expect(c.level).toBe('Fondations')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PILOT-UX-1 — audience wording', () => {
  it('the approved role-agnostic wording is present', () => {
    expect(PARCOURS[0].bullets).toContain(APPROVED_AUDIENCE)
  })

  it('the obsolete persona list is gone from every journey bullet', () => {
    for (const p of PARCOURS)
      for (const b of p.bullets) expect(b).not.toBe(OBSOLETE_AUDIENCE)
  })

  it('the obsolete string survives only as explanatory prose, never as copy', () => {
    // Raw source still mentions it (the comment explains the replacement);
    // comment-stripped source must not.
    expect(stripJs(read(CONTENT))).not.toContain(OBSOLETE_AUDIENCE)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PILOT-UX-1 — homepage "Ce que nous offrons"', () => {
  const home = () => read(HOME)

  it('the section label is still present', () => {
    expect(home()).toContain('Ce que nous offrons')
  })

  it('its font size was increased — no longer text-xs', () => {
    const m = /<span className="([^"]*)">\s*\n?\s*Ce que nous offrons/.exec(home())
    expect(m, 'the label span should be findable').not.toBeNull()
    const cls = m![1]
    expect(cls).not.toMatch(/\btext-xs\b/)
    expect(cls).toMatch(/\btext-(sm|base|lg)\b/)
  })

  it('carries the approved lead sentence', () => {
    expect(home()).toContain(APPROVED_LEAD)
    expect(home()).toContain('votre rythme')
  })

  it('carries the approved benefit list', () => {
    const s = home()
    expect(s).toContain('Accès immédiat')
    expect(s).toContain('Cas pratiques • Quiz • Ressources PDF')
    expect(s).toContain('Mobile, tablette et ordinateur')
  })

  it('the obsolete benefit wording is gone from rendered copy', () => {
    const s = stripJs(home())
    expect(s).not.toContain('Vidéos + ressources PDF')
    expect(s).not.toContain('Mobile & desktop')
  })

  it('the CTA still reads "Voir les formations" and points at /courses', () => {
    expect(home()).toMatch(/href="\/courses"[\s\S]{0,200}Voir les formations/)
  })

  it('the section was not redesigned — layout classes are intact', () => {
    const s = home()
    expect(s).toMatch(/id="formations"/)
    expect(s).toMatch(/cx-section-title/)
    // Responsive grid for the two mode cards still present.
    expect(s).toMatch(/grid sm:grid-cols-2/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PILOT-UX-1 — nothing adjacent regressed', () => {
  it('the courses page still reads PUBLISHED courses only, through RLS', () => {
    const s = stripJs(read(COURSES))
    expect(s).toContain('getPublishedCoursesByCatalogue')
    // A public page must never reach for the service-role client.
    expect(s).not.toContain('createAdminClient')
  })

  it('an unknown catalogue is omitted rather than guessed', () => {
    expect(stripJs(read(COURSES))).toMatch(/if \(!parcours\) continue/)
  })

  it('no learner-facing SmileyCX residue in public routes', () => {
    for (const f of [HOME, CONTENT, COURSES, 'components/layout/Footer.tsx']) {
      const s = stripJs(read(f))
      expect(s, `${f} carries brand residue`).not.toMatch(/SmileyCX|CX Academy/)
    }
  })

  it('every footer quick link resolves to a real route', () => {
    const footer = read('components/layout/Footer.tsx')
    const hrefs = [...footer.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    for (const h of hrefs) {
      if (!h.startsWith('/')) continue
      const seg = h === '/' ? '' : h.slice(1)
      const candidates = seg === ''
        ? ['app/page.tsx']
        : [
            `app/(public)/${seg}/page.tsx`,
            `app/(auth)/${seg}/page.tsx`,
            `app/(platform)/${seg}/page.tsx`,
            `app/${seg}/page.tsx`,
          ]
      expect(candidates.some(c => existsSync(join(ROOT, c))), `dead link: ${h}`).toBe(true)
    }
  })

  it('every pricing CTA points somewhere real', () => {
    for (const plan of PRICING_PLANS) {
      const path = plan.ctaHref.split('?')[0]
      const seg = path.slice(1)
      const candidates = [
        `app/(public)/${seg}/page.tsx`,
        `app/(auth)/${seg}/page.tsx`,
        `app/(platform)/${seg}/page.tsx`,
      ]
      expect(candidates.some(c => existsSync(join(ROOT, c))), `dead CTA: ${plan.ctaHref}`).toBe(true)
    }
  })

  it('pricing remains visible on the courses page', () => {
    const view = stripJs(read('app/(public)/courses/CoursesView.tsx'))
    expect(view).toContain('<PricingSection />')
    expect(stripJs(read('app/(public)/courses/_components/PricingSection.tsx'))).toContain('PRICING_PLANS')
  })

  it('course filtering by selected journey still works off the internal id', () => {
    const view = stripJs(read('app/(public)/courses/CoursesView.tsx'))
    expect(view).toMatch(/courses\.filter\(c => c\.parcours === selected\)/)
  })
})
