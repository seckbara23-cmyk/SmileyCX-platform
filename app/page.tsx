import Image from 'next/image'
import { ArrowRight, CheckCircle, Monitor, MapPin, Mail, Phone, BookOpen, Award, Users } from 'lucide-react'
import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'
import ContactForm from '@/app/(public)/contact/ContactForm'

const FEATURE_ITEMS = [
  { icon: BookOpen, label: 'Formations pratiques et concrètes' },
  { icon: Monitor,  label: 'En ligne et en présentiel' },
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
                  Des formations concr&egrave;tes, en ligne et en pr&eacute;sentiel, pour am&eacute;liorer
                  la qualit&eacute; de service et la satisfaction client.
                </p>
                <a
                  href="#formations"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#131140] text-white font-bold rounded-cx hover:bg-[#1c1a5e] transition-all hover:-translate-y-0.5 shadow-btn text-base"
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
              <span className="inline-block text-xs font-bold text-secondary uppercase tracking-widest mb-3">
                Ce que nous offrons
              </span>
              <h2>Des formations adapt&eacute;es &agrave; vos besoins</h2>
              <p>
                Apprenez concr&egrave;tement avec des exemples r&eacute;els adapt&eacute;s au contexte local
                et des outils directement applicables.
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
                      {['Accès immédiat', 'Vidéos + ressources PDF', 'Mobile & desktop'].map(f => (
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
                <a href="/courses" className="mt-6 text-sm font-semibold text-primary hover:underline inline-flex items-center gap-1">
                  Voir les formations <ArrowRight className="w-4 h-4" />
                </a>
              </div>

              {/* Formation en présentiel */}
              <div className="cx-card border-t-4 border-secondary p-8 flex flex-col hover:shadow-md transition-shadow">
                {/* Header */}
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
                    <MapPin className="w-6 h-6 text-secondary" />
                  </div>
                  <h3 className="text-lg font-bold text-dark">Formation en pr&eacute;sentiel</h3>
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
                <a href="#contact" className="mt-6 text-sm font-semibold text-secondary hover:underline inline-flex items-center gap-1">
                  Demander un atelier <ArrowRight className="w-4 h-4" />
                </a>
              </div>

            </div>
          </div>
        </section>

        {/* ── À propos ──────────────────────────────────────────────────── */}
        <section id="a-propos" className="cx-section bg-light">
          <div className="cx-container max-w-5xl">
            <div className="flex flex-col md:flex-row gap-10 lg:gap-16 items-center">

              {/* Left: text */}
              <div className="flex-1">
                <span className="inline-block text-xs font-bold text-primary uppercase tracking-widest mb-3">
                  &Agrave; propos
                </span>
                <h2 className="text-2xl md:text-3xl font-extrabold text-dark mb-4 leading-tight">
                  Une expertise locale, une approche concr&egrave;te
                </h2>
                <p className="text-cx-gray leading-relaxed mb-4">
                  SmileyCX Academy est n&eacute; d&apos;un constat simple&nbsp;: les formations en exp&eacute;rience client disponibles sur le march&eacute;
                  ne refl&egrave;tent pas les r&eacute;alit&eacute;s du contexte s&eacute;n&eacute;galais et ouest-africain.
                </p>
                <p className="text-cx-gray leading-relaxed mb-6">
                  Nos programmes sont construits &agrave; partir de cas r&eacute;els, avec une p&eacute;dagogie adapt&eacute;e aux professionnels
                  de la relation client en Afrique de l&apos;Ouest &mdash; agents, managers, entrepreneurs.
                </p>
                <div className="flex flex-col gap-3">
                  {[
                    "10+ années d'expertise en expérience client",
                    'Formations adaptées au marché local',
                    'Approche pratique et immédiatement applicable',
                  ].map(item => (
                    <div key={item} className="flex items-start gap-2 text-sm text-dark">
                      <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" /> {item}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: photo */}
              <div className="w-full md:w-[340px] lg:w-[400px] shrink-0">
                <div className="relative w-full aspect-[4/3] rounded-2xl overflow-hidden shadow-md">
                  <Image
                    src="/images/Picture2.jpg"
                    alt="Fondatrice SmileyCX Academy"
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
                Une question sur une formation&nbsp;? Une demande d&apos;atelier en pr&eacute;sentiel&nbsp;?
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
                        <a href="mailto:mariemeify@gmail.com" className="text-sm text-dark hover:text-primary transition-colors">
                          mariemeify@gmail.com
                        </a>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Phone className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs text-cx-gray font-semibold mb-0.5">T&eacute;l&eacute;phone</p>
                        <p className="text-sm text-dark">+(221) 77 576 0306</p>
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
                  <h3 className="text-sm font-bold text-dark mb-2">Formation en pr&eacute;sentiel</h3>
                  <p className="text-xs text-cx-gray leading-relaxed">
                    Ateliers sur mesure pour &eacute;quipes de 5 &agrave; 30 personnes &agrave; Dakar et en r&eacute;gion.
                    Pr&eacute;cisez &laquo;&nbsp;Formation en pr&eacute;sentiel&nbsp;&raquo; dans le champ Service.
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
              Pr&ecirc;t &agrave; investir dans la qualit&eacute; de service&nbsp;?
            </h2>
            <p className="text-white/80 mb-8 max-w-lg mx-auto">
              Acc&egrave;s anticip&eacute; disponible &mdash; rejoignez la phase pilote et formez vos &eacute;quipes d&egrave;s maintenant.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <a
                href="/courses"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white text-primary font-bold rounded-cx hover:bg-white/90 transition-all hover:-translate-y-0.5"
              >
                Acc&eacute;der aux formations <ArrowRight className="w-5 h-5" />
              </a>
              <a
                href="#contact"
                className="inline-flex items-center justify-center gap-2 px-7 py-3.5 border-2 border-white/40 text-white font-semibold rounded-cx hover:bg-white/15 transition-all"
              >
                Demander une formation en pr&eacute;sentiel
              </a>
            </div>
          </div>
        </section>

      </main>
      <Footer />
    </>
  )
}
