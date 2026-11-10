import type { Metadata } from 'next'
import LegalDocumentView from '@/components/legal/LegalDocumentView'
import { PRIVACY } from '@/lib/legal/documents'

export const metadata: Metadata = {
  title: 'Politique de confidentialité',
  description: 'Politique de confidentialité de XP Client Academy, version 1.0.',
}

/** Privacy policy, version 1.0 (XP-LAUNCH-FINAL-11). Registration records acceptance of this version. */
export default function PrivacyPage() {
  return <LegalDocumentView doc={PRIVACY} href="/privacy" />
}
