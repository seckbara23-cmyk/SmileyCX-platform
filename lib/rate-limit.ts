/**
 * Rate limiting utilities for Next.js API routes.
 *
 * rateLimit     — in-memory, per-process. Suitable for development or low-stakes
 *                 routes. State is lost on Vercel cold starts — do NOT use for
 *                 security-critical endpoints.
 *
 * rateLimitDb   — Supabase-backed, distributed. Safe on Vercel serverless.
 *                 Requires the rate_limits table + check_rate_limit() function
 *                 from migration 011_security_fixes.sql. Use this for the admin
 *                 login route and any other security-critical endpoint.
 */

import { createAdminClient } from '@/lib/supabase/admin'

interface Entry {
  count: number
  resetAt: number
}

const store = new Map<string, Entry>()

// Prune expired entries every 5 minutes to avoid unbounded memory growth.
setInterval(() => {
  const now = Date.now()
  Array.from(store.entries()).forEach(([key, entry]) => {
    if (entry.resetAt <= now) store.delete(key)
  })
}, 5 * 60 * 1000).unref()

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number
  /** Window duration in milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  success: boolean
  /** Remaining requests in the current window. */
  remaining: number
  /** Unix ms when the current window resets. */
  resetAt: number
}

// ── In-memory (dev / non-critical only) ───────────────────────────────────────

export function rateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || entry.resetAt <= now) {
    const newEntry: Entry = { count: 1, resetAt: now + options.windowMs }
    store.set(key, newEntry)
    return { success: true, remaining: options.limit - 1, resetAt: newEntry.resetAt }
  }

  entry.count += 1
  const remaining = Math.max(0, options.limit - entry.count)
  return {
    success: entry.count <= options.limit,
    remaining,
    resetAt: entry.resetAt,
  }
}

// ── Supabase-backed (production-safe, distributed) ────────────────────────────
// Calls the check_rate_limit() SECURITY DEFINER function via the admin client.
// Fails OPEN on DB errors so a Supabase outage never locks out legitimate users.
// The trade-off is that rate limiting is temporarily suspended during outages —
// acceptable for a small admin panel; not acceptable for high-traffic public routes.

export async function rateLimitDb(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_key:       key,
      p_limit:     options.limit,
      p_window_ms: options.windowMs,
    })

    if (error || !data) {
      console.error('[rateLimitDb] DB error:', error?.message)
      // Fail open — better to allow the request than to permanently deny access.
      return { success: true, remaining: options.limit, resetAt: Date.now() + options.windowMs }
    }

    const r = data as { success: boolean; count: number; limit: number; reset_at: number }
    return {
      success:   r.success,
      remaining: Math.max(0, r.limit - r.count),
      resetAt:   r.reset_at,
    }
  } catch (e) {
    console.error('[rateLimitDb] Exception:', e)
    return { success: true, remaining: options.limit, resetAt: Date.now() + options.windowMs }
  }
}

// ── IP extraction ─────────────────────────────────────────────────────────────

/**
 * Extract a stable client identifier from a request for rate-limit keying.
 * Uses X-Forwarded-For (set by Vercel / reverse proxies) with fallback to
 * the X-Real-IP header.
 */
export function getClientIp(request: Request): string {
  const xff = (request.headers as Headers).get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return (request.headers as Headers).get('x-real-ip') ?? 'unknown'
}
