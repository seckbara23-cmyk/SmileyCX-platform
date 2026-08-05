'use server'
/**
 * Public learner registration, verification and recovery (XPA-6A).
 *
 * ── WHY THIS IS A SERVER ACTION AND NOT `supabase.auth.signUp()` ──────────
 *
 * Supabase's `disable_signup` stays TRUE in production, permanently. That is
 * not an oversight to be flipped later — it is the control that closed SEC-1,
 * where registration was a client-side call straight to Supabase with no
 * validation, no rate limit, no audit record and a client-supplied role.
 * `POST /auth/v1/signup` remains closed to the internet and the deploy-time
 * gate (`npm run prebuild`) still fails the build if it is ever switched off.
 *
 * Public registration is therefore SERVER-OWNED. It runs through the admin API,
 * which is exempt from `disable_signup`, behind this pipeline:
 *
 *   commercial host → Zod → CAPTCHA seam → rate limit (IP + email)
 *     → current legal version check → createUser(unconfirmed)
 *     → legal acceptance (FAIL CLOSED) → profile (role forced to 'user')
 *     → verification email on the canonical domain → audit
 *
 * Opening `disable_signup` would have been three lines. It would also have
 * re-opened every one of those gaps at once.
 *
 * ── WHAT REGISTRATION DOES NOT DO ────────────────────────────────────────
 * No enrollment. No entitlement. No payment. No organization membership. No
 * role above 'user'. Decision 4: Account != Payment != Enrollment != Access.
 */

import { headers } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { verifyCaptcha, isCaptchaEnabled } from '@/lib/security/captcha'
import { isCommercialHost } from '@/lib/hosts'
import { publicUrl } from '@/lib/brand'
import { sendVerificationEmail } from '@/lib/email'
import { createLogger } from '@/lib/logger'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/versions'
import {
  RegistrationSchema,
  ResendVerificationSchema,
  ForgotPasswordSchema,
} from '@/lib/validation/schemas'

const log = createLogger('actions/auth')

// Registrations per IP per hour, and per email address per hour. The email
// limit is what stops an attacker from using registration as a mail cannon
// against one victim; the IP limit bounds bulk account creation.
const REGISTER_IP_LIMIT    = { limit: 5,  windowMs: 60 * 60 * 1000 }
const REGISTER_EMAIL_LIMIT = { limit: 3,  windowMs: 60 * 60 * 1000 }
const RESEND_LIMIT         = { limit: 3,  windowMs: 15 * 60 * 1000 }
const RECOVERY_LIMIT       = { limit: 5,  windowMs: 60 * 60 * 1000 }

export interface AuthActionResult {
  ok:      boolean
  /** User-facing message. Deliberately identical across enumeration-sensitive outcomes. */
  message?: string
  /** Field-level validation errors, safe to display. */
  errors?: Record<string, string>
}

/**
 * The single response returned for EVERY outcome of a registration attempt that
 * is not a client-side validation error: success, duplicate email, provider
 * error, mail failure. An attacker learns nothing about which addresses exist.
 */
const NEUTRAL_REGISTRATION_MESSAGE =
  'Si cette adresse peut être utilisée, un email de confirmation vient de vous être envoyé. Vérifiez votre boîte de réception, ainsi que vos spams.'

const NEUTRAL_RECOVERY_MESSAGE =
  'Si un compte existe pour cette adresse, un email de réinitialisation vient de vous être envoyé.'

// ── Request context ─────────────────────────────────────────────────────────

async function requestContext() {
  const h = await headers()
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').toLowerCase()
  const ip =
    h.get('x-forwarded-for')?.split(',')[0].trim() ??
    h.get('x-real-ip') ??
    'unknown'
  // Truncated: a user agent is forensic context, not a fingerprint to retain in full.
  const userAgent = (h.get('user-agent') ?? '').slice(0, 256)
  return { host, ip, userAgent }
}

// ── Registration ────────────────────────────────────────────────────────────

