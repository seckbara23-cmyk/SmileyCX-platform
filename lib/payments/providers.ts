import 'server-only'
import { paytechConfigError } from '@/lib/payments/paytech-config'
import { paydunyaConfigError } from '@/lib/payments/paydunya-config'
import type { EnvLike } from '@/lib/payments/paytech-config'

/**
 * Which payment work this deployment may do — XP-PAYTECH-01, split by XP-PAYTECH-04.
 *
 * ── TWO QUESTIONS, NOT ONE ────────────────────────────────────────────────
 *
 * XP-PAYTECH-01 had a single switch, `PAYTECH_ENABLED`, gating BOTH new
 * checkouts and the notification endpoint. So the only way to stop selling was
 * to stop processing — and a payment already taken would then have its
 * notification refused. Stopping sales must never strand money already paid
 * (XP-PAYTECH-04 safeguard 2). There are now two answers:
 *
 *   * `paytechProcessingAvailability()` — may this deployment confirm and
 *     record PayTech payments that ALREADY EXIST (the IPN, the reconciliation
 *     sweep, the admin "verify" action)? Credentials + a mode that belongs to
 *     this environment. No sales switch is consulted.
 *
 *   * `paytechCheckoutAvailability()` — may this deployment open NEW
 *     checkouts? Everything processing needs, PLUS `PAYTECH_CHECKOUT_ENABLED`,
 *     PLUS (in production) `PAYTECH_ALLOW_PRODUCTION`.
 *
 * ── TEST AND LIVE BELONG TO DIFFERENT ENVIRONMENTS ────────────────────────
 *
 * PayTech's test mode debits a real 100–150 CFA whatever the price and must
 * not be used for public transactions; its live mode moves real money. So:
 *
 *   production  (VERCEL_ENV=production)  → PAYTECH_MODE must be 'prod'
 *   anything else                         → PAYTECH_MODE must NOT be 'prod'
 *
 * Both directions are refused here and again at deploy time
 * (`verify-prod-config.mjs`), and test mode a third time in the database
 * (migration 063).
 * Separately, `payment-database-guard.ts` refuses all payment work on any
 * non-production deployment whose database does not declare itself a sandbox.
 *
 * None of these is a `NEXT_PUBLIC_` variable. The answers are computed on the
 * server; the flags and credentials never reach the browser.
 */

export const PAYMENT_PROVIDERS = ['paydunya', 'paytech'] as const
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]

/** Every provider-selection variable this application recognises. */
export function providerFlagNames(): string[] {
  return ['PAYTECH_CHECKOUT_ENABLED', 'PAYTECH_ALLOW_PRODUCTION']
}

/** Exactly 'true', trimmed. Nothing else enables anything. */
function isTrue(env: EnvLike, name: string): boolean {
  return (env[name] ?? '').trim() === 'true'
}

/**
 * Is this deployment production?
 *
 * Keyed on `VERCEL_ENV`, not `NODE_ENV` — the same choice
 * `scripts/security/verify-prod-config.mjs` makes, and for the same reason: a
 * preview build also runs with NODE_ENV=production, so NODE_ENV cannot tell a
 * preview from the real thing and would gate the wrong deployments.
 */
export function isProductionDeployment(env: EnvLike = process.env): boolean {
  return (env.VERCEL_ENV ?? '').trim() === 'production'
}

/** Why PAYTECH_MODE does not belong to this environment, or null when it does. */
export function paytechModeEnvironmentError(env: EnvLike = process.env): string | null {
  const mode = (env.PAYTECH_MODE ?? '').trim()
  if (isProductionDeployment(env)) {
    return mode === 'prod' ? null : "this is production and PAYTECH_MODE is not 'prod'"
  }
  return mode === 'prod' ? "PAYTECH_MODE='prod' is refused outside production" : null
}

export interface ProviderAvailability {
  readonly available: boolean
  /** Why not, for logs and the operator report. Never shown to a learner. */
  readonly blockedBy: string | null
}

const OK: ProviderAvailability = Object.freeze({ available: true, blockedBy: null })

/** May this deployment confirm and record PayTech payments that already exist? */
export function paytechProcessingAvailability(env: EnvLike = process.env): ProviderAvailability {
  if (paytechConfigError(env) !== null) {
    return { available: false, blockedBy: 'PayTech credentials do not resolve' }
  }
  const modeError = paytechModeEnvironmentError(env)
  if (modeError !== null) return { available: false, blockedBy: modeError }
  return OK
}

/** May this deployment open NEW PayTech checkouts? */
export function paytechCheckoutAvailability(env: EnvLike = process.env): ProviderAvailability {
  if (!isTrue(env, 'PAYTECH_CHECKOUT_ENABLED')) {
    return { available: false, blockedBy: "PAYTECH_CHECKOUT_ENABLED is not 'true'" }
  }
  const processing = paytechProcessingAvailability(env)
  if (!processing.available) return processing
  if (isProductionDeployment(env) && !isTrue(env, 'PAYTECH_ALLOW_PRODUCTION')) {
    return {
      available: false,
      blockedBy: "this is production and PAYTECH_ALLOW_PRODUCTION is not 'true'",
    }
  }
  return OK
}

/**
 * Whether PayDunya may be offered here. Configuration alone, as before.
 *
 * Note PayDunya has no checkout and no notification route in this code base;
 * nothing renders it, and `availableProviders()` is not consulted by checkout.
 */
export function paydunyaAvailability(env: EnvLike = process.env): ProviderAvailability {
  const configError = paydunyaConfigError(env)
  if (configError !== null) {
    return { available: false, blockedBy: 'PayDunya credentials do not resolve' }
  }
  return OK
}

/** Whether a provider may take NEW payments here. */
export function providerAvailability(
  provider: PaymentProvider,
  env: EnvLike = process.env,
): ProviderAvailability {
  return provider === 'paytech' ? paytechCheckoutAvailability(env) : paydunyaAvailability(env)
}

/** The providers that may take new payments here, in display order. */
export function availableProviders(env: EnvLike = process.env): PaymentProvider[] {
  return PAYMENT_PROVIDERS.filter(p => providerAvailability(p, env).available)
}

/** Safe diagnostics for the operator report. Names conditions, never values. */
export function describeProviders(env: EnvLike = process.env): Record<
  PaymentProvider,
  ProviderAvailability
> & { paytechProcessing: ProviderAvailability } {
  return {
    paydunya:          paydunyaAvailability(env),
    paytech:           paytechCheckoutAvailability(env),
    paytechProcessing: paytechProcessingAvailability(env),
  }
}
