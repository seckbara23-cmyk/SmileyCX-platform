import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { Layers, Route, AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react'

/**
 * Catalogue administration — READ ONLY (XPA-2).
 *
 * Shows the academic model seeded from the V4 architecture: catalogues, course
 * codes, learning paths, path assignments, launch status, and — importantly —
 * which coded courses do not yet exist as produced content.
 *
 * Deliberately has no create/edit/delete affordance. Editing arrives in a later
 * phase; introducing write paths now would let the seeded reference data drift
 * away from the ratified source document before the model has settled.
 *
 * Authorization is the platform standard: requirePlatformAdmin() server-side,
 * exactly as every other admin page. Nothing about auth is changed here.
 */

export const dynamic = 'force-dynamic'

const STATUS_STYLE: Record<string, string> = {
  launch:    'bg-green-100 text-green-700',
  backlog:   'bg-amber-100 text-amber-700',
  undecided: 'bg-gray-100 text-gray-600',
  retired:   'bg-red-100 text-red-700',
}

export default async function CataloguePage() {
  await requirePlatformAdmin()
  const db = createAdminClient()

  const [{ data: catalogues }, { data: codes }, { data: paths }, { data: links }, { data: courses }] =
    await Promise.all([
      db.from('catalogues').select('*').order('position'),
      db.from('course_codes').select('*').order('catalogue_code').order('position'),
      db.from('learning_paths').select('*').order('kind').order('position'),
      db.from('learning_path_courses').select('*').order('path_code').order('position'),
      db.from('courses').select('id, code, slug, title, is_published'),
    ])

  // The model may not be migrated yet — render a clear notice instead of an error.
  if (!catalogues || catalogues.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-extrabold text-dark mb-2">Catalogue</h1>
        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="font-semibold">Modèle académique non initialisé.</p>
            <p className="mt-1">
              Les migrations 028–030 n’ont pas encore été appliquées à cette base.
              Aucune donnée existante n’est affectée.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const byCode = new Map((courses ?? []).map(c => [c.code as string | null, c]))
  const linksByPath = new Map<string, typeof links>()
  for (const l of links ?? []) {
    const arr = linksByPath.get(l.path_code as string) ?? []
    arr.push(l)
    linksByPath.set(l.path_code as string, arr as typeof links)
  }

  const produced = (codes ?? []).filter(c => byCode.has(c.code as string))
  const missing  = (codes ?? []).filter(c => !byCode.has(c.code as string))

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <header>
        <h1 className="text-xl font-extrabold text-dark">Catalogue &amp; parcours</h1>
        <p className="text-sm text-cx-gray mt-1">
          Modèle académique de référence (V4). Lecture seule — l’édition arrivera dans une phase ultérieure.
        </p>
      </header>

      {/* Summary */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Catalogues',        value: catalogues.length },
          { label: 'Codes formation',   value: (codes ?? []).length },
          { label: 'Formations produites', value: produced.length },
          { label: 'Parcours',          value: (paths ?? []).length },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-black/[0.07] bg-white p-4">
            <p className="text-2xl font-extrabold text-dark">{s.value}</p>
            <p className="text-xs text-cx-gray mt-0.5">{s.label}</p>
          </div>
        ))}
      </section>

      {/* Catalogues + codes */}
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-dark uppercase tracking-wide">
          <Layers className="w-4 h-4 text-primary" aria-hidden /> Catalogues
        </h2>

        {catalogues.map(cat => (
          <div key={cat.code as string} className="rounded-xl border border-black/[0.07] bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-black/[0.06] bg-light/50">
              <p className="font-semibold text-dark text-sm">
                {cat.code as string} — {cat.title as string}
              </p>
              {cat.objective ? (
                <p className="text-xs text-cx-gray mt-0.5">{cat.objective as string}</p>
              ) : null}
            </div>
            <div className="divide-y divide-black/[0.04]">
              {(codes ?? [])
                .filter(c => c.catalogue_code === cat.code)
                .map(c => {
                  const course = byCode.get(c.code as string)
                  return (
                    <div key={c.code as string} className="flex items-start gap-3 px-4 py-3">
                      <span className="font-mono text-xs font-bold text-primary shrink-0 w-14 pt-0.5">
                        {c.code as string}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-dark leading-snug">{c.canonical_title as string}</p>
                        {course ? (
                          <p className="text-xs text-cx-gray mt-0.5 truncate">
                            <span className="text-green-700 font-medium">Produite</span>
                            {' · '}{course.slug as string}
                            {!course.is_published && <span className="text-amber-700"> · non publiée</span>}
                          </p>
                        ) : (
                          <p className="text-xs text-cx-gray mt-0.5">
                            <span className="text-gray-500">Contenu non produit</span>
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {course
                          ? <CheckCircle2 className="w-4 h-4 text-green-600" aria-label="Contenu produit" />
                          : <CircleDashed className="w-4 h-4 text-gray-300" aria-label="Contenu manquant" />}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_STYLE[c.status as string] ?? STATUS_STYLE.undecided}`}>
                          {c.status as string}
                        </span>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        ))}
      </section>

      {/* Missing content */}
      {missing.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-amber-900 mb-2">
            <AlertTriangle className="w-4 h-4" aria-hidden /> Formations codifiées sans contenu ({missing.length})
          </h2>
          <p className="text-xs text-amber-900/80 mb-3">
            Ces codes existent dans l’architecture de référence mais aucune formation n’a encore été produite.
            Les codes sont réservés définitivement et ne seront jamais réattribués.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {missing.map(c => (
              <span key={c.code as string} className="font-mono text-[11px] bg-white border border-amber-200 text-amber-900 px-2 py-0.5 rounded">
                {c.code as string}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Paths */}
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-dark uppercase tracking-wide">
          <Route className="w-4 h-4 text-primary" aria-hidden /> Parcours
        </h2>

        {(['professional', 'sector'] as const).map(kind => (
          <div key={kind}>
            <p className="text-xs font-semibold text-cx-gray uppercase tracking-wide mb-2">
              {kind === 'professional' ? 'Métier — « qui je suis »' : 'Sectoriel — « où je travaille »'}
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              {(paths ?? []).filter(p => p.kind === kind).map(p => {
                const rows = linksByPath.get(p.code as string) ?? []
                const producedCount = rows.filter(r => byCode.has(r.course_code as string)).length
                return (
                  <div key={p.code as string} className="rounded-xl border border-black/[0.07] bg-white p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-bold text-secondary">{p.code as string}</p>
                        <p className="text-sm font-semibold text-dark leading-snug">{p.title as string}</p>
                      </div>
                      <span className="text-[10px] text-cx-gray shrink-0 pt-1">
                        {producedCount}/{rows.length} produites
                      </span>
                    </div>
                    <ol className="space-y-1">
                      {rows.map(r => {
                        const has = byCode.has(r.course_code as string)
                        return (
                          <li key={r.course_code as string} className="flex items-center gap-2 text-xs">
                            <span className="text-cx-gray/60 w-4 shrink-0">{r.position as number}.</span>
                            <span className={`font-mono font-semibold ${has ? 'text-primary' : 'text-gray-400'}`}>
                              {r.course_code as string}
                            </span>
                            {r.is_socle && (
                              <span className="text-[9px] font-bold text-secondary bg-secondary/10 px-1.5 py-0.5 rounded uppercase">
                                socle
                              </span>
                            )}
                            {!has && <span className="text-[10px] text-gray-400">— non produite</span>}
                          </li>
                        )
                      })}
                    </ol>
                    {p.note ? (
                      <p className="text-[11px] text-cx-gray mt-3 pt-3 border-t border-black/[0.05] leading-relaxed">
                        {p.note as string}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
