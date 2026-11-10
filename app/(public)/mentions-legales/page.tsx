import type { Metadata } from 'next'
import LegalDocumentView from '@/components/legal/LegalDocumentView'
import { LEGAL_NOTICE } from '@/lib/legal/documents'

export const metadata: Metadata = {
  title: 'Mentions légales',
  description: 'Mentions légales de XP Client Academy.',
}

/** Legal notice, version 1.0 (XP-LAUNCH-FINAL-11). */
export default function LegalNoticePage() {
  return <LegalDocumentView doc={LEGAL_NOTICE} href="/mentions-legales" />
}
