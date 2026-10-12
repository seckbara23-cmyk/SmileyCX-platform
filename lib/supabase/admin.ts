import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Supabase client that uses the service role key.
 * ONLY use this in Server Actions and Server Components — never on the client.
 * Requires SUPABASE_SERVICE_ROLE_KEY to be set in .env.local.
 *
 * ── PAY-2D-0: the comment above is now MECHANICALLY ENFORCED ───────────────
 *
 * `import 'server-only'` makes importing this module from a client component a
 * BUILD error rather than a code-review question. It matters more here than
 * anywhere else in the repository: this is the one client that holds
 * SUPABASE_SERVICE_ROLE_KEY, a credential with BYPASSRLS and — since migration
 * 062 — EXECUTE on public.complete_payment(), the sole authority that can grant
 * a paid entitlement. A single careless import from a 'use client' file would
 * put that key in a browser bundle.
 *
 * `check-bundle-secrets.mjs` already scans the built output for the variable
 * name, but that is a post-build net. This fails at compile time instead, which
 * is the earlier and cheaper place to fail.
 *
 * This does NOT restrict the legitimate callers. All 62 of them are server-side
 * — Server Components, route handlers, and 'use server' actions. A 'use server'
 * module is itself a server boundary: a client component importing one receives
 * an RPC reference, never the module's code, so the admin client never reaches
 * a client bundle through it. The same pattern is already proven in production
 * by lib/learn/assessment.ts and lib/learn/completion.ts, both of which are
 * 'server-only' and both of which are reached through Server Actions that
 * client components import.
 */
export function createAdminClient() {
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key || key === 'YOUR_SERVICE_ROLE_KEY') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. ' +
      'Add it to .env.local from Supabase → Settings → API → service_role key.'
    )
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
    // ── XPA-8 W3: never serve an authoritative read from Next's Data Cache ──
    //
    // Next 14 patches global fetch and caches GET responses. supabase-js reads
    // are GETs, so a service-role query gets memoised by URL — across users and
    // across requests — and `dynamic = 'force-dynamic'` does NOT disable it:
    // that governs rendering, while the Data Cache is a separate layer.
    //
    // This was not theoretical. The protected-media route was verified in
    // production returning 404 for one lesson and 401 for every other, because
    // that lesson's row had been fetched minutes earlier — while its
    // video_object_path was still NULL — and the cached row was still being
    // served after migration 042 populated it.
    //
    // Every caller of this client asks an authoritative question: does this
    // learner still have access, has this rate limit been exceeded, what does
    // the audit log say. A stale answer to any of those is a defect, and for
    // rate limiting and revocation it is a security defect. Public discovery
    // data is unaffected — lib/queries/catalogue.ts has its own anon client and
    // keeps its caching.
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  })
}
