import Image from 'next/image'
import Link from 'next/link'
import {
  ArrowRight, CheckCircle, Award, Globe,
  TrendingUp, User, Gem, GraduationCap, MessageCircle,
  Mail, Phone, Linkedin,
} from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Fondatrice — Marieme Ba | XP Client Academy',
  description:
    "Découvrez le parcours de Marieme Ba, professionnelle de l'expérience client et fondatrice de XP Client Academy — une plateforme créée pour rendre la formation CX accessible et pratique en Afrique de l'Ouest.",
}

// ── Journey cards ─────────────────────────────────────────────────────────────

const JOURNEY = [
  {
    icon: User,
    title: 'Du terrain à la stratégie',
    desc:  "J'ai commencé au contact direct des clients, avant d'évoluer vers la supervision, le pilotage de parcours clients et la structuration de dispositifs CX.",
  },
  {
    icon: TrendingUp,
    title: "Plus de 10 ans d'expérience",
    desc:  "J'ai accompagné des projets dans les telecoms, le e-commerce et la santé avec un objectif constant : simplifier l'expérience client.",
  },
  {
    icon: Gem,
    title: 'Une approche concrète',
    desc:  "Mon expérience terrain nourrit aujourd'hui une vision simple : former avec des cas réels, des outils pratiques et des contenus adaptés au contexte sénégalais.",
  },
]

// ── Certifications ────────────────────────────────────────────────────────────

const CERTS = [
  {
    icon:  Award,
    name:  'Customer Experience Specialist (CXS)',
    org:   'CX University',
    date:  'Août 2025',
    desc:  null,
    color: 'text-primary bg-primary/10',
  },
  {
    icon:  GraduationCap,
    name:  'Product Manager (PM)',
    org:   'Product School',
    date:  'Août 2024',
    desc:  null,
    color: 'text-secondary bg-secondary/10',
  },
  {
    icon:  Globe,
    name:  'Formations & événements CX',
    org:   null,
    date:  null,
    desc:  "Séminaires, conférences et formations dédiés à l'expérience client, notamment à Paris et au Sénégal.",
    color: 'text-success bg-success/10',
  },
]

