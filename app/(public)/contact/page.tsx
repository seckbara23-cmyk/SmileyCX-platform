import type { Metadata } from 'next'
import ContactForm from './ContactForm'
import { Mail, Phone, MapPin } from 'lucide-react'
import { CONTACT_PHONE, CONTACT_PHONE_HREF, CONTACT_LOCATION } from '@/lib/brand'
import ContactEmailLink from '@/components/site/ContactEmailLink'

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Contactez XP Client Academy pour toute question sur nos formations en expérience client.',
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
            Une question sur une formation ? Une demande particulière ?
            Remplissez le formulaire — nous vous répondons sous 24h.
          </p>
        </div>

        {/* Sidebar track is 320px, not 280px: the official email needs 227px at
            text-sm, and 280px left only 204px after the card padding and icon
            row. The page container (max-w-4xl) is unchanged. */}
        <div className="grid md:grid-cols-[1fr_320px] gap-10">

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
                  <div className="min-w-0">
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Email</p>
                    <ContactEmailLink className="text-sm text-dark hover:text-primary transition-colors break-words" />
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Phone className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Téléphone</p>
                    <a href={CONTACT_PHONE_HREF} className="text-sm text-dark hover:text-primary transition-colors">
                      {CONTACT_PHONE}
                    </a>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs text-cx-gray font-semibold mb-0.5">Localisation</p>
                    <p className="text-sm text-dark">{CONTACT_LOCATION}</p>
                    <p className="text-xs text-cx-gray">Formations disponibles à distance</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="cx-card p-6 bg-primary/5 border-primary/10">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-bold text-dark">Formation en présentiel</h3>
                <span className="inline-flex items-center rounded-full border border-soon-fg/20 bg-soon-bg px-2 py-0.5 text-[11px] font-semibold text-soon-fg">
                  Bientôt disponible
                </span>
              </div>
              <p className="text-xs text-cx-gray leading-relaxed">
                Les formations en présentiel seront proposées prochainement.
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
