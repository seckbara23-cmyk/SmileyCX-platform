'use client'
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import PaytechCheckoutButton, { type PaytechResumeNotice } from '@/components/payment/PaytechCheckoutButton'
import CheckoutConsents from '@/components/payment/CheckoutConsents'
import type { CheckoutConsent } from '@/lib/legal/checkout-consent'

/**
 * Paying for a pack — XP-LAUNCH-FINAL-08 (CGV v0.3 art. 3, decision D8).
 *
 * If the pack contains a course the learner already owns, they are told BEFORE
 * paying that it is neither refunded nor replaced and keeps its own access dates,
 * and they must tick a box saying they read it. The payment button stays locked
 * until then, and sends the ids of exactly the courses shown here; the server
 * re-derives what the learner owns and refuses if the two differ.
 *
 * Then the three boxes of CGV art. 4 (XP-LAUNCH-FINAL-11): the button also stays
 * locked until all three are ticked.
 *
 * The checkboxes live here, not in the payment button, which renders no input at all
 * (it collects no payment data; safeguard 7).
 */
export default function PackCheckoutPanel({
  packCode,
  ownedCourses,
  resume = null,
}: {
  packCode: string
  ownedCourses: { id: string; title: string }[]
  resume?: PaytechResumeNotice | null
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [consent, setConsent] = useState<CheckoutConsent | null>(null)
  const mustAcknowledge = ownedCourses.length > 0

  return (
    <div className="flex flex-col gap-4">
      {mustAcknowledge && (
        <div role="note" className="rounded-cx border border-warning/40 bg-warning/10 p-4 text-sm text-dark">
          <p className="flex items-start gap-2 font-bold">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-warning shrink-0" aria-hidden="true" />
            Vous possédez déjà {ownedCourses.length === 1 ? 'une formation' : `${ownedCourses.length} formations`} de ce pack
          </p>
          <ul className="mt-2 ml-6 list-disc text-cx-gray">
            {ownedCourses.map(c => <li key={c.id}>{c.title}</li>)}
          </ul>
          <p className="mt-2 text-cx-gray">
            {ownedCourses.length === 1 ? 'Elle n’est' : 'Elles ne sont'} ni remboursée{ownedCourses.length === 1 ? '' : 's'} ni
            remplacée{ownedCourses.length === 1 ? '' : 's'} : {ownedCourses.length === 1 ? 'elle conserve' : 'elles conservent'} votre
            accès actuel, sans le prolonger. Les autres formations du pack s’ouvrent ensemble pour six mois. Vous pouvez aussi
            acheter séparément les seules formations qui vous manquent.
          </p>
          <label className="mt-3 flex items-start gap-2 font-medium">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-secondary"
            />
            <span>J’ai compris et je souhaite tout de même acheter ce pack.</span>
          </label>
        </div>
      )}
      <CheckoutConsents scope="pack" onChange={setConsent} />
      <PaytechCheckoutButton
        packCode={packCode}
        acknowledgedCourseIds={mustAcknowledge && acknowledged ? ownedCourses.map(c => c.id) : []}
        consent={consent}
        blocked={(mustAcknowledge && !acknowledged) || consent === null}
        resume={resume}
      />
    </div>
  )
}
