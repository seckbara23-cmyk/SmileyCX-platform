import Image from 'next/image'
import { HERO_CHIPS } from '../content'

export default function CoursesHero() {
  return (
    <section className="cx-container pt-6">
      <div className="cx-hero-gradient rounded-3xl text-white overflow-hidden">
        <div className="grid lg:grid-cols-[1.15fr,1fr] gap-8 lg:gap-12 items-center p-7 sm:p-10 md:p-12">

          {/* Left: copy */}
          <div>
            <span className="inline-flex items-center gap-2 bg-white/15 border border-white/25 text-white text-xs font-semibold px-4 py-1.5 rounded-full mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-white/80 shrink-0" />
              Plateforme de formation ax&eacute;e sur la relation client moderne
            </span>

            <h1 className="text-4xl md:text-5xl font-extrabold leading-tight mb-3">
              Nos formations
            </h1>
            <p className="text-white/85 text-base md:text-lg leading-relaxed max-w-md mb-7">
              D&eacute;veloppez vos comp&eacute;tences, offrez une exp&eacute;rience client d&apos;exception.
            </p>

            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              {HERO_CHIPS.map(({ Icon, label }) => (
                <span key={label} className="inline-flex items-center gap-2.5 text-sm font-medium text-white/90">
                  <span className="w-8 h-8 rounded-lg bg-white/15 border border-white/20 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4" />
                  </span>
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Right: image */}
          <div className="relative w-full h-56 sm:h-64 md:h-72 rounded-2xl overflow-hidden">
            <Image
              src="/images/hero-formation.jpg"
              alt="Apprenante souriante suivant une formation XP Client Academy sur son ordinateur"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 480px"
              className="object-cover"
            />
          </div>

        </div>
      </div>
    </section>
  )
}
