import 'server-only'

/**
 * PayTech configuration authority — XP-PAYTECH-01.
 *
 * Deliberately the same shape as `paydunya-config.ts`, for the same reason: the
 * expensive failure in a payment integration is not a bug in the checkout call,
 * it is a deployment that charges real money while everyone believes it is in
 * test mode. So this module is the ONLY place that reads a PayTech variable, it
 * has no default, and it refuses to resolve rather than guessing.
 *
 *   * `PAYTECH_MODE` absent          -> error
 *   * `PAYTECH_MODE` anything else   -> error (exact 'test' | 'prod' only)
 *   * the selected mode missing a key -> error, naming WHICH key
 *
 * ── TWO VOCABULARIES, MAPPED ONCE ─────────────────────────────────────────
 *
 * PayTech's own wire field is `env`, whose values are 'test' and 'prod'. Our
 * `payments.provider_mode` column accepts exactly 'test' and 'live' (migration
 * 058, constraint payments_provider_mode_valid). Those are different words for
 * the same two states, and conflating them writes a row the database rejects.
 *
 * The mapping therefore happens HERE, once, and is exported as two distinct
 * properties — `env` for the provider and `providerMode` for our column — so no
 * call site has to remember which vocabulary it is holding.
 *
 * ── TEST AND PROD CANNOT CROSS ────────────────────────────────────────────
 *
 * The credential names are BUILT from the resolved mode, so test mode is
 * structurally incapable of reading a PROD variable. There is no fallback chain
 * and no shared `PAYTECH_API_KEY` that could mean either.
 *
 * ── SECRETS DO NOT LEAVE ──────────────────────────────────────────────────
 *
 * `import 'server-only'` makes a browser import a build error. The returned
 * object redacts itself under `JSON.stringify`, template interpolation and
 * `console.log`. Error messages name variables, never values. Use
 * `describePaytechConfig()` for diagnostics — it reports presence, never content.
 */

/** PayTech's own `env` values, exactly as the provider documents them. */
export const PAYTECH_MODES = ['test', 'prod'] as const
export type PaytechMode = (typeof PAYTECH_MODES)[number]

/** What `payments.provider_mode` accepts (migration 058). A different vocabulary. */
export type ProviderMode = 'test' | 'live'

/** The two credentials PayTech requires, per mode. */
const CREDENTIAL_SUFFIXES = ['API_KEY', 'API_SECRET'] as const
type CredentialSuffix = (typeof CREDENTIAL_SUFFIXES)[number]

/** Env var name for one credential of one mode. Never hand-written elsewhere. */
export function paytechEnvName(mode: PaytechMode, suffix: CredentialSuffix): string {
  return `PAYTECH_${mode.toUpperCase()}_${suffix}`
}

/** Every PayTech variable name this application recognises. */
export function paytechEnvNames(): string[] {
  return [
    'PAYTECH_MODE',
    ...PAYTECH_MODES.flatMap(m => CREDENTIAL_SUFFIXES.map(s => paytechEnvName(m, s))),
  ]
}

/** 'test' -> 'test', 'prod' -> 'live'. The only place these two words are joined. */
export function providerModeFor(mode: PaytechMode): ProviderMode {
  return mode === 'prod' ? 'live' : 'test'
}

export interface PaytechConfig {
  /** PayTech's `env` wire value. Send this to the provider. */
  readonly env: PaytechMode
  /** What `payments.provider_mode` wants. Store this. */
  readonly providerMode: ProviderMode
  readonly apiKey: string
  readonly apiSecret: string
  /** True only when real money can move. Read this instead of comparing strings. */
  readonly isLive: boolean
}

/** A source of environment values — injectable so tests never mutate the real one. */
export type EnvLike = Record<string, string | undefined>

export class PaytechConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaytechConfigError'
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
 * Non-throwing, so a deploy-time gate and a health surface can ask without
 * handling an exception. Every message names variables; none contains a value.
 */
export function paytechConfigError(env: EnvLike = process.env): string | null {
  const rawMode = env.PAYTECH_MODE

  if (typeof rawMode !== 'string' || rawMode.trim().length === 0) {
    return "PAYTECH_MODE is not set. There is deliberately no default: set it to exactly 'test' or 'prod'."
  }

  // Exact match only. Accepting 'TEST' or ' prod ' would mean guessing at intent
  // in the one place where guessing can move real money.
  const mode = rawMode as PaytechMode
  if (!(PAYTECH_MODES as readonly string[]).includes(mode)) {
    return "PAYTECH_MODE must be exactly 'test' or 'prod'. Refusing to interpret the configured "
         + `value (${rawMode.length} characters, not an exact match).`
  }

  const missing = CREDENTIAL_SUFFIXES
    .map(s => paytechEnvName(mode, s))
    .filter(name => value(env, name) === undefined)

  if (missing.length > 0) {
    return `PAYTECH_MODE='${mode}' but ${missing.length} of 2 credentials for that mode are `
         + `missing: ${missing.join(', ')}. A partial credential set is never usable, so this `
         + 'fails closed.'
  }

  return null
}

/** Credentials present for a mode, as a count — never the values. */
export function paytechCredentialsPresent(mode: PaytechMode, env: EnvLike = process.env): number {
  return CREDENTIAL_SUFFIXES.filter(s => value(env, paytechEnvName(mode, s)) !== undefined).length
}

/** Safe diagnostics: which mode, and which variables are present. No values. */
export function describePaytechConfig(env: EnvLike = process.env): {
  mode: string | null
  valid: boolean
  error: string | null
  present: Record<PaytechMode, number>
} {
  const error = paytechConfigError(env)
  return {
    mode:    typeof env.PAYTECH_MODE === 'string' ? env.PAYTECH_MODE : null,
    valid:   error === null,
    error,
    present: { test: paytechCredentialsPresent('test', env), prod: paytechCredentialsPresent('prod', env) },
  }
}

/**
 * The resolved configuration, or a thrown `PaytechConfigError`.
 *
 * The returned object redacts itself if logged or serialised.
 */
export function resolvePaytechConfig(env: EnvLike = process.env): PaytechConfig {
  const error = paytechConfigError(env)
  if (error) throw new PaytechConfigError(error)

  const mode = env.PAYTECH_MODE as PaytechMode

  // Built from `mode`, so the other mode's variables are unreachable from here.
  const apiKey    = value(env, paytechEnvName(mode, 'API_KEY'))!
  const apiSecret = value(env, paytechEnvName(mode, 'API_SECRET'))!

  const providerMode = providerModeFor(mode)
  const redacted = `[PaytechConfig env=${mode} credentials=redacted]`

  return Object.freeze({
    env: mode,
    providerMode,
    apiKey,
    apiSecret,
    isLive: providerMode === 'live',
    toJSON:   () => ({ env: mode, providerMode, credentials: 'redacted' }),
    toString: () => redacted,
    [Symbol.for('nodejs.util.inspect.custom')]: () => redacted,
  }) as PaytechConfig
}