export async function registerLearner(input: {
  firstName: string
  lastName: string
  email: string
  password: string
  confirmPassword: string
  acceptedTermsVersion: string
  acceptedPrivacyVersion: string
  captchaToken?: string
}): Promise<AuthActionResult> {
  const { host, ip, userAgent } = await requestContext()

  // ── Commercial domain only ────────────────────────────────────────────
  // The internal host is for the owner, the developer and administration.
  // Learner registration has no business being reachable there. The middleware
  // host boundary already blocks the PAGE; this blocks the ACTION, because a
  // server action can be invoked without ever rendering its page.
  if (!isCommercialHost(host)) {
    await logAuditEvent({
      eventType: 'user.registration_blocked',
      actorType: 'anonymous',
      method:    'self_registration',
      outcome:   'failure',
      reason:    'registration attempted on a non-commercial host',
      ip,
      userAgent,
      metadata:  { host },
    })
    return { ok: false, message: "L'inscription n'est pas disponible sur ce domaine." }
  }

  // ── Validation ────────────────────────────────────────────────────────
  const parsed = RegistrationSchema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form')
      if (!errors[key]) errors[key] = issue.message
    }
    return { ok: false, errors, message: 'Veuillez corriger les champs indiqués.' }
  }
  const data = parsed.data
  const email = data.email.trim().toLowerCase()

  // ── Bot mitigation seam ───────────────────────────────────────────────
  const captcha = await verifyCaptcha(data.captchaToken, ip)
  if (!captcha.ok) {
    await logAuditEvent({
      eventType:    'user.registration_blocked',
      actorType:    'anonymous',
      subjectEmail: email,
      method:       'self_registration',
      outcome:      'failure',
      reason:       `captcha: ${captcha.reason ?? 'rejected'}`,
      ip,
      userAgent,
    })
    return { ok: false, message: 'Vérification anti-robot échouée. Réessayez.' }
  }

  // ── Rate limiting ─────────────────────────────────────────────────────
  const [byIp, byEmail] = await Promise.all([
    rateLimitDb(`register:ip:${ip}`, REGISTER_IP_LIMIT),
    rateLimitDb(`register:email:${email}`, REGISTER_EMAIL_LIMIT),
  ])
  if (!byIp.success || !byEmail.success) {
    await logAuditEvent({
      eventType:    'user.registration_blocked',
      actorType:    'anonymous',
      subjectEmail: email,
      method:       'self_registration',
      outcome:      'failure',
      reason:       'rate limit exceeded',
      ip,
      userAgent,
    })
    return { ok: false, message: 'Trop de tentatives. Réessayez dans quelques minutes.' }
  }

  // ── Legal acceptance must be for the CURRENT documents ────────────────
  // A stale form must not be able to record acceptance of text the user never
  // saw. This is checked before the account exists, so a version mismatch
  // creates nothing.
  if (
    data.acceptedTermsVersion !== TERMS_VERSION ||
    data.acceptedPrivacyVersion !== PRIVACY_VERSION
  ) {
    return {
      ok: false,
      message:
        'Les conditions ont été mises à jour. Rechargez la page et acceptez la version en vigueur.',
    }
  }

  const admin = createAdminClient()

  // ── Create the auth user, explicitly UNCONFIRMED ──────────────────────
  // email_confirm: false is load-bearing. Verified against this project:
  // GoTrue refuses password sign-in for an unconfirmed user with
  // `email_not_confirmed`, even though the project has mailer_autoconfirm on
  // (that setting governs the self-signup endpoint, which stays closed).
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: data.password,
    email_confirm: false,
    user_metadata: {
      full_name:  `${data.firstName} ${data.lastName}`.trim(),
      first_name: data.firstName,
      last_name:  data.lastName,
    },
  })

  if (createError || !created?.user) {
    // Almost always "user already registered". Audited in full, reported
    // neutrally: the audit trail is for us, the response is for an attacker.
    await logAuditEvent({
      eventType:    'user.registered',
      actorType:    'self',
      subjectEmail: email,
      method:       'self_registration',
      outcome:      'failure',
      reason:       createError?.message ?? 'createUser returned no user',
      ip,
      userAgent,
    })
    return { ok: true, message: NEUTRAL_REGISTRATION_MESSAGE }
  }

  const userId = created.user.id

  // ── Legal acceptance — FAIL CLOSED ────────────────────────────────────
  // If acceptance cannot be recorded, the account must not exist. Registering
  // someone whose consent we cannot evidence is worse than failing the
  // registration, so the just-created user is destroyed and the attempt is
  // reported as a plain error rather than as neutral success.
  const acceptedAt = new Date().toISOString()
  const { error: legalError } = await admin.from('legal_acceptances').insert([
    { user_id: userId, document: 'terms',   version: TERMS_VERSION,   accepted_at: acceptedAt, ip, user_agent: userAgent },
    { user_id: userId, document: 'privacy', version: PRIVACY_VERSION, accepted_at: acceptedAt, ip, user_agent: userAgent },
  ])

  if (legalError) {
    log.error({ err: legalError.message, userId }, 'legal acceptance write failed — rolling back registration')
    await admin.auth.admin.deleteUser(userId).catch(err =>
      log.error({ err, userId }, 'rollback deleteUser failed — ORPHAN ACCOUNT, manual cleanup required'),
    )
    await logAuditEvent({
      eventType:    'user.registered',
      actorType:    'self',
      subjectEmail: email,
      method:       'self_registration',
      outcome:      'failure',
      reason:       'legal acceptance could not be recorded — registration rolled back',
      ip,
      userAgent,
    })
    return {
      ok: false,
      message: "Votre inscription n'a pas pu être finalisée. Réessayez dans quelques instants.",
    }
  }

  // ── Profile ───────────────────────────────────────────────────────────
  // Idempotent: a database trigger already creates the row on user creation,
  // so this is an upsert that fills in the details.
  //
  // platform_role is set to 'user' HERE, server-side, from a literal. It is
  // never read from the request — that is the F-2 lesson, and it is why the
  // registration input schema has no role field to ignore in the first place.
  const { error: profileError } = await admin.from('profiles').upsert(
    {
      id:                       userId,
      email,
      full_name:                `${data.firstName} ${data.lastName}`.trim(),
      first_name:               data.firstName,
      last_name:                data.lastName,
      display_name:             data.firstName,
      platform_role:            'user',
      account_status:           'active',
      accepted_terms_version:   TERMS_VERSION,
      accepted_privacy_version: PRIVACY_VERSION,
    },
    { onConflict: 'id' },
  )

  if (profileError) {
    // Non-fatal: the trigger-created row exists and the account is usable. Loud
    // in the logs because the profile is incomplete until it is repaired.
    log.error({ err: profileError.message, userId }, 'profile upsert failed after registration')
  }

  await logAuditEvent({
    eventType:     'user.legal_accepted',
    actorType:     'self',
    subjectUserId: userId,
    subjectEmail:  email,
    method:        'self_registration',
    outcome:       'success',
    ip,
    userAgent,
    metadata:      { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
  })

  // ── Verification email, on the canonical domain ───────────────────────
  const sent = await dispatchVerificationEmail(email, data.firstName)

  await logAuditEvent({
    eventType:     'user.registered',
    actorType:     'self',
    subjectUserId: userId,
    subjectEmail:  email,
    method:        'self_registration',
    outcome:       'success',
    ip,
    userAgent,
    metadata:      {
      platformRole:      'user',
      emailConfirmed:    false,
      verificationSent:  sent,
      captchaProvider:   isCaptchaEnabled() ? 'enabled' : 'disabled',
      enrollmentCreated: false,
      entitlementGranted: false,
    },
  })

  return { ok: true, message: NEUTRAL_REGISTRATION_MESSAGE }
}

