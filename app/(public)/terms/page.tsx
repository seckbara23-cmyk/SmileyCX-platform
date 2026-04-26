import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'CGU — SmileyCX Academy',
}

export default function TermsPage() {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <div className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-4">Conditions Générales d’Utilisation</h1>
          <p className="text-base text-cx-gray leading-relaxed mb-4">
            En utilisant SmileyCX Academy, vous acceptez nos conditions générales d’utilisation. Celles-ci définissent
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
                Pour toute question, contactez-nous à bonjour@smileycx.com. Nous répondons rapidement aux demandes.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
