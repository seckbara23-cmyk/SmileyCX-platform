import type { Metadata } from 'next'
import PathIndex from '@/components/courses/PathIndex'
import { redirect } from 'next/navigation'
import { PUBLIC_PATHWAYS_VISIBLE } from '@/lib/catalogue/visibility'

export const metadata: Metadata = {
  title: 'Parcours sectoriels',
  description:
    "Des formations en expérience client packagées par secteur d'activité : télécoms, banque et assurance, logistique, commerce, santé et administration publique.",
  alternates: { canonical: '/secteurs' },
}

export default function SecteursPage() {
  // XP-LAUNCH-FINAL-08 (requirements V4 §13): configured, kept, hidden at launch.
  if (!PUBLIC_PATHWAYS_VISIBLE) redirect('/courses')
  return (
    <PathIndex
      kind="sector"
      model="Où je travaille"
      title="Parcours sectoriels"
      lead="Les enjeux de l'expérience client ne sont pas les mêmes dans une banque, un hôpital ou une plateforme logistique. Chaque parcours sectoriel réunit les formations les plus pertinentes pour votre secteur."
      emptyMessage="Les parcours sectoriels seront bientôt disponibles."
    />
  )
}
