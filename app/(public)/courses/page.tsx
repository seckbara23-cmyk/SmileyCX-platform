import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, Clock, CheckCircle, Lock, MapPin, GraduationCap } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Nos formations — SmileyCX Academy',
  description: 'Formations en expérience client en ligne et en présentiel, adaptées au contexte local.',
}

const STATIC_COURSES = [
  {
    title: "Fondamentaux de l'expérience client",
    desc: "Comprenez les bases de l'expérience client et apprenez à analyser le parcours client pour identifier les points de friction et les moments clés.",
    duration: '4h',
    level: 'Débutant',
    slug: 'fondamentaux-experience-client',
    available: true,
    modules: 4,
    objectives: ["Comprendre l'expérience client", 'Comprendre le parcours client'],
    image: '/images/Formation1.jpg',
    formation: 1,
  },
  {
    title: 'Créer une expérience client mémorable',
    desc: 'Techniques concrètes pour concevoir des interactions qui fidélisent et différencient votre organisation.',
    duration: '6h',
    level: 'Intermédiaire',
    slug: 'experience-client-memorable',
    available: true,
    modules: 5,
    objectives: [],
    image: null,
    formation: 2,
  },
  {
    title: 'Service client digital',
    desc: 'Gérer les canaux digitaux, réseaux sociaux et outils CRM pour une relation client moderne et efficace.',
    duration: '5h',
    level: 'Intermédiaire',
    slug: 'service-client-digital',
    available: false,
    modules: 4,
    objectives: [],
    image: null,
    formation: 3,
  },
]

function levelLabel(level: string) {
  if (level === 'beginner' || level === 'Débutant') return 'Débutant'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'Intermédiaire'
  if (level === 'advanced' || level === 'Avancé') return 'Avancé'
  return level
}

