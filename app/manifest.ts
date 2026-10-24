import type { MetadataRoute } from 'next'
import { BRAND_NAME } from '@/lib/brand'

/**
 * Web app manifest (XPA-1).
 *
 * The icon is the official XP symbol, cropped from the logo supplied with the
 * charte graphique and padded to a square (XP-BRAND-01). It is now transparent,
 * which closes the opacity half of D-Q6.
 *
 * `purpose` stays "any" rather than "maskable": the symbol is 1.6:1, so padded
 * into a square its artwork spans ~84% of the width — wider than the maskable
 * safe zone, where a platform may crop to a circle of 80% diameter. Declaring
 * maskable would invite exactly the clipping the brief forbids.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             BRAND_NAME,
    short_name:       'XP Client',
    description:      'Formations pratiques en expérience client, service client et relation client adaptées au contexte africain.',
    start_url:        '/',
    display:          'standalone',
    background_color: '#FFFFFF',
    theme_color:      '#1B2A4A',
    lang:             'fr',
    icons: [
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  }
}