// ── Verification email dispatch ─────────────────────────────────────────────

/**
 * Mint a single-use verification token and send it from OUR mail template.
 *
 * The link is composed here from PUBLIC_SITE_URL, so it is structurally
 * incapable of carrying the internal hostname — it does not read the request
 * origin at all. That is the fix for the class of bug where a learner who was
 * served by a preview deployment receives a preview-domain link.
 *
 * Verified against this project: `generateLink({ type: 'signup' })` returns a
 * `hashed_token` that `verifyOtp({ type: 'signup' })` accepts exactly once
 * (replay → 403 otp_expired) and which sets `email_confirmed_at`.
 */
async function dispatchVerificationEmail(email: string, firstName: string): Promise<boolean> {
  const admin = createAdminClient()

  const { data, error } = await admin.auth.admin.generateLink({
    type:     'signup',
    email,
    // The API requires a password for type 'signup'. The account already
    // exists, and this value is NOT applied to it — verified against this
    // project: after generating a link with a different password, the
    // learner's chosen password still authenticates and this one is rejected
    // as invalid_credentials. A random throwaway is passed so that no
    // meaningful secret is transmitted even so.
    password: cryptoRandomString(),
  })

  const hashedToken = data?.properties?.hashed_token
  if (error || !hashedToken) {
    log.error({ err: error?.message }, 'Failed to generate verification token')
    return false
  }

  const verifyUrl = publicUrl(
    `/auth/verify?token_hash=${encodeURIComponent(hashedToken)}&type=signup`,
  )

  const result = await sendVerificationEmail(email, { firstName, verifyUrl })
  if (!result.success) {
    log.error({ to: email, err: result.error }, 'Failed to send verification email')
    return false
  }
  return true
}

