import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle, Clock, Play } from 'lucide-react'
import { LEVEL_LABELS } from '@/lib/utils/cn'
import { getPublicPath, getPublicPathCourses, type PublicPath } from '@/lib/queries/catalogue'

interface Props {
  code: string
  kind: PublicPath['kind']
}

/**
 * Path detail for /parcours/[code] and /secteurs/[code] (XPA-3).
 *
 * Renders ONLY published courses linked to the path, in the view's re-ranked
 * order. Course cards link to the canonical `/courses/[slug]` page — no
 * pedagogical content is duplicated here; the title and short description come
 * from the course row itself, which is the same source the canonical page uses.
 *
 * Q-E compliance:
 *   * no planned total and no unavailable count is computed or rendered
 *   * a path with no published course is not publicly visible at all: the view
 *     omits it, so getPublicPath() returns null and this 404s
 *   * a path requested under the wrong axis (e.g. a sector code under
 *     /parcours) 404s rather than revealing that the code exists elsewhere
 */
export default async function PathDetail({ code, kind }: Props) {
  const path = await getPublicPath(code)

  // 404 covers three cases identically — unknown code, no published content,
  // wrong axis — so none of them can be distinguished from outside.
  if (!path || path.kind !== kind) notFound()

  const courses = await getPublicPathCourses(path.code)
  if (courses.length === 0) notFound()

  const backHref  = kind === 'sector' ? '/secteurs' : '/parcours'
  const backLabel = kind === 'sector' ? 'Tous les secteurs' : 'Tous les parcours métier'
  const hasSocle  = courses.some(c => c.is_socle)

  return (
    <div>
      {/* ══ Header ═════════════════════════════════════════════════════ */}
      <section className="bg-light border-b border-black/[0.06] py-10 md:py-14">
        <div className="cx-container max-w-4xl">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 text-sm text-cx-gray hover:text-primary transition-colors mb-5"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden /> {backLabel}
          </Link>

          <p className="font-mono text-xs font-bold text-secondary tracking-wide mb-2">
            {path.code}
          </p>
          <h1 className="text-2xl md:text-4xl font-extrabold text-dark leading-tight mb-4">
            {path.title}
          </h1>
          {path.objective && (
            <p className="text-cx-gray leading-relaxed max-w-prose">{path.objective}</p>
          )}

          <p className="flex items-center gap-1.5 text-sm text-cx-gray mt-5">
            <CheckCircle className="w-4 h-4 text-success shrink-0" aria-hidden />
            {courses.length} formation{courses.length !== 1 ? 's' : ''} disponible
            {courses.length !== 1 ? 's' : ''}
          </p>
        </div>
      </section>

      {/* ══ Ordered courses ════════════════════════════════════════════ */}
      <section className="py-10 md:py-14">
        <div className="cx-container max-w-3xl">
          <h2 className="text-xl font-extrabold text-dark mb-2">Formations recommandées</h2>
          <p className="text-sm text-cx-gray mb-6">
            Dans l&apos;ordre conseillé. Chaque formation reste accessible
            indépendamment.
          </p>

          <ol className="flex flex-col gap-3">
            {courses.map((c, i) => (
              <li key={c.slug}>
                <Link
                  href={`/courses/${c.slug}`}
                  className="cx-card cx-card-hover flex items-start gap-4 p-4 sm:p-5 group"
                >
                  <span
                    className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold shrink-0"
                    aria-hidden
                  >
                    {i + 1}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <h3 className="font-semibold text-dark text-sm leading-snug">
                        {c.title}
                      </h3>
                      {c.is_socle && (
                        <span className="text-[10px] font-bold text-secondary bg-secondary/10 px-2 py-0.5 rounded-full uppercase tracking-wide">
                          Socle commun
                        </span>
                      )}
                    </div>

                    {c.description && (
                      <p className="text-xs text-cx-gray leading-relaxed line-clamp-2">
                        {c.description}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-cx-gray">
                      <span>{LEVEL_LABELS[c.level] ?? c.level}</span>
                      {c.duration_hours != null && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-primary/60 shrink-0" aria-hidden />
                          {c.duration_hours}h
                        </span>
                      )}
                    </div>
                  </div>

                  <Play
                    className="w-4 h-4 text-cx-gray/40 group-hover:text-primary transition-colors shrink-0 mt-1"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ol>

          {hasSocle && (
            <p className="text-xs text-cx-gray mt-6 pt-5 border-t border-black/[0.06] leading-relaxed">
              Les formations marquées <strong>socle commun</strong> constituent la base
              partagée : elles posent les fondamentaux de l&apos;expérience client avant
              les contenus spécifiques.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
