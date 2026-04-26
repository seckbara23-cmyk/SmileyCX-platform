import Image from 'next/image'
import { ArrowRight, CheckCircle, Monitor, MapPin, Clock, Mail, Phone } from 'lucide-react'
import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'
import ContactForm from '@/app/(public)/contact/ContactForm'
import { createClient } from '@/lib/supabase/server'

const STATIC_COURSES = [
  {
    title: "Fondamentaux de l'expérience client",
    desc: "Maîtrisez les bases de la satisfaction client et de la relation de service dans le contexte local.",
    duration: '4h',
    level: 'Débutant',
    slug: null as string | null,
    available: false,
  },
  {
    title: "Créer une expérience client mémorable",
    desc: "Techniques concrètes pour concevoir des interactions qui fidélisent et différencient.",
    duration: '6h',
    level: 'Intermédiaire',
    slug: null as string | null,
    available: false,
  },
  {
    title: 'Service client digital',
    desc: "Gérer les canaux digitaux, réseaux sociaux et outils CRM pour une relation client moderne.",
    duration: '5h',
    level: 'Intermédiaire',
    slug: null as string | null,
    available: false,
  },
]

export default async function HomePage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('slug, title, description, level, duration_hours')
    .eq('is_published', true)
    .order('created_at', { ascending: true })
    .limit(3)

  const courses = dbCourses && dbCourses.length > 0
    ? dbCourses.map(c => ({
        title: c.title,
        desc: c.description ?? '',
        duration: c.duration_hours ? `${c.duration_hours}h` : '',
        level: c.level ?? '',
        slug: c.slug as string,
        available: true,
      }))
    : STATIC_COURSES
  return (
    <>
      <Header />
      <main className="pt-[72px]">

        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section id="accueil" className="relative cx-hero-gradient text-white overflow-hidden">
          <div className="cx-container py-16 sm:py-24">
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">

              {/* Left: text */}
              <div>
                <span className="inline-block bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-1.5 rounded-full mb-6 tracking-wide">
                  La Teranga au c&oelig;ur de l&apos;exp&eacute;rience client
                </span>
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold leading-tight mb-5 tracking-tight">
                  Transformez l&apos;exp&eacute;rience client en avantage concurrentiel
                </h1>
                <p className="text-white/85 text-lg leading-relaxed mb-8 max-w-lg">
                  Des formations concr&egrave;tes, en ligne et en pr&eacute;sentiel, pour am&eacute;liorer la qualit&eacute; de service et la satisfaction client.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <a
                    href="#contact"
                    className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white/15 border border-white/30 text-white font-semibold rounded-cx hover:bg-white/25 transition-all text-base"
                  >
                    Nous contacter
                  </a>
                </div>
              </div>

              {/* Right: hero image */}
              <div className="hidden lg:block">
                <div className="relative rounded-2xl overflow-hidden aspect-[4/3]">
                  <Image
                    src="/images/hero-formation.jpg"
                    alt="Formation expérience client"
                    fill
                    className="object-cover"
                    priority
                  />
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ── Nos formations ────────────────────────────────────────────── */}
        <section id="formations" className="cx-section bg-light">
          <div className="cx-container">
            <div className="cx-section-title text-center mb-12">
              <h2>Nos formations</h2>
              <p>
                Apprenez concr&egrave;tement avec des exemples r&eacute;els adapt&eacute;s au contexte local
                et des outils applicables imm&eacute;diatement.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {courses.map((course, i) => (
                <div key={course.slug ?? i} className={`cx-card flex flex-col ${!course.available ? 'opacity-70' : ''}`}>
                  <div className="p-6 flex flex-col flex-1">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">
                        {course.level}
                      </span>
                      {!course.available && (
                        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-cx-gray/10 text-cx-gray">
                          Bient&ocirc;t disponible
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-bold text-dark mb-2 leading-snug">{course.title}</h3>
                    <p className="text-sm text-cx-gray leading-relaxed flex-1 mb-4">{course.desc}</p>
                    {course.duration && (
                      <div className="flex items-center gap-3 text-xs text-cx-gray mb-5">
                        <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {course.duration}</span>
                      </div>
                    )}
                    {course.available && course.slug ? (
                      <a
                        href={`/courses/${course.slug}`}
                        className="mt-auto inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-secondary text-white text-sm font-bold rounded-cx hover:bg-secondary-dark transition-all"
                      >
                        Acc&eacute;der <ArrowRight className="w-4 h-4" />
                      </a>
                    ) : (
                      <a
                        href="#contact"
                        className="mt-auto inline-flex items-center justify-center w-full px-4 py-2.5 bg-light border border-black/[0.08] text-cx-gray text-sm font-semibold rounded-cx hover:bg-white transition-colors"
                      >
                        &Ecirc;tre notifi&eacute;
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Types de formation ────────────────────────────────────────── */}
        <section className="cx-section bg-white">
          <div className="cx-container">
            <div className="cx-section-title text-center mb-12">
              <h2>Modes de formation</h2>
              <p>Choisissez le format adapt&eacute; &agrave; votre situation et &agrave; vos objectifs.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
              <div className="cx-card p-8 flex flex-col gap-4 border-t-4 border-primary">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Monitor className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-dark mb-1">Formation en ligne</h3>
                  <p className="text-cx-gray text-sm leading-relaxed">
                    Modules pratiques accessibles &agrave; votre rythme, &agrave; tout moment.
                  </p>
                </div>
                <ul className="flex flex-col gap-2 text-sm text-dark mt-2">
                  {['Accès immédiat', 'Vidéos + ressources PDF', 'Mobile & desktop'].map(f => (
                    <li key={f} className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-success shrink-0" /> {f}
                    </li>
                  ))}
                </ul>
                <a href="#formations" className="mt-2 text-sm font-semibold text-primary hover:underline flex items-center gap-1">
                  Voir les formations <ArrowRight className="w-4 h-4" />
                </a>
              </div>

              <div className="cx-card p-8 flex flex-col gap-4 border-t-4 border-secondary">
                <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center">
                  <MapPin className="w-6 h-6 text-secondary" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-dark mb-1">Formation en pr&eacute;sentiel</h3>
                  <p className="text-cx-gray text-sm leading-relaxed">
                    Ateliers interactifs pour &eacute;quipes et professionnels.
                  </p>
                </div>
                <ul className="flex flex-col gap-2 text-sm text-dark mt-2">
                  {['Dakar et région', 'Groupes et équipes', 'Programme sur mesure'].map(f => (
                    <li key={f} className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-success shrink-0" /> {f}
                    </li>
                  ))}
                </ul>
                <a href="#contact" className="mt-2 text-sm font-semibold text-secondary hover:underline flex items-center gap-1">
                  Demander un atelier <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── À propos ──────────────────────────────────────────────────── */}
        <section id="a-propos" className="cx-section bg-light">
          <div className="cx-container max-w-4xl">
            <div className="grid md:grid-cols-[280px_1fr] gap-10 lg:gap-16 items-center">

              {/* Photo */}
              <div className="mx-auto md:mx-0">
                <div className="relative w-56 h-56 md:w-full md:h-72 rounded-2xl overflow-hidden">
                  <Image
                    src="/images/Picture5.jpg"
                    alt="Fondatrice SmileyCX Academy"
                    fill
                    className="object-cover"
                  />
                </div>
              </div>

              {/* Text */}
              <div>
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
                        <a href="mailto:bonjour@smileycx.com" className="text-sm text-dark hover:text-primary transition-colors">
                          bonjour@smileycx.com
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
