/**
 * HOTFIX-2 regression tests for the course detail page.
 *
 * CONTEXT: the reported "/courses/<slug> 500" was NOT a defect in this page.
 * Runtime logs showed "Failed to prepare server" — the SEC-2 instrumentation
 * gate threw before the route ever ran, so every route 500'd (a nonexistent
 * slug returned 500 instead of 404, which is the giveaway). The page itself
 * renders correctly against real production data.
 *
 * These tests exist so that stays true. A React Server Component is just an
 * async function returning an element tree, so it can be invoked directly with
 * the Supabase client mocked — no rendering required, and no refactor of the
 * page to make it testable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const notFoundError = new Error('NEXT_NOT_FOUND')

vi.mock('next/navigation', () => ({
  notFound: () => { throw notFoundError },
}))

/** Rows each table returns for a given test. */
interface Fixture {
  course?: Record<string, unknown> | null
  modules?: unknown[] | null
  user?: { id: string } | null
  enrollment?: unknown | null
  error?: { code: string; message: string } | null
}

let fixture: Fixture = {}

/**
 * Minimal chainable stub matching the query shapes this page builds:
 *   from(t).select(..).eq(..).eq(..).maybeSingle()
 *   from(t).select(..).eq(..).order(..)
 *   from(t).select(..).eq(..).eq(..).single()
 *   from(t).select(..).eq(..).eq(..).in(..)
 */
function makeClient() {
  const build = (table: string) => {
    const rowsFor = () => {
      if (table === 'courses')     return fixture.course ?? null
      if (table === 'modules')     return fixture.modules ?? []
      if (table === 'enrollments') return fixture.enrollment ?? null
      return []
    }
    const result = () => ({ data: rowsFor(), error: fixture.error ?? null })

    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
      chain[m] = () => chain
    }
    chain.maybeSingle = async () => result()
    chain.single      = async () => result()
    // Awaiting the chain directly (the .in(...) progress queries) resolves too.
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
    return chain
  }

  return {
    from: (table: string) => build(table),
    auth: { getUser: async () => ({ data: { user: fixture.user ?? null } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeClient(),
}))

const PUBLISHED_COURSE = {
  id: 'course-1',
  slug: 'les-fondamentaux-de-l-experience-client',
  title: "Les fondamentaux de l'experience client",
  description: 'Une description',
  level: 'beginner',
  price: 9000,
  currency: 'XOF',
  duration_hours: 2,
  cover_url: 'https://eqoqcxkdcxeosjqaafhs.supabase.co/storage/v1/object/public/course-media/cover/x.png',
  intro_video_url: null,
}

const MODULE_WITH_LESSONS = {
  id: 'mod-1',
  slug: 'comprendre-cx',
  title: 'Comprendre la CX',
  order_index: 1,
  lessons: [
    { id: 'l1', slug: 'lecon-1', title: 'Leçon 1', order_index: 1, duration_minutes: 10, is_preview: true },
    { id: 'l2', slug: 'lecon-2', title: 'Leçon 2', order_index: 2, duration_minutes: 12, is_preview: false },
  ],
}

async function renderPage(slug: string) {
  const mod = await import('@/app/(public)/courses/[slug]/page')
  return (mod.default as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>)({
    params: Promise.resolve({ slug }),
  })
}

describe('HOTFIX-2 — course detail page', () => {
  beforeEach(() => {
    vi.resetModules()
    fixture = {}
  })

  it('renders an existing published course', async () => {
    fixture = { course: PUBLISHED_COURSE, modules: [MODULE_WITH_LESSONS] }
    const el = await renderPage(PUBLISHED_COURSE.slug)
    expect(el).toBeTruthy()
  })

  it('returns 404 for a slug that does not exist', async () => {
    fixture = { course: null }
    await expect(renderPage('does-not-exist-xyz')).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('an unpublished course is indistinguishable from a missing one (404, not 500)', async () => {
    // The query filters on is_published, so an unpublished course returns no
    // row. It must 404 — never leak existence, never throw.
    fixture = { course: null }
    await expect(renderPage('unpublished-course')).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('a course with zero modules does not crash', async () => {
    fixture = { course: PUBLISHED_COURSE, modules: [] }
    await expect(renderPage(PUBLISHED_COURSE.slug)).resolves.toBeTruthy()
  })

  it('a module whose lessons relation is missing does not crash', async () => {
    fixture = {
      course: PUBLISHED_COURSE,
      modules: [{ id: 'mod-1', slug: 'm', title: 'M', order_index: 1 }], // no `lessons` key
    }
    await expect(renderPage(PUBLISHED_COURSE.slug)).resolves.toBeTruthy()
  })

  it('a module with an explicitly null lessons relation does not crash', async () => {
    fixture = {
      course: PUBLISHED_COURSE,
      modules: [{ id: 'mod-1', slug: 'm', title: 'M', order_index: 1, lessons: null }],
    }
    await expect(renderPage(PUBLISHED_COURSE.slug)).resolves.toBeTruthy()
  })

  it('an RLS denial on modules degrades instead of throwing', async () => {
    // supabase-js returns { data: null, error } rather than rejecting; the page
    // must fall back to an empty module list, not dereference null.
    fixture = {
      course: PUBLISHED_COURSE,
      modules: null,
      error: { code: '42501', message: 'permission denied for table modules' },
    }
    await expect(renderPage(PUBLISHED_COURSE.slug)).resolves.toBeTruthy()
  })

  it('an anonymous visitor (no session) renders without an enrollment lookup crash', async () => {
    fixture = { course: PUBLISHED_COURSE, modules: [MODULE_WITH_LESSONS], user: null }
    await expect(renderPage(PUBLISHED_COURSE.slug)).resolves.toBeTruthy()
  })

  it('generateMetadata does not throw when the course is missing', async () => {
    fixture = { course: null }
    const mod = await import('@/app/(public)/courses/[slug]/page')
    const meta = await (mod.generateMetadata as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>)({
      params: Promise.resolve({ slug: 'does-not-exist-xyz' }),
    })
    expect(meta).toBeTruthy()
  })
})
