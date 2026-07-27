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
]

export function isAdminHostPublicPath(pathname: string): boolean {
  return ADMIN_HOST_PUBLIC_PATHS.some(
    p => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/')
  )
}
