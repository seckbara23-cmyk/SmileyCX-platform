/**
 * UAT-FU-3 — journey cards reflect what is actually published.
 *
 * Marième (19 August 2026): "the intermediate and advanced parcours catalogue
 * buttons need correct published / upcoming course behaviour."
 *
 * On /courses each of the three journeys (Fondations / Intermédiaire / Avancé)
 * offered "Voir les formations" unconditionally. For a journey with nothing
 * published that button scrolled the learner onto "Aucune formation dans ce
 * parcours pour le moment" — an action that leads nowhere.
 *
 * Owner rulings implemented here:
 *
 *   · journey cards only — pricing is out of scope
 *   · 0 published courses → the journey still shows, with "Bientôt disponible",
 *     and NO actionable CTA: no button, no link, no /contact, no scroll
 *   · ≥1 published course → "Voir les formations" exactly as before
 *   · the state is DERIVED from the published list, never hard-coded, so
 *     Avancé opens by itself when the first C3 course is published
 *   · Q-E holds: no future titles, counts, placeholders or unpublished content
 *
 * ── HOW THIS IS PROVEN ────────────────────────────────────────────────────
 *
 * The helper is tested as a pure function. ParcoursCard and CoursesView are
 * RENDERED in jsdom and clicked, so the CTA, filter and scroll assertions are
 * behavioural, not source reads. CoursesView's unrelated children (hero,
 * pricing, benefits, course cards) are stubbed so the test observes only the
 * journey cards and which published courses the list shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PARCOURS, PRICING_PLANS, parcoursAvailability,
  type CourseItem, type ParcoursId,
} from '@/app/(public)/courses/content'
import ParcoursCard from '@/app/(public)/courses/_components/ParcoursCard'
import CoursesView from '@/app/(public)/courses/CoursesView'

vi.mock('@/app/(public)/courses/_components/CoursesHero', () => ({ default: () => null }))
vi.mock('@/app/(public)/courses/_components/PricingSection', () => ({ default: () => null }))
vi.mock('@/app/(public)/courses/_components/BenefitsStrip', () => ({ default: () => null }))
vi.mock('@/app/(public)/courses/_components/CourseCard', async () => {
  const { createElement: h } = await import('react')
  return {
    default: ({ course }: { course: { title: string; parcours: string } }) =>
      h('article', { 'data-testid': 'course-card', 'data-parcours': course.parcours }, course.title),
  }
})

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const strip = (s: string) =>
  s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const VIEW = 'app/(public)/courses/CoursesView.tsx'
const CARD = 'app/(public)/courses/_components/ParcoursCard.tsx'
const PAGE = 'app/(public)/courses/page.tsx'
const PRICING = 'app/(public)/courses/_components/PricingSection.tsx'

const byId = (id: ParcoursId) => PARCOURS.find(p => p.id === id)!

function course(parcours: ParcoursId, n: number): CourseItem {
  return {
    slug: `${parcours}-${n}`, title: `Formation ${parcours} ${n}`, desc: '', duration: '',
    level: '', image: null, available: true, parcours,
  }
}
const many = (parcours: ParcoursId, count: number) =>
  Array.from({ length: count }, (_, i) => course(parcours, i + 1))

/** The shape production serves today: Fondations 3 · Intermédiaire 4 · Avancé 0. */
const TODAY: CourseItem[] = [...many('debutant', 3), ...many('intermediaire', 4)]

