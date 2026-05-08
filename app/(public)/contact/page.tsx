import type { Metadata } from 'next'
import ContactForm from './ContactForm'
import { Mail, Phone, MapPin } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Contactez SmileyCX Academy pour toute question sur nos formations en expérience client.',
}

interface Props { searchParams: Promise<{ service?: string }> }

export default async function ContactPage({ searchParams }: Props) {
  const { service } = await searchParams

  return (
    <div className="cx-section">
      <div className="cx-container max-w-4xl">

        {/* Header */}
        <div className="cx-section-title mb-10">
          <h1>Contactez-nous</h1>
          <p>
            Une question sur une formation ? Une demande d&apos;atelier en présentiel ?
            Remplissez le formulaire — nous vous répondons sous 24h.
          </p>
        </div>

        <div className="grid md:grid-cols-[1fr_280px] gap-10">

          {/* Form */}
          <div className="cx-card p-7">
            <ContactForm defaultService={service} />
          </div>

          {/* Sidebar */}
          <div className="flex flex-col gap-5">
            <div className="cx-card p-6">
              <h2 className="text-sm font-bold text-dark uppercase tracking-wider mb-4">Nos coordonnées</h2>
              <div className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Email</p>
                    <a href="mailto:bonjour@smileycx.com" className="text-sm text-dark hover:text-primary transition-colors">
                      bonjour@smileycx.com
                    </a>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Phone className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Téléphone</p>
                    <p className="text-sm text-dark">+(221) 77 576 0306</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Localisation</p>
                    <p className="text-sm text-dark">Dakar, Sénégal</p>
                    <p className="text-xs text-cx-gray">Formations disponibles à distance</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="cx-card p-6 bg-primary/5 border-primary/10">
              <h3 className="text-sm font-bold text-dark mb-2">Formation en présentiel</h3>
              <p className="text-xs text-cx-gray leading-relaxed">
                Ateliers sur mesure pour équipes de 5 à 30 personnes à Dakar et en région.
                Précisez &quot;Formation en présentiel&quot; dans le champ Service.
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
