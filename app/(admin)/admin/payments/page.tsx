import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Metadata } from 'next'

// PAY-2C-0. `activateEnrollment` is deliberately NOT imported any more. It used
// to mark a payment completed and create an ENROLLMENT, which since XPA-6B
// authorizes nothing — the learner paid, the payment read "Confirmé", and the
// course stayed shut. This page now reads payments and nothing else; the action
// itself refuses, so a stale page cannot complete a payment either.

export const metadata: Metadata = { title: 'Admin — Paiements' }

export default async function AdminPaymentsPage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, currency, method, status, reference, created_at, completed_at, profiles(full_name, email), courses(title)')
    .order('created_at', { ascending: false })
    .limit(100)

  const { data: revData } = await supabase
    .from('payments')
    .select('amount')
    .eq('status', 'completed')

  const totalRevenue = revData?.reduce((sum, p) => sum + Number(p.amount), 0) ?? 0

  const statusColor: Record<string, string> = {
    completed:  'bg-green-100 text-green-700',
    pending:    'bg-yellow-100 text-yellow-700',
    processing: 'bg-blue-100 text-blue-700',
    failed:     'bg-red-100 text-red-600',
    refunded:   'bg-gray-100 text-gray-500',
  }

  const methodLabel: Record<string, string> = {
    orange_money: 'Orange Money',
    wave:         'Wave',
    card:         'Carte',
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900">Paiements</h1>
          <p className="text-sm text-gray-400 mt-0.5">{payments?.length ?? 0} transaction(s)</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-extrabold text-gray-900">{totalRevenue.toLocaleString('fr-FR')} FCFA</p>
          <p className="text-xs text-gray-400">Revenus confirmés</p>
        </div>
      </div>

      {/* PAY-2C-0. Stated on the page, not only in the code, because the person
          who used to press "Activer" needs to know why it is gone and what to
          do instead. */}
      <div
        role="status"
        className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900"
      >
        <p className="font-semibold">Activation manuelle des paiements indisponible</p>
        <p className="mt-1 text-amber-800">
          Le bouton « Activer » a été retiré : il marquait le paiement comme confirmé
          et créait une inscription, sans accorder le droit d&apos;accès à la formation.
          L&apos;apprenant payait et n&apos;obtenait rien. L&apos;activation sera rétablie avec
          l&apos;intégration sécurisée PayDunya, qui confirmera chaque paiement auprès du
          prestataire avant d&apos;accorder l&apos;accès.
        </p>
        <p className="mt-1 text-amber-800">
          Pour accorder un accès dès maintenant, utilisez{' '}
          <span className="font-semibold">Admin → Accès</span> : la demande y est
          vérifiée, tracée et limitée en débit.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!payments?.length ? (
          <p className="text-sm text-gray-400 text-center py-16">Aucun paiement pour l&apos;instant.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_100px_100px_110px_120px_100px] gap-3 px-5 py-3 bg-gray-50 text-xs font-bold text-gray-400 uppercase tracking-wider">
              <span>Client</span>
              <span>Formation</span>
              <span>Montant</span>
              <span>Méthode</span>
              <span>Statut</span>
              <span>Date</span>
              <span>Actions</span>
            </div>

            {payments.map(p => {
              const user   = p.profiles as unknown as { full_name: string | null; email: string } | null
              const course = p.courses  as unknown as { title: string } | null
              return (
                <div key={p.id} className="hover:bg-gray-50/60 transition-colors">
                  <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_100px_100px_110px_120px_100px] gap-3 px-5 py-3.5 items-center">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{user?.full_name || user?.email || '—'}</p>
                      <p className="text-xs text-gray-400 font-mono truncate">{p.reference}</p>
                    </div>
                    <span className="text-sm text-gray-600 truncate">{course?.title || '—'}</span>
                    <span className="text-sm font-semibold text-gray-800">{Number(p.amount).toLocaleString('fr-FR')} {p.currency}</span>
                    <span className="text-xs text-gray-500">{methodLabel[p.method] || p.method}</span>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${statusColor[p.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {p.status === 'completed' ? 'Confirmé' : p.status === 'pending' ? 'En attente' : p.status === 'processing' ? 'En cours' : p.status === 'failed' ? 'Échoué' : 'Remboursé'}
                    </span>
                    <span className="text-xs text-gray-400">{new Date(p.created_at).toLocaleDateString('fr-FR')}</span>
                    <div className="flex gap-1">
                      {p.status === 'pending' && (
                        <span
                          className="text-xs px-2 py-1 bg-gray-100 text-gray-400 rounded"
                          title="Indisponible : l'activation manuelle accordait une inscription sans droit d'accès. En attente de l'intégration sécurisée PayDunya."
                        >
                          Indisponible
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Mobile */}
                  <div className="sm:hidden px-4 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{user?.full_name || user?.email}</p>
                        <p className="text-xs text-gray-400">{course?.title}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-gray-800">{Number(p.amount).toLocaleString('fr-FR')} FCFA</p>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColor[p.status] ?? 'bg-gray-100 text-gray-500'}`}>
                          {p.status}
                        </span>
                        {p.status === 'pending' && (
                          <span className="mt-1 inline-block text-xs px-2 py-1 bg-gray-100 text-gray-400 rounded">
                            Indisponible
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
