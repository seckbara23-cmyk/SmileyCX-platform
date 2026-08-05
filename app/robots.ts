import type { MetadataRoute } from 'next'
import { PUBLIC_SITE_URL, publicUrl } from '@/lib/brand'

/**
 * robots.txt (XPA-1).
 *
 * The public academy is indexable. Private surfaces are explicitly disallowed:
 * the administration portal, learner-only areas, auth flows and API routes.
 *
 * This is a hint to well-behaved crawlers, NOT an access control. Every path
 * below is independently protected server-side (middleware host boundary +
 * requirePlatformAdmin on every admin page and action). Nothing here weakens
 * or replaces that.
 *
 * The sitemap points at the canonical academy domain — never the Vercel
 * deployment host, which must not be indexed as the brand.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/api/',
          '/dashboard',
          '/learn/',
          '/checkout',
          '/certificate/',
          '/app/',
          '/login',
          '/signup',
          '/forgot-password',
          '/reset-password',
          '/auth/',
          '/access-restricted',
        ],
      },
    ],
    // publicUrl(), not string concatenation: a configured base with a trailing
    // slash would otherwise emit `…com//sitemap.xml`.
    sitemap: publicUrl('/sitemap.xml'),
    host: PUBLIC_SITE_URL,
  }
}
