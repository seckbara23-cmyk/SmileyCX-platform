import type { Metadata } from 'next'
import LegalDocumentView from '@/components/legal/LegalDocumentView'
import { CGU } from '@/lib/legal/documents'

export const metadata: Metadata = {
  title: "Conditions générales d'utilisation",
  description: "Conditions générales d'utilisation de XP Client Academy, version 1.0.",
}

/** CGU, version 1.0 (XP-LAUNCH-FINAL-11). Registration records acceptance of this version. */
export default function TermsPage() {
  return <LegalDocumentView doc={CGU} href="/terms" />
}
