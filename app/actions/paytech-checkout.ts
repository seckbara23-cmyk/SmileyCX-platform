'use server'
/**
 * PayTech checkout initiation — XP-PAYTECH-01 Phase C.
 *
 * Validates eligibility server-side, creates or reuses a PENDING payment row,
 * opens a PayTech hosted checkout, persists the provider token, and returns the
 * redirect URL. It grants no access right of any kind and cannot complete a
 * payment: `complete_payment()` is unreachable from here, and the only module
 * that may call it is `lib/payments/payment-completion.ts`.
 *
 * ── NOTHING THE BROWSER SENDS IS TRUSTED EXCEPT THE COURSE ID ─────────────
 *
 * The caller supplies a course id and nothing else. Price, currency, course
 * title, eligibility and the order reference are all derived on the server:
 *
 *   * the PRICE is read from `courses.price`, never from the request, so a
 *     tampered form cannot buy a course for less;
 *   * ELIGIBILITY goes through `resolveCourseAccessById()`, the single
 *     entitlement seam (XPA-6B / migration 037), so a learner who already has
 *     access is refused rather than charged twice;
 *   * the REFERENCE is minted here and is what the IPN signature covers.
 *
 * ── THE TOKEN IS PERSISTED BEFORE THE LEARNER IS REDIRECTED ───────────────
 *
 * PayTech has no idempotency key, so a second `requestPayment()` opens a second
 * checkout. The order below is therefore deliberate: create the pending row,
 * call the provider, write the token onto the row, and only then hand the
 * learner a URL. If the token write fails we do NOT redirect — a checkout the
 * learner can pay but we cannot correlate is the one outcome worth refusing a
 * sale over, because `provider_token` is the replay key the IPN correlates on
 * and an unrecorded payment cannot be fulfilled.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import { requestPayment, PaytechApiError, PAYTECH_CURRENCY } from '@/lib/payments/paytech-client'
import { resolvePaytechConfig } from '@/lib/payments/paytech-config'
import { paytechAvailability } from '@/lib/payments/providers'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'
import { PUBLIC_SITE_URL } from '@/lib/brand'

const log = createLogger('actions/paytech-checkout')

export interface PaytechCheckoutResult {
  /** Where to send the learner. Always HTTPS on paytech.sn when present. */
  redirectUrl?: string
  /** A French, non-leaking message. Never a provider string. */
  error?: string
}

/**
 * Which origin the provider should call back to — XP-PAYTECH-03.
 *
 * ── THE DEFECT THIS FIXES ─────────────────────────────────────────────────
 *
 * `PUBLIC_SITE_URL` is deliberately "never the Vercel deployment host": it is
 * the canonical marketing origin, used for metadata, sitemaps and certificate
 * links, and it is correct for those. Deriving the PAYMENT callbacks from it
 * meant a PREVIEW checkout told PayTech to notify
 * `https://www.xpclient-academy.com/...` — production. So a sandbox payment
 * started on a preview deployment could never notify the deployment that
 * created it, and its notification would be addressed to production instead.
 *
 * ── RESOLUTION ORDER ──────────────────────────────────────────────────────
 *
 *   1. `PAYTECH_CALLBACK_BASE_URL` — the operator's explicit pin, and the one
 *      that actually matters for sandbox UAT. A per-deployment preview URL
 *      changes on every push, while PayTech's merchant dashboard holds FIXED
 *      URLs, so UAT needs a stable origin an operator chooses deliberately
 *      (a branch alias, or a dedicated staging domain).
 *   2. On any non-production deployment, the deployment's own host
 *      (`VERCEL_URL`), so a preview addresses itself rather than production.
 *   3. `PUBLIC_SITE_URL` — production, and local development.
 *
 * Nothing here is trusted blindly: every URL this produces is checked by
 * `isValidCallbackUrl()` in the transport, which requires absolute HTTPS. A
 * misconfigured pin therefore REFUSES THE CHECKOUT rather than silently
 * falling back to production, which is the failure we want — a sale refused
 * loudly beats a notification delivered to the wrong environment.
 *
 * Production is keyed on `VERCEL_ENV`, not `NODE_ENV`, because a preview build
 * also runs with `NODE_ENV=production`.
 */
export function paytechCallbackBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const pinned = (env.PAYTECH_CALLBACK_BASE_URL ?? '').trim()
  if (pinned.length > 0) return pinned

  if ((env.VERCEL_ENV ?? '').trim() !== 'production') {
    const host = (env.VERCEL_URL ?? '').trim()
    // VERCEL_URL carries a bare host with no scheme.
    if (host.length > 0) return `https://${host}`
  }

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
 * Mint an order reference.
 *
 * Must be unique per order on PayTech's side, and it is one of the two values
 * the IPN signature covers, so it is generated server-side and never accepted
 * from a caller. The shape matches the existing `SCX-` references so the admin
 * payment views keep reading naturally.
 */
export function mintReference(now: number = Date.now()): string {
  const stamp = now.toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `SCX-${stamp}-${rand}`
}

