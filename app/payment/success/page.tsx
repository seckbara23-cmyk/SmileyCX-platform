import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle2, Clock, XCircle, LogIn } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Payment return page — XP-PAYTECH-01 Phase E.
 *
 * ── THIS PAGE DECIDES NOTHING ─────────────────────────────────────────────
 *
 * The learner arrives here because PayTech redirected their BROWSER. That
 * redirect is worth nothing: it is not authenticated, it carries no signature,
 * and it can be typed into an address bar. So this page writes no row, calls no
 * RPC and grants no access. It reads the payment's stored status and reports
 * exactly what it finds.
 *
 * Fulfilment happens only in `/api/payments/paytech/ipn`, from a notification
 * whose HMAC verified against our own stored amount and reference.
 *
 * ── A DELAYED NOTIFICATION MUST NOT LOOK LIKE SUCCESS ─────────────────────
 *
 * The browser redirect routinely beats the server-to-server notification. So
 * `pending` and `processing` render an honest "confirmation in progress" state
 * rather than a tick: claiming success before the entitlement exists would send
 * the learner to a course they cannot open, which reads as a broken product
 * rather than as a race.
 *
 * Only `completed` shows success, because only `completed` means the
 * entitlement was granted — `complete_payment()` writes both in one
 * transaction or neither.
 *
 * ── THE LOOKUP IS SCOPED TO THE SIGNED-IN LEARNER ─────────────────────────
 *
 * `?ref=` is accepted as a hint, but the query is always filtered by
 * `user_id`, so a learner cannot read somebody else's order by guessing a
 * reference. Without a usable reference we show their most recent order.
 */

export const metadata: Metadata = {
  title: 'Paiement',
  description: "État de votre commande — XP Client Academy.",
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ ref?: string; ref_command?: string }>
}

/** A reference we are willing to put in a query. Shape only, never trusted. */
const REFERENCE_RE = /^[A-Za-z0-9_-]{4,64}$/

const SHELL = 'cx-section'
const CARD = 'cx-card p-8 max-w-xl mx-auto text-center'

function Actions({ primaryHref, primaryLabel }: { primaryHref: string; primaryLabel: string }) {
  return (
    <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
      <Link
        href={primaryHref}
        className="inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3
                   bg-secondary text-footer border-2 border-secondary transition-all duration-300
                   hover:bg-secondary-dark hover:border-secondary-dark"
      >
        {primaryLabel}
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
  )
}

export default async function PaymentSuccessPage({ searchParams }: Props) {
  const params = await searchParams
  const hinted = params.ref ?? params.ref_command ?? ''
  const reference = REFERENCE_RE.test(hinted) ? hinted : null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Not signed in: we will not guess whose order this is, and we will certainly
  // not assert that a payment succeeded.
  if (!user) {
    return (
      <div className={SHELL}>
        <div className="cx-container">
          <div className={CARD}>
            <LogIn className="w-12 h-12 text-primary mx-auto mb-4" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold text-primary mb-3">Connectez-vous</h1>
            <p className="text-cx-gray">
              Connectez-vous pour consulter l&apos;état de votre commande. Si votre paiement a
              été confirmé, votre formation apparaîtra dans votre tableau de bord.
            </p>
            <Actions primaryHref="/login" primaryLabel="Se connecter" />
          </div>
        </div>
      </div>
    )
  }

  const admin = createAdminClient()
  let query = admin
    .from('payments')
    .select('id, status, amount, currency, reference, course_id, courses(title, slug)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (reference) query = query.eq('reference', reference)

  const { data: rows } = await query
  const payment = Array.isArray(rows) && rows.length > 0 ? rows[0] : null

  if (!payment) {
    return (
      <div className={SHELL}>
        <div className="cx-container">
          <div className={CARD}>
            <Clock className="w-12 h-12 text-warning mx-auto mb-4" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold text-primary mb-3">Commande introuvable</h1>
            <p className="text-cx-gray">
              Nous ne trouvons aucune commande récente pour votre compte. Si vous venez de
              payer, patientez quelques instants puis actualisez cette page.
            </p>
            <Actions primaryHref="/dashboard" primaryLabel="Mon tableau de bord" />
          </div>
        </div>
      </div>
    )
  }

  const course = (payment as { courses?: { title?: string; slug?: string } | null }).courses ?? null
  const status = String(payment.status)
  const amountLabel = `${Number(payment.amount).toLocaleString('fr-FR')} ${payment.currency}`

  // ── confirmed ──
  if (status === 'completed') {
    return (
      <div className={SHELL}>
        <div className="cx-container">
          <div className={CARD}>
            <CheckCircle2 className="w-14 h-14 text-success mx-auto mb-4" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold text-primary mb-3">Paiement confirmé</h1>
            <p className="text-cx-gray">
              Merci — votre paiement de <strong className="text-dark">{amountLabel}</strong> a été
              confirmé{course?.title ? <> pour <strong className="text-dark">{course.title}</strong></> : null}.
              Votre accès est actif.
            </p>
            <p className="text-xs text-cx-gray mt-4">
              Référence&nbsp;: <span className="font-mono">{String(payment.reference)}</span>
            </p>
            <Actions
              primaryHref={course?.slug ? `/courses/${course.slug}` : '/dashboard'}
              primaryLabel={course?.slug ? 'Accéder à la formation' : 'Mon tableau de bord'}
            />
          </div>
        </div>
      </div>
    )
  }

  // ── terminal, but not paid ──
  if (status === 'cancelled' || status === 'failed' || status === 'expired') {
    return (
      <div className={SHELL}>
        <div className="cx-container">
          <div className={CARD}>
            <XCircle className="w-14 h-14 text-error mx-auto mb-4" aria-hidden="true" />
            <h1 className="text-2xl font-extrabold text-primary mb-3">Paiement non abouti</h1>
            <p className="text-cx-gray">
              Ce paiement n&apos;a pas été finalisé. Aucun montant n&apos;a été débité par
              XP&nbsp;Client Academy. Vous pouvez réessayer depuis le catalogue.
            </p>
            <p className="text-xs text-cx-gray mt-4">
              Référence&nbsp;: <span className="font-mono">{String(payment.reference)}</span>
            </p>
            <Actions primaryHref="/courses" primaryLabel="Réessayer" />
          </div>
        </div>
      </div>
    )
  }

  // ── pending or processing: the honest state when the notification is late ──
  return (
    <div className={SHELL}>
      <div className="cx-container">
        <div className={CARD}>
          <Clock className="w-14 h-14 text-warning mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-extrabold text-primary mb-3">
            Confirmation en cours
          </h1>
          <p className="text-cx-gray">
            Nous avons bien reçu votre retour de paiement et attendons la confirmation de
            l&apos;opérateur. Cela prend généralement moins d&apos;une minute. Votre accès
            s&apos;activera automatiquement dès la confirmation&nbsp;— vous n&apos;avez rien
            d&apos;autre à faire.
          </p>
          <p className="text-sm text-cx-gray mt-4">
            Montant&nbsp;: <strong className="text-dark">{amountLabel}</strong>
          </p>
          <p className="text-xs text-cx-gray mt-1">
            Référence&nbsp;: <span className="font-mono">{String(payment.reference)}</span>
          </p>
          <Actions primaryHref="/dashboard" primaryLabel="Mon tableau de bord" />
        </div>
      </div>
    </div>
  )
}
