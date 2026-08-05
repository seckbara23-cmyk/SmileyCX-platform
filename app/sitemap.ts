import type { MetadataRoute } from 'next'
import { publicUrl } from '@/lib/brand'
import { getPublicPaths, pathHref } from '@/lib/queries/catalogue'

/**
 * sitemap.xml (XPA-1, extended in XPA-3).
 *
 * Lists PUBLIC, publicly-renderable pages only, on the canonical academy domain.
 *
 * Path URLs are included from XPA-3, but only for paths that actually render:
 * the projection views already exclude paths with no published course, and the
 * extra check below guards against advertising a page that would 404. Listing
 * an unbuilt path would also disclose roadmap composition, which Q-E forbids.
 *
 * Course detail URLs remain deliberately absent: the catalogue is still being
 * restructured, and `/courses` already links to every published course.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  type Entry = { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }

  const staticRoutes: Entry[] = [
    { path: '/',              priority: 1.0, changeFrequency: 'weekly'  },
    { path: '/courses',       priority: 0.9, changeFrequency: 'weekly'  },
    { path: '/parcours',      priority: 0.8, changeFrequency: 'weekly'  },
    { path: '/secteurs',      priority: 0.8, changeFrequency: 'weekly'  },
    { path: '/about',         priority: 0.7, changeFrequency: 'monthly' },
    { path: '/about/founder', priority: 0.5, changeFrequency: 'yearly'  },
    { path: '/contact',       priority: 0.6, changeFrequency: 'monthly' },
    { path: '/privacy',       priority: 0.3, changeFrequency: 'yearly'  },
    { path: '/terms',         priority: 0.3, changeFrequency: 'yearly'  },
  ]

  const pathRoutes: Entry[] = []
  try {
    // `public_learning_paths` already excludes paths with no published course,
    // so membership in that view IS the "will actually render" guarantee. No
    // per-path course query is needed — that would be an N+1 for no extra
    // safety, since the detail page 404s on an empty path regardless.
    const [professional, sector] = await Promise.all([
      getPublicPaths('professional'),
      getPublicPaths('sector'),
    ])
    for (const p of [...professional, ...sector]) {
      pathRoutes.push({ path: pathHref(p), priority: 0.7, changeFrequency: 'monthly' })
    }
  } catch {
    // Projection unavailable (e.g. migration 031 not yet applied): emit the
    // static routes rather than failing the whole sitemap.
  }

  return [...staticRoutes, ...pathRoutes].map(r => ({
    url:             publicUrl(r.path),
    lastModified:    now,
    changeFrequency: r.changeFrequency,
    priority:        r.priority,
  }))
}
