import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, CheckCircle, Monitor, MapPin, Mail, Phone, BookOpen, Award, Users, UserCircle } from 'lucide-react'
import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'
import ContactForm from '@/app/(public)/contact/ContactForm'
import FinalCtaButton from '@/components/site/FinalCtaButton'
import { CONTACT_EMAIL, CONTACT_PHONE, CONTACT_PHONE_HREF } from '@/lib/brand'

const FEATURE_ITEMS = [
  { icon: BookOpen, label: 'Formations pratiques et concrètes' },
  { icon: Monitor,  label: 'Formations 100% en ligne' },
  { icon: Users,    label: 'Cas réels inspirés du terrain' },
  { icon: Award,    label: 'Certificats de réussite' },
]

export default function HomePage() {
  return (
    <>
      <Header />
      <main className="pt-[72px]">

        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section id="accueil" className="bg-white">

          {/* Main hero content */}
          <div className="cx-container py-16 sm:py-24">
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">

              {/* Left: text */}
              <div>
                <span className="inline-block bg-secondary/10 text-secondary text-xs font-semibold px-4 py-1.5 rounded-full mb-6 tracking-wide">
                  La Teranga au c&oelig;ur de l&apos;exp&eacute;rience client
                </span>
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold leading-tight mb-5 tracking-tight text-dark">
                  Transformez l&apos;exp&eacute;rience client en{' '}
                  <span className="text-secondary">avantage concurrentiel</span>
                </h1>
                <p className="text-cx-gray text-lg leading-relaxed mb-8 max-w-lg">
                  Des formations concr&egrave;tes, accessibles en ligne, pour am&eacute;liorer
                  la qualit&eacute; de service et la satisfaction client.
                </p>
                <a
                  href="#formations"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-primary text-white font-bold rounded-cx hover:bg-primary-dark transition-all hover:-translate-y-0.5 shadow-btn text-base"
                >
                  D&eacute;couvrir nos formations <ArrowRight className="w-5 h-5" />
                </a>
              </div>

              {/* Right: image */}
              <div className="flex justify-end">
                <div className="relative w-full max-w-[520px] aspect-[4/3] rounded-3xl overflow-hidden shadow-xl">
                  <Image
                    src="/images/Picture7.jpg"
                    alt="Formation expérience client"
                    fill
                    className="object-cover"
                    priority
                  />
                </div>
              </div>

            </div>
          </div>

          {/* Feature strip */}
          <div className="border-t border-black/[0.06] bg-light">
            <div className="cx-container py-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-8">
                {FEATURE_ITEMS.map(({ icon: Icon, label }) => (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-secondary" />
                    </div>
                    <p className="text-sm font-semibold text-dark leading-snug">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </section>

        {/* ── Nos formations ────────────────────────────────────────────── */}
        <section id="formations" className="cx-section bg-white">
          <div className="cx-container">

            {/* Section header */}
            <div className="cx-section-title text-center mb-12">
              {/*
                PILOT-UX-1 (Marième, "Corrections Following the Pilot Phase"):
                the "Ce que nous offrons" label was too small to read as a
                section title — raised from text-xs to text-sm / md:text-base.
                Typography only; the section layout is unchanged.
              */}
              <span className="inline-block text-sm md:text-base font-bold text-secondary uppercase tracking-widest mb-3">
                Ce que nous offrons
              </span>
              <h2>Des formations adapt&eacute;es &agrave; vos besoins</h2>
              {/* Approved lead copy, verbatim from the pilot corrections deck. */}
              <p>
                Choisissez un parcours de formation adapt&eacute; &agrave; votre niveau et apprenez
                &agrave; votre rythme.
              </p>
            </div>

            {/* Mode cards */}
            <div className="grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">

              {/* Formation en ligne */}
              <div className="cx-card border-t-4 border-primary p-8 flex flex-col hover:shadow-md transition-shadow">
                {/* Header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Monitor className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="text-lg font-bold text-dark">Formation en ligne</h3>
                </div>
                {/* Body */}
                <div className="flex-1">
                  <p className="text-cx-gray text-sm leading-relaxed mb-4">
                    Modules pratiques accessibles &agrave; votre rythme, &agrave; tout moment.
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <ul className="flex-1 space-y-3 text-sm text-dark">
                      {/*
                        Approved benefit list from the pilot corrections deck.
                        NOTE: "Quiz" and "Ressources PDF" are advertised here
                        while the learner-facing quiz flow and PDF resources are
                        still open items in Marième's own action table (both
                        "High / To do"). The claim is kept per the phase brief —
                        the functionality is being closed in later phases — and
                        the mismatch is reported rather than silently resolved.
                      */}
                      {['Accès immédiat', 'Cas pratiques • Quiz • Ressources PDF', 'Mobile, tablette et ordinateur'].map(f => (
                        <li key={f} className="flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-success shrink-0" /> {f}
                        </li>
                      ))}
                    </ul>
                    <div className="relative w-full h-36 sm:w-28 sm:h-28 shrink-0 rounded-xl overflow-hidden">
                      <Image src="/images/screenImg.jpg" alt="Formation en ligne" fill className="object-cover" />
                    </div>
                  </div>
                </div>
                {/* Footer */}
                <Link href="/courses" className="mt-6 text-sm font-semibold text-primary hover:underline inline-flex items-center gap-1">
                  Voir les formations <ArrowRight className="w-4 h-4" />
                </Link>
              </div>

              {/* Formation en présentiel */}
              <div className="cx-card border-t-4 border-secondary p-8 flex flex-col hover:shadow-md transition-shadow">
                {/* Header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
                    <MapPin className="w-6 h-6 text-secondary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-dark">Formation en pr&eacute;sentiel</h3>
                    {/* XP-BRAND-01 §10 */}
                    <span className="mt-1 inline-flex items-center rounded-full border border-soon-fg/20 bg-soon-bg px-2.5 py-0.5 text-xs font-semibold text-soon-fg">
                      Bient&ocirc;t disponible
                    </span>
                  </div>
                </div>
                {/* Body */}
                <div className="flex-1">
                  <p className="text-cx-gray text-sm leading-relaxed mb-4">
                    Ateliers interactifs pour &eacute;quipes et professionnels.
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <ul className="flex-1 space-y-3 text-sm text-dark">
                      {['Dakar et région', 'Groupes et équipes', 'Programme sur mesure'].map(f => (
                        <li key={f} className="flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-success shrink-0" /> {f}
                        </li>
                      ))}
                    </ul>
                    <div className="relative w-full h-36 sm:w-28 sm:h-28 shrink-0 rounded-xl overflow-hidden">
                      <Image src="/images/Picture6.jpg" alt="Formation en présentiel" fill className="object-cover" />
                    </div>
                  </div>
                </div>
                {/* Footer */}
                {/* The booking action is withdrawn until the offer opens: a
                    disabled control still reads as "soon", a live link would
                    take a booking the academy cannot honour. */}
                <p className="mt-6 text-sm text-cx-gray">
                  Les formations en pr&eacute;sentiel seront propos&eacute;es prochainement.
                </p>
              </div>

            </div>
          </div>
        </section>

        {/* ── À propos ──────────────────────────────────────────────────── */}
        <section id="a-propos" className="cx-section bg-white">
          <div className="cx-container max-w-5xl">
            <div className="flex flex-col md:flex-row gap-10 lg:gap-16 items-center">

              {/* Left: text */}
              <div className="flex-1">
                <span className="inline-block text-xs font-bold text-primary uppercase tracking-widest mb-3">
                  &Agrave; propos
                </span>
                <h2 className="text-2xl md:text-3xl font-extrabold text-dark mb-5 leading-tight">
                  Une approche pratique de l&apos;exp&eacute;rience client
                </h2>

                <p className="text-cx-gray leading-relaxed mb-3">
                  XP Client Academy propose des formations con&ccedil;ues pour les r&eacute;alit&eacute;s
                  du march&eacute; s&eacute;n&eacute;galais.
                </p>
                <p className="text-cx-gray leading-relaxed mb-3">
                  &Agrave; travers des cas pratiques, des mises en situation et des exemples concrets,
                  la plateforme aide les professionnels &agrave; d&eacute;velopper une exp&eacute;rience
                  client plus simple, plus humaine et plus efficace.
                </p>
                <p className="text-cx-gray leading-relaxed mb-7">
                  Les contenus sont pens&eacute;s pour &ecirc;tre directement applicables sur le terrain,
                  quel que soit le secteur d&apos;activit&eacute;.
                </p>

                {/* Checklist */}
                <div className="flex flex-col gap-3 mb-8">
                  {[
                    'Cas pratiques et mises en situation',
                    'Formations adaptées au contexte local',
                    'Apprentissage concret et applicable immédiatement',
                  ].map(item => (
                    <div key={item} className="flex items-center gap-2.5 text-sm text-dark">
                      <CheckCircle className="w-4 h-4 text-success shrink-0" />
                      {item}
                    </div>
                  ))}
                </div>

                {/* Founder credibility card */}
                <div className="flex items-start gap-3 bg-light rounded-xl p-4 mb-5 border border-black/[0.06]">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <UserCircle className="w-5 h-5 text-primary" />
                  </div>
                  <p className="text-sm text-cx-gray leading-relaxed">
                    Fond&eacute;e par <strong className="text-dark">Marieme Ba</strong>, certifi&eacute;e
                    en exp&eacute;rience client et passionn&eacute;e par l&apos;am&eacute;lioration des
                    parcours clients au S&eacute;n&eacute;gal.
                  </p>
                </div>

                {/* CTA */}
                <a
                  href="/about/founder"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
                >
                  D&eacute;couvrir le parcours de la fondatrice <ArrowRight className="w-4 h-4" />
                </a>
              </div>

              {/* Right: image */}
              <div className="w-full md:w-[340px] lg:w-[420px] shrink-0">
                <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden shadow-lg">
                  <Image
                    src="/images/about-laptop.png"
                    alt="Formation en ligne XP Client Academy — expérience client"
                    fill
                    className="object-cover"
                  />
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ── Contact ───────────────────────────────────────────────────── */}
        <section id="contact" className="cx-section bg-white">
          <div className="cx-container max-w-4xl">
            <div className="cx-section-title text-center mb-12">
              <h2>Contactez-nous</h2>
              <p>
                Une question sur une formation&nbsp;? Une demande particuli&egrave;re&nbsp;?
                Remplissez le formulaire &mdash; nous vous r&eacute;pondons sous 24h.
              </p>
            </div>

            <div className="grid md:grid-cols-[1fr_260px] gap-10">
              {/* Form */}
              <div className="cx-card p-7">
                <ContactForm />
              </div>

              {/* Sidebar */}
              <div className="flex flex-col gap-5">
                <div className="cx-card p-6">
                  <h3 className="text-sm font-bold text-dark uppercase tracking-wider mb-4">Nos coordonn&eacute;es</h3>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-start gap-3">
                      <Mail className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-cx-gray font-semibold mb-0.5">Email</p>
                        <a href={`mailto:${CONTACT_EMAIL}`} className="text-sm text-dark hover:text-primary transition-colors break-all">
                          {CONTACT_EMAIL}
                        </a>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Phone className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-cx-gray font-semibold mb-0.5">T&eacute;l&eacute;phone</p>
                        <a href={CONTACT_PHONE_HREF} className="text-sm text-dark hover:text-primary transition-colors">
                          {CONTACT_PHONE}
                        </a>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-cx-gray font-semibold mb-0.5">Localisation</p>
                        <p className="text-sm text-dark">Dakar, S&eacute;n&eacute;gal</p>
                        <p className="text-xs text-cx-gray">Formations disponibles &agrave; distance</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="cx-card p-6 bg-primary/5 border-primary/10">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-bold text-dark">Formation en pr&eacute;sentiel</h3>
                    <span className="inline-flex items-center rounded-full border border-soon-fg/20 bg-soon-bg px-2 py-0.5 text-[11px] font-semibold text-soon-fg">
                      Bient&ocirc;t disponible
                    </span>
                  </div>
                  <p className="text-xs text-cx-gray leading-relaxed">
                    Les formations en pr&eacute;sentiel seront propos&eacute;es prochainement.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA Banner ────────────────────────────────────────────────── */}
        <section className="cx-hero-gradient text-white py-16">
          <div className="cx-container text-center">
            <h2 className="text-2xl md:text-3xl font-extrabold mb-3">
              Pr&ecirc;t &agrave; d&eacute;velopper vos comp&eacute;tences en exp&eacute;rience client&nbsp;?
            </h2>
            <p className="text-white/80 mb-8 max-w-lg mx-auto">
              Des formations pratiques, accessibles en ligne et adapt&eacute;es &agrave; votre rythme.
            </p>
            {/* One CTA. The présentiel booking link is withdrawn here too — the
                offer carries "Bientôt disponible" everywhere it appears. */}
            <div className="flex justify-center">
              <FinalCtaButton />
            </div>
          </div>
        </section>

      </main>
      <Footer />
    </>
  )
}
