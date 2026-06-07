import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Politique de confidentialité',
  description: 'Politique de confidentialité de XP Client Academy — comment nous traitons vos données personnelles.',
}

export default function PrivacyPage() {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <div className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-4">Politique de confidentialité</h1>
          <p className="text-base text-cx-gray leading-relaxed mb-4">
            XP Client Academy collecte et traite uniquement les données nécessaires à votre inscription,
            à votre facturation et à l’accès aux formations. Nous ne partageons pas vos informations personnelles
            avec des tiers sans votre consentement.
          </p>
          <ul className="list-disc pl-5 space-y-3 text-cx-gray">
            <li>Utilisation des données pour la gestion des comptes et des paiements.</li>
            <li>Protection des informations personnelles par des mesures de sécurité standards.</li>
            <li>Possibilité de demander la suppression ou la correction de vos données sur simple demande.</li>
          </ul>
        </div>
      </div>
    </section>
  )
}
