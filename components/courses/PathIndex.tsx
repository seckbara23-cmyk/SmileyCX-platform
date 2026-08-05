import { Compass } from 'lucide-react'
import PathCard from '@/components/courses/PathCard'
import { getPublicPaths, getPublicPathCourses, type PublicPath } from '@/lib/queries/catalogue'

interface Props {
  kind: PublicPath['kind']
  title: string
  lead: string
  /** Short explanation of the entry model ("qui je suis" / "où je travaille"). */
  model: string
  emptyMessage: string
}

/**
 * Shared index for /parcours and /secteurs (XPA-3).
 *
 * Both axes render identically; only the copy and the `kind` filter differ.
 * One component keeps the Q-E disclosure rules in a single place rather than
 * duplicated across two pages where they could drift apart.
 *
 * Paths with zero published courses never reach here — the underlying view
 * excludes them, so an unbuilt path cannot be inferred from an empty card.
 */
export default async function PathIndex({ kind, title, lead, model, emptyMessage }: Props) {
  const paths = await getPublicPaths(kind)

  // Count published courses per path. This is the ONLY count rendered anywhere
  // in discovery, and it counts what exists — never what is planned.
  const counts = await Promise.all(
    paths.map(async p => (await getPublicPathCourses(p.code)).length)
  )

  return (
    <div>
      <section className="bg-light border-b border-black/[0.06] py-12 md:py-16">
        <div className="cx-container max-w-4xl">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-secondary bg-secondary/10 px-3 py-1 rounded-full uppercase tracking-wide mb-4">
            <Compass className="w-3.5 h-3.5" aria-hidden /> {model}
          </span>
          <h1 className="text-2xl md:text-4xl font-extrabold text-dark leading-tight mb-3">
            {title}
          </h1>
          <p className="text-cx-gray leading-relaxed max-w-prose">{lead}</p>
        </div>
      </section>

      <section className="py-10 md:py-14">
        <div className="cx-container">
          {paths.length === 0 ? (
            <p className="text-sm text-cx-gray">{emptyMessage}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {paths.map((p, i) => (
                <PathCard key={p.code} path={p} availableCount={counts[i]} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
