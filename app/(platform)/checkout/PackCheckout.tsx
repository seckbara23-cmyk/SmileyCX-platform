import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PackCheckoutPanel from '@/components/payment/PackCheckoutPanel'
import { formatPrice } from '@/lib/utils/cn'
import { paytechCheckoutAvailability } from '@/lib/payments/providers'
import { inflightPaytechPackAttempt } from '@/lib/payments/paytech-resume'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import { getPublishedPack, individualTotal, packCodeFrom, packHref } from '@/lib/commerce/packs'

/**
 * Checkout of a fixed pack — XP-LAUNCH-FINAL-08 (requirements V4 §7; CGV v0.3 art. 3 and 5).
 *
 * Reads only. The price and the composition shown are the database's; the payment
 * action re-derives both, with what the learner owns, before anything is opened.
 * A course already owned is listed with the warning the CGV require, and the
 * payment button stays locked until the learner acknowledges it (PackCheckoutPanel).
 */
export default async function PackCheckout({ packParam }: { packParam: string }) {
  const code = packCodeFrom(packParam)
  if (!code) notFound()
  const pack = await getPublishedPack(code)
  if (!pack) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/checkout?pack=${pack.code}`)
  const { data: profile } = await supabase.from('profiles').select('id').eq('id', user.id).single()
  if (!profile) redirect(`/login?next=/checkout?pack=${pack.code}`)

  // What the learner already owns, by the single entitlement seam.
  const owned: { id: string; title: string }[] = []
  for (const c of pack.courses) {
    const access = await resolveCourseAccessById(c.id)
    if (access.allowed) owned.push({ id: c.id, title: c.title })
  }
  if (owned.length === pack.courses.length) redirect('/dashboard')

  const total = individualTotal(pack)
  const saving = total - pack.price

  if (!paytechCheckoutAvailability().available) {
    return (
      <div className="cx-section">
        <div className="cx-container max-w-2xl text-center py-16">
          <h1 className="text-2xl font-extrabold text-dark mb-3">Inscription bient&ocirc;t disponible</h1>
          <p className="text-cx-gray mb-2 max-w-md mx-auto font-semibold text-dark">
            {pack.title} · {formatPrice(pack.price, pack.currency)} · Accès 6 mois · Certificats inclus
          </p>
          <p className="text-cx-gray mb-8 max-w-md mx-auto text-sm">
            Le paiement en ligne n&apos;est pas encore activé. Contactez-nous pour organiser votre inscription.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href={`/contact?offre=${encodeURIComponent(pack.code.toLowerCase())}`}
              className="inline-block px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity">
              Nous contacter
            </Link>
            <Link href={packHref(pack.code)}
              className="inline-block px-6 py-3 bg-light border border-black/[0.08] text-dark font-semibold rounded-cx hover:bg-white transition-colors">
              Revenir au pack
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // A pack payment already opened and pending is RESUMED, never replaced (XP-LAUNCH-04).
  const resume = await inflightPaytechPackAttempt(user.id, pack.id)

  return (
    <div className="cx-section">
      <div className="cx-container max-w-4xl">
        <h1 className="text-2xl font-extrabold text-dark mb-8">
          {resume ? 'Reprendre votre paiement' : `Acheter le ${pack.title}`}
        </h1>

        <div className="grid md:grid-cols-[1fr_320px] lg:grid-cols-[1fr_360px] gap-6 md:gap-8 items-start">
          <div className="cx-card p-6">
            <h2 className="text-lg font-bold text-dark mb-6">Paiement sécurisé</h2>
            {resume && (
              <div role="status" className="mb-6 rounded-cx border border-primary/20 bg-primary/5 p-4 text-sm text-dark">
                <p className="font-bold">Reprise de votre paiement en cours</p>
                <p className="mt-1 text-cx-gray">
                  Votre session de paiement PayTech pour ce pack est toujours active. Aucune nouvelle commande
                  n&apos;est créée, et nous vérifions d&apos;abord auprès de PayTech si elle a déjà été réglée.
                </p>
                <p className="mt-2 text-xs text-cx-gray">
                  Référence : <span className="font-mono">{resume.reference}</span>
                </p>
              </div>
            )}
            <PackCheckoutPanel
              packCode={pack.code}
              ownedCourses={owned}
              resume={resume ? { resumable: resume.resumable } : null}
            />
          </div>

          <div className="cx-card p-4 sm:p-6 md:sticky md:top-24">
            <h2 className="text-base font-bold text-dark mb-4">Récapitulatif</h2>
            <p className="font-semibold text-dark text-sm mb-3">{pack.title}</p>
            <ul className="flex flex-col gap-2 mb-4 pb-4 border-b border-black/[0.06] text-sm">
              {pack.courses.map(c => (
                <li key={c.id} className="flex justify-between gap-3 text-cx-gray">
                  <span>{c.title}</span>
                  <span className="shrink-0">{formatPrice(c.price, c.currency)}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 mb-4 text-sm">
              <div className="flex justify-between text-cx-gray">
                <span>Prix à l&apos;unité</span>
                <span className="line-through">{formatPrice(total, pack.currency)}</span>
              </div>
              {saving > 0 && (
                <div className="flex justify-between text-success font-semibold">
                  <span>Économie</span>
                  <span>{formatPrice(saving, pack.currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-cx-gray">
                <span>Frais</span>
                <span>Inclus</span>
              </div>
            </div>
            <div className="flex justify-between font-bold text-dark border-t border-black/[0.06] pt-3">
              <span>Total</span>
              <span className="text-lg">{formatPrice(pack.price, pack.currency)}</span>
            </div>
            <div className="mt-4 pt-4 border-t border-black/[0.06] text-xs text-cx-gray space-y-1">
              <p>✅ Toutes les formations activées ensemble dès la confirmation du paiement</p>
              <p>✅ Accès 6 mois à compter de la validation du paiement</p>
              <p>✅ Un certificat par formation terminée</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
