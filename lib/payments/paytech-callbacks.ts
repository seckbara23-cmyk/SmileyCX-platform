import 'server-only'
import { randomBytes } from 'node:crypto'
import { PUBLIC_SITE_URL } from '@/lib/brand'
import type { EnvLike } from '@/lib/payments/paytech-config'

/**
 * PayTech callback URLs and order references — XP-PAYTECH-03, moved here by
 * XP-PAYTECH-04.
 *
 * These lived in `app/actions/paytech-checkout.ts`. A `'use server'` module may
 * export only async functions, and Next enforces that the moment a client
 * component imports the action — which XP-PAYTECH-04's checkout button is the
 * first to do. So the synchronous helpers live here.
 */

/**
 * Which origin the provider should call back to.
 *
 * ── RESOLUTION ORDER ──────────────────────────────────────────────────────
 *
 *   1. PRODUCTION — always `PUBLIC_SITE_URL`, the canonical domain. The pin is
 *      IGNORED here (XP-PAYTECH-READY-01 E3): production notifications must
 *      reach production, and the deploy gate refuses the pin in production.
 *   2. `PAYTECH_CALLBACK_BASE_URL` — the operator's pin for a non-production
 *      deployment, normally a stable staging hostname.
 *   3. On any other non-production deployment, its own host (`VERCEL_URL`).
 *   4. `PUBLIC_SITE_URL` — local development.
 *
 * Every URL this produces is still checked by `isValidCallbackUrl()` in the
 * transport, which requires absolute HTTPS, so a bad pin refuses the checkout
 * rather than falling back somewhere unintended.
 */
export function paytechCallbackBaseUrl(env: EnvLike = process.env): string {
  if ((env.VERCEL_ENV ?? '').trim() === 'production') return PUBLIC_SITE_URL

  const pinned = (env.PAYTECH_CALLBACK_BASE_URL ?? '').trim()
  if (pinned.length > 0) return pinned

  const host = (env.VERCEL_URL ?? '').trim()
  // VERCEL_URL carries a bare host with no scheme.
  if (host.length > 0) return `https://${host}`

  return PUBLIC_SITE_URL
}

/** The three callback URLs. Absolute HTTPS, enforced by the transport. */
export function paytechCallbackUrls(siteUrl: string = paytechCallbackBaseUrl()): {
  ipnUrl: string
  successUrl: string
  cancelUrl: string
} {
  const base = siteUrl.replace(/\/+$/, '')
  return {
    ipnUrl:     `${base}/api/payments/paytech/ipn`,
    successUrl: `${base}/payment/success`,
    cancelUrl:  `${base}/payment/cancel`,
  }
}

/**
 * Mint an order reference: one per provider attempt, never reused.
 *
 * It is `ref_command` on the provider side (documented as unique, behaviour
 * on reuse undocumented) and one of the two values the IPN signature covers.
 * The random part comes from the CSPRNG; the shape matches the existing `SCX-`
 * references so the admin views keep reading naturally.
 */
export function mintReference(now: number = Date.now()): string {
  const stamp = now.toString(36).toUpperCase()
  const rand = randomBytes(5).toString('hex').toUpperCase()
  return `SCX-${stamp}-${rand}`
}
