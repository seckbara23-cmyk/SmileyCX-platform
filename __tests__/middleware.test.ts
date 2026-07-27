// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    cookies: {},
  })),
}))

// Spy on NextResponse.next to avoid edge-runtime Headers requirement.
// We only test redirect paths in unit tests; pass-through is covered by e2e.

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(pathname: string, options?: { adminCookie?: string; host?: string }) {
  const url = `http://localhost${pathname}`
  const headers = new Headers()
  if (options?.adminCookie) {
    headers.set('cookie', `scx_admin=${options.adminCookie}`)
  }
  if (options?.host) {
    headers.set('x-forwarded-host', options.host)
  }
  return new NextRequest(url, { headers })
}

/** Request addressed to the private portal hostname. */
function portalRequest(pathname: string) {
  return makeRequest(pathname, { host: 'smiley-cx-platform.vercel.app' })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('middleware redirect rules', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
    // The auth-required route list is MODE-DEPENDENT (see lib/pilot.ts and
    // middleware.ts): in 'pilot' it is ['/app'] only, because pilot deliberately
    // opens course content to anonymous visitors and /dashboard self-protects at
    // page level. In 'public' (and 'private') the full list applies.
    //
    // Pin the suite to 'public' so these tests assert the STRICTEST matrix —
    // that middleware really does gate every protected route when configured to.
    // PLATFORM_MODE is resolved at module load, so this must be stubbed before
    // the first dynamic import of '@/middleware' (which happens inside a test).
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_MODE', 'public')
    // Stub NextResponse.next to avoid edge-runtime Headers requirement
    vi.spyOn(NextResponse, 'next').mockReturnValue(new Response(null, { status: 200 }) as never)
  })

  describe('auth-required routes', () => {
    it('redirects unauthenticated user from /dashboard to /login with next param', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/dashboard'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
      expect(res.headers.get('location')).toContain('next=')
    })

    it('redirects unauthenticated user from /app/* to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/app/my-org/dashboard'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })

    it('redirects unauthenticated user from /learn/* to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/learn/some-course/module/lesson'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })
  })

  describe('guest-only routes', () => {
    it('redirects authenticated user from /login to /dashboard', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/login'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/dashboard')
    })

    it('redirects authenticated user from /signup to /dashboard', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/signup'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/dashboard')
    })
  })

  /**
   * CX-AUTH-1 — these previously asserted that /admin redirected to
   * /admin/login when the `scx_admin` cookie was ABSENT. That check was
   * satisfied by any non-empty cookie value, and the cookie was an unsigned
   * user UUID (CX-AUTH-0 finding F-3).
   *
   * The assertion is now STRICTER, not looser: /admin requires a verified
   * Supabase session belonging to the configured owner. Cookie presence
   * proves nothing.
   */
  describe('admin routes', () => {
    it('redirects anonymous /admin to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/admin'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })

    it('redirects anonymous /admin/users to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/admin/users'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })

    it('redirects an authenticated NON-owner away from /admin', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'someone@else.com' } } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/admin'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })
  })

  /**
   * CX-AUTH-2A — the Vercel host gates access; it does NOT substitute pages.
   *
   * CX-AUTH-2 rewrote `/` into /admin, which replaced the Smiley CX landing
   * page with the admin dashboard. That is reverted: `/` renders the landing
   * page and the dashboard stays at /admin.
   *
   * Behavioural, not source-grep: the middleware is invoked with a real owner
   * session and the response inspected.
   */
  describe('CX-AUTH-2A private host routing', () => {
    const OWNER = 'owner@example.com'

    function asOwner() {
      vi.stubEnv('ADMIN_OWNER_EMAILS', OWNER)
      mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: OWNER } } })
    }

    /** Next signals an internal rewrite with this header. */
    const rewrittenTo = (res: NextResponse) => res.headers.get('x-middleware-rewrite')

    it('anonymous / on the Vercel host redirects to /login', async () => {
      vi.stubEnv('ADMIN_OWNER_EMAILS', OWNER)
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')

      const res = await middleware(portalRequest('/'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })

    it('authenticated owner / renders the landing page — NOT the dashboard', async () => {
      asOwner()
      const { middleware } = await import('@/middleware')
      const res = await middleware(portalRequest('/'))

      expect(res.status).not.toBe(307)          // not redirected away
      expect(rewrittenTo(res)).toBeNull()       // and not rewritten into /admin
    })

    it('NO / → /admin rewrite remains anywhere on the host', async () => {
      asOwner()
      const { middleware } = await import('@/middleware')
      for (const p of ['/', '/courses', '/about', '/contact']) {
        const res = await middleware(portalRequest(p))
        expect(rewrittenTo(res) ?? '').not.toContain('/admin')
      }
    })

    it('authenticated owner /admin reaches the dashboard route unchanged', async () => {
      asOwner()
      const { middleware } = await import('@/middleware')
      for (const p of ['/admin', '/admin/users', '/admin/courses', '/admin/modules']) {
        const res = await middleware(portalRequest(p))
        expect(res.status).not.toBe(307)        // not bounced to /login
        expect(rewrittenTo(res)).toBeNull()     // served as-is
      }
    })

    it('clean paths are NOT rewritten into /admin (they were never real routes)', async () => {
      asOwner()
      const { middleware } = await import('@/middleware')
      for (const p of ['/users', '/modules']) {
        const res = await middleware(portalRequest(p))
        expect(rewrittenTo(res) ?? '').not.toContain('/admin')
      }
    })

    it('deep links still survive login', async () => {
      vi.stubEnv('ADMIN_OWNER_EMAILS', OWNER)
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')

      const res = await middleware(portalRequest('/admin/users'))
      expect(res.headers.get('location')).toContain('next=%2Fadmin%2Fusers')
    })

    it('AUTHORIZATION UNCHANGED: a non-owner is still signed out', async () => {
      vi.stubEnv('ADMIN_OWNER_EMAILS', OWNER)
      mockGetUser.mockResolvedValue({ data: { user: { id: 'u2', email: 'someone@else.com' } } })
      const { middleware } = await import('@/middleware')

      const res = await middleware(portalRequest('/'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/api/auth/signout')
    })

    it('the PUBLIC host remains public and unrewritten', async () => {
      asOwner()
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/', { host: 'www.xpclient-academy.com' }))
      expect(rewrittenTo(res) ?? '').not.toContain('/admin')
      expect(res.status).not.toBe(307)
    })
  })

  describe('security headers on redirects', () => {
    it('applies X-Frame-Options DENY on redirect responses', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/dashboard'))
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    })

    it('applies CSP header on redirect responses', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/dashboard'))
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    })

    it('applies X-Content-Type-Options on redirect responses', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/dashboard'))
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })
  })
})
