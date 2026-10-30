import { redirect } from 'next/navigation'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Paiement' }

/**
 * `/checkout/confirm` — RETIRED by XP-PAYTECH-04.
 *
 * This page was the end of the legacy flow: it read a payment by the id in its
 * query string and showed "Paiement en attente" for a row nothing would ever
 * settle. The status of an order now lives on `/payment/success`, which reads
 * only the SIGNED-IN learner's own payments and decides nothing.
 *
 * Kept as a redirect so old links and bookmarks land somewhere honest. It
 * reads nothing and forwards no query parameter.
 */
export default function ConfirmPage() {
  redirect('/payment/success')
}
