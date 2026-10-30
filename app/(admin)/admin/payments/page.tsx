import Link from 'next/link'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyPaytechPayment, closeUnpaidPaytechPayment } from './reconcile-actions'
import type { Metadata } from 'next'

// PAY-2C-0. `activateEnrollment` is deliberately NOT imported: it marked a
// payment completed without the provider, and it now refuses. XP-PAYTECH-04
// adds the only two operator actions a payment may receive — "ask PayTech" and
// "close as unpaid after a manual check" — neither of which can mark one paid.

export const metadata: Metadata = { title: 'Admin — Paiements' }

/** Every status 060 admits, labelled. XP-PAYTECH-READY-01 A1: these used to fall through to "Remboursé". */
const STATUS_LABEL: Record<string, string> = {
  completed:  'Confirmé',
  pending:    'En attente',
  processing: 'En cours',
  failed:     'Échoué',
  cancelled:  'Annulé',
  expired:    'Expiré',
  refunded:   'Remboursé',
}

const STATUS_COLOR: Record<string, string> = {
  completed:  'bg-green-100 text-green-700',
  pending:    'bg-yellow-100 text-yellow-700',
  processing: 'bg-blue-100 text-blue-700',
  failed:     'bg-red-100 text-red-600',
  cancelled:  'bg-gray-100 text-gray-600',
  expired:    'bg-gray-100 text-gray-600',
  refunded:   'bg-purple-100 text-purple-700',
}

const METHOD_LABEL: Record<string, string> = {
  orange_money: 'Orange Money',
  wave:         'Wave',
  card:         'Carte',
}

/** Fixed operator messages, keyed by the code the actions redirect with. Nothing is reflected. */
const NOTICE: Record<string, string> = {
  verify_completed:         'PayTech a confirmé le paiement : il est enregistré et l’accès est accordé.',
  verify_already_completed: 'Ce paiement était déjà confirmé.',
  verify_failed:            'PayTech indique un échec : le paiement est clôturé.',
  verify_cancelled:         'PayTech indique une annulation : le paiement est clôturé.',
  verify_already_terminal:  'Ce paiement était déjà clôturé.',
  verify_pending:           'PayTech indique un paiement en attente : rien n’a été modifié.',
  verify_unknown:           'PayTech n’a pas pu donner de réponse exploitable (contrat de statut non confirmé, ou service injoignable). Rien n’a été modifié.',
  verify_refused:           'PayTech indique un paiement que la plateforme refuse d’honorer automatiquement (voir « Motif »). Décision manuelle requise — remboursement ou accès.',
  verify_ineligible:        'Ce paiement ne peut pas être vérifié automatiquement (voir « Motif »).',
  close_done:               'Paiement clôturé comme non abouti. L’apprenant peut relancer un paiement.',
  close_refused_provider_says_paid:    'Clôture refusée : PayTech indique que ce paiement a abouti.',
  close_refused_provider_says_pending: 'Clôture refusée : PayTech indique que ce paiement peut encore être réglé.',
  close_refused_not_open:   'Clôture refusée : ce paiement n’est plus en cours.',
  close_refused_ineligible: 'Clôture refusée : ce paiement ne relève pas de PayTech.',
  close_refused_race:       'Clôture refusée : le paiement a changé entre-temps. Actualisez.',
  close_reason_required:    'Indiquez un motif (10 caractères minimum).',
  close_attestation_required: 'Cochez la confirmation de vérification dans le tableau de bord PayTech.',
  environment_refused:      'Opération refusée sur ce déploiement : il ne peut pas agir sur cette base de données. Rien n’a été modifié.',
  close_refused_environment_refused: 'Opération refusée sur ce déploiement : il ne peut pas agir sur cette base de données. Rien n’a été modifié.',
  rate_limited:             'Trop de demandes. Réessayez dans quelques minutes.',
  not_found:                'Paiement introuvable.',
  invalid:                  'Demande invalide.',
}

interface Props { searchParams?: Promise<{ filter?: string; notice?: string }> }

interface PaymentRow {
  id: string
  amount: number | string
  currency: string
  method: string
  status: string
  reference: string
  provider: string | null
  provider_mode: string | null
  failure_reason: string | null
  last_ipn_at: string | null
  created_at: string
  completed_at: string | null
  profiles: { full_name: string | null; email: string } | null
  courses: { title: string } | null
}

const STALE_MS = 30 * 60 * 1000

/** Needs a human: stale in flight, or carrying a refusal or an unresolved check. */
function needsReconciliation(p: PaymentRow, now: number): boolean {
  if (p.provider !== 'paytech') return false
  const inFlight = p.status === 'pending' || p.status === 'processing'
  return (inFlight && now - new Date(p.created_at).getTime() > STALE_MS) || p.failure_reason !== null
}