const cardFor = (id: ParcoursId) =>
  screen.getByText(byId(id).badge).closest('.cx-card') as HTMLElement

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE HELPER — pure, data-derived
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-FU-3 — parcoursAvailability', () => {
  it('a journey with 0 published courses is upcoming', () => {
    expect(parcoursAvailability([])).toEqual({
      debutant: 'upcoming', intermediaire: 'upcoming', avance: 'upcoming',
    })
  })

  it('a single published course is enough to make a journey available', () => {
    const state = parcoursAvailability([course('avance', 1)])
    expect(state.avance).toBe('available')
    expect(state.debutant).toBe('upcoming')
    expect(state.intermediaire).toBe('upcoming')
  })

  it("today's catalogue: Fondations and Intermédiaire available, Avancé upcoming", () => {
    expect(parcoursAvailability(TODAY)).toEqual({
      debutant: 'available', intermediaire: 'available', avance: 'upcoming',
    })
  })

  it('is data-derived, not hard-coded — a different empty journey flips the state', () => {
    const state = parcoursAvailability([...many('intermediaire', 2), course('avance', 1)])
    expect(state.debutant).toBe('upcoming')
    expect(state.avance).toBe('available')
    expect(state.intermediaire).toBe('available')
  })

  it('a placeholder (available: false) never opens a journey', () => {
    const placeholder = { ...course('avance', 1), available: false }
    expect(parcoursAvailability([placeholder]).avance).toBe('upcoming')
  })

  it('answers for every journey with one of two states, and discloses nothing else', () => {
    const state = parcoursAvailability(TODAY)
    expect(Object.keys(state).sort()).toEqual(PARCOURS.map(p => p.id).sort())
    for (const v of Object.values(state)) expect(['available', 'upcoming']).toContain(v)
  })

  it('does not mutate the course list it is given', () => {
    const frozen = Object.freeze(TODAY.map(c => Object.freeze({ ...c })))
    expect(() => parcoursAvailability(frozen)).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE CARD — rendered
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-FU-3 — ParcoursCard', () => {
  it('an available journey offers "Voir les formations" and selects the journey', () => {
    const onSelect = vi.fn()
    render(createElement(ParcoursCard, { parcours: byId('intermediaire'), availability: 'available', onSelect }))

    const cta = screen.getByRole('button', { name: /Voir les formations/ })
    fireEvent.click(cta)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('intermediaire')
    expect(screen.queryByText('Bientôt disponible')).toBeNull()
  })

  it('an upcoming journey shows "Bientôt disponible" and no action of any kind', () => {
    const onSelect = vi.fn()
    const { container } = render(createElement(ParcoursCard, { parcours: byId('avance'), availability: 'upcoming', onSelect }))

    expect(screen.getByText('Bientôt disponible')).toBeInTheDocument()
    expect(screen.queryByText(/Voir les formations/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    // Nothing focusable or clickable at all — not merely a disabled button.
    expect(container.querySelector('a, button, [role="button"], [tabindex], [href]')).toBeNull()

    fireEvent.click(screen.getByText('Bientôt disponible'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('the upcoming journey is still shown normally', () => {
    const avance = byId('avance')
    render(createElement(ParcoursCard, { parcours: avance, availability: 'upcoming', onSelect: vi.fn() }))
    expect(screen.getByText(avance.badge)).toBeInTheDocument()
    expect(screen.getByText(avance.title)).toBeInTheDocument()
    expect(screen.getByText(avance.desc)).toBeInTheDocument()
    for (const b of avance.bullets) expect(screen.getByText(b)).toBeInTheDocument()
  })

  it('the upcoming state adds nothing but its label — no count, title or catalogue detail', () => {
    const avance = byId('avance')
    const upcoming = render(createElement(ParcoursCard, { parcours: avance, availability: 'upcoming', onSelect: vi.fn() }))
    const upText = upcoming.container.textContent ?? ''
    upcoming.unmount()
    const available = render(createElement(ParcoursCard, { parcours: avance, availability: 'available', onSelect: vi.fn() }))
    const avText = available.container.textContent ?? ''

    // Identical card apart from the CTA slot: nothing about the journey's
    // contents is revealed by the upcoming state.
    expect(upText.replace('Bientôt disponible', '')).toBe(avText.replace('Voir les formations', ''))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE PAGE VIEW — the published list drives the cards
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-FU-3 — CoursesView', () => {
  it("today: Fondations and Intermédiaire offer the action, Avancé shows Bientôt disponible", () => {
    render(createElement(CoursesView, { courses: TODAY }))

    expect(screen.getAllByRole('button', { name: /Voir les formations/ })).toHaveLength(2)
    expect(within(cardFor('debutant')).getByRole('button', { name: /Voir les formations/ })).toBeInTheDocument()
    expect(within(cardFor('intermediaire')).getByRole('button', { name: /Voir les formations/ })).toBeInTheDocument()

    const avance = cardFor('avance')
    expect(within(avance).getByText('Bientôt disponible')).toBeInTheDocument()
    expect(within(avance).queryByRole('button')).toBeNull()
    expect(screen.getAllByText('Bientôt disponible')).toHaveLength(1)
  })

  it('an available journey still filters to its published courses and scrolls to them', () => {
    render(createElement(CoursesView, { courses: TODAY }))

    fireEvent.click(within(cardFor('intermediaire')).getByRole('button', { name: /Voir les formations/ }))

    expect(screen.getByRole('heading', { name: /Formations du parcours Intermédiaire/ })).toBeInTheDocument()
    const shown = screen.getAllByTestId('course-card')
    expect(shown).toHaveLength(4)
    for (const c of shown) expect(c).toHaveAttribute('data-parcours', 'intermediaire')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('an upcoming journey cannot change the list or scroll the learner', () => {
    render(createElement(CoursesView, { courses: TODAY }))
    const before = screen.getByRole('heading', { name: /Formations du parcours/ }).textContent

    fireEvent.click(within(cardFor('avance')).getByText('Bientôt disponible'))

    expect(screen.getByRole('heading', { name: /Formations du parcours/ }).textContent).toBe(before)
    expect(screen.queryByText('Aucune formation dans ce parcours pour le moment.')).toBeNull()
    expect(screen.getAllByTestId('course-card')).toHaveLength(3)
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('the first published C3 course opens Avancé with no code change', () => {
    render(createElement(CoursesView, { courses: [...TODAY, course('avance', 1)] }))

    expect(screen.queryByText('Bientôt disponible')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Voir les formations/ })).toHaveLength(3)

    fireEvent.click(within(cardFor('avance')).getByRole('button', { name: /Voir les formations/ }))
    const shown = screen.getAllByTestId('course-card')
    expect(shown).toHaveLength(1)
    expect(shown[0]).toHaveAttribute('data-parcours', 'avance')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('whichever journey is empty is the one marked — not always Avancé', () => {
    render(createElement(CoursesView, { courses: [...many('debutant', 2), course('avance', 1)] }))

    expect(within(cardFor('intermediaire')).getByText('Bientôt disponible')).toBeInTheDocument()
    expect(within(cardFor('intermediaire')).queryByRole('button')).toBeNull()
    expect(within(cardFor('avance')).getByRole('button', { name: /Voir les formations/ })).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════

describe('UAT-FU-3 — invariants', () => {
  it('Fondations / Intermédiaire / Avancé terminology and internal ids are intact', () => {
    expect(PARCOURS.map(p => p.label)).toEqual(['Fondations', 'Intermédiaire', 'Avancé'])
    expect(PARCOURS.map(p => p.badge)).toEqual(['Parcours Fondations', 'Parcours Intermédiaire', 'Parcours Avancé'])
    expect(PARCOURS.map(p => p.id)).toEqual(['debutant', 'intermediaire', 'avance'])
  })

  it('no journey is singled out in the card or the view — availability comes from data', () => {
    const card = strip(read(CARD))
    for (const id of ["'debutant'", "'intermediaire'", "'avance'"]) expect(card).not.toContain(id)

    const view = strip(read(VIEW))
    expect(view).toMatch(/const availability = parcoursAvailability\(courses\)/)
    expect(view).toMatch(/availability=\{availability\[p\.id\]\}/)
  })

  it('the existing filter-and-scroll path is unchanged', () => {
    const view = strip(read(VIEW))
    expect(view).toMatch(/courses\.filter\(c => c\.parcours === selected\)/)
    expect(view).toMatch(/function selectParcours[\s\S]{0,200}scrollIntoView/)
    expect(strip(read(CARD))).toMatch(/onClick=\{\(\) => onSelect\(parcours\.id\)\}/)
  })

  it('Q-E: /courses is still fed published courses only, with no placeholders', () => {
    const page = strip(read(PAGE))
    expect(page).toMatch(/getPublishedCoursesByCatalogue/)
    expect(page).toMatch(/available:\s*true/)
    expect(page).not.toMatch(/STATIC_CATALOG/)
    expect(strip(read(VIEW))).not.toMatch(/STATIC_CATALOG/)
  })

  it('pricing is out of scope and untouched by FU-3', () => {
    const pricing = strip(read(PRICING))
    expect(pricing).not.toMatch(/parcoursAvailability|availability|Bientôt/)
    expect(PRICING_PLANS.map(p => [p.ctaLabel, p.ctaHref])).toEqual([
      ['Commencer maintenant', '/signup'],
      ['Commencer maintenant', '/signup'],
      ['Demander un devis', '/contact?service=devis'],
    ])
  })
})
