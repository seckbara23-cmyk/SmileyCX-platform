import 'server-only'
import { paytechConfigError } from '@/lib/payments/paytech-config'
import { paydunyaConfigError } from '@/lib/payments/paydunya-config'
import type { EnvLike } from '@/lib/payments/paytech-config'

/**
 * Which payment providers this deployment may offer — XP-PAYTECH-01 Phase F.
 *
 * ── WHY A SERVER-ONLY FLAG AND NOT A CHECKOUT REDESIGN ────────────────────
 *
 * PayTech's merchant account is created but PRODUCTION APPROVAL IS NOT
 * CONFIRMED, and the IPN signature format rests on a single documentation
 * source (see `paytech-ipn.ts`). So PayTech must be reachable for controlled
 * sandbox UAT and unreachable in production, with no code change in between
 * and no way for a preview flag to leak into production by accident.
 *
 * Three independent conditions must ALL hold before PayTech is offered. Each
 * fails closed on absence, which is the house rule every other flag in this
 * codebase follows:
 *
 *   1. `PAYTECH_ENABLED` is exactly 'true'.
 *   2. PayTech's credentials actually resolve (`paytechConfigError()` is null).
 *      A checkout button for an unconfigured provider is a broken promise, so
 *      "configured" is part of "available" rather than discovered at click time.
 *   3. In production, `PAYTECH_ALLOW_PRODUCTION` is ALSO exactly 'true'.
 *      Enabling PayTech everywhere is therefore not enough to enable it in
 *      production: that takes a second, differently-named decision, which is
 *      what "production provider switching requires explicit approval" means
 *      in practice.
 *
 * Note none of these is a `NEXT_PUBLIC_` variable. The availability answer is
 * computed on the server and sent to the browser as a boolean; the credentials
 * and the flags never cross that boundary.
 *
 * PayDunya is deliberately untouched by all of this. Its availability is its
 * own configuration, exactly as before, so nothing here can change how
 * production behaves today.
 */

export const PAYMENT_PROVIDERS = ['paydunya', 'paytech'] as const
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]

/** Every provider-selection variable this application recognises. */
export function providerFlagNames(): string[] {
  return ['PAYTECH_ENABLED', 'PAYTECH_ALLOW_PRODUCTION']
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

export interface ProviderAvailability {
  readonly available: boolean
  /** Why not, for logs and the operator report. Never shown to a learner. */
  readonly blockedBy: string | null
}

/** Whether PayTech may be offered here, and if not, which condition failed. */
export function paytechAvailability(env: EnvLike = process.env): ProviderAvailability {
  if (!isTrue(env, 'PAYTECH_ENABLED')) {
    return { available: false, blockedBy: "PAYTECH_ENABLED is not 'true'" }
  }

  const configError = paytechConfigError(env)
  if (configError !== null) {
    return { available: false, blockedBy: 'PayTech credentials do not resolve' }
  }

  if (isProductionDeployment(env) && !isTrue(env, 'PAYTECH_ALLOW_PRODUCTION')) {
    return {
      available: false,
      blockedBy: "this is production and PAYTECH_ALLOW_PRODUCTION is not 'true'",
    }
  }

  return { available: true, blockedBy: null }
}

/** Whether PayDunya may be offered here. Unchanged behaviour: configuration alone. */
export function paydunyaAvailability(env: EnvLike = process.env): ProviderAvailability {
  const configError = paydunyaConfigError(env)
  if (configError !== null) {
    return { available: false, blockedBy: 'PayDunya credentials do not resolve' }
  }
  return { available: true, blockedBy: null }
}

export function providerAvailability(
  provider: PaymentProvider,
  env: EnvLike = process.env,
): ProviderAvailability {
  return provider === 'paytech' ? paytechAvailability(env) : paydunyaAvailability(env)
}

/**
 * The providers a learner may actually be offered, in display order.
 *
 * "No public checkout option may appear unless its provider is configured and
 * operational" is implemented by deriving the list from availability rather
 * than hard-coding it in a component.
 */
export function availableProviders(env: EnvLike = process.env): PaymentProvider[] {
  return PAYMENT_PROVIDERS.filter(p => providerAvailability(p, env).available)
}

/** Safe diagnostics for the operator report. Names conditions, never values. */
export function describeProviders(env: EnvLike = process.env): Record<
  PaymentProvider,
  ProviderAvailability
> {
  return {
    paydunya: paydunyaAvailability(env),
    paytech:  paytechAvailability(env),
  }
}
