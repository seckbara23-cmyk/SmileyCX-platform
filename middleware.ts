import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { PLATFORM_MODE } from '@/lib/pilot'
import { isPrivateMode, isAllowedPrivateUser } from '@/lib/access-control'

// Routes requiring authentication (prefix match).
// In pilot mode, learner content becomes public; only /app (platform CRM)
// stays auth-gated. In private/public mode, all learning routes are protected.
const AUTH_REQUIRED = PLATFORM_MODE === 'pilot'
  ? ['/app']
  : ['/app', '/dashboard', '/learn', '/checkout', '/certificate']

// Platform admin routes — always protected regardless of platform mode
const ADMIN_ROUTES = ['/admin']

// Learner auth pages. Authenticated users are redirected away.
// In pilot mode: ALL visitors are redirected to /courses (no auth needed).
const LEARNER_AUTH_PAGES = ['/login', '/signup', '/forgot-password']

/**
 * Security headers applied to every response.
 * CSP is intentionally permissive for now (unsafe-inline/eval needed by
 * Next.js dev HMR and some Supabase SDK internals). Tighten in a later pass
 * once nonce-based CSP is wired up through the Next.js config.
 */
function applySecurityHeaders(response: NextResponse): NextResponse {
  const h = response.headers
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('X-Frame-Options', 'DENY')
  h.set('X-XSS-Protection', '1; mode=block')
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  h.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  )
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Next.js inline scripts + Supabase auth flows
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind inline styles
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      // Google Fonts, Supabase storage, Unsplash
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co https://images.unsplash.com",
      // Supabase Storage video/audio files
      "media-src 'self' https://*.supabase.co blob:",
      // Supabase API + auth
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      // iframe embeds: YouTube, Vimeo, Loom
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  )
  return response
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
          )
        },
      },
    }
  )

  // IMPORTANT: getUser() refreshes the session and must be called here
  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  // ── Auth-required routes ───────────────────────────────────────────
  const isProtected = AUTH_REQUIRED.some(r => pathname.startsWith(r))
  if (isProtected) {
    if (!user) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', pathname + request.nextUrl.search)
      return applySecurityHeaders(NextResponse.redirect(loginUrl))
    }
    // Private mode: allowlist gate — only permitted emails can proceed
    if (isPrivateMode && !isAllowedPrivateUser(user.email ?? '')) {
      return applySecurityHeaders(NextResponse.redirect(new URL('/access-restricted', request.url)))
    }
  }

  // ── Learner auth pages ─────────────────────────────────────────────
  if (LEARNER_AUTH_PAGES.some(p => pathname === p)) {
    if (PLATFORM_MODE === 'pilot') {
      // Pilot: no accounts needed — send everyone to the catalog
      return applySecurityHeaders(NextResponse.redirect(new URL('/courses', request.url)))
    }
    // Private/public: authenticated users don't need to see login/signup
    if (user) {
      // Private mode: non-allowlisted users land on the restricted page, not dashboard
      if (isPrivateMode && !isAllowedPrivateUser(user.email ?? '')) {
        return applySecurityHeaders(NextResponse.redirect(new URL('/access-restricted', request.url)))
      }
      return applySecurityHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
    }
  }

  // ── Platform admin routes ──────────────────────────────────────────
  // /admin/login is public. All other /admin/* routes check the scx_admin
  // cookie set by /api/admin/login. The role check (super_admin) is enforced
  // in the admin layout using the service role client.
  if (ADMIN_ROUTES.some(r => pathname.startsWith(r)) && pathname !== '/admin/login') {
    const adminCookie = request.cookies.get('scx_admin')?.value
    if (!adminCookie) {
      return applySecurityHeaders(NextResponse.redirect(new URL('/admin/login', request.url)))
    }
  }

  return applySecurityHeaders(supabaseResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
}
