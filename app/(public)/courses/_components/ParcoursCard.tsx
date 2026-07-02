'use client'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import type { ParcoursConfig } from '../content'

interface Props {
  parcours: ParcoursConfig
  onSelect: (_id: ParcoursConfig['id']) => void
}

export default function ParcoursCard({ parcours, onSelect }: Props) {
  const { Icon } = parcours

  return (
    <div className="cx-card rounded-2xl p-6 md:p-7 flex flex-col hover:-translate-y-1 hover:shadow-md transition-all duration-300">

      {/* Badge */}
      <span className={`self-center text-[11px] font-bold uppercase tracking-wide px-3.5 py-1.5 rounded-full mb-6 ${parcours.badgeClass}`}>
        {parcours.badge}
      </span>

      {/* Illustration */}
      <div className={`self-center w-24 h-24 rounded-full flex items-center justify-center mb-6 ${parcours.iconWrapClass}`}>
        <Icon className={`w-10 h-10 ${parcours.iconClass}`} strokeWidth={1.75} aria-hidden />
      </div>

      {/* Title + description */}
      <h3 className="text-center text-lg font-extrabold text-dark leading-snug mb-2">
        {parcours.title}
      </h3>
      <p className="text-center text-sm text-cx-gray leading-relaxed mb-5">
        {parcours.desc}
      </p>

      {/* Bullets */}
      <ul className="space-y-2.5 mb-6 flex-1">
        {parcours.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5 text-sm text-cx-gray leading-relaxed">
            <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${parcours.checkClass}`} aria-hidden />
            {b}
          </li>
        ))}
      </ul>

      {/* CTA */}
      <button
        type="button"
        onClick={() => onSelect(parcours.id)}
        className={`self-start inline-flex items-center gap-1.5 text-sm font-bold transition-colors ${parcours.ctaClass}`}
      >
        Voir les formations <ArrowRight className="w-4 h-4" aria-hidden />
      </button>

    </div>
  )
}
