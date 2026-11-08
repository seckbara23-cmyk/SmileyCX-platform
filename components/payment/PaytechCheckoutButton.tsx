'use client'
import { useState } from 'react'
import { Loader2, Lock, RotateCcw } from 'lucide-react'
import { startPaytechCheckout, startPaytechPackCheckout } from '@/app/actions/paytech-checkout'

/**
 * The only payment control a learner sees — XP-PAYTECH-04.
 *
 * It sends ONE thing to the server: the course id. Price, currency, payer and
 * order reference are all decided there. It collects no card number, no CVV,
 * no expiry and no phone number: the learner chooses and enters their payment
 * instrument on PayTech's own hosted page, so no payment data ever transits or
 * is stored by XP Client Academy (XP-PAYTECH-04 safeguard 7). This replaces
 * `PaymentMethodSelector`, whose card form put the site in PCI DSS scope.
 *
 * ── A RESUME IS SAID TO BE ONE (XP-LAUNCH-04) ─────────────────────────────
 *
 * PayTech's « Annuler » button only sends the browser back; the hosted page it
 * leaves stays payable and the provider keeps calling the attempt pending. The
 * server therefore re-offers the SAME page rather than opening a second
 * chargeable one, and this button says so: when the checkout page found an
 * attempt in flight it reads « Reprendre le paiement », and when the server
 * answers `resumed` the redirect is announced as a resume. The decision is the
 * server's, on the click, after asking the provider; this component only names
 * it, and never holds a URL or a token of its own.
 */

/** What the checkout page knows of an attempt in flight for this course. Never a URL or a token. */
export interface PaytechResumeNotice {
  /** A hosted page is stored for it, so the same page can be offered again. */
  resumable: boolean
}

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

const FALLBACK = 'Le paiement n’a pas pu être lancé. Veuillez réessayer.'

/** A single course: the ONE thing sent is its id. */
function startCourse(courseId: string) {
  return startPaytechCheckout({ courseId })
}

export default function PaytechCheckoutButton({
  courseId,
  packCode,
  acknowledgedCourseIds,
  blocked = false,
  resume = null,
}: {
  /** The course to buy. */
  courseId?: string
  /**
   * XP-LAUNCH-FINAL-08: the pack to buy instead, with the owned courses whose
   * warning the learner acknowledged (`PackCheckoutPanel`). The server re-derives
   * both and refuses if they differ.
   */
  packCode?: string
  acknowledgedCourseIds?: string[]
  /** True until the learner has acknowledged what the page asks (the pack warning). */
  blocked?: boolean
  resume?: PaytechResumeNotice | null
}) {
  const [loading, setLoading] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState<string | null>(null)

  async function pay() {
    if (blocked) return
    setLoading(true)
    setResuming(false)
    setError('')
    setReference(null)
    try {
      const result = packCode
        ? await startPaytechPackCheckout({ packCode, acknowledgedCourseIds: acknowledgedCourseIds ?? [] })
        : await startCourse(courseId ?? '')
      const destination = result.redirectUrl ?? result.accessUrl
      if (destination && isSafeDestination(destination)) {
        if (result.resumed === true) setResuming(true)
        window.location.assign(destination)
        return
      }
      setError(result.error ?? FALLBACK)
      setReference(result.reference ?? null)
    } catch {
      setError(FALLBACK)
    }
    setLoading(false)
  }

  const label = resume?.resumable
    ? 'Reprendre le paiement'
    : resume
      ? 'Vérifier l’état de mon paiement'
      : 'Payer avec PayTech'
  const busyLabel = resuming ? 'Reprise de votre paiement en cours…' : 'Redirection vers PayTech…'

  return (
    <div className="flex flex-col gap-4">
      {resume?.resumable ? (
        <p className="text-sm text-cx-gray">
          Vous allez retrouver <strong className="text-dark">votre session de paiement PayTech en cours</strong> pour
          cette formation, là où vous l&apos;aviez laissée. Aucune nouvelle commande n&apos;est créée.
        </p>
      ) : resume ? (
        <p className="text-sm text-cx-gray">
          Un paiement est déjà en cours de vérification pour cette formation. Nous demandons son état
          à <strong className="text-dark">PayTech</strong> avant toute nouvelle commande.
        </p>
      ) : (
        <p className="text-sm text-cx-gray">
          Vous allez être redirigé vers <strong className="text-dark">PayTech</strong>, notre prestataire
          de paiement sécurisé, pour régler par Orange Money, Wave, Free Money ou carte bancaire.
        </p>
      )}
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
        disabled={loading || blocked}
        className={`w-full flex items-center justify-center gap-2 py-4 rounded-cx font-bold text-white text-base transition-all ${
          loading || blocked
            ? 'bg-cx-gray/40 cursor-not-allowed'
            : 'bg-secondary hover:bg-secondary-dark hover:-translate-y-0.5 shadow-btn'
        }`}
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            {busyLabel}
          </>
        ) : (
          <>
            {resume?.resumable && <RotateCcw className="w-5 h-5" aria-hidden="true" />}
            {label}
          </>
        )}
      </button>
    </div>
  )
}
