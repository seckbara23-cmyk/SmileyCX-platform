import {
  UserRound, BarChart3, Rocket, Laptop, BadgeCheck,
  Users, MonitorSmartphone, Award, ClipboardList,
  type LucideIcon,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Internal parcours identity. PILOT-UX-1 renamed the FIRST journey's
 * learner-facing label from "Débutant" to "Fondations" per Marième's pilot
 * corrections; the id stays `debutant` on purpose. It is a stable key used for
 * selection state and for the catalogue mapping (C1 → debutant), and renaming
 * a key to match a caption is how presentation quietly becomes schema.
 */
export type ParcoursId = 'debutant' | 'intermediaire' | 'avance'

export type CourseItem = {
  slug: string | null
  title: string
  desc: string
  duration: string
  level: string
  image: string | null
  available: boolean
  parcours: ParcoursId
  /**
   * CAT-02 — the authoritative commercial price, from `courses.price`.
   *
   * Carried on the item rather than fetched by the card, because the catalogue
   * is a cached server-rendered page: the card is a presentation component and
   * must not open its own database read.
   */
  price: number
  currency: string
  /** True only for a deliberately free course. Rendered as "Gratuit". */
  isFree: boolean
}

export type ParcoursConfig = {
  id: ParcoursId
  badge: string
  label: string
  title: string
  desc: string
  bullets: string[]
  tagline: string
  Icon: LucideIcon
  // Static Tailwind classes (never computed — required by the JIT compiler)
  badgeClass: string
  iconWrapClass: string
  iconClass: string
  checkClass: string
  ctaClass: string
  accentTextClass: string
}

// ── Hero ──────────────────────────────────────────────────────────────────────

export const HERO_CHIPS: { Icon: LucideIcon; label: string }[] = [
  { Icon: Laptop,     label: 'En ligne et en présentiel' },
  { Icon: BadgeCheck, label: 'Certificats de réussite' },
]

// ── Parcours ──────────────────────────────────────────────────────────────────

export const PARCOURS: ParcoursConfig[] = [
  {
    id:     'debutant',
    badge:  'Parcours Fondations',
    label:  'Fondations',
    title:  "Pour découvrir les bases de l'expérience client",
    desc:   'Une approche accessible pour poser des fondations solides.',
    bullets: [
      // Pilot correction: the narrower persona list ("Agents, assistants,
      // clients, entrepreneurs") excluded the people the course is actually
      // for. The approved wording is deliberately role-agnostic.
      'Toute personne en contact avec des clients, quel que soit son métier',
      'Approche humaine et structurée',
      'Fondamentaux indispensables',
    ],
    tagline: 'Les fondamentaux indispensables.',
    Icon:    UserRound,
    badgeClass:      'bg-success/10 text-success',
    iconWrapClass:   'bg-success/10',
    iconClass:       'text-success',
    checkClass:      'text-success',
    ctaClass:        'text-success hover:text-success/80',
    accentTextClass: 'text-success',
  },
  {
    id:     'intermediaire',
    badge:  'Parcours Intermédiaire',
    label:  'Intermédiaire',
    title:  "Pour améliorer et piloter l'expérience client",
    desc:   'Des méthodes concrètes pour élever la qualité de service.',
    bullets: [
      'Superviseurs, managers, responsables CX',
      "Pilotage et qualité de l'expérience",
      'Mesurer, analyser et optimiser son service',
    ],
    tagline: "Pilotage et qualité de l'expérience.",
    Icon:    BarChart3,
    badgeClass:      'bg-primary/10 text-primary',
    iconWrapClass:   'bg-primary/10',
    iconClass:       'text-primary',
    checkClass:      'text-primary',
    ctaClass:        'text-primary hover:text-primary-dark',
    accentTextClass: 'text-primary',
  },
  {
    id:     'avance',
    badge:  'Parcours Avancé',
    label:  'Avancé',
    title:  "Pour transformer l'expérience client et créer de la valeur",
    desc:   'Stratégie, gouvernance et transformation customer-centric.',
    bullets: [
      'Managers CX, dirigeants, consultants',
      'Stratégie et transformation',
      "Culture centrée sur l'expérience",
    ],
    tagline: 'Stratégie et transformation client.',
    Icon:    Rocket,
    badgeClass:      'bg-violet-600/10 text-violet-600',
    iconWrapClass:   'bg-violet-600/10',
    iconClass:       'text-violet-600',
    checkClass:      'text-violet-600',
    ctaClass:        'text-violet-600 hover:text-violet-700',
    accentTextClass: 'text-violet-600',
  },
]

// ── Journey availability (UAT-FU-3) ───────────────────────────────────────────

/**
 * Whether a journey can be opened right now. Presentation state only.
 *
 * UAT-FU-3 (Marième): a journey with nothing published must say so, rather
 * than offer "Voir les formations" onto an empty list. The answer is DERIVED
 * from the course list the page already holds — published courses only, read
 * under RLS (`is_published = true`) — so no journey is ever marked by hand. The
 * day the first C3 course is published, Avancé becomes available on its own.
 *
 * Deliberately two values and nothing more: no count, no titles, no planned
 * total. Decision Q-E keeps the roadmap private, and a journey-level
 * "Bientôt disponible" discloses nothing the empty list did not already.
 */
export type ParcoursAvailability = 'available' | 'upcoming'

export function parcoursAvailability(
  courses: ReadonlyArray<Pick<CourseItem, 'parcours' | 'available'>>,
): Record<ParcoursId, ParcoursAvailability> {
  const state = {} as Record<ParcoursId, ParcoursAvailability>
  for (const { id } of PARCOURS) {
    // Everything /courses supplies is available today. Checking the flag anyway
    // means a placeholder card could never make an empty journey look open.
    state[id] = courses.some(c => c.parcours === id && c.available) ? 'available' : 'upcoming'
  }
  return state
}

// ───────────────────────────────────────────────────────
// CAT-02 removed `STATIC_CATALOG`, the pilot-era hardcoded course list.
//
// CAT-ARCH-01 had already stopped the catalogue reading it: /courses is driven
// by `public_catalogue_courses` plus the `courses` rows, and per decision Q-E
// the public site shows only published courses that exist - no placeholder
// cards. The array survived as dead data with zero importers, carrying invented
// titles, `available: false` placeholders and no price at all.
//
// It had to go rather than be extended: CourseItem now requires a price, and
// the only honest price is the one in the database. Adding figures to
// hardcoded rows would have invented prices for courses that do not exist.
// ───────────────────────────────────────────────────────

// ── Pricing ───────────────────────────────────────────────────────────────────

export type PricingPlan = {
  id: ParcoursId
  name: string
  tagline: string
  monthlyPrice: number | null   // null → 'Sur devis'
  features: string[]
  featured: boolean
  ctaLabel: string
  ctaHref: string
  // Static Tailwind classes
  nameClass: string
  priceClass: string
  checkClass: string
  ctaClass: string
  cardClass: string
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id:           'debutant',
    name:         'Parcours Fondations',
    tagline:      'La base pour bien commencer',
    monthlyPrice: 29000,
    features: [
      'Accès à toutes les formations Fondations',
      'Certificat de réussite',
      'Ressources téléchargeables',
      'Support par email',
      'Mises à jour régulières',
    ],
    featured:   false,
    ctaLabel:   'Commencer maintenant',
    ctaHref:    '/signup',
    nameClass:  'text-success',
    priceClass: 'text-dark',
    checkClass: 'text-success',
    ctaClass:   'bg-success text-white hover:bg-success/90',
    cardClass:  'border border-black/[0.08]',
  },
  {
    id:           'intermediaire',
    name:         'Parcours Intermédiaire',
    tagline:      'Progressez avec méthode',
    monthlyPrice: 59000,
    features: [
      'Accès à toutes les formations intermédiaires',
      'Certificat de réussite',
      'Ressources avancées',
      'Support prioritaire',
      "Accès aux conseils d'experts",
    ],
    featured:   true,
    ctaLabel:   'Commencer maintenant',
    ctaHref:    '/signup',
    nameClass:  'text-primary',
    priceClass: 'text-primary',
    checkClass: 'text-primary',
    ctaClass:   'bg-primary text-white hover:bg-primary-dark',
    cardClass:  'border-2 border-primary',
  },
  {
    id:           'avance',
    name:         'Parcours Avancé',
    tagline:      'Maîtrisez la transformation client',
    monthlyPrice: null,
    features: [
      'Formations avancées',
      'Accompagnement personnalisé',
      'Ateliers exclusifs',
      'Rapports et audits avancés',
      "Certificat d'excellence",
    ],
    featured:   false,
    ctaLabel:   'Demander un devis',
    ctaHref:    '/contact?service=devis',
    nameClass:  'text-violet-600',
    priceClass: 'text-violet-600',
    checkClass: 'text-violet-600',
    ctaClass:   'bg-violet-600 text-white hover:bg-violet-700',
    cardClass:  'border border-black/[0.08]',
  },
]

