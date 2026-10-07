import 'server-only'

/**
 * PayDunya configuration authority — PAY-LAUNCH-02A.
 *
 * ── WHY THIS EXISTS BEFORE ANY PAYMENT CODE ───────────────────────────────
 *
 * The expensive mistake in a payment integration is not a bug in the checkout
 * call; it is a deployment that charges real money while everyone believes it is
 * in test mode, or that silently stops charging because a credential went
 * missing. Both are configuration failures, and both are preventable with a
 * boundary that refuses to resolve at all rather than guessing.
 *
 * So this module is deliberately the ONLY place that reads a PayDunya variable,
 * it is written before the API client exists, and it has no default:
 *
 *   * `PAYDUNYA_MODE` absent            -> throws
 *   * `PAYDUNYA_MODE` anything else     -> throws (exact 'test' | 'live' only)
 *   * the selected mode missing a key   -> throws, naming WHICH key
 *
 * ── TEST AND LIVE CANNOT CROSS ────────────────────────────────────────────
 *
 * The credential names are BUILT from the resolved mode, so test mode is
 * structurally incapable of reading a LIVE variable and live mode is incapable
 * of reading a TEST one. There is no fallback chain, no `??` between the two
 * sets, and no single shared `PAYDUNYA_PRIVATE_KEY` that could mean either.
 * A mode mismatch therefore fails closed instead of silently charging against
 * the wrong account.
 *
 * Whether LIVE credentials may even be PRESENT during the current test phase is
 * a deployment question, not a runtime one, and is enforced by
 * `scripts/security/verify-prod-config.mjs` — which blocks the build rather
 * than waiting for a request.
 *
 * ── SECRETS DO NOT LEAVE BY ACCIDENT ──────────────────────────────────────
 *
 * `import 'server-only'` makes importing this from a client component a build
 * error, the same mechanism the admin and assessment modules use. The returned
 * object redacts itself under `JSON.stringify`, template interpolation and
 * `console.log`, so a careless log line cannot leak a key. Error messages name
 * variables, never values. Use `describePaydunyaConfig()` for anything
 * diagnostic — it reports presence, never content.
 *
 * No network call and no PayDunya client live here. This slice is the boundary
 * only; nothing in the application can take a payment yet, and
 * `NEXT_PUBLIC_PAYMENTS_ENABLED` remains the separate feature flag.
 */

export const PAYDUNYA_MODES = ['test', 'live'] as const
export type PaydunyaMode = (typeof PAYDUNYA_MODES)[number]

/** The three credentials PayDunya requires, per mode. */
const CREDENTIAL_SUFFIXES = ['MASTER_KEY', 'PRIVATE_KEY', 'TOKEN'] as const
type CredentialSuffix = (typeof CREDENTIAL_SUFFIXES)[number]

/** Env var name for one credential of one mode. Never hand-written elsewhere. */
export function paydunyaEnvName(mode: PaydunyaMode, suffix: CredentialSuffix): string {
  return `PAYDUNYA_${mode.toUpperCase()}_${suffix}`
}

/** Every PayDunya variable name this application recognises. */
export function paydunyaEnvNames(): string[] {
  return [
    'PAYDUNYA_MODE',
    ...PAYDUNYA_MODES.flatMap(m => CREDENTIAL_SUFFIXES.map(s => paydunyaEnvName(m, s))),
  ]
}

export interface PaydunyaConfig {
  readonly mode:       PaydunyaMode
  readonly masterKey:  string
  readonly privateKey: string
  readonly token:      string
  /** True only when `mode === 'live'`. Read this instead of comparing strings. */
  readonly isLive:     boolean
}

/** A source of environment values — injectable so tests never mutate the real one. */
export type EnvLike = Record<string, string | undefined>

export class PaydunyaConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaydunyaConfigError'
  }
}

/** Trimmed value, or undefined when absent or blank. Blank is never a credential. */
function value(env: EnvLike, name: string): string | undefined {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Why the configuration is unusable, or null when it is usable.
 *
 * Non-throwing, so the deploy-time gate and a health surface can ask without
 * handling an exception. Every message names variables; none contains a value.
 */
export function paydunyaConfigError(env: EnvLike = process.env): string | null {
  const rawMode = env.PAYDUNYA_MODE

  if (typeof rawMode !== 'string' || rawMode.trim().length === 0) {
    return 'PAYDUNYA_MODE is not set. There is deliberately no default: set it to '
         + "exactly 'test' or 'live'."
  }

  // Exact match only. Accepting 'TEST' or ' live ' would mean guessing at intent
  // in the one place where guessing can move real money.
  const mode = rawMode as PaydunyaMode
  if (!(PAYDUNYA_MODES as readonly string[]).includes(mode)) {
    return `PAYDUNYA_MODE must be exactly 'test' or 'live'. Refusing to interpret `
         + `the configured value (${rawMode.length} characters, not an exact match).`
  }

  const missing = CREDENTIAL_SUFFIXES
    .map(s => paydunyaEnvName(mode, s))
    .filter(name => value(env, name) === undefined)

  if (missing.length > 0) {
    return `PAYDUNYA_MODE='${mode}' but ${missing.length} of 3 credentials for that `
         + `mode are missing: ${missing.join(', ')}. A partial credential set is `
         + 'never usable, so this fails closed.'
  }

  return null
}

/** Credentials present for a mode, as a count — never the values. */
export function paydunyaCredentialsPresent(mode: PaydunyaMode, env: EnvLike = process.env): number {
  return CREDENTIAL_SUFFIXES.filter(s => value(env, paydunyaEnvName(mode, s)) !== undefined).length
}

/**
 * Safe diagnostics: which mode, and which variables are present. No values.
 * This is what a log line or a health endpoint may print.
 */
export function describePaydunyaConfig(env: EnvLike = process.env): {
  mode: string | null
  valid: boolean
  error: string | null
  present: Record<PaydunyaMode, number>
} {
  const error = paydunyaConfigError(env)
  return {
    mode:    typeof env.PAYDUNYA_MODE === 'string' ? env.PAYDUNYA_MODE : null,
    valid:   error === null,
    error,
    present: { test: paydunyaCredentialsPresent('test', env), live: paydunyaCredentialsPresent('live', env) },
  }
}

/**
 * The resolved configuration, or a thrown `PaydunyaConfigError`.
 *
 * Call this from server code that is about to talk to PayDunya. The returned
 * object redacts itself if logged or serialised.
 */
export function resolvePaydunyaConfig(env: EnvLike = process.env): PaydunyaConfig {
  const error = paydunyaConfigError(env)
  if (error) throw new PaydunyaConfigError(error)

  const mode = env.PAYDUNYA_MODE as PaydunyaMode

  // Built from `mode`, so the other mode's variables are unreachable from here.
  const masterKey  = value(env, paydunyaEnvName(mode, 'MASTER_KEY'))!
  const privateKey = value(env, paydunyaEnvName(mode, 'PRIVATE_KEY'))!
  const token      = value(env, paydunyaEnvName(mode, 'TOKEN'))!

  const redacted = `[PaydunyaConfig mode=${mode} credentials=redacted]`

  return Object.freeze({
    mode,
    masterKey,
    privateKey,
    token,
    isLive: mode === 'live',
    // Logging or serialising the config must not print a key.
    toJSON:   () => ({ mode, isLive: mode === 'live', credentials: 'redacted' }),
    toString: () => redacted,
    [Symbol.for('nodejs.util.inspect.custom')]: () => redacted,
  }) as PaydunyaConfig
}