export async function startPaytechCheckout(input: {
  courseId: string
}): Promise<PaytechCheckoutResult> {
  // ── 1. is PayTech even offerable here? ──
  const availability = paytechAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'PayTech checkout refused: provider unavailable')
    return { error: "Ce moyen de paiement n'est pas disponible actuellement." }
  }

  // ── 2. authentication ──
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Vous devez être connecté pour effectuer un achat.' }

  const parsed = UuidSchema.safeParse(input.courseId)
  if (!parsed.success) return { error: 'Formation introuvable.' }
  const courseId = parsed.data

  // ── 3. eligibility — the single entitlement seam ──
  // A learner who can already reach the material must not be charged for it.
  const access = await resolveCourseAccessById(courseId)
  if (access.allowed) {
    return { error: 'Vous avez déjà accès à cette formation.' }
  }
  if (access.reason === 'email_unverified') {
    return { error: 'Confirmez votre adresse email avant de régler une formation.' }
  }
  if (access.reason === 'account_inactive') {
    return { error: "Votre compte n'est pas actif. Contactez-nous." }
  }

  // ── 4. the authoritative course record ──
  const admin = createAdminClient()
  const { data: course } = await admin
    .from('courses')
    .select('id, title, price, currency, is_published')
    .eq('id', courseId)
    .maybeSingle()

  if (!course || !course.is_published) {
    return { error: 'Formation introuvable.' }
  }
  // The provider bills whole XOF francs and `complete_payment()` refuses any
  // other currency, so a course priced otherwise is refused rather than rounded.
  if (course.currency !== PAYTECH_CURRENCY) {
    log.error({ courseId }, 'course is not priced in XOF; refusing PayTech checkout')
    return { error: "Cette formation n'est pas réglable en ligne." }
  }
  if (!Number.isInteger(course.price) || course.price <= 0) {
    log.error({ courseId }, 'course price is not a positive whole number')
    return { error: "Cette formation n'est pas réglable en ligne." }
  }

  // ── 5. the pending intent ──
  // 058's partial unique index allows ONE live intent per learner per course, so
  // an existing pending row is reused rather than duplicated. Reuse keeps the
  // learner's original reference, which is what any already-issued signature
  // covers.
  const { data: existing } = await admin
    .from('payments')
    .select('id, reference, amount, status')
    .eq('user_id', user.id)
    .eq('course_id', courseId)
    .in('status', ['pending', 'processing'])
    .maybeSingle()

  let paymentId: string
  let reference: string

  if (existing) {
    paymentId = existing.id as string
    reference = existing.reference as string
    // The stored amount is authoritative for the signature, so a price change
    // since the intent was created must not silently re-price the order.
    if (existing.amount !== course.price) {
      log.warn({ paymentId }, 'pending intent amount differs from current course price')
      return { error: 'Le tarif de cette formation a changé. Contactez-nous pour finaliser.' }
    }
  } else {
    reference = mintReference()
    const { data: created, error: insertError } = await admin
      .from('payments')
      .insert({
        user_id:    user.id,
        course_id:  courseId,
        amount:     course.price,       // server-side price only
        currency:   course.currency,
        method:     'card',             // PayTech offers the instrument choice itself
        status:     'pending',
        reference,
        metadata:   { provider: 'paytech' },
      })
      .select('id')
      .single()

    if (insertError || !created) {
      log.error({ userId: user.id, courseId }, 'could not create the pending payment intent')
      return { error: "L'initialisation du paiement a échoué. Veuillez réessayer." }
    }
    paymentId = created.id as string
  }

  // ── 6. open the hosted checkout ──
  const config = resolvePaytechConfig()
  const urls = paytechCallbackUrls()

  let checkout
  try {
    checkout = await requestPayment({
      itemPrice:   course.price,
      itemName:    String(course.title).slice(0, 120),
      commandName: `XP Client Academy — ${String(course.title)}`.slice(0, 160),
      refCommand:  reference,
      ipnUrl:      urls.ipnUrl,
      successUrl:  urls.successUrl,
      cancelUrl:   urls.cancelUrl,
      // Echoed back on the IPN. Correlation data only — never anything secret,
      // and never anything we would trust on the way back.
      customField: { payment_id: paymentId, course_id: courseId },
    })
  } catch (err) {
    const reason = err instanceof PaytechApiError ? err.reason : 'unexpected'
    log.error({ paymentId, reason }, 'PayTech refused to open a checkout')
    return { error: "Le service de paiement est momentanément indisponible. Veuillez réessayer." }
  }

  // ── 7. persist the correlation key BEFORE redirecting ──
  const { error: tokenError } = await admin
    .from('payments')
    .update({
      provider:           'paytech',
      provider_mode:      checkout.providerMode,
      provider_token:     checkout.token,
      provider_reference: reference,
      status:             'processing',
    })
    .eq('id', paymentId)

  if (tokenError) {
    // Refusing the sale is the correct outcome: the learner could pay a checkout
    // whose token we never stored, and the IPN would then arrive for a payment
    // we cannot find.
    log.error({ paymentId }, 'could not persist the PayTech token; refusing to redirect')
    return { error: "L'initialisation du paiement a échoué. Veuillez réessayer." }
  }

  log.info(
    { paymentId, providerMode: checkout.providerMode, isLive: config.isLive },
    'PayTech checkout opened',
  )

  return { redirectUrl: checkout.redirectUrl }
}
