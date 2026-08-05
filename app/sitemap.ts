import type { MetadataRoute } from 'next'
import { publicUrl } from '@/lib/brand'

/**
 * sitemap.xml (XPA-1).
 *
 * Lists the PUBLIC marketing surface only, on the canonical academy domain.
 *
 * Deliberately static: course detail pages are not enumerated here. Doing so
 * would require a database read at build time, and the catalogue is being
 * restructured in XPA-2 (stable course codes, catalogues, paths). Adding
 * slug-based course URLs now would bake in URLs that XPA-2/XPA-3 may reorganise.
 * Course URLs are added once the catalogue model is settled.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  const routes: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
    { path: '/',              priority: 1.0, changeFrequency: 'weekly'  },
    { path: '/courses',       priority: 0.9, changeFrequency: 'weekly'  },
    { path: '/about',         priority: 0.7, changeFrequency: 'monthly' },
    { path: '/about/founder', priority: 0.5, changeFrequency: 'yearly'  },
    { path: '/contact',       priority: 0.6, changeFrequency: 'monthly' },
    { path: '/privacy',       priority: 0.3, changeFrequency: 'yearly'  },
    { path: '/terms',         priority: 0.3, changeFrequency: 'yearly'  },
  ]

  return routes.map(r => ({
    url:             publicUrl(r.path),
    lastModified:    now,
    changeFrequency: r.changeFrequency,
    priority:        r.priority,
  }))
}
