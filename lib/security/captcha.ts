/**
 * Bot-mitigation seam (XPA-6A).
 *
 * No CAPTCHA provider is configured for this platform today. Rather than leave
 * a TODO, this module is the integration point: registration and verification
 * resend already call `verifyCaptcha()`, so enabling a provider later is a
 * configuration change plus one `case` below — not a change to the auth flow.
 *
 * ── FAIL BEHAVIOUR, DELIBERATELY ASYMMETRIC ───────────────────────────────
 *
 *   provider unset            → allow. CAPTCHA is off by ratified rollout mode;
 *                               refusing every registration because an optional
 *                               control is absent would be an outage, not
 *                               security. Rate limiting still applies.
 *   provider set, verify fails → DENY. Once a provider is configured, an
 *                               unverifiable token is a failure, never a pass.
 *                               This is the direction that matters: a
 *                               misconfigured or unreachable provider must not
 *                               silently degrade into "no protection".
 *
 * That asymmetry is the whole point. "Fails safely according to the ratified
 * rollout mode" means off-by-config is allowed and broken-when-on is not.
 */

import { createLogger } from '@/lib/logger'

const log = createLogger('security/captcha')

export type CaptchaProvider = 'disabled' | 'turnstile' | 'hcaptcha'

export interface CaptchaResult {
  ok:       boolean
  provider: CaptchaProvider
  /** Non-sensitive reason, safe to log. Never contains the token. */
  reason?:  string
}

/** Which provider is configured, derived solely from the environment. */
export function captchaProvider(): CaptchaProvider {
  const raw = (process.env.CAPTCHA_PROVIDER ?? '').trim().toLowerCase()
  if (raw === 'turnstile' || raw === 'hcaptcha') return raw
  return 'disabled'
}

/** True when a provider is configured and a token must be supplied. */
export function isCaptchaEnabled(): boolean {
  return captchaProvider() !== 'disabled'
}

/**
 * Verify a client-supplied CAPTCHA token.
 *
 * Server-side only — the secret must never reach the browser, which is why it
 * is read from CAPTCHA_SECRET_KEY (no NEXT_PUBLIC_ prefix).
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<CaptchaResult> {
  const provider = captchaProvider()

  if (provider === 'disabled') {
    return { ok: true, provider, reason: 'provider not configured' }
  }

  const secret = process.env.CAPTCHA_SECRET_KEY
  if (!secret) {
    // Configured but unusable. Deny: a provider that was switched on and then
    // half-configured must not degrade into no protection at all.
    log.error({ provider }, 'CAPTCHA_PROVIDER is set but CAPTCHA_SECRET_KEY is missing')
    return { ok: false, provider, reason: 'provider misconfigured' }
  }

  if (!token) return { ok: false, provider, reason: 'missing token' }

  const endpoint =
    provider === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
      : 'https://hcaptcha.com/siteverify'

  try {
    const body = new URLSearchParams({ secret, response: token })
    if (remoteIp) body.set('remoteip', remoteIp)

    const res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(5_000),
    })

    const data = (await res.json()) as { success?: boolean }
    if (data.success === true) return { ok: true, provider }

    return { ok: false, provider, reason: 'token rejected' }
  } catch (err) {
    // Unreachable provider. Deny — see the asymmetry note at the top.
    log.error({ err, provider }, 'CAPTCHA verification request failed')
    return { ok: false, provider, reason: 'verification unavailable' }
  }
}
