import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isOwnerEmail } from '@/lib/auth/owner-email'

/**
 * Retirement of the legacy `/app/[orgSlug]` product (XPA-8 W2, blocker B-3).
 *
 * ── WHAT WAS HERE ─────────────────────────────────────────────────────────
 *
 * A second, SmileyCX-era organization product: an org switcher, per-org
 * dashboard, journeys, touchpoints, action plans and feedback. Reachable by any
 * authenticated user, linked from the admin shell, and never tested against the
 * policies XPA-7 introduced.
 *
 * It was retired rather than guarded because XPA-7 already provides the
 * authoritative organization experience — list, detail, members, corporate
 * licensing and read-only reporting — at `/admin/organizations`. Keeping a
 * parallel one alive would have meant maintaining two answers to "who belongs
 * to this company".
 *
 * Its CX-analytics tables (journeys, touchpoints, action_plans,
 * feedback_entries, kpi_*) all exist and are all EMPTY. Nothing was deleted:
 * the data model is untouched, only the routes are gone. If that product is
 * ever revived it will be as a deliberate phase, not as a surface nobody
 * noticed was still reachable.
 *
 * ── WHY THE SLUG IS DELIBERATELY IGNORED ──────────────────────────────────
 *
 * This handler never looks the organization up. Resolving `params.path` would
 * turn a retired route into an existence oracle: `/app/acme` behaving
 * differently from `/app/not-a-customer` tells an unrelated learner which
 * companies exist. It would also be an open redirect keyed on a string a
 * visitor controls.
 *
 * So the destination is decided entirely by WHO IS ASKING, never by what they
 * asked for. Every slug — valid, foreign, or invented — resolves identically:
 *
 *   unauthenticated   -> /login          (middleware gets there first)
 *   platform admin    -> /admin/organizations
 *   anyone else       -> /dashboard
 *
 * Neither destination lives under `/app`, so no redirect loop is possible.
 */
export const dynamic = 'force-dynamic'

export default async function RetiredLegacyOrgSurface() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // `/app` is in the middleware's AUTH_REQUIRED list, so an anonymous caller is
  // normally bounced before reaching this. Repeated here so the page is correct
  // on its own rather than relying on a list somewhere else staying right.
  if (!user) redirect('/login')

  // Platform admins were the only legitimate audience left — the admin shell
  // linked here. Send them to the surface that replaced it.
  if (isOwnerEmail(user.email ?? '')) redirect('/admin/organizations')

  // Everyone else goes to their own learner surface. A learner who belongs to
  // an organization sees it through their entitlements and progress, which is
  // where organization context now lives for them.
  redirect('/dashboard')
}
