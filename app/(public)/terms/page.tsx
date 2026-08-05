import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/lib/brand'
import { TERMS_VERSION, LEGAL_TEXT_PENDING_REVIEW } from '@/lib/legal/versions'

export const metadata: Metadata = {
  title: "Conditions générales d'utilisation",
  description: "Conditions générales d'utilisation de XP Client Academy.",
}

/**
 * XPA-6A: the page now DECLARES its version, because registration records
 * acceptance against that version. The body text is unchanged — XPA-6A does not
 * write legal wording, and the notice below says so plainly rather than letting
 * a summary pass for counsel-approved terms.
 */
export default function TermsPage() {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <div className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-2">Conditions Générales d’Utilisation</h1>
          <p className="text-xs text-cx-gray font-mono mb-4">Version {TERMS_VERSION}</p>

          {LEGAL_TEXT_PENDING_REVIEW && (
            <div className="mb-5 px-4 py-3 rounded-cx bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <strong>Document en cours de validation juridique.</strong> Le texte ci-dessous est un
              résumé des règles d’utilisation. Il sera remplacé par la version définitive validée
              par un conseil juridique.
            </div>
          )}

          <p className="text-base text-cx-gray leading-relaxed mb-4">
            En utilisant XP Client Academy, vous acceptez nos conditions générales d’utilisation. Celles-ci définissent
            les règles d’accès, de cotisation et de support à nos formations.
          </p>
          <div className="space-y-4 text-sm text-cx-gray">
            <div>
              <h2 className="font-semibold text-dark mb-2">Accès et utilisation</h2>
              <p>
                Vous acceptez de respecter les règles d’usage et de ne pas partager vos identifiants. Les contenus sont
                protégés par droits d’auteur.
              </p>
            </div>
            <div>
              <h2 className="font-semibold text-dark mb-2">Paiement</h2>
              <p>
                Le paiement confirme votre accès aux formations. Les frais sont indiqués lors de l’achat, et tout paiement
                est traité avec sécurité.
              </p>
            </div>
            <div>
              <h2 className="font-semibold text-dark mb-2">Support</h2>
              <p>
                Pour toute question, contactez-nous à {CONTACT_EMAIL}. Nous répondons rapidement aux demandes.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
