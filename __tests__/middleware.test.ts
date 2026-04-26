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

function makeRequest(pathname: string, options?: { adminCookie?: string }) {
  const url = `http://localhost${pathname}`
  const headers = new Headers()
  if (options?.adminCookie) {
    headers.set('cookie', `scx_admin=${options.adminCookie}`)
  }
  return new NextRequest(url, { headers })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('middleware redirect rules', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
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

  describe('admin routes', () => {
    it('redirects /admin without scx_admin cookie to /admin/login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/admin'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/admin/login')
    })

    it('redirects /admin/users without scx_admin cookie to /admin/login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { middleware } = await import('@/middleware')
      const res = await middleware(makeRequest('/admin/users'))
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/admin/login')
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
