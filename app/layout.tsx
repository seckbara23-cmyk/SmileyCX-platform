import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: {
    template: '%s | SmileyCX Academy',
    default:  'SmileyCX Academy — Formations en Expérience Client',
  },
  description:
    'Développez vos compétences en expérience client avec SmileyCX Academy. Formations certifiantes en ligne pour individus et entreprises.',
  keywords: ['expérience client', 'formation CX', 'customer experience', 'SmileyCX'],
  authors: [{ name: 'SmileyCX Consulting' }],
  openGraph: {
    type:    'website',
    locale:  'fr_FR',
    siteName: 'SmileyCX Academy',
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
