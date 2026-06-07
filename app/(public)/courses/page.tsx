import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import {
  ArrowRight, Clock, CheckCircle, MapPin, GraduationCap, BookOpen,
  Users, Target, Lock, Building2, UserCircle, Presentation,
} from 'lucide-react'
import { PLATFORM_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Parcours de formation CX — XP Client Academy',
  description:
    'Trois parcours structurés pour développer vos compétences en expérience client : du débutant au directeur CX. Formations certifiantes adaptées au contexte africain.',
}

// ── Course catalog (static enrichment merged with DB) ─────────────────────────

type CourseEntry = {
  title: string; desc: string; duration: string; level: string
  slug: string; available: boolean; modules: number
  audience: string; outcome: string; image: string | null
  formation: number; path: string
}

const STATIC_COURSES: CourseEntry[] = [
  {
    title:     "Fondamentaux de l'expérience client",
    desc:      "Identifiez les frustrations de vos clients, améliorez les moments clés du parcours et créez une expérience qui donne envie de revenir.",
    duration:  '4h',
    level:     'Débutant',
    slug:      'fondamentaux-experience-client',
    available: true,
    modules:   4,
    audience:  'Agents, conseillers, employés en contact client',
    outcome:   'Comprendre la CX et améliorer les moments clés du parcours client',
    image:     '/images/Formation1.jpg',
    formation: 1,
    path:      'beginner',
  },
  {
    title:     'Créer une expérience client mémorable',
    desc:      "Apprenez à concevoir des interactions qui marquent durablement vos clients, renforcent leur fidélité et différencient votre organisation.",
    duration:  '6h',
    level:     'Intermédiaire',
    slug:      'experience-client-memorable',
    available: true,
    modules:   5,
    audience:  'Professionnels CX, responsables qualité de service',
    outcome:   'Concevoir des interactions mémorables et transformer vos clients en ambassadeurs',
    image:     '/images/Picture3.jpg',
    formation: 2,
    path:      'beginner',
  },
  {
    title:     'Service client digital',
    desc:      "Maîtrisez les canaux digitaux et les outils CRM pour offrir une relation client fluide, réactive et cohérente — quel que soit le canal.",
    duration:  '5h',
    level:     'Intermédiaire',
    slug:      'service-client-digital',
    available: false,
    modules:   4,
    audience:  'Conseillers digitaux, community managers, chargés CRM',
    outcome:   'Gérer une relation client cohérente sur tous les canaux digitaux',
    image:     '/images/Elearning.jpeg',
    formation: 3,
    path:      'beginner',
  },
]

// ── Learning paths ─────────────────────────────────────────────────────────────

