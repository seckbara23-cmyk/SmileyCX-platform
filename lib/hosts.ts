/**
 * Host classification (CX-AUTH-1).
 *
 * Two hostnames point at the SAME production deployment but serve different
 * purposes:
 *
 *   www.xpclient-academy.com        → public marketing site, stays fully public
 *   smiley-cx-platform.vercel.app   → private administration portal
 *
 * Before CX-AUTH-1 the application was entirely host-blind, so the admin
 * hostname served the complete public website to anyone. This module is the
 * single place that distinguishes them.
 *
 * Adding admin.xpclient-academy.com later requires only appending it to
 * ADMIN_HOSTS — no code change.
 */

/**
 * Default admin hostname, so the boundary works with zero Vercel configuration.
 * ADMIN_HOSTS overrides this when set (comma-separated).
 */
const DEFAULT_ADMIN_HOSTS = ['smiley-cx-platform.vercel.app']

function configuredAdminHosts(): string[] {
  const raw = (process.env.ADMIN_HOSTS ?? '').trim()
  if (!raw) return DEFAULT_ADMIN_HOSTS
  return raw
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
}

/** Strip the port and lowercase. `Example.com:3000` → `example.com`. */
function normalizeHost(host: string | null | undefined): string {
  if (!host) return ''
  return host.trim().toLowerCase().split(':')[0]
}

/**
 * Is this request addressed to the private administration portal?
 *
 * Allow-list, not deny-list: only explicitly listed hosts are treated as
 * admin. An unrecognised host is PUBLIC, which is the safe default for
 * availability — a typo in ADMIN_HOSTS degrades to "public marketing site",
 * never to "admin pages exposed". Admin pages remain independently protected
 * by requirePlatformAdmin() on every page and action, so a host
 * misclassification alone cannot expose them.
 *
 * Vercel preview deployments (*.vercel.app that are not the production alias)
 * are already gated by Vercel Deployment Protection and are additionally
 * treated as admin hosts here, so they never serve the public site anonymously.
 */
export function isAdminHost(host: string | null | undefined): boolean {
  const h = normalizeHost(host)
  if (!h) return false

  if (configuredAdminHosts().includes(h)) return true

  // Any other *.vercel.app deployment/preview URL: deny by default.
  // The public site is served exclusively from its own custom domain.
  if (h.endsWith('.vercel.app')) return true

  return false
}

/**
 * Resolve the request host. On Vercel, x-forwarded-host is set at the edge and
 * is not client-controllable; the Host header is the fallback for local dev.
 */
export function resolveHost(headers: Headers): string {
  return normalizeHost(headers.get('x-forwarded-host') ?? headers.get('host'))
}

/**
 * Paths that must stay reachable on the admin host WITHOUT a session,
 * otherwise the owner could never log in. Everything else on the admin host
 * requires the owner session.
 */
export const ADMIN_HOST_PUBLIC_PATHS = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth/',          // Supabase code exchange
  '/api/auth/',      // sign-out
  '/api/health',
  // ── XP-PAYTECH-01: the payment provider's server-to-server notification ──
  //
  // `isAdminHost()` treats EVERY *.vercel.app host as the admin host, by
  // design. Without this entry the PayTech IPN is redirected to /login on
  // every preview deployment, so a notification would arrive as a 307 to an
  // HTML login page and nothing would ever be fulfilled — which makes the
  // controlled preview UAT this integration is gated behind impossible to
  // run. Verified against the live preview before adding it.
  //
  // Exposing it is safe, and it is already necessarily public in production
  // because PayTech must reach it from the internet:
  //
  //   * every request is authenticated before any database read — the
  //     official sha256-constant check first, then an HMAC over a message
  //     built from our own stored values, both compared in constant time —
  //     and an unauthenticated caller gets 401 having touched nothing;
  //   * the route additionally refuses with 503 unless PayTech is enabled on
  //     that deployment, so it is inert wherever the provider is not
  //     configured;
  //   * it grants nothing by itself: completion runs through migration 062,
  //     which is reachable only via the single chokepoint.
  //
  // Named as the full route rather than an `/api/payments/` prefix, so a
  // future payments endpoint is not exposed on the admin host by accident.
  // Note the matcher below is prefix-based for every entry, so this covers
  // this path and anything below it; nothing is routed below it, and a test
  // pins that no sibling payments route becomes reachable.
  '/api/payments/paytech/ipn',
  // ── XP-PAYTECH-04: the reconciliation sweep, called by Vercel Cron ──
  //
  // Vercel Cron calls the production deployment through a *.vercel.app host,
  // which `isAdminHost()` treats as the admin host, so without this entry every
  // sweep would be redirected to /login and nothing would ever be reconciled.
  // The route authenticates every request itself (CRON_SECRET, compared in
  // constant time, and it refuses with 503 when the secret is not configured),
  // answers with counts only, and can complete only what PayTech confirms.
  // Named in full, like the IPN, so no sibling route is exposed by accident.
  '/api/payments/paytech/reconcile',
]

export function isAdminHostPublicPath(pathname: string): boolean {
  return ADMIN_HOST_PUBLIC_PATHS.some(
    p => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/')
  )
}

/**
 * Is this request addressed to the COMMERCIAL learner application? (XPA-6A)
 *
 * Defined as the complement of the admin host rather than as an equality test
 * against the production domain, and that is deliberate:
 *
 *   * Equality would break local development and every preview URL, so the
 *     first person to run `npm run dev` would "fix" it by loosening it.
 *   * The complement is the property that actually matters. `isAdminHost()`
 *     already denies the production admin alias AND every *.vercel.app
 *     deployment, so "not admin" means "a real customer-facing domain".
 *
 * Used to refuse public registration on the internal host. It is a
 * SUPPLEMENTARY control, never the only one: the middleware host boundary
 * blocks the registration page there too, and authorization never depends on
 * the hostname (a spoofed Host cannot grant anything — see requirePlatformAdmin).
 */
export function isCommercialHost(host: string | null | undefined): boolean {
  return !isAdminHost(host)
}
