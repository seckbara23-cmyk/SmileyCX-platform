import Link from 'next/link'
import type { PaymentExceptionView } from '@/lib/payments/payment-exceptions'
import {
  acknowledgeExceptionReport,
  confirmExceptionReceipt,
  dismissException,
  recheckException,
  recordExceptionAccess,
  recordExceptionRefund,
  reopenExceptionAfterReview,
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
  paid_hint:          'Une notification indique un paiement',
  unverified_report:  'Notification non vérifiée : signature invalide ou type d’événement inconnu',
  provider_paid:      'PayTech confirme un paiement sur une tentative clôturée',
  completion_refused: 'PayTech confirme un paiement que la plateforme n’a pas pu honorer',
  provider_pending:   'Tentative clôturée, mais encore réglable selon PayTech',
  provider_not_paid:  'PayTech contredit l’état enregistré',
  cancel_hint:        'Une notification indique une annulation',
  amount_mismatch:    'Montant signalé différent du montant enregistré',
  currency_mismatch:  'Devise signalée différente de la devise enregistrée',
}

/** Recorded as a conflict, and not about an amount. */
const DETAIL_HEADLINE: Record<string, string> = {
  settlement_status_unrecognised: 'PayTech donne un état de paiement que le contrat ne connaît pas',
  settlement_amount_unreadable:   'PayTech indique un paiement sans montant lisible',
}

/** What PayTech itself last answered. Shown apart, because a notification can change the rest. */
const PROVIDER_ANSWER_LABEL: Record<string, string> = {
  settlement_amount_mismatch:   'un montant différent du montant enregistré',
  settlement_currency_mismatch: 'une devise différente de la devise enregistrée',
  provider_not_paid:            'que ce paiement n’a pas abouti',
  provider_pending:             'que ce paiement peut encore être réglé',
  provider_paid:                'que ce paiement a abouti',
  settlement_amount_unreadable: 'un paiement sans montant lisible',
  settlement_status_unrecognised: 'un état de paiement que le contrat ne connaît pas',
}

/** A record on a completed payment is about another payment, or questions this one. */
const QUESTIONS_THE_PAYMENT = ['cancel_hint', 'provider_not_paid', 'amount_mismatch', 'currency_mismatch', 'completion_refused']

/** Not a report of money. It questions what was settled. */
const QUESTIONS_THE_SETTLEMENT = ['cancel_hint', 'provider_not_paid', 'provider_pending']

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

/** The daily sweep has not finished for this long, so alerts and detection may be late. */
const SWEEP_OVERDUE_MS = 36 * 60 * 60 * 1000

/** A sweep that has stopped cannot report itself, so this page says so. */
export function SweepHealth({
  lastSweep, now, alertRecipients,
}: { lastSweep: { readable: boolean; at: string | null }; now: number; alertRecipients: number }) {
  const recent = lastSweep.readable && lastSweep.at && now - new Date(lastSweep.at).getTime() < SWEEP_OVERDUE_MS
  if (recent && alertRecipients > 0) return null
  return (
    <>
      {alertRecipients === 0 && (
        <div role="alert" className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
          Aucun destinataire d’alerte n’est configuré : personne n’est prévenu par e-mail. Consultez la file des
          anomalies, et prévenez le contact technique.
        </div>
      )}
      {!recent && (
        <div role="alert" className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
          {!lastSweep.readable
            ? 'Impossible de savoir quand le contrôle quotidien des paiements a abouti pour la dernière fois.'
            : lastSweep.at
              ? `Le contrôle quotidien des paiements n’a pas abouti depuis le ${when(lastSweep.at)}.`
              : 'Le contrôle quotidien des paiements n’a encore jamais abouti.'}{' '}
          Les alertes et la détection peuvent être en retard : consultez la file des anomalies et le tableau de bord
          PayTech, et prévenez le contact technique.
        </div>
      )}
    </>
  )
}

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

/** PayTech questioned this completed payment, and has since said it was paid at its amount. */
const tookItBack = (e: PaymentExceptionView) =>
  e.payment?.status === 'completed' && e.providerAnswer === null && e.providerAnswers.length > 0

