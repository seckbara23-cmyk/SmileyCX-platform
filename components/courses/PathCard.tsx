import Link from 'next/link'
import { ArrowRight, BookOpen } from 'lucide-react'
import { pathHref, type PublicPath } from '@/lib/queries/catalogue'

interface Props {
  path: PublicPath
  /** Number of PUBLISHED courses. Never a planned total (Q-E). */
  availableCount: number
}

/**
 * Path summary card (XPA-3).
 *
 * The count shown is "N formations disponibles" — published courses only.
 * It is deliberately NOT "N of M": exposing a planned total would disclose how
 * much of the path is unbuilt, which Q-E forbids. The component has no prop
 * for a planned total, so that phrasing cannot be reintroduced by accident.
 */
export default function PathCard({ path, availableCount }: Props) {
  return (
    <Link
      href={pathHref(path)}
      className="cx-card cx-card-hover flex flex-col p-5 group"
    >
      {/*
        B-2.5: the internal code chip that sat opposite the arrow is gone — it is
        an internal identifier and meant nothing to a visitor. `ml-auto` replaces
        what `justify-between` was doing for it, so the arrow stays where it was
        and the card is otherwise untouched.
      */}
      <div className="flex items-start gap-3 mb-2">
        <ArrowRight
          className="w-4 h-4 text-cx-gray/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0 ml-auto"
          aria-hidden
        />
      </div>

      <h3 className="text-base font-extrabold text-dark leading-snug mb-2">
        {path.title}
      </h3>

      {path.objective && (
        <p className="text-sm text-cx-gray leading-relaxed line-clamp-3 flex-1">
          {path.objective}
        </p>
      )}

      <p className="flex items-center gap-1.5 text-xs text-cx-gray mt-4 pt-3 border-t border-black/[0.05]">
        <BookOpen className="w-3.5 h-3.5 text-primary/70 shrink-0" aria-hidden />
        {availableCount} formation{availableCount !== 1 ? 's' : ''} disponible{availableCount !== 1 ? 's' : ''}
      </p>
    </Link>
  )
}
