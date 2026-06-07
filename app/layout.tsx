import type { Metadata } from 'next'
import './globals.css'

const SITE_TITLE       = 'XP Client Academy — Formations en expérience client au Sénégal'
const SITE_DESCRIPTION = 'Formations pratiques en expérience client, service client et relation client adaptées au contexte africain.'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://academy.smileycx.com'),
  title: {
    template: '%s | XP Client Academy',
    default:  SITE_TITLE,
  },
  description: SITE_DESCRIPTION,
  keywords: ['expérience client', 'formation CX', 'service client', 'relation client', 'Sénégal', 'Afrique', 'XP Client'],
  authors: [{ name: 'XP Client Consulting' }],
  openGraph: {
    type:        'website',
    locale:      'fr_FR',
    siteName:    'XP Client Academy',
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card:        'summary_large_image',
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
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