export default async function CoursesPage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, slug, title, description, duration_hours, level, cover_url, modules(id)')
    .eq('is_published', true)
    .order('created_at', { ascending: false })

  const hasDbCourses = dbCourses && dbCourses.length > 0

  // Normalise DB courses to the same shape as static ones
  const allCourses = hasDbCourses
    ? dbCourses!.map((c, i) => ({
        title: c.title,
        desc: c.description ?? '',
        duration: c.duration_hours ? `${c.duration_hours}h` : '',
        level: c.level ?? '',
        slug: c.slug as string,
        available: true,
        modules: Array.isArray(c.modules) ? c.modules.length : 0,
        objectives: [] as string[],
        image: c.cover_url ?? null,
        formation: i + 1,
      }))
    : STATIC_COURSES

  const [featured, ...rest] = allCourses

  return (
    <div>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="cx-hero-gradient text-white py-14">
        <div className="cx-container">
          <div className="inline-block bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-1.5 rounded-full mb-5 tracking-wide">
            Plateforme en phase pilote — accès anticipé disponible
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold mb-3">Nos formations</h1>
          <p className="text-white/80 text-base max-w-xl">
            Des programmes conçus pour les professionnels de la relation client en Afrique de l&apos;Ouest —
            applicables immédiatement, en ligne ou en présentiel.
          </p>
        </div>
      </div>

      <div className="cx-section">
        <div className="cx-container">

          {/* ── Featured beginner card ────────────────────────────────── */}
          {featured && (
            <div className="mb-8 rounded-2xl overflow-hidden bg-[#fdf8f2] border border-[#f0e6d3] shadow-sm">
              <div className="grid md:grid-cols-[1fr_300px] lg:grid-cols-[1fr_360px]">

                {/* Left: content */}
                <div className="p-7 md:p-10 flex flex-col justify-center">
                  {/* Badges row */}
                  <div className="flex items-center gap-2 mb-5">
                    <span className="flex items-center gap-1.5 bg-secondary/15 text-secondary text-[11px] font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                      <GraduationCap className="w-3.5 h-3.5" />
                      Formation en ligne
                    </span>
                    <span className="bg-primary/10 text-primary text-[11px] font-semibold px-2.5 py-1 rounded-full">
                      {levelLabel(featured.level)}
                    </span>
                  </div>

                  <h2 className="text-xl md:text-2xl font-extrabold text-dark leading-snug mb-3">
                    {featured.title}
                  </h2>
                  <p className="text-sm text-cx-gray leading-relaxed mb-5">{featured.desc}</p>

                  {/* Checklist */}
                  {featured.objectives.length > 0 && (
                    <ul className="flex flex-col gap-2 mb-6">
                      {featured.objectives.map(obj => (
                        <li key={obj} className="flex items-center gap-2 text-sm text-dark">
                          <CheckCircle className="w-4 h-4 text-success shrink-0" /> {obj}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Meta */}
                  {featured.duration && (
                    <p className="flex items-center gap-1.5 text-xs text-cx-gray mb-6">
                      <Clock className="w-3.5 h-3.5" /> {featured.duration} · {featured.modules} modules
                    </p>
                  )}

                  <div>
                    {featured.available ? (
                      <Link
                        href={`/courses/${featured.slug}`}
                        className="inline-flex items-center gap-2 px-6 py-3 bg-secondary text-white text-sm font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5"
                      >
                        Voir la formation <ArrowRight className="w-4 h-4" />
                      </Link>
                    ) : (
                      <Link
                        href="/contact"
                        className="inline-flex items-center gap-2 px-6 py-3 bg-white border border-black/[0.1] text-cx-gray text-sm font-semibold rounded-cx hover:bg-light transition-colors"
                      >
                        Être notifié à l&apos;ouverture
                      </Link>
                    )}
                  </div>
                </div>

                {/* Right: illustration */}
                <div className="relative hidden md:block bg-[#f5ede0]">
                  {featured.image ? (
                    <Image
                      src={featured.image}
                      alt={featured.title}
                      fill
                      className="object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <GraduationCap className="w-20 h-20 text-secondary/20" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Remaining course cards ────────────────────────────────── */}
          {rest.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-6 mb-14">
              {rest.map((course) => (
                <div key={course.slug} className={`cx-card flex flex-col ${!course.available ? 'opacity-70' : ''}`}>
                  <div className="p-6 flex flex-col flex-1">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">
                        {levelLabel(course.level)}
                      </span>
                      {!course.available && (
                        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-500">
                          Bientôt disponible
                        </span>
                      )}
                    </div>

                    <h2 className="text-base font-bold text-dark mb-2 leading-snug">{course.title}</h2>
                    <p className="text-sm text-cx-gray leading-relaxed flex-1 mb-4 line-clamp-3">{course.desc}</p>

                    <div className="flex items-center gap-4 text-xs text-cx-gray mb-5">
                      {course.duration && <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {course.duration}</span>}
                      {course.modules > 0 && <span>{course.modules} modules</span>}
                    </div>

                    {course.available ? (
                      <Link
                        href={`/courses/${course.slug}`}
                        className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-secondary text-white text-sm font-bold rounded-cx hover:bg-secondary-dark transition-all"
                      >
                        Voir la formation <ArrowRight className="w-4 h-4" />
                      </Link>
                    ) : (
                      <Link
                        href="/contact"
                        className="inline-flex items-center justify-center w-full px-4 py-2.5 bg-light border border-black/[0.08] text-cx-gray text-sm font-semibold rounded-cx hover:bg-white transition-colors"
                      >
                        &Ecirc;tre notifi&eacute; &agrave; l&apos;ouverture
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Target audience ───────────────────────────────────────── */}
          <div className="bg-light rounded-2xl p-8 mb-10">
            <h2 className="text-lg font-bold text-dark mb-5">À qui s&apos;adressent ces formations ?</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {[
                { title: 'Professionnels de la relation client', desc: 'Agents, conseillers, chargés de clientèle souhaitant améliorer leurs compétences.' },
                { title: 'Managers et responsables', desc: "Responsables service client, directeurs qualité, managers d'équipe." },
                { title: 'Entrepreneurs et TPE/PME', desc: 'Dirigeants souhaitant structurer leur approche client dès le départ.' },
                { title: 'Équipes en entreprise', desc: 'Formations sur mesure en présentiel pour groupes de 5 à 30 personnes.' },
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

          {/* ── In-person CTA ─────────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-primary to-[#6b8ef0] rounded-2xl p-8 text-white flex flex-col md:flex-row gap-6 items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-5 h-5 text-white/80" />
                <h3 className="text-lg font-bold">Demander une formation en présentiel</h3>
              </div>
              <p className="text-white/80 text-sm max-w-md">
                Ateliers interactifs à Dakar et en région pour vos équipes. Programme adapté à votre secteur.
              </p>
            </div>
            <Link
              href="/contact?service=presentiel"
              className="shrink-0 px-6 py-3 bg-white text-primary font-bold rounded-cx hover:bg-white/90 transition-all hover:-translate-y-0.5 whitespace-nowrap"
            >
              Nous contacter
            </Link>
          </div>

        </div>
      </div>
    </div>
  )
}
