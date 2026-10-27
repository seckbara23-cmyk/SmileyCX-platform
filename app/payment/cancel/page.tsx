import type { Metadata } from 'next'
import Link from 'next/link'
import { Info, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Payment cancellation page — XP-PAYTECH-01 Phase E.
 *
 * ── CANCELLING REVOKES NOTHING ────────────────────────────────────────────
 *
 * This page writes nothing. Not the payment, not the entitlement, not the
 * enrollment. That matters more than it looks: a learner who completes a
 * purchase and then walks back into `/payment/cancel`, or who simply has the
 * URL in their history, must not lose what they bought.
 *
 * The only place a payment becomes `cancelled` is the IPN route, from an
 * authenticated `sale_canceled` notification, and even there
 * `recordTerminalFailure()` refuses to touch a row that is already
 * `completed`. So a cancellation can never undo a verified purchase, whether it
 * arrives by browser or by notification, in any order.
 *
 * Because of that, this page reads the stored status and — if the learner has in
 * fact already paid — says so rather than implying the purchase was lost.
 */

export const metadata: Metadata = {
  title: 'Paiement annulé',
  description: 'Votre paiement a été annulé — XP Client Academy.',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

const SHELL = 'cx-section'
const CARD = 'cx-card p-8 max-w-xl mx-auto text-center'

export default async function PaymentCancelPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Only to decide which honest message to show — never to change anything.
  let alreadyPaid = false
  let courseSlug: string | null = null

  if (user) {
    const admin = createAdminClient()
    const { data: rows } = await admin
      .from('payments')
      .select('status, courses(slug)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)

    const latest = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (latest && String(latest.status) === 'completed') {
      alreadyPaid = true
      courseSlug = (latest as { courses?: { slug?: string } | null }).courses?.slug ?? null
    }
  }

  if (alreadyPaid) {
    return (
      <div className={SHELL}>
        <div className="cx-container">
          <div className={CARD}>
            <CheckCircle2 className="w-14 h-14 text-success mx-auto mb-4" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold text-primary mb-3">
              Votre dernier paiement est confirmé
            </h1>
            <p className="text-cx-gray">
              Rien n&apos;a été annulé&nbsp;: votre dernier paiement a bien été confirmé et votre
              accès reste actif.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href={courseSlug ? `/courses/${courseSlug}` : '/dashboard'}
                className="inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                           bg-secondary text-footer border-2 border-secondary transition-all duration-300
                           hover:bg-secondary-dark hover:border-secondary-dark"
              >
                {courseSlug ? 'Accéder à la formation' : 'Mon tableau de bord'}
              </Link>
              <Link
                href="/courses"
                className="inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                           border-2 border-primary text-primary transition-all duration-300
                           hover:bg-primary hover:text-white"
              >
                Voir le catalogue
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={SHELL}>
      <div className="cx-container">
        <div className={CARD}>
          <Info className="w-14 h-14 text-primary mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-extrabold text-primary mb-3">Paiement annulé</h1>
          <p className="text-cx-gray">
            Votre paiement a été annulé et <strong className="text-dark">aucun montant
            n&apos;a été débité</strong>. Vous pouvez reprendre votre inscription à tout moment
            depuis le catalogue.
          </p>
          <p className="text-sm text-cx-gray mt-4">
            Une question&nbsp;? Notre équipe répond sous 24&nbsp;h.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/courses"
              className="inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                         bg-secondary text-footer border-2 border-secondary transition-all duration-300
                         hover:bg-secondary-dark hover:border-secondary-dark"
            >
              Voir le catalogue
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                         border-2 border-primary text-primary transition-all duration-300
                         hover:bg-primary hover:text-white"
            >
              Nous contacter
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
