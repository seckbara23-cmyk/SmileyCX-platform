import Image from 'next/image'
import Link from 'next/link'
import {
  ArrowRight, CheckCircle, MapPin, Award, BookOpen,
  Briefcase, Target, Globe, Quote,
} from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Fondatrice — Marieme Ba | XP Client Academy',
  description:
    "Découvrez le parcours de Marieme Ba, professionnelle de l'expérience client et fondatrice de XP Client Academy — une plateforme créée pour rendre la formation CX accessible et pratique en Afrique de l'Ouest.",
}

// ── Sector cards ──────────────────────────────────────────────────────────────

const SECTORS = [
  {
    icon: '📡',
    label: 'Télécommunications',
    desc: "Gestion de la relation client dans un secteur à fort volume d'interactions et d'exigences de réactivité.",
  },
  {
    icon: '🛒',
    label: 'E-commerce',
    desc: "Optimisation du parcours client digital, réduction des frictions et amélioration de la satisfaction post-achat.",
  },
  {
    icon: '🏥',
    label: 'Santé',
    desc: "Expérience patient et qualité de service dans des environnements à haute sensibilité émotionnelle.",
  },
  {
    icon: '⭐',
    label: 'Expérience Client',
    desc: "Conseil, formation et mise en œuvre de stratégies CX adaptées au contexte sénégalais et ouest-africain.",
  },
]

// ── Certifications ────────────────────────────────────────────────────────────

const CERTIFICATIONS = [
  {
    name: 'Certified Customer Experience Professional',
    org:  'CX University',
    desc: 'Formation de référence mondiale en management de l\'expérience client.',
    icon: Award,
  },
  {
    name: 'Développement professionnel continu',
    org:  'CX & Service Design',
    desc: 'Veille active, masterclasses et apprentissage régulier des meilleures pratiques CX.',
    icon: BookOpen,
  },
]

// ── Trust signals ─────────────────────────────────────────────────────────────

const TRUST_SIGNALS = [
  { value: '10+',        label: "ans d'expérience",        sub: 'en expérience client' },
  { value: '4',          label: 'secteurs clés',            sub: 'Télécom, E-com, Santé, CX' },
  { value: 'Certifiée',  label: 'CX University',            sub: 'Formation internationale' },
  { value: '100%',       label: 'terrain africain',         sub: 'Cas réels, contexte local' },
]

