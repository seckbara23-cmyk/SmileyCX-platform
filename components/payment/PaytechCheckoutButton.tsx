'use client'
import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { startPaytechCheckout } from '@/app/actions/paytech-checkout'

/**
 * The only payment control a learner sees — XP-PAYTECH-04.
 *
 * It sends ONE thing to the server: the course id. Price, currency, payer and
 * order reference are all decided there. It collects no card number, no CVV,
 * no expiry and no phone number: the learner chooses and enters their payment
 * instrument on PayTech's own hosted page, so no payment data ever transits or
 * is stored by XP Client Academy (XP-PAYTECH-04 safeguard 7). This replaces
 * `PaymentMethodSelector`, whose card form put the site in PCI DSS scope.
 */

/** Only ever navigate to PayTech's host, or to a path on this site. */
function isSafeDestination(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'paytech.sn'
  } catch {
    return false
  }
}

export default function PaytechCheckoutButton({ courseId }: { courseId: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState<string | null>(null)

  async function pay() {
    setLoading(true)
    setError('')
    setReference(null)
    try {
      const result = await startPaytechCheckout({ courseId })
      const destination = result.redirectUrl ?? result.accessUrl
      if (destination && isSafeDestination(destination)) {
        window.location.assign(destination)
        return
      }
      setError(result.error ?? 'Le paiement n’a pas pu être lancé. Veuillez réessayer.')
      setReference(result.reference ?? null)
    } catch {
      setError('Le paiement n’a pas pu être lancé. Veuillez réessayer.')
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-cx-gray">
        Vous allez être redirigé vers <strong className="text-dark">PayTech</strong>, notre prestataire
        de paiement sécurisé, pour régler par Orange Money, Wave, Free Money ou carte bancaire.
      </p>
      <p className="text-xs text-cx-gray flex items-start gap-1.5">
        <Lock className="w-3.5 h-3.5 mt-0.5 text-success shrink-0" aria-hidden="true" />
        XP Client Academy ne demande ni ne conserve jamais vos coordonnées bancaires ou
        de paiement mobile : elles sont saisies uniquement sur la page PayTech.
      </p>

      {error && (
        <p role="alert" className="text-sm text-error font-medium">
          {error}
          {reference && (
            <span className="block mt-1 text-xs font-normal text-cx-gray">
              Référence : <span className="font-mono">{reference}</span>
            </span>
          )}
        </p>
      )}

      <button
        type="button"
        onClick={pay}
        disabled={loading}
        className={`w-full flex items-center justify-center gap-2 py-4 rounded-cx font-bold text-white text-base transition-all ${
          loading
            ? 'bg-cx-gray/40 cursor-not-allowed'
            : 'bg-secondary hover:bg-secondary-dark hover:-translate-y-0.5 shadow-btn'
        }`}
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            Redirection vers PayTech…
          </>
        ) : (
          'Payer avec PayTech'
        )}
      </button>
    </div>
  )
}
