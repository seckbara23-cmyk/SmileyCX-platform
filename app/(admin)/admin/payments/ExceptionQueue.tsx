import Link from 'next/link'
import type { PaymentExceptionView } from '@/lib/payments/payment-exceptions'
import {
  acknowledgeExceptionReport,
  confirmExceptionReceipt,
  dismissException,
  recheckException,
  recordExceptionAccess,
  recordExceptionRefund,
  requireExceptionRefund,
  withdrawExceptionReceipt,
  withdrawExceptionRefund,
} from './exception-actions'

/**
 * The payment exception queue — XP-PAYTECH-05.
 *
 * The page that renders this has already called `requirePlatformAdmin()`. Each
 * form posts to an action that checks again.
 *
 * Four facts are shown apart on purpose. "Paid at PayTech", "the learner has
 * access", "money must go back" and "money went back" can each be true or false
 * independently, and collapsing them into one status is how a refund gets missed.
 */

const SIGNAL_LABEL: Record<string, string> = {
  paid_hint:          'PayTech a notifié un paiement sur une tentative clôturée',
  unverified_report:  'Notification reçue dont la signature n’a pas pu être vérifiée',
  provider_paid:      'PayTech confirme un paiement sur une tentative clôturée',
  completion_refused: 'PayTech confirme un paiement que la plateforme n’a pas pu honorer',
  provider_pending:   'Tentative clôturée, mais encore réglable selon PayTech',
  provider_not_paid:  'PayTech contredit l’état enregistré',
  cancel_hint:        'PayTech a notifié une annulation sur un paiement confirmé',
  amount_mismatch:    'Montant signalé différent du montant enregistré',
  currency_mismatch:  'Devise signalée différente de la devise enregistrée',
}

const RECEIVED_LABEL: Record<string, string> = {
  not_established:       'Non établi',
  reported:              'Signalé, non prouvé',
  confirmed_by_operator: 'Confirmé par un administrateur',
  confirmed_by_provider: 'Confirmé par PayTech',
  not_received:          'Non reçu',
}

const REFUND_REQUIRED_LABEL: Record<string, string> = {
  not_assessed: 'À décider',
  required:     'Oui',
  not_required: 'Non',
  confirmed:    'Oui',
}

const RESOLUTION_LABEL: Record<string, string> = {
  nothing_to_return: 'Rien à rembourser',
  refund_confirmed:  'Remboursement confirmé',
  access_honoured:   'Accès accordé pour ce paiement',
  settled_normally:  'Réglé normalement',
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR') : '—')

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className={strong ? 'font-semibold text-gray-900' : 'text-gray-700'}>{value}</dd>
    </div>
  )
}

function NoteField({ placeholder }: { placeholder: string }) {
  return (
    <textarea
      name="note" required minLength={10} maxLength={500} rows={2}
      placeholder={placeholder}
      className="w-full text-xs border rounded p-1"
    />
  )
}

function Decision({
  e, title, action, cta, tone = 'gray', attest, placeholder,
}: {
  e: PaymentExceptionView
  title: string
  action: (_formData: FormData) => Promise<void>
  cta: string
  tone?: 'gray' | 'blue'
  attest?: string
  placeholder: string
}) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-gray-600">{title}</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5">
        <input type="hidden" name="exceptionId" value={e.id} />
        <NoteField placeholder={placeholder} />
        {attest && (
          <label className="flex items-start gap-1.5 text-xs text-gray-600">
            <input type="checkbox" name="attest" value="yes" required />
            {attest}
          </label>
        )}
        <button
          type="submit"
          className={`text-xs px-2 py-1 rounded text-white ${tone === 'blue' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-700 hover:bg-gray-800'}`}
        >
          {cta}
        </button>
      </form>
    </details>
  )
}

