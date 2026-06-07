import Link from 'next/link'
import { Lock, ArrowLeft, Mail } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accès restreint — XP Client Academy',
  // Prevent search engines from indexing this page
  robots: { index: false, follow: false },
}

export default function AccessRestrictedPage() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center bg-light">
      <div className="cx-container max-w-lg text-center py-20">

        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
          <Lock className="w-7 h-7 text-primary" />
        </div>

        {/* Heading */}
        <h1 className="text-2xl md:text-3xl font-extrabold text-dark mb-3">
          Acc&egrave;s temporairement restreint
        </h1>

        {/* Message */}
        <p className="text-cx-gray leading-relaxed mb-2">
          La phase pilote est maintenant termin&eacute;e.
        </p>
        <p className="text-cx-gray leading-relaxed mb-8">
          L&apos;acc&egrave;s &agrave; XP Client Academy est actuellement limit&eacute; pendant que nous
          pr&eacute;parons le lancement officiel. Revenez bient&ocirc;t&nbsp;!
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary/90 transition-all hover:-translate-y-0.5"
          >
            <ArrowLeft className="w-4 h-4" /> Retour &agrave; l&apos;accueil
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 border-2 border-primary text-primary text-sm font-semibold rounded-xl hover:bg-primary/5 transition-all"
          >
            <Mail className="w-4 h-4" /> Contact
          </Link>
        </div>

      </div>
    </div>
  )
}
