import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { PLATFORM_MODE } from '@/lib/pilot'
import { isPrivateMode, isAllowedPrivateUser } from '@/lib/access-control'

// Routes requiring authentication in pilot / public modes (prefix match).
// In private mode the site-wide gate below replaces this list.
const AUTH_REQUIRED = PLATFORM_MODE === 'pilot'
  ? ['/app']
  : ['/app', '/dashboard', '/learn', '/checkout', '/certificate']

// Platform admin routes — always protected regardless of platform mode
const ADMIN_ROUTES = ['/admin']

// Learner auth pages. Authenticated users are redirected away.
const LEARNER_AUTH_PAGES = ['/login', '/signup', '/forgot-password']

// Paths that bypass the private mode site-wide gate to prevent redirect loops
// and preserve core auth flows. Use exact prefix matching.
const PRIVATE_MODE_EXEMPT = [
  '/login',
  '/forgot-password',
  '/reset-password',  // password-reset landing after email link
  '/access-restricted',
  '/admin',           // admin has its own scx_admin cookie gate
  '/api',             // API routes
  '/auth',            // Supabase auth callbacks (e.g. /auth/callback)
]

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
  // microphone=(self): required for Voice Practice (ElevenLabs) on our own
  // origin. camera and geolocation stay fully disabled — not used anywhere.
  h.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  h.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  )
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Next.js inline scripts + Supabase auth flows; blob: is required by the
      // ElevenLabs SDK, which loads its AudioWorklet module from a blob URL
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      // ElevenLabs SDK audio worklet/worker (blob URLs)
      "worker-src 'self' blob:",
      // Tailwind inline styles
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      // Google Fonts, Supabase storage, Unsplash
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co https://images.unsplash.com",
      // Supabase Storage video/audio files
      "media-src 'self' https://*.supabase.co blob:",
      // Supabase API + auth; ElevenLabs Conversational AI (Voice Practice) —
      // signed WebSocket + LiveKit WebRTC transport
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.elevenlabs.io wss://api.elevenlabs.io wss://livekit.rtc.elevenlabs.io",
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
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set(name, value)
          supabaseResponse = NextResponse.next({ request })
          supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set(name, '')
          supabaseResponse = NextResponse.next({ request })
          supabaseResponse.cookies.delete(name)
        },
      },
    }
  )

  // IMPORTANT: getUser() refreshes the session and must be called here
  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  // ── Private mode: site-wide allowlist gate ─────────────────────────────
  // When PLATFORM_MODE=private the entire site is locked down. Only the
  // paths in PRIVATE_MODE_EXEMPT bypass this check; everything else requires
  // an authenticated, allowlisted session.
  if (isPrivateMode) {
    const isExempt = PRIVATE_MODE_EXEMPT.some(
      p => pathname === p || pathname.startsWith(p + '/')
    )
    if (!isExempt) {
      if (!user) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('next', pathname + request.nextUrl.search)
        return applySecurityHeaders(NextResponse.redirect(loginUrl))
      }
      if (!isAllowedPrivateUser(user.email ?? '')) {
        return applySecurityHeaders(
          NextResponse.redirect(new URL('/access-restricted', request.url))
        )
      }
    }
  }

  // ── Auth-required routes (pilot / public modes only) ──────────────────
  // In private mode the site-wide gate above already enforces auth on every
  // route, so this block only runs for pilot / public modes.
  if (!isPrivateMode) {
    const isProtected = AUTH_REQUIRED.some(r => pathname.startsWith(r))
    if (isProtected && !user) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', pathname + request.nextUrl.search)
      return applySecurityHeaders(NextResponse.redirect(loginUrl))
    }
  }

  // ── Learner auth pages ─────────────────────────────────────────────────
  if (LEARNER_AUTH_PAGES.some(p => pathname === p)) {
    if (user) {
      // /login is exempt from the site-wide gate, so handle non-allowlisted
      // authenticated users explicitly here to avoid them reaching /dashboard.
      if (isPrivateMode && !isAllowedPrivateUser(user.email ?? '')) {
        return applySecurityHeaders(
          NextResponse.redirect(new URL('/access-restricted', request.url))
        )
      }
      // Respect the ?next= param so the middleware redirect is consistent with
      // the login form's own post-login destination.
      const rawNext = request.nextUrl.searchParams.get('next') ?? ''
      const target =
        rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/login')
          ? rawNext
          : '/dashboard'
      return applySecurityHeaders(NextResponse.redirect(new URL(target, request.url)))
    }
  }

  // ── Platform admin routes ──────────────────────────────────────────────
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