function Actions({ e }: { e: PaymentExceptionView }) {
  if (e.state !== 'open') {
    if (!e.postSettlementReportAt) return null
    return (
      <div className="flex flex-col gap-2 min-w-[16rem]">
        <Decision
          e={e} title="Marquer ce signalement comme vérifié…" action={acknowledgeExceptionReport} cta="Marquer comme vérifié"
          attest="J’ai vérifié dans le tableau de bord PayTech s’il y a eu un second paiement."
          placeholder="Résultat de la vérification. Un second remboursement éventuel est à décrire ici…"
        />
      </div>
    )
  }
  const confirmed = e.paymentReceived === 'confirmed_by_operator' || e.paymentReceived === 'confirmed_by_provider'
  const completed = e.payment?.status === 'completed'
  const undecided = e.refundState === 'not_assessed'

  return (
    <div className="flex flex-col gap-2 min-w-[16rem]">
      <form action={recheckException}>
        <input type="hidden" name="exceptionId" value={e.id} />
        <button type="submit" className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
          Vérifier à nouveau auprès de PayTech
        </button>
      </form>

      {!confirmed && (
        <Decision
          e={e} title="Confirmer la réception des fonds…" action={confirmExceptionReceipt} cta="Confirmer la réception"
          attest="J’ai vérifié dans le tableau de bord PayTech que ces fonds ont été reçus."
          placeholder="Vérification effectuée (transaction, date, montant)…"
        />
      )}

      {undecided && (!confirmed || completed) && (
        <Decision
          e={e} title="Classer : rien à rembourser…" action={dismissException} cta="Classer"
          attest={completed
            ? 'J’ai vérifié dans le tableau de bord PayTech que ce paiement reste valable.'
            : 'J’ai vérifié dans le tableau de bord PayTech qu’aucun fonds n’a été reçu.'}
          placeholder="Vérification effectuée…"
        />
      )}

      {confirmed && undecided && (
        <>
          <Decision
            e={e} title="Un remboursement est nécessaire…" action={requireExceptionRefund} cta="Marquer à rembourser"
            placeholder="Pourquoi le remboursement est nécessaire…"
          />
          {!completed && (
            <div>
              <Decision
                e={e} title="L’accès a été accordé pour ce paiement…" action={recordExceptionAccess} cta="Rattacher l’accès"
                placeholder="Décision et référence de l’accès accordé…"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Ceci n’accorde rien. Accordez d’abord l’accès dans{' '}
                <Link href="/admin/entitlements" className="underline">Accès formations</Link>.
              </p>
            </div>
          )}
        </>
      )}

      {e.paymentReceived === 'confirmed_by_operator' && undecided && (
        <Decision
          e={e} title="Annuler ma confirmation de réception…" action={withdrawExceptionReceipt} cta="Annuler la confirmation"
          placeholder="Pourquoi cette confirmation était une erreur…"
        />
      )}

      {e.refundState === 'required' && (
        <Decision
          e={e} title="Annuler la décision de remboursement…" action={withdrawExceptionRefund} cta="Annuler la décision"
          placeholder="Pourquoi cette décision était une erreur…"
        />
      )}

      {e.refundState === 'required' && (
        <details open>
          <summary className="cursor-pointer text-xs font-semibold text-gray-700">Enregistrer le remboursement effectué…</summary>
          <form action={recordExceptionRefund} className="mt-2 flex flex-col gap-1.5">
            <input type="hidden" name="exceptionId" value={e.id} />
            <input type="hidden" name="currency" value={e.payment?.currency ?? 'XOF'} />
            <input
              name="externalReference" required minLength={3} maxLength={120}
              placeholder="Référence du remboursement chez PayTech"
              className="text-xs border rounded p-1"
            />
            <div className="flex gap-1.5">
              <input
                name="amount" type="number" min="1" step="1" required defaultValue={e.payment?.amount}
                aria-label="Montant remboursé (intégral)" className="w-24 text-xs border rounded p-1"
              />
              <input
                name="refundedOn" type="date" required
                aria-label="Date du remboursement" className="text-xs border rounded p-1"
              />
            </div>
            <NoteField placeholder="Comment le remboursement a été confirmé…" />
            <label className="flex items-start gap-1.5 text-xs text-gray-600">
              <input type="checkbox" name="attest" value="yes" required />
              Ce remboursement a été effectué et confirmé en dehors de la plateforme.
            </label>
            <button type="submit" className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-800">
              Enregistrer
            </button>
          </form>
        </details>
      )}
    </div>
  )
}

export default function ExceptionQueue({ exceptions }: { exceptions: PaymentExceptionView[] | null }) {
  if (exceptions === null) {
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
        La file des anomalies n’a pas pu être lue. Ne concluez pas qu’elle est vide.
      </div>
    )
  }
  if (exceptions.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-16">Aucune anomalie ouverte.</p>
  }

  return (
    <ul className="space-y-4">
      {exceptions.map(e => (
        <li key={e.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="font-semibold text-gray-900">{SIGNAL_LABEL[e.lastSignal] ?? e.lastSignal}</p>
                <p className="text-xs text-gray-500 font-mono">
                  {e.payment?.reference ?? e.paymentId}
                  {e.payment?.providerMode === 'test' && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700">TEST</span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {e.learner?.name || e.learner?.email || 'Apprenant supprimé'} · {e.courseTitle ?? 'Formation inconnue'}
                  {e.payment && <> · {e.payment.amount.toLocaleString('fr-FR')} {e.payment.currency}</>}
                  {e.payment && <> · paiement enregistré : {e.payment.status}</>}
                </p>
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <Fact label="Paiement reçu" value={RECEIVED_LABEL[e.paymentReceived] ?? e.paymentReceived} strong />
                <Fact
                  label="Accès accordé"
                  value={e.accessState === 'granted' ? 'Oui, pour ce paiement' : e.accessLive ? 'Accès actif, autre origine' : 'Non'}
                  strong
                />
                <Fact label="Remboursement requis" value={REFUND_REQUIRED_LABEL[e.refundState] ?? e.refundState} strong />
                <Fact label="Remboursement confirmé" value={e.refundState === 'confirmed' ? 'Oui' : 'Non'} strong />
              </dl>

              {e.postSettlementReportAt && (
                <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
                  PayTech a signalé un paiement après ce règlement ({when(e.postSettlementReportAt)}). Il peut s’agir
                  d’un second paiement réel. L’apprenant ne peut pas relancer de paiement tant que ce signalement
                  n’est pas vérifié.
                </p>
              )}

              {e.otherCompletedReference && (
                <p role="alert" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  Paiement possible en double : cet apprenant a aussi un paiement confirmé pour cette formation
                  (<span className="font-mono">{e.otherCompletedReference}</span>).
                </p>
              )}

              {e.refundExternalReference && (
                <p className="text-xs text-gray-600">
                  Remboursé hors plateforme : {e.refundAmount?.toLocaleString('fr-FR')} {e.refundCurrency}, le{' '}
                  {when(e.refundConfirmedAt)} (réf. <span className="font-mono">{e.refundExternalReference}</span>).
                </p>
              )}

              <p className="text-xs text-gray-400">
                {e.reportCount} signalement(s) · premier {when(e.firstReportedAt)} · dernier {when(e.lastReportedAt)}
                {e.detail && <> · <span className="font-mono">{e.detail}</span></>}
                {' · '}
                {e.alertSentAt ? `alerte envoyée ${when(e.alertSentAt)}` : 'alerte en attente'}
                {e.resolution && <> · {RESOLUTION_LABEL[e.resolution] ?? e.resolution} {when(e.resolvedAt)}</>}
              </p>
            </div>
            <Actions e={e} />
          </div>
        </li>
      ))}
    </ul>
  )
}
