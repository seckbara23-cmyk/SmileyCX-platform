'use client'
import { useState } from 'react'
import PaytechCheckoutButton, { type PaytechResumeNotice } from '@/components/payment/PaytechCheckoutButton'
import CheckoutConsents from '@/components/payment/CheckoutConsents'
import type { CheckoutConsent } from '@/lib/legal/checkout-consent'

/**
 * Paying for one course — XP-LAUNCH-FINAL-11.
 *
 * The three boxes of CGV art. 4 come first; the payment button stays locked
 * until all three are ticked. The boxes live here, not in the payment button,
 * which renders no input at all (it collects no payment data; safeguard 7).
 */
export default function CourseCheckoutPanel({
  courseId,
  resume = null,
}: {
  courseId: string
  resume?: PaytechResumeNotice | null
}) {
  const [consent, setConsent] = useState<CheckoutConsent | null>(null)
  return (
    <div className="flex flex-col gap-5">
      <CheckoutConsents scope="course" onChange={setConsent} />
      <PaytechCheckoutButton courseId={courseId} consent={consent} blocked={consent === null} resume={resume} />
    </div>
  )
}
