import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Supabase client for use in Server Components, Route Handlers, and Server Actions.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // ── XPA-8 W3: authorization must never come from the Data Cache ──────
      //
      // Next 14 caches GET fetches, and supabase-js reads are GETs. This client
      // is what `resolveCourseAccessById` uses to ask my_course_access whether
      // a learner may open a course. A cached answer means a revoked or expired
      // entitlement keeps working until the entry is evicted — the exact
      // failure the per-request re-authorization design exists to prevent.
      //
      // See lib/supabase/admin.ts for the production evidence that this cache
      // is real and does apply to supabase-js.
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: 'no-store' }),
      },
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])
          } catch {
            // Server Component — cookies can't be set here; handled by middleware
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set(name, '', { ...options, maxAge: 0 })
          } catch {
            // Server Component — cookies can't be deleted here; handled by middleware
          }
        },
      },
    }
  )
}
