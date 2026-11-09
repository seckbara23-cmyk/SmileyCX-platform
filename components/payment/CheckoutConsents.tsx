'use client'
import { useState } from 'react'
import Link from 'next/link'
import { CHECKOUT_TERMS_VERSION, type CheckoutConsent } from '@/lib/legal/checkout-consent'
import { SALES_TERMS_VERSION, TERMS_VERSION } from '@/lib/legal/versions'

/**
 * The three unticked boxes of CGV art. 4, shown before every purchase — XP-LAUNCH-FINAL-11.
 *
 * Nothing is pre-ticked. `onChange` receives the consent only when all three
 * are ticked, and `null` otherwise, so the payment button stays locked until
 * then. The server checks the same three again and records them on the order;
 * this component decides nothing.
 *
 * The immediate-access box repeats CGV 7.1 as written: the request does NOT
 * deprive the buyer of the rights Senegalese law gives them.
 */
export default function CheckoutConsents({
  scope,
  onChange,
}: {
  /** What the immediate-access request covers: one course, or the courses of a pack. */
  scope: 'course' | 'pack'
  onChange: (consent: CheckoutConsent | null) => void
}) {
  const [terms, setTerms] = useState(false)
  const [immediateAccess, setImmediateAccess] = useState(false)
  const [adultOrGuardian, setAdultOrGuardian] = useState(false)

  function update(next: { terms: boolean; immediateAccess: boolean; adultOrGuardian: boolean }) {
    setTerms(next.terms)
    setImmediateAccess(next.immediateAccess)
    setAdultOrGuardian(next.adultOrGuardian)
    onChange(next.terms && next.immediateAccess && next.adultOrGuardian
      ? { version: CHECKOUT_TERMS_VERSION, ...next }
      : null)
  }
  const state = { terms, immediateAccess, adultOrGuardian }
  const what = scope === 'pack' ? 'aux formations du pack' : 'à la formation'

  return (
    <fieldset className="flex flex-col gap-3 text-sm text-dark">
      <legend className="sr-only">Conditions de la commande</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="terms"
          checked={terms}
          onChange={e => update({ ...state, terms: e.target.checked })}
          className="mt-1 h-4 w-4 shrink-0 accent-secondary"
        />
        <span>
          J’ai lu et j’accepte les{' '}
          <Link href="/terms" target="_blank" className="text-primary font-semibold hover:underline">
            Conditions générales d’utilisation
          </Link>{' '}
          (version {TERMS_VERSION}) et les{' '}
          <Link href="/cgv" target="_blank" className="text-primary font-semibold hover:underline">
            Conditions générales de vente
          </Link>{' '}
          (version {SALES_TERMS_VERSION}).
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="immediateAccess"
          checked={immediateAccess}
          onChange={e => update({ ...state, immediateAccess: e.target.checked })}
          className="mt-1 h-4 w-4 shrink-0 accent-secondary"
        />
        <span>
          Je demande expressément l’activation immédiate de mon accès {what} dès la validation du
          paiement, avant l’expiration éventuelle du délai légal de rétractation. Cette demande ne me
          prive pas des droits que me reconnaît la législation sénégalaise (CGV, article 7.1).
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          name="adultOrGuardian"
          checked={adultOrGuardian}
          onChange={e => update({ ...state, adultOrGuardian: e.target.checked })}
          className="mt-1 h-4 w-4 shrink-0 accent-secondary"
        />
        <span>
          Je certifie avoir 18 ans ou plus, ou acheter en tant que parent ou représentant légal de
          l’apprenant (CGV, article 9).
        </span>
      </label>
    </fieldset>
  )
}