export default function FounderPage() {
  return (
    <div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="cx-hero-gradient text-white py-14 md:py-20">
        <div className="cx-container">
          <div className="flex flex-col md:flex-row gap-8 md:gap-14 items-center">

            {/* Photo */}
            <div className="shrink-0">
              <div className="relative w-32 h-32 md:w-44 md:h-44 rounded-2xl overflow-hidden ring-4 ring-white/20 shadow-xl">
                <Image
                  src="/images/Picture2.jpg"
                  alt="Marieme Ba — Fondatrice XP Client Academy"
                  fill
                  className="object-cover object-top"
                  priority
                />
              </div>
            </div>

            {/* Text */}
            <div className="flex-1">
              <div className="inline-flex items-center gap-2 bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-300 shrink-0" />
                Fondatrice &amp; Formatrice CX
              </div>
              <h1 className="text-3xl md:text-4xl font-extrabold mb-2 leading-tight">Marieme Ba</h1>
              <p className="text-white/80 text-base mb-4 leading-relaxed max-w-xl">
                Professionnelle de l&apos;exp&eacute;rience client — Formatrice — Fondatrice de XP&nbsp;Client&nbsp;Academy
              </p>
              <div className="flex items-center gap-2 text-white/70 text-sm">
                <MapPin className="w-4 h-4 shrink-0" />
                Dakar, S&eacute;n&eacute;gal
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── Trust signals strip ───────────────────────────────────────────── */}
      <div className="bg-white border-b border-black/[0.06]">
        <div className="cx-container">
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-black/[0.06]">
            {TRUST_SIGNALS.map((s) => (
              <div key={s.label} className="px-4 py-5 text-center">
                <p className="text-xl font-extrabold text-dark leading-none mb-0.5">{s.value}</p>
                <p className="text-xs font-semibold text-dark">{s.label}</p>
                <p className="text-[11px] text-cx-gray">{s.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Professional journey ──────────────────────────────────────────── */}
      <section className="py-12 md:py-16">
        <div className="cx-container max-w-4xl">

          <div className="mb-8">
            <span className="text-xs font-bold text-primary uppercase tracking-widest">Parcours</span>
            <h2 className="text-2xl font-extrabold text-dark mt-1 mb-3">Un parcours ancr&eacute; dans le terrain</h2>
            <p className="text-cx-gray leading-relaxed max-w-2xl">
              Avec plus de 10 ans d&apos;exp&eacute;rience dans la gestion de la relation client, Mariame a oeuvr&eacute; dans
              des secteurs vari&eacute;s — chaque r&ocirc;le lui donnant une vision plus large de ce que les clients
              attendent vraiment, et de ce qui fait la diff&eacute;rence entre un service ordinaire et une exp&eacute;rience
              m&eacute;morable.
            </p>
          </div>

          {/* Quote */}
          <div className="bg-primary/5 border-l-4 border-primary rounded-r-2xl p-5 mb-10 flex gap-3">
            <Quote className="w-6 h-6 text-primary/40 shrink-0 mt-0.5" />
            <p className="text-dark italic leading-relaxed text-sm md:text-base">
              &laquo;&nbsp;J&apos;ai toujours voulu comprendre pourquoi certains professionnels captivent naturellement
              leurs clients, alors que d&apos;autres les perdent malgr&eacute; tous leurs efforts. La r&eacute;ponse, c&apos;est
              presque toujours la m&ecirc;me&nbsp;: la qualit&eacute; de l&apos;exp&eacute;rience que l&apos;on cr&eacute;e
              &agrave; chaque point de contact.&nbsp;&raquo;
            </p>
          </div>

          {/* Sector grid */}
          <div className="grid sm:grid-cols-2 gap-4 mb-8">
            {SECTORS.map((s) => (
              <div key={s.label} className="cx-card p-5 flex gap-4">
                <span className="text-2xl shrink-0">{s.icon}</span>
                <div>
                  <p className="font-bold text-dark text-sm mb-1">{s.label}</p>
                  <p className="text-xs text-cx-gray leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Key focus areas */}
          <div className="bg-light rounded-2xl p-6">
            <p className="text-xs font-bold text-dark uppercase tracking-wider mb-4 flex items-center gap-2">
              <Briefcase className="w-4 h-4" /> Domaines d&apos;expertise
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              {[
                "Gestion des interactions clients et de la relation client",
                "Qualité de service et standards d'excellence",
                "Collecte et analyse des retours clients",
                "Cartographie et amélioration du parcours client",
                "Formation et développement des équipes en contact client",
                "Mise en place de stratégies d'expérience client pratiques",
              ].map((item) => (
                <div key={item} className="flex items-start gap-2 text-sm text-dark">
                  <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  {item}
                </div>
              ))}
            </div>
          </div>

        </div>
      </section>

      {/* ── Certifications & continuous learning ──────────────────────────── */}
      <section className="py-12 md:py-14 bg-light border-y border-black/[0.06]">
        <div className="cx-container max-w-4xl">

          <div className="mb-8">
            <span className="text-xs font-bold text-secondary uppercase tracking-widest">Formation</span>
            <h2 className="text-2xl font-extrabold text-dark mt-1 mb-2">Certifications &amp; apprentissage continu</h2>
            <p className="text-cx-gray text-sm max-w-xl">
              Engag&eacute;e dans l&apos;apprentissage continu et l&apos;excellence professionnelle &mdash;
              parce que la CX &eacute;volue, les pratiques aussi.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-5">
            {CERTIFICATIONS.map((cert) => (
              <div key={cert.name} className="cx-card p-5 flex gap-4 items-start">
                <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
                  <cert.icon className="w-5 h-5 text-secondary" />
                </div>
                <div>
                  <p className="font-bold text-dark text-sm leading-snug mb-0.5">{cert.name}</p>
                  <p className="text-[11px] font-semibold text-secondary mb-1.5">{cert.org}</p>
                  <p className="text-xs text-cx-gray leading-relaxed">{cert.desc}</p>
                </div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Why XP Client Academy exists ──────────────────────────────────── */}
      <section className="py-12 md:py-16">
        <div className="cx-container max-w-4xl">

          <div className="grid md:grid-cols-[1fr_380px] gap-10 items-start">

            <div>
              <span className="text-xs font-bold text-primary uppercase tracking-widest">Genèse</span>
              <h2 className="text-2xl font-extrabold text-dark mt-1 mb-4 leading-tight">
                Pourquoi XP Client Academy&nbsp;?
              </h2>

              <div className="space-y-4 text-cx-gray leading-relaxed">
                <p>
                  Dans beaucoup d&apos;organisations, la formation en exp&eacute;rience client reste insuffisante ou
                  inexistante. Les professionnels apprennent sur le tas, par essais et erreurs — souvent au d&eacute;triment
                  de leurs clients et de leur propre &eacute;volution de carri&egrave;re.
                </p>
                <p>
                  Les formations disponibles sur le march&eacute; international ne refl&egrave;tent pas les r&eacute;alit&eacute;s
                  du terrain en Afrique de l&apos;Ouest&nbsp;: les attentes des clients locaux, les contraintes op&eacute;rationnelles,
                  les contextes culturels qui influencent chaque interaction.
                </p>
                <p>
                  XP Client Academy est n&eacute;e de cette conviction&nbsp;: <strong className="text-dark">tout
                  professionnel m&eacute;rite une formation CX qui parle de sa r&eacute;alit&eacute;</strong> — pratique,
                  concr&egrave;te, et imm&eacute;diatement applicable sur le terrain.
                </p>
              </div>

              <div className="mt-6 flex flex-col gap-3">
                {[
                  'Former à partir de cas réels, pas de théorie abstraite',
                  'Rendre la CX accessible aux professionnels africains',
                  'Développer une culture client durable dans les organisations',
                ].map((item) => (
                  <div key={item} className="flex items-start gap-2 text-sm text-dark">
                    <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" /> {item}
                  </div>
                ))}
              </div>
            </div>

            {/* Side: why card */}
            <div className="cx-card p-6 bg-primary/[0.03] border-primary/10">
              <p className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
                <Target className="w-4 h-4" /> La mission
              </p>
              <p className="text-base font-bold text-dark leading-snug mb-3">
                Rendre la formation en exp&eacute;rience client pratique, accessible et ancr&eacute;e dans la r&eacute;alit&eacute;
                des professionnels africains.
              </p>
              <p className="text-sm text-cx-gray leading-relaxed">
                Chaque formation est con&ccedil;ue pour &ecirc;tre directement utile &mdash; des outils et des m&eacute;thodes
                que vous pouvez appliquer d&egrave;s le lendemain.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* ── Vision ───────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-14 bg-light border-t border-black/[0.06]">
        <div className="cx-container max-w-4xl">

          <div className="mb-8">
            <span className="text-xs font-bold text-secondary uppercase tracking-widest">Vision</span>
            <h2 className="text-2xl font-extrabold text-dark mt-1 mb-2">
              Un Afrique de l&apos;Ouest centr&eacute;e sur le client
            </h2>
            <p className="text-cx-gray leading-relaxed max-w-2xl">
              Le S&eacute;n&eacute;gal et l&apos;Afrique de l&apos;Ouest ont une richesse relationnelle profonde &mdash; la <em>Teranga</em>,
              l&apos;hospitalit&eacute; et le sens de l&apos;accueil sont d&eacute;j&agrave; ancr&eacute;s dans la culture.
              XP Client Academy existe pour transformer ces qualit&eacute;s naturelles en comp&eacute;tences professionnelles
              structur&eacute;es.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                icon: Globe,
                title: 'Professionnalisation',
                desc: 'Élever le standard de la relation client dans les entreprises africaines.',
              },
              {
                icon: Target,
                title: 'Culture client',
                desc: "Faire de l'expérience client un avantage compétitif réel, pas un slogan.",
              },
              {
                icon: BookOpen,
                title: 'Compétences pratiques',
                desc: 'Former des professionnels opérationnels dès le premier jour après la formation.',
              },
              {
                icon: Award,
                title: 'Développement des talents',
                desc: 'Construire une nouvelle génération de professionnels CX en Afrique de l\'Ouest.',
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="cx-card p-5 text-center flex flex-col items-center">
                <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-secondary" />
                </div>
                <p className="font-bold text-dark text-sm mb-1.5">{title}</p>
                <p className="text-xs text-cx-gray leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-14">
        <div className="cx-container max-w-3xl">
          <div className="cx-hero-gradient rounded-2xl p-8 md:p-10 text-white text-center">
            <h2 className="text-2xl font-extrabold mb-3">Rejoignez XP Client Academy</h2>
            <p className="text-white/80 mb-7 max-w-lg mx-auto leading-relaxed text-sm">
              Que vous soyez agent de service client, manager ou dirigeant, il y a un parcours fait pour vous.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/courses"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white text-primary font-bold rounded-xl hover:bg-white/90 transition-all hover:-translate-y-0.5"
              >
                Voir les formations <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/contact"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 border-2 border-white/40 text-white font-semibold rounded-xl hover:bg-white/15 transition-all"
              >
                Nous contacter
              </Link>
            </div>
          </div>
        </div>
      </section>

    </div>
  )
}
