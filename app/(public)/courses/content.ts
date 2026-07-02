import {
  UserRound, BarChart3, Rocket, Laptop, BadgeCheck,
  Users, MonitorSmartphone, Award, ClipboardList,
  type LucideIcon,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

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
    badge:  'Parcours Débutant',
    label:  'Débutant',
    title:  "Pour découvrir les bases de l'expérience client",
    desc:   'Une approche accessible pour poser des fondations solides.',
    bullets: [
      'Agents, assistants, clients, entrepreneurs',
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

// ── Course catalog (static fallback — DB rows override matching slugs) ────────

export const STATIC_CATALOG: CourseItem[] = [
  // Débutant
  {
    slug:      'fondamentaux-experience-client',
    title:     'Expérience client : les fondamentaux pour fidéliser vos relations',
    desc:      "Découvrez les principes essentiels pour vos clients et posez les bases d'une expérience positive et durable.",
    duration:  '3h',
    level:     'Débutant',
    image:     '/images/Picture5.jpg',
    available: true,
    parcours:  'debutant',
  },
  {
    slug:      'experience-client-memorable',
    title:     'Créer des interactions clients qui donnent envie de revenir',
    desc:      "Maîtrisez la communication, l'écoute active et les techniques de conversation qui permettent d'offrir un service client de qualité.",
    duration:  '2h30',
    level:     'Débutant',
    image:     '/images/Picture3.jpg',
    available: true,
    parcours:  'debutant',
  },
  {
    slug:      'service-client-digital',
    title:     "Les bases d'un service client digital professionnel et performant",
    desc:      'Utilisez les canaux digitaux pour répondre vite, réduire les frictions et offrir une expérience client fluide et moderne.',
    duration:  '2h',
    level:     'Débutant',
    image:     '/images/Elearning.jpeg',
    available: false,
    parcours:  'debutant',
  },
  // Intermédiaire
  {
    slug:      null,
    title:     'Gestion des réclamations & récupération',
    desc:      'Transformez les incidents en opportunités de fidélisation grâce à une gestion structurée des réclamations.',
    duration:  '',
    level:     'Intermédiaire',
    image:     '/images/Picture6.jpg',
    available: false,
    parcours:  'intermediaire',
  },
  {
    slug:      null,
    title:     "Mesurer l'expérience client",
    desc:      'NPS, CSAT, CES : choisissez les bons indicateurs et pilotez la satisfaction avec des données fiables.',
    duration:  '',
    level:     'Intermédiaire',
    image:     '/images/Picture2.jpg',
    available: false,
    parcours:  'intermediaire',
  },
  {
    slug:      null,
    title:     'Expérience digitale & omnicanale',
    desc:      'Offrez une expérience cohérente et sans couture sur tous vos canaux, physiques comme digitaux.',
    duration:  '',
    level:     'Intermédiaire',
    image:     '/images/Picture7.jpg',
    available: false,
    parcours:  'intermediaire',
  },
  {
    slug:      null,
    title:     'Voix du client',
    desc:      "Collectez, analysez et transformez les retours clients en actions concrètes d'amélioration.",
    duration:  '',
    level:     'Intermédiaire',
    image:     '/images/Picture8.jpg',
    available: false,
    parcours:  'intermediaire',
  },
  // Avancé
  {
    slug:      null,
    title:     'Stratégie CX',
    desc:      "Définissez et déployez une stratégie d'expérience client alignée sur vos objectifs business.",
    duration:  '',
    level:     'Avancé',
    image:     '/images/Picture5.jpg',
    available: false,
    parcours:  'avance',
  },
  {
    slug:      null,
    title:     'Customer Insights',
    desc:      'Exploitez la donnée client pour anticiper les attentes et éclairer vos décisions stratégiques.',
    duration:  '',
    level:     'Avancé',
    image:     '/images/Picture2.jpg',
    available: false,
    parcours:  'avance',
  },
  {
    slug:      null,
    title:     'Gouvernance CX',
    desc:      "Structurez les rôles, les rituels et les indicateurs pour ancrer l'expérience client dans la durée.",
    duration:  '',
    level:     'Avancé',
    image:     '/images/Picture6.jpg',
    available: false,
    parcours:  'avance',
  },
  {
    slug:      null,
    title:     'IA & Expérience Client',
    desc:      "Intégrez l'intelligence artificielle pour personnaliser et fluidifier les parcours clients.",
    duration:  '',
    level:     'Avancé',
    image:     '/images/Elearning.jpeg',
    available: false,
    parcours:  'avance',
  },
  {
    slug:      null,
    title:     'Transformation Customer-Centric',
    desc:      'Conduisez le changement et diffusez une culture centrée client dans toute votre organisation.',
    duration:  '',
    level:     'Avancé',
    image:     '/images/Picture7.jpg',
    available: false,
    parcours:  'avance',
  },
]

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
    name:         'Parcours Débutant',
    tagline:      'La base pour bien commencer',
    monthlyPrice: 29000,
    features: [
      'Accès à toutes les formations débutant',
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
  if (level === 'beginner'     || level === 'Débutant')      return 'Débutant'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'Intermédiaire'
  if (level === 'advanced'     || level === 'Avancé')        return 'Avancé'
  return level
}

/** Format a FCFA amount with thin non-breaking spaces: 29000 → "29 000" */
export function formatFcfa(amount: number): string {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