// ── Benefits strip ────────────────────────────────────────────────────────────

export const BENEFITS: { Icon: LucideIcon; title: string; desc: string }[] = [
  {
    Icon:  Users,
    title: 'Apprentissage pratique',
    desc:  'Des méthodes concrètes et applicables immédiatement.',
  },
  {
    Icon:  MonitorSmartphone,
    title: 'En ligne & présentiel',
    desc:  'Apprenez à votre rythme, en ligne ou lors de nos sessions.',
  },
  {
    Icon:  Award,
    title: 'Certificat reconnu',
    desc:  'Valorisez vos compétences avec un certificat.',
  },
  {
    Icon:  ClipboardList,
    title: 'Cas réels & exercices',
    desc:  'Des situations concrètes pour des résultats concrets.',
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

export function levelLabel(level: string): string {
  // 'Débutant' is still accepted as INPUT so any legacy row or cached payload
  // still resolves; the OUTPUT is the approved label.
  if (level === 'beginner' || level === 'Débutant' || level === 'Fondations') return 'Fondations'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'Intermédiaire'
  if (level === 'advanced'     || level === 'Avancé')        return 'Avancé'
  return level
}

/** Format a FCFA amount with thin non-breaking spaces: 29000 → "29 000" */
export function formatFcfa(amount: number): string {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