const PATHS = [
  {
    id:         'beginner',
    badge:      'Parcours Débutant',
    accentBg:   'bg-success',
    badgeClass: 'bg-success/10 text-success',
    checkColor: 'text-success',
    title:      'Fondations CX',
    subtitle:   "Maîtrisez les bases de l'expérience client",
    tagline:    'Vous apprendrez à :',
    audience:   ['Agents service client', 'Employés de première ligne', 'Étudiants', 'Reconversion professionnelle'],
    outcomes: [
      "Mieux gérer chaque interaction avec un client",
      "Comprendre les émotions et attentes des clients",
      "Cartographier et améliorer le parcours client",
      "Communiquer avec plus d'efficacité et d'empathie",
    ],
    courses: [
      { title: "Fondamentaux de l'expérience client",   available: true,  slug: 'fondamentaux-experience-client' },
      { title: 'Créer une expérience client mémorable', available: true,  slug: 'experience-client-memorable' },
      { title: 'Service client digital',                 available: false, slug: null },
    ],
    duration:   '~10–15h',
    ctaLabel:   'Commencer le parcours',
    ctaHref:    '/courses/fondamentaux-experience-client',
    ctaPrimary: true,
    available:  true,
  },
  {
    id:         'intermediate',
    badge:      'Parcours Intermédiaire',
    accentBg:   'bg-primary',
    badgeClass: 'bg-primary/10 text-primary',
    checkColor: 'text-primary',
    title:      'Excellence Opérationnelle',
    subtitle:   'Améliorez la qualité de service de votre équipe',
    tagline:    'Vous serez capable de :',
    audience:   ["Responsables d'équipe", 'Superviseurs', 'Managers service client'],
    outcomes: [
      "Gérer les réclamations et récupérer après un incident",
      "Mesurer et améliorer la satisfaction client",
      "Piloter une expérience omnicanale cohérente",
      "Transformer la voix du client en actions concrètes",
    ],
    courses: [
      { title: 'Gestion des réclamations & récupération', available: false, slug: null },
      { title: "Mesurer l'expérience client",             available: false, slug: null },
      { title: 'Expérience digitale & omnicanale',        available: false, slug: null },
      { title: 'Voix du client',                          available: false, slug: null },
    ],
    duration:   '~20h',
    ctaLabel:   "Être notifié à l'ouverture",
    ctaHref:    '/contact?parcours=intermediate',
    ctaPrimary: false,
    available:  false,
  },
  {
    id:         'advanced',
    badge:      'Parcours Avancé',
    accentBg:   'bg-secondary',
    badgeClass: 'bg-secondary/10 text-secondary',
    checkColor: 'text-secondary',
    title:      'Transformation CX',
    subtitle:   "Pilotez la stratégie et la transformation customer-centric",
    tagline:    'Conçu pour les leaders qui veulent :',
    audience:   ['Directeurs CX', 'Leaders de transformation', "Dirigeants d'entreprise"],
    outcomes: [
      "Définir et déployer une stratégie CX à l'échelle",
      "Conduire la transformation customer-centric",
      "Gouverner et mesurer l'impact CX",
      "Intégrer l'IA dans l'expérience client",
    ],
    courses: [
      { title: 'Stratégie CX',                      available: false, slug: null },
      { title: 'Customer Insights',                  available: false, slug: null },
      { title: 'Gouvernance CX',                     available: false, slug: null },
      { title: 'IA & Expérience Client',             available: false, slug: null },
      { title: 'Transformation Customer-Centric',    available: false, slug: null },
    ],
    duration:   'À définir',
    ctaLabel:   "Rejoindre la liste d'attente",
    ctaHref:    '/contact?parcours=advanced',
    ctaPrimary: false,
    available:  false,
  },
]

// ── Pricing tiers ─────────────────────────────────────────────────────────────

