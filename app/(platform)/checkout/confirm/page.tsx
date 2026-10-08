import { redirect } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, BookOpen, Award } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatPrice } from '@/lib/utils/cn'
import { FREE_ACCESS_MODE } from '@/lib/pilot'
import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/lib/brand'

export const metadata: Metadata = { title: 'Paiement confirmé' }

interface Props { searchParams: Promise<{ payment?: string }> }

export default async function ConfirmPage({ searchParams }: Props) {
  // TEMP_FREE_ACCESS: No payment records are created in free mode.
  // Any hit to this page is a stale link or direct URL — send to dashboard.
  if (FREE_ACCESS_MODE) redirect('/dashboard')

  const { payment: paymentId } = await searchParams
  const supabase = await createClient()

  let payment = null
  let courseName = 'Votre formation XP Client'

  if (paymentId) {
    // PAY-1B(a) — EXPLICIT PROJECTION, not `select('*')`.
    //
    // This is the only browser-role reader of public.payments: it runs on the
    // USER's client, so RLS (`payments_own`: user_id = auth.uid()) is what
    // confines it to the caller's own rows. RLS decides ROWS, not COLUMNS —
    // `select('*')` therefore returned every column of that row, which from
    // PAY-2 onward would include `provider_token`, and already includes the
    // free-form `metadata` jsonb that PAY-2 will fill with provider payloads.
    //
    // Migration 059 converts the browser roles' table-wide SELECT into an
    // explicit column allowlist that excludes both. Under column-level grants
    // `select('*')` FAILS with 42501 rather than narrowing (055 §1), so this
    // projection must land FIRST or 059 breaks this page. Hence PAY-1B(a).
    //
    // Exactly the five fields rendered below, plus the course title: `status`
    // (the three presentation branches and the Statut line), `reference` and
    // `amount`/`currency` (the receipt block), and `id` — the row's identity,
    // which the caller already supplied as the `payment` query parameter, so
    // it discloses nothing new. `courses.slug` was selected and never read.
    const { data } = await supabase
      .from('payments')
      .select('id, reference, amount, currency, status, courses(title)')
      .eq('id', paymentId)
      .single()
    payment = data
    // `courses` is a MANY-TO-ONE embed (payments.course_id -> courses.id), so
    // PostgREST returns a single object — verified GET-only against the live
    // database, where the analogous enrollments embed yields
    // `{"title":"…"}`, not an array. supabase-js types it as an array because
    // this project has no generated `Database` types and so cannot infer
    // cardinality from the select string; with `select('*')` it inferred
    // nothing at all, which is why the narrower cast compiled before. The
    // `unknown` hop closes that static gap and changes no runtime shape. If it
    // were ever wrong, `courseName` simply keeps its default.
    if (data?.courses) courseName = (data.courses as unknown as { title: string }).title
  }

  const status = payment?.status
  const isConfirmed = status === 'completed'
  const isFailed = status === 'failed'
  const isPending = status === 'pending' || status === 'processing'

  const title = isConfirmed
    ? 'Paiement confirmé !'
    : isFailed
      ? 'Le paiement a échoué'
      : 'Paiement en attente'

  const description = isConfirmed ? (
    <>Félicitations ! Vous avez maintenant accès à <strong className="text-dark">{courseName}</strong>.</>
  ) : isFailed ? (
    <>Votre paiement n&apos;a pas été validé. Veuillez réessayer ou contacter le support.</>
  ) : (
    <>Votre paiement a été enregistré et est en attente de confirmation. Nous vous informerons dès que la transaction sera validée.</>
  )

  return (
    <div className="cx-section">
      <div className="cx-container max-w-lg text-center">
        <div className="cx-card p-10">
          <CheckCircle className={`w-16 h-16 mx-auto mb-5 ${isConfirmed ? 'text-success' : 'text-secondary'}`} />
          <h1 className="text-2xl font-extrabold text-dark mb-2">{title}</h1>
          <p className="text-cx-gray mb-6 leading-relaxed">{description}</p>

          {payment && (
            <div className="bg-light rounded-cx p-4 mb-6 text-left text-sm">
              <p className="text-cx-gray">
                Référence : <strong className="text-dark">{payment.reference}</strong>
              </p>
              <p className="text-cx-gray mt-1">
                Montant : <strong className="text-dark">{formatPrice(payment.amount, payment.currency)}</strong>
              </p>
              <p className="text-cx-gray mt-1">
                Statut : <strong className="text-dark capitalize">{payment.status}</strong>
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <Link
              href="/dashboard"
              className="flex items-center justify-center gap-2 px-6 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all"
            >
              <BookOpen className="w-5 h-5" /> Retour au tableau de bord
            </Link>
            <Link
              href="/courses"
              className="flex items-center justify-center gap-2 px-6 py-3.5 bg-light text-dark font-semibold rounded-cx hover:bg-light/80 transition-all"
            >
              Explorer d&apos;autres formations
            </Link>
          </div>

          <p className="text-xs text-cx-gray mt-6">
            {isConfirmed
              ? 'Un email de confirmation a été envoyé à votre adresse.'
              : isFailed
                ? 'Pour toute question : '
                : 'Nous vous contacterons dès que le paiement sera confirmé.'}
            {isFailed && (
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline"> {CONTACT_EMAIL}</a>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
