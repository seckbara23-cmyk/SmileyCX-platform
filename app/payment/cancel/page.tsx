import type { Metadata } from 'next'
import Link from 'next/link'
import { Info, CheckCircle2, RotateCcw } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { paytechCheckoutAvailability } from '@/lib/payments/providers'
import { inflightPaytechAttempts, type InflightPaytechAttempt } from '@/lib/payments/paytech-resume'

/**
 * Payment cancellation page — XP-PAYTECH-01 Phase E; the resume path by XP-LAUNCH-04.
 *
 * ── CANCELLING REVOKES NOTHING ────────────────────────────────────────────
 *
 * This page writes nothing. Not the payment, not the entitlement, not the
 * enrollment. That matters more than it looks: a learner who completes a
 * purchase and then walks back into `/payment/cancel`, or who simply has the
 * URL in their history, must not lose what they bought.
 *
 * A payment becomes `cancelled` only when PayTech itself reports it so, server
 * to server (`lib/payments/paytech-reconcile.ts`), and even then
 * `recordTerminalFailure()` touches only a payment still in flight — and
 * migration 063 makes `completed` final in the database. So a cancellation can
 * never undo a verified purchase, whether it arrives by browser or by
 * notification, in any order.
 *
 * Because of that, this page reads the stored status and — if the learner has in
 * fact already paid — says so rather than implying the purchase was lost.
 *
 * ── CANCELLING CLOSES NOTHING EITHER (XP-LAUNCH-04) ───────────────────────
 *
 * PayTech's « Annuler » button sends the browser here and does nothing else:
 * the hosted page the learner left stays payable, the provider keeps calling
 * the attempt pending, no notification is sent, and PayTech documents no call
 * to cancel or invalidate a token. Closing the attempt on arrival here would
 * leave that payable page behind and let a second chargeable one open beside
 * it. So this page closes nothing. It reads the signed-in learner's attempts
 * still in flight and offers to RESUME each one: a link to the checkout of that
 * course, whose action asks the provider and re-offers the SAME hosted page.
 * Nothing in the request selects an attempt; the session does.
 */

export const metadata: Metadata = {
  title: 'Paiement annulé',
  description: 'Votre paiement a été annulé — XP Client Academy.',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

const SHELL = 'cx-section'
const CARD = 'cx-card p-8 max-w-xl mx-auto text-center'
const PRIMARY = `inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                 bg-secondary text-footer border-2 border-secondary transition-all duration-300
                 hover:bg-secondary-dark hover:border-secondary-dark`
const SECONDARY = `inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                   border-2 border-primary text-primary transition-all duration-300
                   hover:bg-primary hover:text-white`

export default async function PaymentCancelPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return <Cancelled signedIn={false} />

  // The attempts this learner may resume. `null` means they could not be read:
  // then the plain message, never a claim that there is nothing to resume.
  const inflight = await inflightPaytechAttempts(user.id)
  if (inflight && inflight.length > 0) {
    return <Resume attempts={inflight} canResume={paytechCheckoutAvailability().available} />
  }

  // Only to decide which honest message to show — never to change anything.
  let alreadyPaid = false
  let courseSlug: string | null = null

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

  if (alreadyPaid) return <Confirmed courseSlug={courseSlug} />
  return <Cancelled signedIn />
}

/** The learner left PayTech's page before paying. The attempt is still theirs to finish. */
function Resume({ attempts, canResume }: { attempts: InflightPaytechAttempt[]; canResume: boolean }) {
  return (
    <div className={SHELL}>
      <div className="cx-container">
        <div className={CARD}>
          <RotateCcw className="w-14 h-14 text-primary mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-extrabold text-primary mb-3">Paiement interrompu</h1>
          <p className="text-cx-gray">
            Vous avez quitté la page de paiement PayTech avant de régler.{' '}
            <strong className="text-dark">Aucun paiement n&apos;a été confirmé pour l&apos;instant</strong>, et
            votre session de paiement reste ouverte&nbsp;: vous pouvez la reprendre quand vous le souhaitez,
            sans créer de nouvelle commande.
          </p>

          <ul className="mt-6 flex flex-col gap-4 text-left">
            {attempts.map(attempt => (
              <li key={attempt.paymentId} className="rounded-cx border border-black/[0.08] p-4">
                <p className="font-semibold text-dark">{attempt.courseTitle ?? attempt.packTitle ?? 'Votre formation'}</p>
                <p className="text-xs text-cx-gray mt-1">
                  Référence : <span className="font-mono">{attempt.reference}</span>
                </p>
                {canResume && attempt.resumable ? (
                  <Link
                    href={attempt.packCode
                      ? `/checkout?pack=${encodeURIComponent(attempt.packCode)}`
                      : `/checkout?course=${encodeURIComponent(attempt.courseId)}`}
                    className={`${PRIMARY} mt-4 w-full sm:w-auto`}
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    Reprendre le paiement
                  </Link>
                ) : (
                  <p className="text-sm text-cx-gray mt-3">
                    Ce paiement est en cours de vérification. S&apos;il a abouti, votre accès s&apos;activera
                    automatiquement dès sa confirmation&nbsp;; sinon, contactez-nous en indiquant la
                    référence ci-dessus.
                  </p>
                )}
              </li>
            ))}
          </ul>

          <p className="text-sm text-cx-gray mt-6">
            Une question&nbsp;? Notre équipe répond sous 24&nbsp;h.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/courses" className={SECONDARY}>
              Voir le catalogue
            </Link>
            <Link href="/contact" className={SECONDARY}>
              Nous contacter
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The learner's latest payment is completed: nothing was lost. */
function Confirmed({ courseSlug }: { courseSlug: string | null }) {
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
            <Link href={courseSlug ? `/courses/${courseSlug}` : '/dashboard'} className={PRIMARY}>
              {courseSlug ? 'Accéder à la formation' : 'Mon tableau de bord'}
            </Link>
            <Link href="/courses" className={SECONDARY}>
              Voir le catalogue
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Nothing in flight to resume, and nothing completed to report. */
function Cancelled({ signedIn }: { signedIn: boolean }) {
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
          {!signedIn && (
            <p className="text-sm text-cx-gray mt-4">
              Vous aviez un paiement en cours&nbsp;?{' '}
              <Link href="/login?next=/payment/cancel" className="font-semibold text-primary underline underline-offset-2">
                Connectez-vous
              </Link>{' '}
              pour le reprendre.
            </p>
          )}
          <p className="text-sm text-cx-gray mt-4">
            Une question&nbsp;? Notre équipe répond sous 24&nbsp;h.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/courses" className={PRIMARY}>
              Voir le catalogue
            </Link>
            <Link href="/contact" className={SECONDARY}>
              Nous contacter
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
