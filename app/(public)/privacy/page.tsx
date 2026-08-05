import type { Metadata } from 'next'
import { PRIVACY_VERSION, LEGAL_TEXT_PENDING_REVIEW } from '@/lib/legal/versions'

export const metadata: Metadata = {
  title: 'Politique de confidentialité',
  description: 'Politique de confidentialité de XP Client Academy — comment nous traitons vos données personnelles.',
}

/**
 * XPA-6A: version declared so acceptance can be recorded against it. Body text
 * unchanged; the pending-review notice is explicit rather than implied.
 */
export default function PrivacyPage() {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <div className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-2">Politique de confidentialité</h1>
          <p className="text-xs text-cx-gray font-mono mb-4">Version {PRIVACY_VERSION}</p>

          {LEGAL_TEXT_PENDING_REVIEW && (
            <div className="mb-5 px-4 py-3 rounded-cx bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <strong>Document en cours de validation juridique.</strong> Le texte ci-dessous décrit
              nos pratiques actuelles. Il sera remplacé par la version définitive validée par un
              conseil juridique.
            </div>
          )}

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
