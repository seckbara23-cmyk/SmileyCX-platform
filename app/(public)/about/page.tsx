import Image from 'next/image'
import Link from 'next/link'
import { CheckCircle, ArrowRight, Users, Award, BookOpen, Monitor } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'À propos — XP Client Academy',
  description:
    "Découvrez la mission, l'histoire et les valeurs de XP Client Academy — la plateforme de formation en expérience client pour les professionnels d'Afrique de l'Ouest.",
}

export default function AboutPage() {
  return (
    <div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="cx-hero-gradient text-white py-14 md:py-20">
        <div className="cx-container max-w-3xl">
          <h1 className="text-3xl md:text-4xl font-extrabold mb-3 leading-tight">
            &Agrave; propos de XP Client Academy
          </h1>
          <p className="text-white/80 text-base leading-relaxed">
            Une plateforme n&eacute;e d&apos;une conviction&nbsp;: chaque professionnel en Afrique de l&apos;Ouest
            m&eacute;rite une formation en exp&eacute;rience client concr&egrave;te, pratique et adapt&eacute;e
            &agrave; sa r&eacute;alit&eacute;.
          </p>
        </div>
      </div>

      {/* ── Mission ───────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-16">
        <div className="cx-container max-w-4xl">

          <div className="grid md:grid-cols-2 gap-10 items-start">

            <div>
              <span className="text-xs font-bold text-primary uppercase tracking-widest">Mission</span>
              <h2 className="text-2xl font-extrabold text-dark mt-1 mb-4 leading-tight">
                Former les professionnels qui servent les clients
              </h2>
              <p className="text-cx-gray leading-relaxed mb-4">
                XP Client Academy forme les professionnels et les &eacute;quipes &agrave; offrir une exp&eacute;rience
                client exceptionnelle &mdash; pas en th&eacute;orie, mais dans la r&eacute;alit&eacute; quotidienne
                de leurs interactions.
              </p>
              <p className="text-cx-gray leading-relaxed mb-6">
                Nos programmes sont construits &agrave; partir de cas r&eacute;els, avec une p&eacute;dagogie
                adapt&eacute;e aux professionnels de la relation client en Afrique de l&apos;Ouest &mdash;
                agents, managers, entrepreneurs.
              </p>
              <div className="flex flex-col gap-3">
                {[
                  "10+ années d'expertise en expérience client",
                  'Formations adaptées au marché local',
                  'Approche pratique et immédiatement applicable',
                  'Certificats de réussite reconnus',
                ].map((item) => (
                  <div key={item} className="flex items-start gap-2 text-sm text-dark">
                    <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" /> {item}
                  </div>
                ))}
              </div>
            </div>

            {/* Features grid */}
            <div className="grid gap-4">
              {[
                { icon: Monitor,  title: 'Cours 100% en ligne',    desc: "Accessibles à tout moment, depuis n'importe quel appareil." },
                { icon: Award,    title: 'Certificat inclus',       desc: 'Obtenez une reconnaissance officielle à la fin de votre parcours.' },
                { icon: Users,    title: 'Adapté au terrain local', desc: 'Cas réels issus du contexte sénégalais et ouest-africain.' },
                { icon: BookOpen, title: 'Mises à jour continues',  desc: 'Contenu enrichi régulièrement par des experts CX.' },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="cx-card p-4 flex gap-4 items-start">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-dark mb-0.5">{title}</p>
                    <p className="text-xs text-cx-gray">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

          </div>
        </div>
      </section>

      {/* ── Founder ───────────────────────────────────────────────────────── */}
      <section className="py-12 md:py-14 bg-light border-y border-black/[0.06]">
        <div className="cx-container max-w-4xl">

          <div className="flex flex-col md:flex-row gap-8 md:gap-12 items-center">

            {/* Photo */}
            <div className="shrink-0">
              <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-2xl overflow-hidden ring-4 ring-primary/10 shadow-md">
                <Image
                  src="/images/Picture2.jpg"
                  alt="Marieme Ba — Fondatrice XP Client Academy"
                  fill
                  className="object-cover object-top"
                />
              </div>
            </div>

            {/* Text */}
            <div className="flex-1">
              <span className="text-xs font-bold text-primary uppercase tracking-widest">Fondatrice</span>
              <h2 className="text-xl font-extrabold text-dark mt-1 mb-1">Marieme Ba</h2>
              <p className="text-sm text-cx-gray mb-3">
                Professionnelle de l&apos;exp&eacute;rience client &middot; +10 ans d&apos;expertise &middot; Dakar, S&eacute;n&eacute;gal
              </p>
              <p className="text-sm text-cx-gray leading-relaxed mb-5 max-w-xl">
                Avec une exp&eacute;rience dans les t&eacute;l&eacute;communications, l&apos;e-commerce et la sant&eacute;,
                Marieme a cr&eacute;&eacute; XP Client Academy pour rendre la formation CX accessible,
                pratique et ancr&eacute;e dans la r&eacute;alit&eacute; des professionnels africains.
              </p>
              <Link
                href="/about/founder"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary/90 transition-all hover:-translate-y-0.5"
              >
                D&eacute;couvrir son parcours <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

          </div>
        </div>
      </section>

      {/* ── Expert Network (placeholder) ──────────────────────────────────── */}
      <section className="py-12 md:py-14">
        <div className="cx-container max-w-4xl">

          <div className="mb-6">
            <span className="text-xs font-bold text-secondary uppercase tracking-widest">R&eacute;seau</span>
            <h2 className="text-2xl font-extrabold text-dark mt-1 mb-2">R&eacute;seau d&apos;experts</h2>
            <p className="text-cx-gray text-sm max-w-xl">
              XP Client Academy s&apos;appuie sur un r&eacute;seau de praticiens CX pour enrichir ses contenus
              et garantir une expertise multisectorielle.
            </p>
          </div>

          <div className="cx-card rounded-2xl p-8 md:p-10 text-center border-dashed border-2 border-black/10 bg-light/50">
            <div className="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center mx-auto mb-4">
              <Users className="w-6 h-6 text-secondary" />
            </div>
            <p className="font-bold text-dark mb-2">Prochainement</p>
            <p className="text-sm text-cx-gray max-w-sm mx-auto">
              Nos experts partenaires et formateurs invit&eacute;s seront pr&eacute;sent&eacute;s ici.
              Rejoignez la communaut&eacute; pour &ecirc;tre inform&eacute;.
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 mt-5 text-sm font-semibold text-primary hover:underline"
            >
              Proposer votre expertise <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

        </div>
      </section>

      {/* ── Contact CTA ───────────────────────────────────────────────────── */}
      <section className="py-10 md:py-12 bg-light border-t border-black/[0.06]">
        <div className="cx-container max-w-4xl">
          <div className="flex flex-col md:flex-row gap-6 items-center justify-between">
            <div>
              <h3 className="text-lg font-extrabold text-dark mb-1">Vous avez une question&nbsp;?</h3>
              <p className="text-sm text-cx-gray">
                Formation en ligne, pr&eacute;sentiel, partenariat — &eacute;crivez-nous.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 shrink-0">
              <Link
                href="/courses"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary/90 transition-all"
              >
                Voir les formations <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 px-5 py-2.5 border border-primary/30 text-primary text-sm font-semibold rounded-xl hover:bg-primary/5 transition-all"
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
