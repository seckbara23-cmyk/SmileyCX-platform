import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'À propos — SmileyCX Academy',
}

export default function AboutPage() {
  return (
    <section className="cx-section">
      <div className="cx-container max-w-4xl text-dark">
        <div className="cx-card p-8">
          <h1 className="text-3xl font-extrabold mb-4">À propos de SmileyCX Academy</h1>
          <p className="text-base text-cx-gray leading-relaxed mb-4">
            SmileyCX Academy forme les leaders et les équipes à offrir une expérience client exceptionnelle.
            Notre plateforme simplifie l&apos;accès aux formations certifiantes, aux parcours pratiques et aux outils de suivi.
          </p>
          <p className="text-base text-cx-gray leading-relaxed mb-4">
            Nous croyons que l&apos;expérience client est le moteur de la croissance durable. C&apos;est pourquoi nous proposons
            des contenus clairs, une pédagogie adaptée et un accompagnement orienté résultats.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 mt-8">
            {[
              { label: "Cours 100% en ligne", description: "Formations accessibles à tout moment, depuis n’importe quel appareil." },
              { label: "Certificat inclus", description: "Obtenez une reconnaissance officielle à la fin de votre parcours." },
              { label: "Support dédié", description: "Un accompagnement utilisateur pour vous aider à avancer rapidement." },
              { label: "Mises à jour continues", description: "Contenu enrichi régulièrement par des experts CX." },
            ].map(card => (
              <div key={card.label} className="rounded-cx border border-black/[0.06] p-5 bg-white shadow-sm">
                <h2 className="text-lg font-semibold text-dark mb-2">{card.label}</h2>
                <p className="text-sm text-cx-gray">{card.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
