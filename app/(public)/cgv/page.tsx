import type { Metadata } from 'next'
import LegalDocumentView from '@/components/legal/LegalDocumentView'
import { CGV } from '@/lib/legal/documents'

export const metadata: Metadata = {
  title: 'Conditions générales de vente',
  description: 'Conditions générales de vente de XP Client Academy, version 1.0.',
}

/** CGV, version 1.0 (XP-LAUNCH-FINAL-11). Every order records acceptance of this version. */
export default function SalesTermsPage() {
  return <LegalDocumentView doc={CGV} href="/cgv" />
}
