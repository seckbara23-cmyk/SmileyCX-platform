import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import RegisterForm from './RegisterForm'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/versions'
import { isCommercialHost } from '@/lib/hosts'

export const metadata: Metadata = {
  title:       'Créer un compte',
  description: 'Créez votre compte XP Client Academy.',
  robots:      { index: false, follow: false },
}

/**
 * /signup — public learner registration (XPA-6A).
 *
 * ── WHAT CHANGED, AND WHAT DID NOT ────────────────────────────────────────
 * Until now this page was an access-REQUEST form: the platform was invite-only
 * and accounts were created by an administrator. Ratified decisions 1 and 2
 * open registration to individuals on the commercial domain, so this is now a
 * real registration form.
 *
 * The SEC-1 remediation is NOT being unwound. What made SEC-1 a finding was not
 * "the public could register" — it was that registration was a CLIENT-side call
 * straight to Supabase with no validation, no rate limit, no audit trail and a
 * client-supplied role. All of that stays closed:
 *
 *   * Supabase `disable_signup` remains TRUE, so POST /auth/v1/signup is still
 *     refused for everyone, and the deploy gate still fails the build if it is
 *     ever switched off.
 *   * Registration is a SERVER ACTION using the admin API, behind Zod
 *     validation, a CAPTCHA seam, per-IP and per-email rate limiting, versioned
 *     legal acceptance and full auditing.
 *   * `platform_role` is written server-side from a literal and is not a field
 *     the browser can send.
 *
 * ── AND IT GRANTS NOTHING ─────────────────────────────────────────────────
 * A new account has no enrollment, no entitlement, no payment and no course
 * access. Decision 4: Account != Payment != Enrollment != Access.
 */
export default async function SignupPage() {
  // Belt and braces with the middleware host boundary, which already blocks
  // this path on the internal host. The server ACTION performs the same check
  // independently, because an action can be invoked without this page ever
  // rendering — a redirect in the browser is not an authorization control.
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (!isCommercialHost(host)) redirect('/login')

  return <RegisterForm termsVersion={TERMS_VERSION} privacyVersion={PRIVACY_VERSION} />
}
