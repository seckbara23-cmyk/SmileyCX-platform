import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, Clock, CheckCircle, MapPin, GraduationCap, Layers } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Nos formations',
  description: 'Formations pratiques en expérience client, service client et relation client adaptées au contexte africain.',
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
    image: '/images/Picture3.jpg',
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
    image: '/images/Elearning.jpeg',
    formation: 3,
  },
]

function levelLabel(level: string) {
  if (level === 'beginner'     || level === 'Débutant')     return 'Débutant'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'Intermédiaire'
  if (level === 'advanced'     || level === 'Avancé')        return 'Avancé'
  return level
}

function levelBadgeClass(level: string) {
  if (level === 'beginner'     || level === 'Débutant')     return 'bg-success/10 text-success'
  if (level === 'intermediate' || level === 'Intermédiaire') return 'bg-primary/10 text-primary'
  return 'bg-secondary/10 text-secondary'
}

export default async function CoursesPage() {
  const supabase = await createClient()
  const { data: dbCourses } = await supabase
    .from('courses')
    .select('id, slug, title, description, duration_hours, level, cover_url, modules(id)')
    .eq('is_published', true)
    .order('created_at', { ascending: true })

  const hasDbCourses = dbCourses && dbCourses.length > 0

  const allCourses = hasDbCourses
    ? dbCourses!.map((c, i) => ({
        title:     c.title,
        desc:      c.description ?? '',
        duration:  c.duration_hours ? `${c.duration_hours}h` : '',
        level:     c.level ?? '',
        slug:      c.slug as string,
        available: true,
        modules:   Array.isArray(c.modules) ? c.modules.length : 0,
        objectives: [] as string[],
        image:     c.cover_url ?? STATIC_COURSES[i]?.image ?? null,
        formation: i + 1,
      }))
    : STATIC_COURSES

  return (
    <div>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="cx-hero-gradient text-white py-16">
        <div className="cx-container">
          <div className="inline-flex items-center gap-2 bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse shrink-0" />
            Phase pilote — Vos retours nous aident &agrave; am&eacute;liorer l&apos;exp&eacute;rience
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold mb-3">Nos formations</h1>
          <p className="text-white/80 text-base max-w-xl">
            D&eacute;veloppez vos comp&eacute;tences. Offrez une exp&eacute;rience client d&apos;exception.
          </p>
        </div>
      </div>

      <div className="cx-section">
        <div className="cx-container">

          {/* ── Course grid ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-14">
            {allCourses.map((course) => (
              <div
                key={course.slug}
                className={`cx-card flex flex-col rounded-2xl overflow-hidden hover:shadow-lg hover:-translate-y-1 transition-all duration-200${!course.available ? ' opacity-80' : ''}`}
              >
                {/* Top image */}
                <div className="relative w-full h-44 bg-light shrink-0">
                  {course.image ? (
                    <Image
                      src={course.image}
                      alt={course.title}
                      fill
                      className="object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <GraduationCap className="w-16 h-16 text-primary/20" />
                    </div>
                  )}
                  {!course.available && (
                    <div className="absolute inset-0 bg-dark/40 flex items-center justify-center">
                      <span className="bg-white text-dark text-xs font-bold px-3 py-1.5 rounded-full">
                        Bient&ocirc;t disponible
                      </span>
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="flex flex-col flex-1 p-6">
                  {/* Level badge */}
                  <div className="mb-3">
                    <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${levelBadgeClass(course.level)}`}>
                      {levelLabel(course.level)}
                    </span>
                  </div>

                  <h2 className="text-base font-bold text-dark leading-snug mb-2">{course.title}</h2>
                  <p className="text-sm text-cx-gray leading-relaxed flex-1 mb-4 line-clamp-3">{course.desc}</p>

                  {/* Meta */}
                  <div className="flex items-center gap-4 text-xs text-cx-gray border-t border-black/[0.06] pt-4 mb-5">
                    {course.duration && (
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" /> {course.duration}
                      </span>
                    )}
                    {course.modules > 0 && (
                      <span className="flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5" /> {course.modules} modules
                      </span>
                    )}
                  </div>

                  {/* CTA */}
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

          {/* ── Target audience ─────────────────────────────────────────── */}
          <div className="bg-light rounded-2xl p-8 mb-10">
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

          {/* ── In-person CTA ───────────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-primary to-[#6b8ef0] rounded-2xl p-8 text-white flex flex-col md:flex-row gap-6 items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-5 h-5 text-white/80" />
                <h3 className="text-lg font-bold">Demander une formation en pr&eacute;sentiel</h3>
              </div>
              <p className="text-white/80 text-sm max-w-md">
                Ateliers interactifs &agrave; Dakar et en r&eacute;gion pour vos &eacute;quipes. Programme adapt&eacute; &agrave; votre secteur.
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
      </div>

    </div>
  )
}
