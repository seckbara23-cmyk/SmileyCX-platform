import type { Metadata } from 'next'
import PathDetail from '@/components/courses/PathDetail'
import { getPublicPath, getPublicPathCourses } from '@/lib/queries/catalogue'

interface Props { params: Promise<{ code: string }> }

/**
 * Metadata mirrors the page's own visibility rules: a path that is not publicly
 * renderable gets generic metadata and is marked noindex, so an unbuilt or
 * wrong-axis path is never advertised to a crawler.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params
  const path = await getPublicPath(code)

  if (!path || path.kind !== 'professional') {
    return { title: 'Parcours métier', robots: { index: false, follow: false } }
  }

  return {
    title: path.title,
    description: path.objective ?? undefined,
    alternates: { canonical: `/parcours/${path.code.toLowerCase()}` },
    openGraph: {
      title: path.title,
      description: path.objective ?? undefined,
      url: `/parcours/${path.code.toLowerCase()}`,
    },
  }
}

export default async function Page({ params }: Props) {
  const { code } = await params
  return <PathDetail code={code} kind="professional" />
}
