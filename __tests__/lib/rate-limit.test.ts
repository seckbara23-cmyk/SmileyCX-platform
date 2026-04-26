import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rateLimit, getClientIp } from '@/lib/rate-limit'

// We manipulate Date.now() to control the sliding window
const now = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rateLimit', () => {
  it('allows requests within the limit', () => {
    const key = `test:${Math.random()}`
    const opts = { limit: 3, windowMs: 60_000 }

    const r1 = rateLimit(key, opts)
    const r2 = rateLimit(key, opts)
    const r3 = rateLimit(key, opts)

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r3.success).toBe(true)
    expect(r3.remaining).toBe(0)
  })

  it('blocks requests that exceed the limit', () => {
    const key = `test:${Math.random()}`
    const opts = { limit: 2, windowMs: 60_000 }

    rateLimit(key, opts)
    rateLimit(key, opts)
    const over = rateLimit(key, opts)

    expect(over.success).toBe(false)
    expect(over.remaining).toBe(0)
  })

  it('resets the counter after the window expires', () => {
    const key = `test:${Math.random()}`
    const opts = { limit: 1, windowMs: 10_000 }

    const first = rateLimit(key, opts)
    expect(first.success).toBe(true)

    const blocked = rateLimit(key, opts)
    expect(blocked.success).toBe(false)

    // Advance past the window
    vi.advanceTimersByTime(10_001)

    const reset = rateLimit(key, opts)
    expect(reset.success).toBe(true)
  })

  it('returns the correct resetAt timestamp', () => {
    const key = `test:${Math.random()}`
    const opts = { limit: 5, windowMs: 30_000 }

    const result = rateLimit(key, opts)
    expect(result.resetAt).toBe(now + 30_000)
  })

  it('different keys are independent', () => {
    const opts = { limit: 1, windowMs: 60_000 }
    const r1 = rateLimit('key-a', opts)
    const r2 = rateLimit('key-b', opts)

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
  })
})

describe('getClientIp', () => {
  it('extracts IP from X-Forwarded-For header', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
    })
    expect(getClientIp(req)).toBe('203.0.113.1')
  })

  it('falls back to X-Real-IP', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-real-ip': '198.51.100.5' },
    })
    expect(getClientIp(req)).toBe('198.51.100.5')
  })

  it('returns "unknown" when no IP headers are present', () => {
    const req = new Request('http://localhost/')
    expect(getClientIp(req)).toBe('unknown')
  })
})
