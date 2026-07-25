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

/**
 * Stable error codes (HOTFIX-1). Operators grep production logs for these, so
 * they must never change once published.
 *
 *  SEC2_SIGNUP_ENABLED   — confirmed insecure: public registration is open.
 *  SEC2_SIGNUP_UNVERIFIED — the setting could not be read. The application is
 *                           running WITHOUT having verified this control.
 */
export const ERR_SIGNUP_ENABLED    = 'SEC2_SIGNUP_ENABLED'
export const ERR_SIGNUP_UNVERIFIED = 'SEC2_SIGNUP_UNVERIFIED'

export interface AuthConfigResult {
  status: AuthConfigStatus
  /** Stable machine-readable code; undefined when status is 'secure'. */
  code?: typeof ERR_SIGNUP_ENABLED | typeof ERR_SIGNUP_UNVERIFIED
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
    return { status: 'unknown', code: ERR_SIGNUP_UNVERIFIED, detail: 'Supabase URL or anon key not configured' }
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
      return { status: 'unknown', code: ERR_SIGNUP_UNVERIFIED, detail: `settings endpoint returned ${res.status}` }
    }

    const body = (await res.json()) as { disable_signup?: unknown }
    if (typeof body.disable_signup !== 'boolean') {
      return { status: 'unknown', code: ERR_SIGNUP_UNVERIFIED, detail: 'settings payload missing disable_signup' }
    }

    return body.disable_signup
      ? { status: 'secure',   disableSignup: true }
      : { status: 'insecure', code: ERR_SIGNUP_ENABLED, disableSignup: false }
  } catch (e) {
    return { status: 'unknown', code: ERR_SIGNUP_UNVERIFIED, detail: (e as Error).message }
  }
}

/** Message shown when the platform is running with public registration open. */
export const INSECURE_SIGNUP_MESSAGE = [
  `[${ERR_SIGNUP_ENABLED}]`,
  'SECURITY: public self-registration is ENABLED on this Supabase project',
  '(auth settings report disable_signup: false).',
  'XP Client Academy is invite-only — accounts must be provisioned by an administrator.',
  'Fix: Supabase Dashboard → Authentication → Sign In / Providers → Email →',
  'disable "Allow new users to sign up", then redeploy.',
  'See docs/security/sec-2-remediation.md (production checklist).',
].join(' ')

/**
 * Startup observability check. NEVER throws (HOTFIX-3).
 *
 * ── Why this no longer takes the server down ────────────────────────────────
 * SEC-2 originally threw here when the setting was confirmed insecure. In
 * production that turned an operator configuration mistake into an
 * application-wide outage: the throw happens inside the instrumentation hook
 * during Next.js server *preparation*, so every route 500s — a nonexistent
 * slug returned 500 instead of 404 (HOTFIX-1, HOTFIX-2).
 *
 * Worse, it did not close the hole it detected. POST /auth/v1/signup is served
 * by Supabase directly using the public anon key; it never traverses this
 * application. Refusing to boot removed the legitimate surface (courses, login,
 * admin) while leaving the insecure one fully reachable.
 *
 * The ratified architecture (HOTFIX-3) splits the two concerns:
 *
 *   DEPLOY TIME  → enforcement.   scripts/security/verify-prod-config.mjs exits
 *                                 non-zero, the build fails, and the insecure
 *                                 deployment never goes live.
 *   RUNTIME      → observability. Log at fatal level with a stable code and
 *                                 report `degraded` from /api/health. Keep
 *                                 serving.
 *
 * This is NOT a relaxation of the control: enforcement moved earlier, where it
 * is deterministic and cannot be defeated by a cold-start network fault. What
 * was removed is the self-inflicted outage, which protected nobody.
 */
export async function assertSignupDisabled(): Promise<AuthConfigResult> {
  const result = await checkSignupDisabled()

  switch (result.status) {
    case 'secure':
      log.info({ disableSignup: true }, 'Auth configuration verified: public signup is disabled')
      break

    case 'insecure':
      // Fatal level: this is the most severe configuration state there is.
      // The platform keeps serving, but the deployment gate should have
      // prevented this build from shipping — treat it as an active incident.
      log.fatal({ code: ERR_SIGNUP_ENABLED, disableSignup: false }, INSECURE_SIGNUP_MESSAGE)
      break

    case 'unknown':
      // Never silently continue: this is an error-level event, not a debug note.
      // Reaching this branch means the application is serving traffic WITHOUT
      // having verified that public signup is closed.
      log.error(
        { code: ERR_SIGNUP_UNVERIFIED, detail: result.detail },
        `[${ERR_SIGNUP_UNVERIFIED}] SECURITY: could not verify Supabase disable_signup setting — verify manually in the Supabase Dashboard`
      )
      break
  }

  return result
}
