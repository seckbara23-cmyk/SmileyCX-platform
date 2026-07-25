import { createLogger } from '@/lib/logger'

const log = createLogger('security/auth-config')

/**
 * Runtime validation of the external Supabase Auth configuration (SEC-2 §2).
 *
 * The platform is invite-only: accounts may be provisioned ONLY through the
 * administrative flow. The repository enforces everything it can (no signup UI,
 * no auth.signUp call anywhere, no public registration endpoint), but one
 * control is unavoidably external — Supabase's own `disable_signup` setting,
 * which governs POST /auth/v1/signup. That endpoint is reachable by anyone
 * holding the public anon key, which is embedded in every page by design.
 *
 * This module verifies that external setting at server startup and refuses to
 * continue when it is definitively insecure. It never silently proceeds.
 *
 * Failure semantics, deliberately distinguished:
 *   - CONFIRMED INSECURE (disable_signup === false) → throw, server does not boot
 *   - UNKNOWN (network error, unexpected payload)   → log at error level, continue
 *
 * The distinction matters: a transient network blip must not take the platform
 * down, but a confirmed open-registration configuration must never run.
 */

export type AuthConfigStatus = 'secure' | 'insecure' | 'unknown'

export interface AuthConfigResult {
  status: AuthConfigStatus
  /** Raw value of disable_signup when the probe succeeded. */
  disableSignup?: boolean
  detail?: string
}

/**
 * Probe the public Supabase Auth settings endpoint.
 * Read-only; uses the public anon key; sends no user data.
 */
export async function checkSignupDisabled(
  opts: { url?: string; anonKey?: string; timeoutMs?: number } = {}
): Promise<AuthConfigResult> {
  const url     = opts.url     ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = opts.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    return { status: 'unknown', detail: 'Supabase URL or anon key not configured' }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
    let res: Response
    try {
      res = await fetch(`${url}/auth/v1/settings`, {
        headers: { apikey: anonKey },
        cache:   'no-store',
        signal:  controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      return { status: 'unknown', detail: `settings endpoint returned ${res.status}` }
    }

    const body = (await res.json()) as { disable_signup?: unknown }
    if (typeof body.disable_signup !== 'boolean') {
      return { status: 'unknown', detail: 'settings payload missing disable_signup' }
    }

    return body.disable_signup
      ? { status: 'secure',   disableSignup: true }
      : { status: 'insecure', disableSignup: false }
  } catch (e) {
    return { status: 'unknown', detail: (e as Error).message }
  }
}

/** Message shown when the platform is running with public registration open. */
export const INSECURE_SIGNUP_MESSAGE = [
  'SECURITY: public self-registration is ENABLED on this Supabase project',
  '(auth settings report disable_signup: false).',
  'XP Client Academy is invite-only — accounts must be provisioned by an administrator.',
  'Fix: Supabase Dashboard → Authentication → Sign In / Providers → Email →',
  'disable "Allow new users to sign up", then redeploy.',
  'See docs/security/sec-2-remediation.md (production checklist).',
].join(' ')

/**
 * Startup gate. Throws when the configuration is confirmed insecure.
 *
 * Enforced only when NODE_ENV === 'production' so that local development,
 * tests and CI builds are never blocked by a project whose dashboard setting is
 * still being migrated. Non-production runs still log the finding loudly.
 */
export async function assertSignupDisabled(): Promise<AuthConfigResult> {
  const result = await checkSignupDisabled()

  switch (result.status) {
    case 'secure':
      log.info({ disableSignup: true }, 'Auth configuration verified: public signup is disabled')
      break

    case 'insecure':
      log.error({ disableSignup: false }, INSECURE_SIGNUP_MESSAGE)
      if (process.env.NODE_ENV === 'production') {
        throw new Error(INSECURE_SIGNUP_MESSAGE)
      }
      break

    case 'unknown':
      // Never silently continue: this is an error-level event, not a debug note.
      log.error(
        { detail: result.detail },
        'SECURITY: could not verify Supabase disable_signup setting — verify manually in the Supabase Dashboard'
      )
      break
  }

  return result
}
