import type { MetadataRoute } from 'next'
import { BRAND_NAME } from '@/lib/brand'

/**
 * Web app manifest (XPA-1).
 *
 * Reuses the existing tracked XP mark (`app/icon.png`) rather than generating
 * new artwork. Note the source PNG is opaque (measured: zero transparent
 * pixels — see decision register D-Q6), so `purpose` is "any", not "maskable":
 * declaring maskable on an opaque square would let platforms crop the mark.
 * When a transparent/vector master is supplied (Q-A), add the maskable variant.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             BRAND_NAME,
    short_name:       'XP Client',
    description:      'Formations pratiques en expérience client, service client et relation client adaptées au contexte africain.',
    start_url:        '/',
    display:          'standalone',
    background_color: '#ffffff',
    theme_color:      '#ffffff',
    lang:             'fr',
    icons: [
      { src: '/icon.png', sizes: '245x246', type: 'image/png', purpose: 'any' },
    ],
  }
}