export default async function AdminPaymentsPage({ searchParams }: Props) {
  await requirePlatformAdmin()
  const params = (await searchParams) ?? {}
  const reconcileOnly = params.filter === 'reconcile'
  const notice = params.notice ? NOTICE[params.notice] ?? null : null
  const supabase = createAdminClient()

  const { data } = await supabase
    .from('payments')
    .select('id, amount, currency, method, status, reference, provider, provider_mode, failure_reason, last_ipn_at, created_at, completed_at, profiles(full_name, email), courses(title)')
    .order('created_at', { ascending: false })
    .limit(200)

  const { data: revData } = await supabase
    .from('payments')
    .select('amount, provider_mode')
    .eq('status', 'completed')

  // Revenue is money that moved in LIVE mode (or a pre-provider manual sale).
  // A test-mode completion is never revenue — and migration 063 refuses one in
  // a live database anyway.
  const completed = (revData ?? []) as { amount: number | string; provider_mode: string | null }[]
  const totalRevenue = completed.filter(p => p.provider_mode !== 'test').reduce((s, p) => s + Number(p.amount), 0)
  const testExcluded = completed.filter(p => p.provider_mode === 'test').length

  const now = Date.now()
  const all = (data ?? []) as unknown as PaymentRow[]
  const toReconcile = all.filter(p => needsReconciliation(p, now))
  const payments = reconcileOnly ? toReconcile : all.slice(0, 100)

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Paiements</h1>
          <p className="text-sm text-gray-400 mt-0.5">{payments.length} transaction(s)</p>
          <div className="mt-2 flex gap-3 text-sm">
            <Link href="/admin/payments" className={reconcileOnly ? 'text-gray-500 hover:underline' : 'font-semibold text-gray-900'}>
              Toutes
            </Link>
            <Link href="/admin/payments?filter=reconcile" className={reconcileOnly ? 'font-semibold text-gray-900' : 'text-gray-500 hover:underline'}>
              À rapprocher ({toReconcile.length})
            </Link>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-extrabold text-gray-900">{totalRevenue.toLocaleString('fr-FR')} FCFA</p>
          <p className="text-xs text-gray-400">Revenus confirmés (mode réel)</p>
          {testExcluded > 0 && (
            <p className="text-xs text-amber-600 mt-0.5">{testExcluded} paiement(s) de test exclu(s)</p>
          )}
        </div>
      </div>

      {notice && (
        <div role="status" className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-3 text-sm text-blue-900">
          {notice}
        </div>
      )}

      <div role="note" className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
        <p className="font-semibold">Aucun paiement ne peut être marqué « payé » à la main</p>
        <p className="mt-1 text-amber-800">
          Un paiement n&apos;est confirmé que lorsque PayTech le confirme, de serveur à serveur.
          « Vérifier » interroge PayTech ; « Clôturer » enregistre, après vérification dans le
          tableau de bord PayTech, qu&apos;un paiement n&apos;a pas abouti — cela n&apos;accorde rien
          et permet seulement à l&apos;apprenant de réessayer. Pour accorder un accès sans paiement,
          utilisez <span className="font-semibold">Admin → Accès</span>.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
        {payments.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            {reconcileOnly ? 'Aucun paiement à rapprocher.' : 'Aucun paiement pour l’instant.'}
          </p>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Client / Référence</th>
                <th className="px-4 py-3 text-left">Formation</th>
                <th className="px-4 py-3 text-left">Montant</th>
                <th className="px-4 py-3 text-left">Prestataire</th>
                <th className="px-4 py-3 text-left">Statut</th>
                <th className="px-4 py-3 text-left">Motif</th>
                <th className="px-4 py-3 text-left">Dates</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {payments.map(p => {
                const actionable = p.provider === 'paytech' && (p.status === 'pending' || p.status === 'processing')
                return (
                  <tr key={p.id} className="align-top hover:bg-gray-50/60">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{p.profiles?.full_name || p.profiles?.email || '—'}</p>
                      <p className="text-xs text-gray-400 font-mono">{p.reference}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p.courses?.title || '—'}</td>
                    <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">
                      {Number(p.amount).toLocaleString('fr-FR')} {p.currency}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {p.provider === 'paytech' ? 'PayTech' : p.provider ?? (METHOD_LABEL[p.method] ?? p.method)}
                      {p.provider_mode === 'test' && (
                        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700">TEST</span>
                      )}
                      {p.provider_mode === 'live' && <span className="ml-1 text-gray-400">réel</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${STATUS_COLOR[p.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-500">{p.failure_reason ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                      <p>Créé {new Date(p.created_at).toLocaleString('fr-FR')}</p>
                      {p.last_ipn_at && <p>Notifié {new Date(p.last_ipn_at).toLocaleString('fr-FR')}</p>}
                      {p.completed_at && <p>Confirmé {new Date(p.completed_at).toLocaleString('fr-FR')}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {actionable ? (
                        <div className="flex flex-col gap-2 min-w-[14rem]">
                          <form action={verifyPaytechPayment}>
                            <input type="hidden" name="paymentId" value={p.id} />
                            <button type="submit" className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
                              Vérifier auprès de PayTech
                            </button>
                          </form>
                          <details>
                            <summary className="cursor-pointer text-xs text-gray-500">Clôturer comme non abouti…</summary>
                            <form action={closeUnpaidPaytechPayment} className="mt-2 flex flex-col gap-1.5">
                              <input type="hidden" name="paymentId" value={p.id} />
                              <textarea name="reason" required minLength={10} maxLength={500} rows={2}
                                placeholder="Motif (vérification effectuée, échange avec l’apprenant…)"
                                className="text-xs border rounded p-1" />
                              <label className="flex items-start gap-1.5 text-xs text-gray-600">
                                <input type="checkbox" name="attest" value="yes" required />
                                J&apos;ai vérifié dans le tableau de bord PayTech que ce paiement n&apos;a pas abouti.
                              </label>
                              <button type="submit" className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-800">
                                Clôturer
                              </button>
                            </form>
                          </details>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