function cryptoRandomString(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return `Xp!${Buffer.from(bytes).toString('base64url')}`
}

// ── Resend verification ─────────────────────────────────────────────────────

export async function resendVerification(input: {
  email: string
  captchaToken?: string
}): Promise<AuthActionResult> {
  const { ip, userAgent } = await requestContext()

  const parsed = ResendVerificationSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: 'Adresse email invalide.' }
  }
  const email = parsed.data.email.trim().toLowerCase()

  const captcha = await verifyCaptcha(parsed.data.captchaToken, ip)
  if (!captcha.ok) {
    return { ok: false, message: 'Vérification anti-robot échouée. Réessayez.' }
  }

  const rl = await rateLimitDb(`verify-resend:${email}`, RESEND_LIMIT)
  if (!rl.success) {
    await logAuditEvent({
      eventType:    'user.verification_resent',
      actorType:    'anonymous',
      subjectEmail: email,
      method:       'self_service',
      outcome:      'failure',
      reason:       'rate limit exceeded',
      ip,
      userAgent,
    })
    // Same neutral wording as success: the rate-limit response must not become
    // an oracle for "this address exists and is unverified".
    return { ok: true, message: NEUTRAL_REGISTRATION_MESSAGE }
  }

  const sent = await dispatchVerificationEmail(email, '')

  await logAuditEvent({
    eventType:    'user.verification_resent',
    actorType:    'anonymous',
    subjectEmail: email,
    method:       'self_service',
    outcome:      sent ? 'success' : 'failure',
    reason:       sent ? null : 'token generation or delivery failed',
    ip,
    userAgent,
  })

  return { ok: true, message: NEUTRAL_REGISTRATION_MESSAGE }
}

// ── Password recovery ───────────────────────────────────────────────────────

/**
 * Server-owned password recovery.
 *
 * The previous flow called `resetPasswordForEmail` from the browser with
 * `redirectTo: location.origin`, which meant an owner who requested recovery
 * while on the internal host received an internal-host link. It also could not
 * be rate limited or audited, because the application server was never in the
 * request path.
 *
 * The redirect target is now composed from PUBLIC_SITE_URL and cannot reflect
 * the request origin.
 */
export async function requestPasswordReset(input: {
  email: string
  captchaToken?: string
}): Promise<AuthActionResult> {
  const { ip, userAgent } = await requestContext()

  const parsed = ForgotPasswordSchema.safeParse(input)
  if (!parsed.success) {
    // Neutral even here: a malformed address must not be distinguishable from
    // a well-formed one that does not exist.
    return { ok: true, message: NEUTRAL_RECOVERY_MESSAGE }
  }
  const email = parsed.data.email.trim().toLowerCase()

  const captcha = await verifyCaptcha(input.captchaToken, ip)
  if (!captcha.ok) {
    return { ok: false, message: 'Vérification anti-robot échouée. Réessayez.' }
  }

  const rl = await rateLimitDb(`password-reset:${email}`, RECOVERY_LIMIT)
  if (!rl.success) {
    await logAuditEvent({
      eventType:    'user.password_reset_requested',
      actorType:    'anonymous',
      subjectEmail: email,
      method:       'self_service',
      outcome:      'failure',
      reason:       'rate limit exceeded',
      ip,
      userAgent,
    })
    return { ok: true, message: NEUTRAL_RECOVERY_MESSAGE }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: publicUrl('/auth/callback?next=/reset-password&type=recovery'),
  })

  await logAuditEvent({
    eventType:    'user.password_reset_requested',
    actorType:    'anonymous',
    subjectEmail: email,
    method:       'self_service',
    outcome:      error ? 'failure' : 'success',
    reason:       error?.message ?? null,
    ip,
    userAgent,
  })

  return { ok: true, message: NEUTRAL_RECOVERY_MESSAGE }
}