function headline(e: PaymentExceptionView): string {
  if (tookItBack(e)) return 'PayTech confirme de nouveau ce paiement, au montant enregistré'
  if (e.lastSignal === 'provider_pending' && (e.payment?.status === 'pending' || e.payment?.status === 'processing')) return 'Encore réglable selon PayTech'
  if (e.lastSignal === 'completion_refused' && e.payment?.status === 'completed') return 'Ce paiement a depuis abouti ; ce dossier reste à vérifier'
  const byDetail = e.lastSignal === 'amount_mismatch' && e.detail ? DETAIL_HEADLINE[e.detail] : undefined
  return byDetail ?? SIGNAL_LABEL[e.lastSignal] ?? e.lastSignal
}

/** What PayTech has said on this record that a person should read, in the words of the queue. */
function providerSaid(e: PaymentExceptionView): string[] {
  const answers = e.providerAnswers.length > 0 ? e.providerAnswers : e.providerAnswer ? [e.providerAnswer] : []
  return answers
    .filter(a => PROVIDER_ANSWER_LABEL[a]
      // Paid is what the rest of the record already says, unless it went back on it.
      && (a !== 'provider_paid' || e.providerAnswer !== 'provider_paid')
      // "Not paid" is what a refunded or dismissed attempt should hear, unless it confirmed the money first.
      && (a !== 'provider_not_paid' || e.paymentReceived === 'confirmed_by_provider'
          || (e.resolution !== 'refund_confirmed' && e.resolution !== 'nothing_to_return')))
    .map(a => (a === 'provider_not_paid' && e.detail === 'provider_says_pending' && e.providerAnswer === 'provider_not_paid'
      ? 'que ce paiement peut encore être réglé'
      : a === 'settlement_amount_mismatch' && e.providerAmount !== null
      ? `${PROVIDER_ANSWER_LABEL[a]} (${e.providerAmount.toLocaleString('fr-FR')} ${e.payment?.currency ?? ''})`.replace(' )', ')')
      : PROVIDER_ANSWER_LABEL[a]))
}

/** A record keeps 20 digests, so past that the count is a floor. */
const howMany = (e: PaymentExceptionView) => (e.evidenceOverflow ? 'Plus de 20' : String(e.evidenceCount))
const howManyNotifications = (e: PaymentExceptionView) => (e.evidenceOverflow ? 'Plus de 20' : String(e.notificationCount))

/** Several different reports may mean several payments. */
function CoversEveryNotification({ e }: { e: PaymentExceptionView }) {
  if (e.evidenceCount <= 1) return null
  return (
    <label className="flex items-start gap-1.5 text-xs text-gray-600">
      <input type="checkbox" name="attestAll" value="yes" required />
      {howMany(e)} signalements différents figurent sur ce dossier. J’ai vérifié dans le tableau de bord PayTech
      s’ils correspondent à plusieurs paiements.
    </label>
  )
}