const PRICING_TIERS = [
  {
    id:        'individual',
    Icon:      UserCircle,
    title:     'Particulier',
    subtitle:  'Formez-vous à votre rythme',
    price:     'Sur demande',
    priceSub:  'tarif par cours',
    featured:  false,
    features: [
      'Accès complet à la formation',
      'Certificat de complétion inclus',
      'Accès à vie au contenu',
      'Support par e-mail',
    ],
    ctaLabel: 'Nous contacter',
    ctaHref:  '/contact?service=individuel',
    ctaClass: 'bg-primary text-white hover:bg-primary/90',
    note:     null,
  },
  {
    id:        'team',
    Icon:      Building2,
    title:     'Entreprise',
    subtitle:  'Formez toute votre équipe',
    price:     'Sur devis',
    priceSub:  'selon effectif',
    featured:  true,
    features: [
      'Licences multi-utilisateurs',
      'Tableau de bord de suivi',
      'Contenus personnalisables',
      'Support dédié',
    ],
    ctaLabel: 'Demander un devis',
    ctaHref:  '/contact?service=equipe',
    ctaClass: 'bg-secondary text-white hover:bg-secondary/90',
    note:     null,
  },
  {
    id:        'presentiel',
    Icon:      Presentation,
    title:     'Présentiel',
    subtitle:  'Formation en groupe à Dakar',
    price:     'Sur devis',
    priceSub:  '5 à 30 participants',
    featured:  false,
    features: [
      'Programme adapté à votre secteur',
      'Animateur expert CX',
      'Atelier interactif',
      'Attestation de formation',
    ],
    ctaLabel: 'En savoir plus',
    ctaHref:  '/contact?service=presentiel',
    ctaClass: 'border border-primary text-primary hover:bg-primary/5',
    note:     null,
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function levelBadgeClass(level: string) {
  if (level === 'beginner'     || level === 'Débutant')      return 'bg-success/10 text-success'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'bg-primary/10 text-primary'
  return 'bg-secondary/10 text-secondary'
}

function levelLabel(level: string) {
  if (level === 'beginner'     || level === 'Débutant')      return 'Débutant'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'Intermédiaire'
  if (level === 'advanced'     || level === 'Avancé')        return 'Avancé'
  return level
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CoursesPage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, slug, title, description, duration_hours, level, cover_url, modules(id)')
    .eq('is_published', true)
    .order('created_at', { ascending: true })

  const hasDbCourses = dbCourses && dbCourses.length > 0

  function toCleanSlug(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  const allCourses: CourseEntry[] = hasDbCourses
    ? dbCourses!
        .filter((c) => typeof c.slug === 'string' && c.slug.trim() !== '')
        .map((c, i) => {
          const slug   = toCleanSlug(c.slug as string)
          const static_ = STATIC_COURSES.find(s => s.slug === slug) ?? STATIC_COURSES[i]
          return {
            title:     c.title,
            desc:      c.description ?? '',
            duration:  c.duration_hours ? `${c.duration_hours}h` : '',
            level:     c.level ?? '',
            slug,
            available: true,
            modules:   Array.isArray(c.modules) ? c.modules.length : 0,
            audience:  static_?.audience  ?? '',
            outcome:   static_?.outcome   ?? '',
            image:     c.cover_url ?? static_?.image ?? null,
            formation: i + 1,
            path:      static_?.path ?? 'beginner',
          }
        })
    : STATIC_COURSES

  // Split available vs coming-soon
  const availableCourses = allCourses.filter(c => c.available)
  const comingSoonCourses = STATIC_COURSES.filter(s => !s.available && !allCourses.find(c => c.slug === s.slug))

  return (
    <div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="cx-hero-gradient text-white py-14 md:py-20">
        <div className="cx-container">
          {PLATFORM_MODE === 'pilot' && (
            <div className="inline-flex items-center gap-2 bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse shrink-0" />
              Phase pilote &mdash; Vos retours nous aident &agrave; am&eacute;liorer l&apos;exp&eacute;rience
            </div>
          )}
          {PLATFORM_MODE === 'private' && (
            <div className="inline-flex items-center gap-2 bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              Acc&egrave;s sur invitation &middot;{' '}
              <a href="/signup" className="underline underline-offset-2 hover:text-white/80 transition-colors">
                Rejoindre la liste d&apos;attente
              </a>
            </div>
          )}
          <div className="max-w-2xl">
            <h1 className="text-3xl md:text-4xl font-extrabold mb-3 leading-tight">
              Devenez expert en exp&eacute;rience client
            </h1>
            <p className="text-white/80 text-base max-w-xl leading-relaxed">
              Trois parcours structur&eacute;s pour progresser &agrave; votre rythme — de la relation client
              de terrain &agrave; la transformation CX strat&eacute;gique.
            </p>
          </div>
        </div>
      </div>

      {/* ── Learning Paths ───────────────────────────────────────────────── */}
      <section className="py-12 md:py-16">
        <div className="cx-container">

          <div className="mb-8 md:mb-10">
            <h2 className="text-2xl font-extrabold text-dark mb-2">Choisissez votre parcours</h2>
            <p className="text-cx-gray text-sm max-w-xl">
              Chaque parcours est con&ccedil;u pour un profil sp&eacute;cifique, avec des objectifs concrets et des
              formations adapt&eacute;es.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {PATHS.map((path) => (
              <div
                key={path.id}
                className="cx-card rounded-2xl overflow-hidden flex flex-col"
              >
                {/* Accent bar */}
                <div className={`h-1.5 ${path.accentBg}`} />

                <div className="p-5 md:p-6 flex flex-col flex-1">

                  {/* Badge */}
                  <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full w-fit mb-3 ${path.badgeClass}`}>
                    {path.badge}
                  </span>

                  {/* Title */}
                  <h3 className="text-lg font-extrabold text-dark leading-snug mb-0.5">{path.title}</h3>
                  <p className="text-xs text-cx-gray mb-4">{path.subtitle}</p>

                  {/* Audience */}
                  <div className="mb-4">
                    <p className="text-[10px] font-bold text-dark uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Users className="w-3 h-3" /> Pour qui ?
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {path.audience.map((a) => (
                        <span key={a} className="text-[11px] bg-light px-2.5 py-0.5 rounded-full text-cx-gray border border-black/[0.06]">
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Outcomes */}
                  <div className="mb-5 flex-1">
                    <p className="text-[10px] font-bold text-dark uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Target className="w-3 h-3" /> {path.tagline}
                    </p>
                    <ul className="space-y-1.5">
                      {path.outcomes.map((o) => (
                        <li key={o} className="flex items-start gap-2 text-xs text-cx-gray leading-relaxed">
                          <CheckCircle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${path.checkColor}`} />
                          {o}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Courses */}
                  <div className="mb-5">
                    <p className="text-[10px] font-bold text-dark uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <BookOpen className="w-3 h-3" /> Formations incluses
                    </p>
                    <ul className="space-y-1.5">
                      {path.courses.map((c) => (
                        <li key={c.title} className="flex items-center gap-2">
                          <BookOpen className="w-3 h-3 text-dark/25 shrink-0" />
                          <span className="text-xs text-dark flex-1 leading-snug">{c.title}</span>
                          {c.available ? (
                            <span className="text-[10px] font-bold text-success bg-success/10 px-2 py-0.5 rounded-full shrink-0">
                              Disponible
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold text-cx-gray bg-light px-2 py-0.5 rounded-full border border-black/[0.06] shrink-0">
                              Bient&ocirc;t
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Footer: duration + CTA */}
                  <div className="border-t border-black/[0.06] pt-4 flex items-center justify-between gap-3 flex-wrap">
                    <span className="flex items-center gap-1.5 text-xs text-cx-gray">
                      <Clock className="w-3.5 h-3.5" /> {path.duration}
                    </span>
                    {path.available ? (
                      <Link
                        href={path.ctaHref}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold rounded-xl bg-success text-white hover:opacity-90 active:scale-[0.98] transition-all"
                      >
                        {path.ctaLabel} <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    ) : (
                      <Link
                        href={path.ctaHref}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl border transition-all ${path.badgeClass} border-current/20 hover:opacity-80`}
                      >
                        {path.ctaLabel}
                      </Link>
                    )}
                  </div>

                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-16 bg-light border-y border-black/[0.06]">
        <div className="cx-container">

          <div className="mb-8 md:mb-10 text-center">
            <h2 className="text-2xl font-extrabold text-dark mb-2">Tarifs</h2>
            <p className="text-cx-gray text-sm max-w-xl mx-auto">
              Des formules adapt&eacute;es &agrave; chaque besoin — particulier, entreprise ou formation en groupe.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {PRICING_TIERS.map((tier) => (
              <div
                key={tier.id}
                className={`cx-card rounded-2xl p-6 flex flex-col relative${tier.featured ? ' ring-2 ring-secondary' : ''}`}
              >
                {tier.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-secondary text-white text-[11px] font-bold px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                      Le plus populaire
                    </span>
                  </div>
                )}

                {/* Icon + title */}
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${tier.featured ? 'bg-secondary/10' : 'bg-primary/10'}`}>
                    <tier.Icon className={`w-5 h-5 ${tier.featured ? 'text-secondary' : 'text-primary'}`} />
                  </div>
                  <div>
                    <p className="font-bold text-dark text-sm leading-tight">{tier.title}</p>
                    <p className="text-[11px] text-cx-gray">{tier.subtitle}</p>
                  </div>
                </div>

                {/* Price */}
                <div className="mb-4 pb-4 border-b border-black/[0.06]">
                  <p className="text-2xl font-extrabold text-dark leading-none">{tier.price}</p>
                  <p className="text-xs text-cx-gray mt-0.5">{tier.priceSub}</p>
                </div>

                {/* Features */}
                <ul className="space-y-2 flex-1 mb-5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-cx-gray">
                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <Link
                  href={tier.ctaHref}
                  className={`inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-bold rounded-xl transition-all ${tier.ctaClass}`}
                >
                  {tier.ctaLabel} <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Available Courses ─────────────────────────────────────────────── */}
      <section className="py-12 md:py-14" id="formations">
        <div className="cx-container">

          <div className="mb-8">
            <h2 className="text-2xl font-extrabold text-dark mb-2">Formations disponibles</h2>
            <p className="text-cx-gray text-sm">
              Commencez d&egrave;s maintenant avec nos formations en ligne certifiantes.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-10">
            {/* Available courses */}
            {availableCourses.map((course) => (
              <div
                key={course.slug}
                className="cx-card flex flex-col rounded-2xl overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200"
              >
                {/* Image */}
                <div className="relative w-full h-40 bg-light shrink-0">
                  {course.image ? (
                    <Image src={course.image} alt={course.title} fill className="object-cover" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <GraduationCap className="w-12 h-12 text-primary/20" />
                    </div>
                  )}
                </div>

                <div className="flex flex-col flex-1 p-5">
                  {/* Badges row */}
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${levelBadgeClass(course.level)}`}>
                      {levelLabel(course.level)}
                    </span>
                    <span className="text-[11px] text-success bg-success/10 font-semibold px-2.5 py-0.5 rounded-full">
                      Disponible
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-dark leading-snug mb-1.5">{course.title}</h3>

                  {/* Outcome (outcomes-based messaging) */}
                  {course.outcome && (
                    <p className="text-xs text-primary font-medium mb-2 leading-relaxed">
                      Vous apprendrez &agrave; : {course.outcome.replace(/^[A-Z]/, c => c.toLowerCase())}
                    </p>
                  )}

                  <p className="text-xs text-cx-gray leading-relaxed flex-1 mb-3 line-clamp-2">{course.desc}</p>

                  {/* Audience */}
                  {course.audience && (
                    <p className="text-[11px] text-cx-gray mb-3 flex items-center gap-1.5">
                      <Users className="w-3 h-3 shrink-0" />
                      <span className="truncate">{course.audience}</span>
                    </p>
                  )}

                  {/* Meta */}
                  <div className="flex items-center gap-4 text-xs text-cx-gray border-t border-black/[0.06] pt-3 mb-4">
                    {course.duration && (
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" /> {course.duration}
                      </span>
                    )}
                    {course.modules > 0 && (
                      <span className="flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5" /> {course.modules} modules
                      </span>
                    )}
                  </div>

                  <Link
                    href={`/courses/${course.slug}`}
                    className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-secondary text-white text-sm font-bold rounded-cx hover:bg-secondary-dark transition-all"
                  >
                    Voir la formation <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            ))}

            {/* Coming-soon courses */}
            {comingSoonCourses.map((course) => (
              <div
                key={course.slug}
                className="cx-card flex flex-col rounded-2xl overflow-hidden opacity-75"
              >
                {/* Image */}
                <div className="relative w-full h-40 bg-light shrink-0">
                  {course.image ? (
                    <Image src={course.image} alt={course.title} fill className="object-cover" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <GraduationCap className="w-12 h-12 text-primary/20" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-dark/30 flex items-center justify-center">
                    <span className="bg-white text-dark text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5">
                      <Lock className="w-3 h-3" /> Bient&ocirc;t disponible
                    </span>
                  </div>
                </div>

                <div className="flex flex-col flex-1 p-5">
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${levelBadgeClass(course.level)}`}>
                      {levelLabel(course.level)}
                    </span>
                    <span className="text-[11px] text-cx-gray bg-light font-semibold px-2.5 py-0.5 rounded-full border border-black/[0.06]">
                      Bient&ocirc;t disponible
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-dark leading-snug mb-1.5">{course.title}</h3>

                  {course.outcome && (
                    <p className="text-xs text-cx-gray/70 font-medium mb-2 leading-relaxed">
                      Vous apprendrez &agrave; : {course.outcome.replace(/^[A-Z]/, c => c.toLowerCase())}
                    </p>
                  )}

                  <p className="text-xs text-cx-gray leading-relaxed flex-1 mb-3 line-clamp-2">{course.desc}</p>

                  {course.audience && (
                    <p className="text-[11px] text-cx-gray mb-3 flex items-center gap-1.5">
                      <Users className="w-3 h-3 shrink-0" />
                      <span className="truncate">{course.audience}</span>
                    </p>
                  )}

                  <div className="flex items-center gap-4 text-xs text-cx-gray border-t border-black/[0.06] pt-3 mb-4">
                    {course.duration && (
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" /> {course.duration}
                      </span>
                    )}
                    {course.modules > 0 && (
                      <span className="flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5" /> {course.modules} modules
                      </span>
                    )}
                  </div>

                  <Link
                    href="/contact"
                    className="inline-flex items-center justify-center w-full px-4 py-2.5 bg-light border border-black/[0.08] text-cx-gray text-sm font-semibold rounded-cx hover:bg-white transition-colors"
                  >
                    &Ecirc;tre notifi&eacute; &agrave; l&apos;ouverture
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {/* Upcoming intermediate/advanced teaser */}
          <div className="rounded-2xl border border-black/[0.08] bg-gradient-to-br from-white to-light p-6 md:p-8">
            <div className="flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
              <div>
                <p className="text-xs font-bold text-primary uppercase tracking-wide mb-1">Prochainement</p>
                <h3 className="text-base font-extrabold text-dark mb-2">
                  Parcours Interm&eacute;diaire &amp; Avanc&eacute; en pr&eacute;paration
                </h3>
                <p className="text-sm text-cx-gray max-w-lg">
                  Gestion des r&eacute;clamations, mesure de l&apos;exp&eacute;rience client, strat&eacute;gie CX, IA et
                  transformation customer-centric. Rejoignez la liste d&apos;attente pour &ecirc;tre le premier informé.
                </p>
              </div>
              <Link
                href="/contact?parcours=upcoming"
                className="shrink-0 inline-flex items-center gap-2 px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary/90 transition-all hover:-translate-y-0.5 whitespace-nowrap"
              >
                Rejoindre la liste <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

        </div>
      </section>

      {/* ── Target audience ───────────────────────────────────────────────── */}
      <section className="py-10 md:py-12 bg-light border-t border-black/[0.06]">
        <div className="cx-container">
          <h2 className="text-lg font-bold text-dark mb-5">&Agrave; qui s&apos;adressent nos formations&nbsp;?</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { title: 'Professionnels de la relation client', desc: 'Agents, conseillers, chargés de clientèle souhaitant améliorer leurs compétences.' },
              { title: 'Managers et responsables',             desc: "Responsables service client, directeurs qualité, managers d'équipe." },
              { title: 'Entrepreneurs et TPE/PME',             desc: 'Dirigeants souhaitant structurer leur approche client dès le départ.' },
              { title: 'Équipes en entreprise',               desc: 'Formations sur mesure en présentiel pour groupes de 5 à 30 personnes.' },
            ].map(({ title, desc }) => (
              <div key={title} className="flex items-start gap-3">
                <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-dark">{title}</p>
                  <p className="text-xs text-cx-gray mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── In-person CTA ─────────────────────────────────────────────────── */}
      <section className="py-10 md:py-12 border-t border-black/[0.06]">
        <div className="cx-container">
          <div className="bg-gradient-to-r from-primary to-[#6b8ef0] rounded-2xl p-8 text-white flex flex-col md:flex-row gap-6 items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-5 h-5 text-white/80" />
                <h3 className="text-lg font-bold">Demander une formation en pr&eacute;sentiel</h3>
              </div>
              <p className="text-white/80 text-sm max-w-md">
                Ateliers interactifs &agrave; Dakar et en r&eacute;gion pour vos &eacute;quipes.
                Programme adapt&eacute; &agrave; votre secteur.
              </p>
            </div>
            <Link
              href="/contact?service=presentiel"
              className="shrink-0 px-6 py-3 bg-white text-primary font-bold rounded-cx hover:bg-white/90 transition-all hover:-translate-y-0.5 whitespace-nowrap"
            >
              En savoir plus
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
