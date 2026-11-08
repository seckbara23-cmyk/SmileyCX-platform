import Link from 'next/link'
import { Package, Users, CheckCircle } from 'lucide-react'
import { formatPrice } from '@/lib/utils/cn'
import { getPublishedPacks, individualTotal, packHref } from '@/lib/commerce/packs'

/**
 * The three public commercial offers — XP-LAUNCH-FINAL-08 (requirements V4 §17).
 *
 * Exactly three cards, French names: Pack Conseiller and Pack Manager (fixed packs,
 * read from the database with their price and courses) and Pack Entreprises (on
 * quotation). The business card promises no portal, no configurator, no coaching and
 * no automated purchase: it asks for a quote. Individual courses stay purchasable.
 *
 * When the packs cannot be read (before migration 065, or on an error), the section
 * is not shown at all rather than shown wrong.
 */
export default async function CommercialOffers({ heading = true }: { heading?: boolean }) {
  const packs = await getPublishedPacks()
  if (packs.length === 0) return null

  return (
    <section aria-labelledby="nos-offres" className="py-12">
      {heading && (
        <div className="text-center mb-8">
          <h2 id="nos-offres" className="text-2xl font-extrabold text-dark">Nos offres</h2>
          <p className="text-cx-gray mt-2">Chaque formation s&apos;achète à l&apos;unité, ou dans un pack à prix réduit.</p>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
        {packs.map(pack => {
          const total = individualTotal(pack)
          return (
            <div key={pack.code} className="cx-card border-t-4 border-primary p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5 text-primary" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-bold text-dark">{pack.title}</h3>
              </div>
              <ul className="flex-1 space-y-2 text-sm text-dark mb-5">
                {pack.courses.map(c => (
                  <li key={c.id} className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden="true" />
                    {c.title}
                  </li>
                ))}
              </ul>
              <p className="text-2xl font-extrabold text-dark">{formatPrice(pack.price, pack.currency)}</p>
              {total > pack.price && (
                <p className="text-xs text-cx-gray mb-4">au lieu de <span className="line-through">{formatPrice(total, pack.currency)}</span> · Accès 6 mois</p>
              )}
              <Link href={packHref(pack.code)} className="mt-auto text-center px-5 py-2.5 bg-secondary text-footer font-bold rounded-cx hover:bg-secondary-dark">
                Découvrir le pack
              </Link>
            </div>
          )
        })}
        <div className="cx-card border-t-4 border-secondary p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-secondary" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-bold text-dark">Pack Entreprises</h3>
          </div>
          <p className="flex-1 text-sm text-cx-gray mb-5">
            Des licences pour vos collaborateurs, sur les formations de votre choix. Remise selon le nombre de
            personnes. Paiement avant activation.
          </p>
          <p className="text-2xl font-extrabold text-dark mb-4">Sur devis</p>
          <Link href="/contact?offre=pack-entreprises" className="mt-auto text-center px-5 py-2.5 border-2 border-primary text-primary font-bold rounded-cx hover:bg-primary hover:text-white">
            Demander un devis
          </Link>
        </div>
      </div>
    </section>
  )
}
