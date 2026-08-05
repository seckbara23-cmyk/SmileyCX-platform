import type { Metadata } from 'next'
import PathIndex from '@/components/courses/PathIndex'

export const metadata: Metadata = {
  title: 'Parcours métier',
  description:
    "Choisissez le parcours de formation adapté à votre métier : conseiller, manager, commercial, qualité, RH, digital, produit ou direction. Formations en expérience client adaptées au contexte africain.",
  alternates: { canonical: '/parcours' },
}

export default function ParcoursPage() {
  return (
    <PathIndex
      kind="professional"
      model="Qui je suis"
      title="Parcours métier"
      lead="Chaque métier rencontre le client à sa manière. Choisissez le parcours correspondant à votre rôle : nous vous recommandons les formations les plus utiles pour vous, dans l'ordre conseillé."
      emptyMessage="Les parcours métier seront bientôt disponibles."
    />
  )
}
