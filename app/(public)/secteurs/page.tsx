import type { Metadata } from 'next'
import PathIndex from '@/components/courses/PathIndex'

export const metadata: Metadata = {
  title: 'Parcours sectoriels',
  description:
    "Des formations en expérience client packagées par secteur d'activité : télécoms, banque et assurance, logistique, commerce, santé et administration publique.",
  alternates: { canonical: '/secteurs' },
}

export default function SecteursPage() {
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
