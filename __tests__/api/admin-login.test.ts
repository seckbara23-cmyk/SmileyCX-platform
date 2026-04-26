// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRateLimit = vi.fn()
const mockGetClientIp = vi.fn().mockReturnValue('127.0.0.1')

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: mockRateLimit,
  getClientIp: mockGetClientIp,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}))

const mockSignIn = vi.fn()
const mockProfileSelect = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithPassword: mockSignIn },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: mockProfileSelect,
        }),
      }),
    }),
  })),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(fields: Record<string, string>) {
  const req = new NextRequest('http://localhost/api/admin/login', { method: 'POST' })
  const formData = new FormData()
  Object.entries(fields).forEach(([k, v]) => formData.append(k, v))
  vi.spyOn(req, 'formData').mockResolvedValue(formData)
  return req
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/admin/login', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ADMIN_USERNAME', 'admin')
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
    // Default: rate limit passes
    mockRateLimit.mockReturnValue({ success: true, remaining: 4, resetAt: Date.now() + 60000 })
    vi.clearAllMocks()
    // Re-apply defaults after clearAllMocks
    mockRateLimit.mockReturnValue({ success: true, remaining: 4, resetAt: Date.now() + 60000 })
    mockGetClientIp.mockReturnValue('127.0.0.1')
  })

  it('redirects to /admin on valid credentials + super_admin role', async () => {
    const fakeUserId = 'user-123'
    mockSignIn.mockResolvedValue({ data: { user: { id: fakeUserId } }, error: null })
    mockProfileSelect.mockResolvedValue({ data: { platform_role: 'super_admin' } })

    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'admin', password: 'secret' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/admin')
    // Cookie should be set
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('scx_admin')
    expect(setCookie).toContain(fakeUserId)
  })

  it('redirects with error=invalid on wrong username', async () => {
    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'wrong', password: 'secret' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=invalid')
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('redirects with error=invalid on empty credentials', async () => {
    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: '', password: '' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=invalid')
  })

  it('redirects with error=invalid when supabase auth fails', async () => {
    mockSignIn.mockResolvedValue({ data: { user: null }, error: new Error('bad password') })

    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'admin', password: 'wrong' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=invalid')
  })

  it('redirects with error=forbidden when user is not super_admin', async () => {
    mockSignIn.mockResolvedValue({ data: { user: { id: 'user-456' } }, error: null })
    mockProfileSelect.mockResolvedValue({ data: { platform_role: 'org_admin' } })

    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'admin', password: 'secret' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=forbidden')
  })

  it('redirects with error=not_configured when env vars are missing', async () => {
    vi.stubEnv('ADMIN_USERNAME', '')
    vi.stubEnv('ADMIN_EMAIL', '')

    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'admin', password: 'secret' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=not_configured')
  })

  it('redirects with error=too_many_attempts when rate limited', async () => {
    mockRateLimit.mockReturnValueOnce({ success: false, remaining: 0, resetAt: Date.now() + 60000 })

    const { POST } = await import('@/app/api/admin/login/route')
    const req = makeRequest({ username: 'admin', password: 'secret' })
    const res = await POST(req)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=too_many_attempts')
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})
