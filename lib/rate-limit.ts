/**
 * Lightweight in-memory rate limiter for Next.js API routes (Node runtime).
 *
 * Limitation: state is per-process. On multi-instance deployments (e.g. many
 * Vercel serverless containers) counts are not shared. This still provides
 * meaningful protection against single-IP brute-force bursts on login.
 * For strict distributed rate limiting, replace the store with an Upstash
 * Redis client using the same RateLimiter interface.
 */

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

/**
 * Extract a stable identifier from a request for rate-limit keying.
 * Uses X-Forwarded-For (set by Vercel/proxies) then falls back to
 * the remote address header available in Next.js edge/node requests.
 */
export function getClientIp(request: Request): string {
  const xff = (request.headers as Headers).get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return (request.headers as Headers).get('x-real-ip') ?? 'unknown'
}