function Decision({
  e, title, action, cta, tone = 'gray', attest, placeholder, coversAll,
}: {
  e: PaymentExceptionView
  title: string
  action: (_formData: FormData) => Promise<void>
  cta: string
  tone?: 'gray' | 'blue'
  attest?: string
  placeholder: string
  coversAll?: boolean
}) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-gray-600">{title}</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5">
        <input type="hidden" name="exceptionId" value={e.id} />
        <input type="hidden" name="evidenceCount" value={e.evidenceCount} />
        <input type="hidden" name="evidenceVersion" value={e.evidenceVersion} />
        <NoteField placeholder={placeholder} />
        {attest && (
          <label className="flex items-start gap-1.5 text-xs text-gray-600">
            <input type="checkbox" name="attest" value="yes" required />
            {attest}
          </label>
        )}
        {coversAll && <CoversEveryNotification e={e} />}
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
    if (e.state !== 'resolved') return null
    return (
      <div className="flex flex-col gap-2 min-w-[16rem]">
        {(e.postSettlementReportAt || e.repeatCount > 0) && (
          <form action={recheckException}>
            <input type="hidden" name="exceptionId" value={e.id} />
            <button type="submit" className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
              Vérifier à nouveau auprès de PayTech
            </button>
          </form>
        )}
        {(e.postSettlementReportAt || e.repeatCount > 0) && (
          <Decision
            e={e} title="Marquer ce signalement comme vérifié…" action={acknowledgeExceptionReport} cta="Marquer comme vérifié"
            attest="J’ai vérifié dans le tableau de bord PayTech l’état de ce paiement et s’il y a eu un autre paiement."
            placeholder="Résultat de la vérification. Un second remboursement éventuel est à décrire ici…"
          />
        )}
        <Decision
          e={e} title="Un paiement n’est pas couvert par ce dossier…" action={reopenExceptionAfterReview} cta="Rouvrir le dossier"
          attest="J’ai constaté dans le tableau de bord PayTech un paiement que ce dossier ne couvre pas."
          placeholder="Ce que le tableau de bord PayTech montre…"
        />
      </div>
    )
  }
  const confirmed = e.paymentReceived === 'confirmed_by_operator' || e.paymentReceived === 'confirmed_by_provider'
  const completed = e.payment?.status === 'completed'
  // A completed payment was paid at its amount, so a lower one cannot be recorded.
  const belowCompleted = completed && e.providerAmount !== null && e.providerAmount < (e.payment?.amount ?? 0)
  const undecided = e.refundState === 'not_assessed'
  // PayTech confirmed this money, and its last word is that it was not paid or can still be
  // paid, or proves nothing while no amount it named stands. The dashboard decides.
  const providerWentBack = e.paymentReceived === 'confirmed_by_provider'
    && (e.providerAnswer === 'provider_not_paid' || e.providerAnswer === 'provider_pending'
        || ((e.providerAnswer === 'settlement_amount_mismatch' || e.providerAnswer === 'settlement_amount_unreadable' || e.providerAnswer === 'settlement_status_unrecognised')
            && e.providerAmount === null))
  // More than one amount: only the dashboard says which was received.
  const severalAmounts = e.providerAmounts.length > 1
  // A figure below the provider's last amount can be recorded only under its own attestation.
  const lastAmount = e.providerAmount
  const belowLastPossible = lastAmount !== null && !belowCompleted
    && (lastAmount > (e.payment?.amount ?? 0) || e.providerAmounts.some(a => a < lastAmount))

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

      {undecided && (!confirmed || completed || providerWentBack) && (
        <Decision
          e={e} title="Classer : rien à rembourser…" action={dismissException} cta="Classer"
          attest={completed
            ? 'J’ai vérifié dans le tableau de bord PayTech que ce paiement reste valable.'
            : 'J’ai vérifié dans le tableau de bord PayTech qu’aucun fonds n’a été reçu.'}
          placeholder="Vérification effectuée…" coversAll
        />
      )}

      {undecided && (e.payment?.status === 'pending' || e.payment?.status === 'processing') && (
        <p className="text-[11px] text-gray-500">
          Le paiement reste en cours : classer cette anomalie ne le clôture pas. L’apprenant ne pourra relancer un
          paiement qu’une fois la tentative clôturée.
        </p>
      )}

      {confirmed && undecided && (
        <>
          <Decision
            e={e} title="Un remboursement est nécessaire…" action={requireExceptionRefund} cta="Marquer à rembourser"
            placeholder="Pourquoi le remboursement est nécessaire…" coversAll
          />
          {!completed && (
            <div>
              <Decision
                e={e} title="L’accès a été accordé pour ce paiement…" action={recordExceptionAccess} cta="Rattacher l’accès"
                placeholder="Décision et référence de l’accès accordé…" coversAll
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
            <input type="hidden" name="evidenceCount" value={e.evidenceCount} />
            <input type="hidden" name="evidenceVersion" value={e.evidenceVersion} />
            <input type="hidden" name="currency" value={e.payment?.currency ?? 'XOF'} />
            <input
              name="externalReference" required minLength={3} maxLength={120}
              placeholder="Référence du remboursement chez PayTech"
              className="text-xs border rounded p-1"
            />
            <div className="flex gap-1.5">
              <input
                name="amount" type="number" min="1" step="any" required defaultValue={belowCompleted ? e.payment?.amount : e.providerAmount ?? e.payment?.amount}
                aria-label="Montant remboursé (intégral)" className="w-24 text-xs border rounded p-1"
              />
              <input
                name="refundedOn" type="date" required
                aria-label="Date du remboursement" className="text-xs border rounded p-1"
              />
            </div>
            {e.providerAmount !== null && (
              <p className="text-[11px] text-gray-500">
                PayTech a indiqué un autre montant que celui enregistré.{' '}
                {belowCompleted
                  ? 'Seul le montant du paiement peut être enregistré'
                  : belowLastPossible
                    ? severalAmounts && !completed ? 'Seuls les montants annoncés par PayTech sur ce dossier ou celui du paiement peuvent être enregistrés, sous l’attestation ci-dessous s’ils sont inférieurs au dernier annoncé' : 'Seuls ce montant ou, sous l’attestation ci-dessous, celui du paiement peuvent être enregistrés'
                    : severalAmounts ? 'Seuls les montants annoncés par PayTech sur ce dossier ou celui du paiement peuvent être enregistrés' : 'Seuls ce montant ou celui du paiement peuvent être enregistrés'}
                {' '}: vérifiez ce qui a réellement été reçu dans le tableau de bord PayTech.
              </p>
            )}
            {belowLastPossible && (
              <label className="flex items-start gap-1.5 text-xs text-gray-600">
                <input type="checkbox" name="attestCharged" value="yes" />
                Si le montant enregistré est inférieur au dernier annoncé par PayTech : j’ai vérifié dans le tableau de bord PayTech que c’est la totalité de ce qui a été reçu.
              </label>
            )}
            <NoteField placeholder="Comment le remboursement a été confirmé…" />
            <label className="flex items-start gap-1.5 text-xs text-gray-600">
              <input type="checkbox" name="attest" value="yes" required />
              Ce remboursement a été effectué et confirmé en dehors de la plateforme.
            </label>
            <CoversEveryNotification e={e} />
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
  const limits = (
    <p className="mb-4 text-xs text-gray-500">
      Cette file complète le rapprochement avec le tableau de bord PayTech et ne le remplace pas.
    </p>
  )
  if (exceptions.length === 0) {
    return (
      <>
        {limits}
        <p className="text-sm text-gray-400 text-center py-16">Aucune anomalie ouverte.</p>
      </>
    )
  }

  return (
    <>
    {limits}
    <ul className="space-y-4">
      {exceptions.map(e => (
        <li key={e.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="font-semibold text-gray-900">{headline(e)}</p>
                {providerSaid(e).length > 0 && (
                  <p className="text-xs text-gray-700 mt-1">
                    Désaccord enregistré avec PayTech : il a indiqué {providerSaid(e).join(' ; ')}.
                  </p>
                )}
                {tookItBack(e) && (
                  <p className="text-xs text-gray-700 mt-1">
                    Dernière réponse de PayTech : paiement confirmé au montant enregistré.
                  </p>
                )}
                {e.providerAmounts.length > 1 && (
                  <p className="text-xs text-gray-700 mt-1">
                    Montants annoncés par PayTech sur ce dossier : {e.providerAmounts.map(a => a.toLocaleString('fr-FR')).join(', ')} {e.payment?.currency}.
                  </p>
                )}
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
                  value={e.accessState === 'granted'
                    ? 'Oui, pour ce paiement'
                    : e.accessLive ? (e.payment?.status === 'completed' || e.payment?.status === 'refunded' ? 'Accès actif' : 'Accès actif, autre origine') : 'Non'}
                  strong
                />
                <Fact label="Remboursement requis" value={REFUND_REQUIRED_LABEL[e.refundState] ?? e.refundState} strong />
                <Fact label="Remboursement confirmé" value={e.refundState === 'confirmed' ? 'Oui' : 'Non'} strong />
              </dl>

              {e.postSettlementReportAt && (
                <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
                  {e.administratorFlaggedAt ? (
                    <>
                      Un administrateur a indiqué un paiement que ce dossier ne couvre pas ({when(e.administratorFlaggedAt)}). Vérifiez-le dans le tableau de bord PayTech.
                      {' '}{e.payment?.status === 'completed'
                        ? 'L’apprenant n’est pas bloqué.'
                        : 'L’apprenant ne peut pas relancer de paiement tant que ce signalement n’est pas vérifié.'}
                    </>
                  ) : e.payment?.status === 'completed' && e.resolution === 'nothing_to_return' && e.notificationCount <= 1 ? (
                    <>
                      Ce paiement a abouti alors que ce dossier avait été classé sans remboursement ({when(e.postSettlementReportAt)}).
                      Vérifiez-le dans le tableau de bord PayTech. L’apprenant n’est pas bloqué.
                    </>
                  ) : e.payment?.status === 'completed' ? (
                    <>
                      {e.notificationCount > 1
                        ? <>Un paiement que ce dossier ne couvre pas est à vérifier ({when(e.postSettlementReportAt)}). Plusieurs signalements différents peuvent correspondre à plusieurs paiements.</>
                        : <>Un signalement que ce paiement ne couvre pas est à vérifier ({when(e.postSettlementReportAt)}).</>}
                      {QUESTIONS_THE_PAYMENT.includes(e.lastSignal) || (e.differentSignal && QUESTIONS_THE_PAYMENT.includes(e.differentSignal)) || e.providerAnswer
                        ? ' Ce dossier met aussi en doute le paiement confirmé ci-dessus : vérifiez-le dans le tableau de bord PayTech.'
                        : e.notificationCount > 1
                          ? ' Vérifiez dans le tableau de bord PayTech lequel des deux est concerné avant tout remboursement.'
                          : ' Vérifiez-le dans le tableau de bord PayTech avant tout remboursement.'}
                      {' '}L’apprenant n’est pas bloqué.
                    </>
                  ) : e.lastSignal === 'amount_mismatch' && e.providerAnswer === 'settlement_status_unrecognised' ? (
                    <>
                      PayTech a donné après ce règlement un état de paiement que le contrat ne connaît pas ({when(e.postSettlementReportAt)}) :
                      vérifiez-le dans le tableau de bord PayTech. L’apprenant ne peut pas relancer de paiement tant qu’il n’est pas vérifié.
                    </>
                  ) : QUESTIONS_THE_SETTLEMENT.includes(e.lastSignal) ? (
                    <>
                      Un signalement met ce règlement en doute ({when(e.postSettlementReportAt)}) : vérifiez-le dans le
                      tableau de bord PayTech. L’apprenant ne peut pas relancer de paiement tant qu’il n’est pas vérifié.
                    </>
                  ) : (
                    <>
                      Un paiement a été signalé après ce règlement{e.lastSignal === 'provider_paid' || e.lastSignal === 'completion_refused' ? ' par PayTech' : ', sans que cela soit prouvé'} ({when(e.postSettlementReportAt)}). Il peut s’agir
                      d’un second paiement réel. L’apprenant ne peut pas relancer de paiement tant que ce signalement
                      n’est pas vérifié.
                    </>
                  )}
                </p>
              )}

              {(e.state === 'open' || e.postSettlementReportAt || e.differentReportAt) && e.notificationCount > 1 && (
                <p role="alert" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  {howManyNotifications(e)} notifications au contenu différent ont été reçues pour ce paiement. Il peut y avoir
                  eu plusieurs paiements : vérifiez-les dans le tableau de bord PayTech avant de décider.
                </p>
              )}

              {e.differentReportAt && (
                <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
                  Un signalement que la dernière vérification ne couvre pas a été reçu ({when(e.differentReportAt)}). Il a été
                  compté et n’a rien rouvert. Il peut s’agir d’un autre paiement : vérifiez le tableau de bord PayTech.
                  {e.differentSignal && SIGNAL_LABEL[e.differentSignal] && <> Dernier signalement : {SIGNAL_LABEL[e.differentSignal]}.</>}
                </p>
              )}

              {e.repeatCount > 0 && !e.differentReportAt && (
                <p role="alert" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  Une notification déjà prise en compte a été reçue de nouveau, {e.repeatCount} fois (dernière : {when(e.lastRepeatAt)}).
                  {!e.postSettlementReportAt && ' Elle ne bloque pas l’apprenant.'} Une répétition et un second paiement
                  peuvent se ressembler : vérifiez le tableau de bord PayTech.
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

              {e.lastDecisionNote && (
                <p className="text-xs text-gray-600">
                  Dernière décision ({when(e.lastDecisionAt)}) : {e.lastDecisionNote}
                </p>
              )}

              <p className="text-xs text-gray-400">
                {e.evidenceCount > 0 && <>{howMany(e)} signalement(s) différent(s) · </>}
                {e.reportCount} signalement(s) · premier {when(e.firstReportedAt)} · dernier {when(e.lastReportedAt)}
                {e.detail && <> · <span className="font-mono">{e.detail}</span></>}
                {' · '}
                {e.alertSentAt
                  ? `alerte envoyée ${when(e.alertSentAt)}`
                  : e.state === 'open' || e.postSettlementReportAt
                    ? 'alerte en attente'
                    : e.repeatCount > 0 ? 'une alerte par semaine au plus' : 'aucune alerte requise'}
                {e.resolution && <> · {RESOLUTION_LABEL[e.resolution] ?? e.resolution} {when(e.resolvedAt)}</>}
              </p>
            </div>
            <Actions e={e} />
          </div>
        </li>
      ))}
    </ul>
    </>
  )
}
