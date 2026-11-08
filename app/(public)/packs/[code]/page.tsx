import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CheckCircle, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatPrice } from '@/lib/utils/cn'
import { paytechCheckoutAvailability } from '@/lib/payments/providers'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import { getPublishedPack, individualTotal, packCheckoutHref } from '@/lib/commerce/packs'

/**
 * A fixed pack, publicly — XP-LAUNCH-FINAL-08 (requirements V4 §7 and §17).
 *
 * Reads only. Its price and composition are the database's. A signed-in learner who
 * already owns a course of the pack sees the CGV's warning here already, before the
 * checkout repeats it with a box to tick.
 */
export const dynamic = 'force-dynamic'

interface Props { params: Promise<{ code: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params
  const pack = await getPublishedPack(code)
  if (!pack) return { title: 'Pack introuvable' }
  return {
    title: `${pack.title} — XP Client Academy`,
    description: pack.description || `${pack.title} : ${pack.courses.map(c => c.title).join(', ')}.`,
    alternates: { canonical: `/packs/${pack.code.toLowerCase()}` },
  }
}

export default async function PackPage({ params }: Props) {
  const { code } = await params
  const pack = await getPublishedPack(code)
  if (!pack) notFound()

  const total = individualTotal(pack)
  const saving = total - pack.price
  const purchasable = paytechCheckoutAvailability().available

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const owned: string[] = []
  if (user) {
    for (const c of pack.courses) {
      if ((await resolveCourseAccessById(c.id)).allowed) owned.push(c.title)
    }
  }
  const ownsAll = user !== null && owned.length === pack.courses.length

  const ctaHref = !user
    ? `/login?next=${encodeURIComponent(packCheckoutHref(pack.code))}`
    : purchasable
      ? packCheckoutHref(pack.code)
      : `/contact?offre=${encodeURIComponent(pack.code.toLowerCase())}`
  const ctaLabel = !user ? 'Créer mon compte ou me connecter' : purchasable ? 'Acheter le pack' : 'Inscription bientôt disponible'

  return (
    <div className="cx-section">
      <div className="cx-container max-w-4xl">
        <p className="text-sm font-bold text-secondary uppercase tracking-widest mb-2">Pack</p>
        <h1 className="text-3xl font-extrabold text-dark mb-3">{pack.title}</h1>
        {pack.description && <p className="text-cx-gray max-w-2xl mb-8">{pack.description}</p>}

        <div className="grid md:grid-cols-[1fr_320px] gap-6 items-start">
          <div className="cx-card p-6">
            <h2 className="text-lg font-bold text-dark mb-4">Les {pack.courses.length} formations du pack</h2>
            <ul className="flex flex-col gap-3">
              {pack.courses.map(c => (
                <li key={c.id} className="flex items-start justify-between gap-4">
                  <span className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden="true" />
                    <Link href={`/courses/${c.slug}`} className="text-dark hover:text-primary hover:underline">{c.title}</Link>
                  </span>
                  <span className="text-sm text-cx-gray shrink-0">{formatPrice(c.price, c.currency)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-cx-gray">
              Toutes les formations du pack sont activées ensemble dès la validation du paiement, pour six mois.
              Chaque formation terminée donne droit à son certificat, qui reste valide après la fin de l&apos;accès.
            </p>
            {owned.length > 0 && !ownsAll && (
              <div role="note" className="mt-6 rounded-cx border border-warning/40 bg-warning/10 p-4 text-sm text-dark">
                <p className="flex items-start gap-2 font-bold">
                  <AlertTriangle className="w-4 h-4 mt-0.5 text-warning shrink-0" aria-hidden="true" />
                  Vous possédez déjà : {owned.join(', ')}
                </p>
                <p className="mt-1 text-cx-gray">
                  Une formation déjà possédée n&apos;est ni remboursée ni remplacée si vous achetez ce pack. Vous pouvez
                  aussi acheter séparément les seules formations qui vous manquent.
                </p>
              </div>
            )}
          </div>

          <div className="cx-card p-6 md:sticky md:top-24">
            <div className="flex justify-between text-sm text-cx-gray mb-1">
              <span>Prix à l&apos;unité</span>
              <span className="line-through">{formatPrice(total, pack.currency)}</span>
            </div>
            {saving > 0 && (
              <div className="flex justify-between text-sm text-success font-semibold mb-3">
                <span>Économie</span>
                <span>{formatPrice(saving, pack.currency)}</span>
              </div>
            )}
            <p className="text-2xl font-extrabold text-dark mb-1">{formatPrice(pack.price, pack.currency)}</p>
            <p className="text-xs text-cx-gray mb-5">Accès 6 mois · Prix final, sans frais ajoutés</p>
            {ownsAll ? (
              <Link href="/dashboard" className="block text-center px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90">
                Vous avez déjà toutes ces formations
              </Link>
            ) : (
              <Link href={ctaHref} className="block text-center px-6 py-3 bg-secondary text-footer font-bold rounded-cx hover:bg-secondary-dark">
                {ctaLabel}
              </Link>
            )}
            <p className="mt-3 text-xs text-cx-gray">
              Un pack est facultatif : chaque formation s&apos;achète aussi à l&apos;unité.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