export default function FounderPage() {
  return (
    <div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="bg-white py-10 md:py-14">
        <div className="cx-container max-w-5xl">
          <div className="grid grid-cols-1 lg:grid-cols-[0.85fr_1.15fr] gap-10 items-center">

            {/* Left: text */}
            <div>
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-extrabold text-dark leading-tight mb-3">
                Le parcours<br className="hidden sm:block" /> de la fondatrice
              </h1>
              <div className="w-10 h-1 bg-amber-400 rounded-full mb-6" />

              <p className="text-cx-gray leading-relaxed mb-3 max-w-lg">
                Certifi&eacute;e en exp&eacute;rience client, elle accompagne depuis plus de 10 ans
                l&apos;am&eacute;lioration des parcours clients au S&eacute;n&eacute;gal.
              </p>
              <p className="text-cx-gray leading-relaxed mb-8 max-w-lg">
                De conseill&egrave;re client &agrave; responsable exp&eacute;rience client, son parcours
                s&apos;est construit sur le terrain, au contact des clients, des &eacute;quipes et des
                r&eacute;alit&eacute;s op&eacute;rationnelles.
              </p>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/courses"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary-dark transition-all hover:-translate-y-0.5"
                >
                  D&eacute;couvrir XP Client Academy <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  href="/contact"
                  className="inline-flex items-center gap-2 px-6 py-3 border-2 border-primary text-primary text-sm font-semibold rounded-xl hover:bg-primary/5 transition-all"
                >
                  Me contacter
                </Link>
              </div>
            </div>

            {/* Right: portrait */}
            <div className="w-full">
              <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden shadow-xl">
                <Image
                  src="/images/Marieme.png"
                  alt="Marieme Ba — Fondatrice XP Client Academy"
                  fill
                  className="object-cover object-[center_35%]"
                  priority
                />
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── Journey ───────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-16 bg-light border-y border-black/[0.06]">
        <div className="cx-container">

          <h2 className="text-xl md:text-2xl font-extrabold text-dark text-center mb-10">
            Mon parcours en quelques mots
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {JOURNEY.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="bg-white rounded-2xl p-6 border border-black/[0.06] shadow-sm flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <p className="font-bold text-dark text-sm mb-2 leading-snug">{title}</p>
                <p className="text-xs text-cx-gray leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Certifications ────────────────────────────────────────────────── */}
      <section className="py-12 md:py-16 bg-white">
        <div className="cx-container">

          <h2 className="text-xl md:text-2xl font-extrabold text-dark text-center mb-10">
            Certifications &amp; apprentissage continu
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-4xl mx-auto">
            {CERTS.map((cert) => (
              <div key={cert.name} className="cx-card p-5 flex flex-col gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cert.color}`}>
                  <cert.icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-bold text-dark text-sm leading-snug">{cert.name}</p>
                  {cert.org && (
                    <p className="text-xs font-semibold text-primary mt-0.5">{cert.org}</p>
                  )}
                  {cert.date && (
                    <p className="text-xs text-cx-gray mt-0.5">{cert.date}</p>
                  )}
                  {cert.desc && (
                    <p className="text-xs text-cx-gray leading-relaxed mt-1.5">{cert.desc}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* ── Why XP Client Academy ─────────────────────────────────────────── */}
      <section className="py-12 md:py-16 bg-light border-t border-black/[0.06]">
        <div className="cx-container max-w-4xl">

          <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-8 items-start">

            {/* Image */}
            <div className="relative w-full md:w-40 aspect-square rounded-2xl overflow-hidden shadow-md shrink-0">
              <Image
                src="/images/Picture5.jpg"
                alt="XP Client Academy — formation expérience client"
                fill
                className="object-cover"
              />
            </div>

            {/* Text */}
            <div>
              <h2 className="text-xl md:text-2xl font-extrabold text-dark mb-2 leading-tight">
                Pourquoi XP Client Academy&nbsp;?
              </h2>
              <div className="w-8 h-1 bg-amber-400 rounded-full mb-5" />

              <p className="text-cx-gray leading-relaxed mb-3 text-sm">
                XP Client Academy est n&eacute;e d&apos;un constat simple&nbsp;: les formations en
                exp&eacute;rience client sont souvent trop th&eacute;oriques et peu adapt&eacute;es aux
                r&eacute;alit&eacute;s du terrain local.
              </p>
              <p className="text-cx-gray leading-relaxed mb-4 text-sm">
                La plateforme propose une approche plus concr&egrave;te, avec des cas pratiques,
                des quiz, des exercices et des exemples inspir&eacute;s du contexte s&eacute;n&eacute;galais.
              </p>
              <div className="flex items-start gap-2 text-sm text-dark bg-white rounded-xl p-3.5 border border-black/[0.06]">
                <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <p>
                  <strong>Objectif&nbsp;:</strong> aider les professionnels &agrave; cr&eacute;er des
                  exp&eacute;riences clients plus simples, plus humaines et plus efficaces.
                </p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── Contact strip ─────────────────────────────────────────────────── */}
      <section className="bg-dark py-6">
        <div className="cx-container">
          <div className="flex flex-col md:flex-row gap-4 md:gap-8 items-center justify-between">

            {/* Message */}
            <div className="flex items-center gap-3">
              <MessageCircle className="w-5 h-5 text-white/50 shrink-0" />
              <p className="text-white/80 text-sm">
                Envie d&apos;&eacute;changer ou d&apos;en savoir plus&nbsp;? Je suis &agrave; votre &eacute;coute.
              </p>
            </div>

            {/* Links */}
            <div className="flex flex-wrap items-center gap-5">
              <a
                href="https://www.linkedin.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-white/80 text-sm font-semibold hover:text-white transition-colors"
              >
                <Linkedin className="w-4 h-4" /> LinkedIn
              </a>
              <a
                href="mailto:mariemelly@gmail.com"
                className="flex items-center gap-1.5 text-white/80 text-sm hover:text-white transition-colors"
              >
                <Mail className="w-4 h-4" /> mariemelly@gmail.com
              </a>
              <a
                href="tel:+221775760382"
                className="flex items-center gap-1.5 text-white/80 text-sm hover:text-white transition-colors"
              >
                <Phone className="w-4 h-4" /> +221 77 576 03 82
              </a>
            </div>

          </div>
        </div>
      </section>

    </div>
  )
}
