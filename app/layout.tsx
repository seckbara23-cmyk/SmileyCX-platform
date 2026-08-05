import type { Metadata } from 'next'
import { BRAND_NAME, BRAND_LEGAL_NAME, PUBLIC_SITE_URL } from '@/lib/brand'
import './globals.css'

const SITE_TITLE       = 'XP Client Academy — Formations en expérience client au Sénégal'
const SITE_DESCRIPTION = 'Formations pratiques en expérience client, service client et relation client adaptées au contexte africain.'

// XPA-1: metadataBase previously defaulted to a legacy domain the platform does
// not serve, so every relative OG/canonical URL Next.js resolved against it was
// wrong. It now resolves against the canonical academy domain.
export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: {
    template: `%s | ${BRAND_NAME}`,
    default:  SITE_TITLE,
  },
  description: SITE_DESCRIPTION,
  keywords: ['expérience client', 'formation CX', 'service client', 'relation client', 'Sénégal', 'Afrique', 'XP Client'],
  authors: [{ name: BRAND_LEGAL_NAME }],
  alternates: { canonical: '/' },
  openGraph: {
    type:        'website',
    locale:      'fr_FR',
    siteName:    BRAND_NAME,
    url:         PUBLIC_SITE_URL,
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
    // Uses the existing tracked XP mark. A purpose-built 1200×630 master is
    // pending the logo decision (register Q-A) — no artwork is invented here.
    images: [{ url: '/icon.png', width: 245, height: 246, alt: BRAND_NAME }],
  },
  twitter: {
    card:        'summary',
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
    images:      ['/icon.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
