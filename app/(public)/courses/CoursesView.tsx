'use client'
import { useState } from 'react'
import { BookOpen, LayoutGrid } from 'lucide-react'
import { PARCOURS, type CourseItem, type ParcoursId } from './content'
import CoursesHero from './_components/CoursesHero'
import ParcoursCard from './_components/ParcoursCard'
import CourseCard from './_components/CourseCard'
import PricingSection from './_components/PricingSection'
import BenefitsStrip from './_components/BenefitsStrip'

type Selection = ParcoursId | 'all'

const ICON_WRAP: Record<Selection, string> = {
  debutant:      'bg-success/10 text-success',
  intermediaire: 'bg-primary/10 text-primary',
  avance:        'bg-violet-600/10 text-violet-600',
  all:           'bg-dark/10 text-dark',
}

export default function CoursesView({ courses }: { courses: CourseItem[] }) {
  const [selected, setSelected] = useState<Selection>('debutant')

  const activeParcours = PARCOURS.find(p => p.id === selected)
  const visibleCourses = (
    selected === 'all' ? [...courses] : courses.filter(c => c.parcours === selected)
  ).sort((a, b) => Number(b.available) - Number(a.available))

  function selectParcours(id: Selection) {
    setSelected(id)
    document.getElementById('formations')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div>

      <CoursesHero />

      {/* ── Parcours ──────────────────────────────────────────────────────── */}
      <section className="py-14 md:py-16">
        <div className="cx-container">
          <div className="text-center mb-10">
            <p className="text-secondary text-xs font-bold uppercase tracking-widest mb-2">
              Choisissez votre parcours
            </p>
            <h2 className="text-2xl md:text-3xl font-extrabold text-dark mb-3">
              Quel parcours vous correspond&nbsp;?
            </h2>
            <p className="text-cx-gray text-sm max-w-xl mx-auto leading-relaxed">
              Chaque parcours est con&ccedil;u pour r&eacute;pondre &agrave; des besoins et vous aider &agrave;
              d&eacute;velopper des comp&eacute;tences cl&eacute;s.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {PARCOURS.map((p) => (
              <ParcoursCard key={p.id} parcours={p} onSelect={selectParcours} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Dynamic course listing ────────────────────────────────────────── */}
      <section className="pb-14 md:pb-16 scroll-mt-24" id="formations">
        <div className="cx-container">

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div className="flex items-center gap-3.5">
              <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${ICON_WRAP[selected]}`}>
                <BookOpen className="w-5 h-5" aria-hidden />
              </span>
              <div>
                <h2 className="text-xl md:text-2xl font-extrabold text-dark leading-tight" aria-live="polite">
                  {activeParcours ? (
                    <>
                      Formations du parcours{' '}
                      <span className={activeParcours.accentTextClass}>{activeParcours.label}</span>
                    </>
                  ) : (
                    'Toutes les formations'
                  )}
                </h2>
                <p className="text-xs text-cx-gray mt-0.5">
                  {activeParcours
                    ? activeParcours.tagline
                    : 'Du fondamental à la transformation CX.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSelected('all')}
              aria-pressed={selected === 'all'}
              className={`self-start sm:self-auto inline-flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold rounded-xl border transition-colors ${
                selected === 'all'
                  ? 'bg-dark text-white border-dark'
                  : 'bg-white text-dark border-black/[0.1] hover:bg-light'
              }`}
            >
              <LayoutGrid className="w-4 h-4" aria-hidden /> Voir toutes les formations
            </button>
          </div>

          {visibleCourses.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {visibleCourses.map((course) => (
                <CourseCard key={`${course.parcours}-${course.slug ?? course.title}`} course={course} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-cx-gray py-8 text-center">
              Aucune formation dans ce parcours pour le moment.
            </p>
          )}

        </div>
      </section>

      <PricingSection />

      <BenefitsStrip />

    </div>
  )
}
