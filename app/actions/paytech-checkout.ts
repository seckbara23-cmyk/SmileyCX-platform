'use server'
/**
 * PayTech checkout initiation — XP-PAYTECH-01, rebuilt by XP-PAYTECH-04.
 *
 * Validates eligibility on the server, opens AT MOST ONE chargeable PayTech
 * checkout per learner per course at a time, persists the provider token, and
 * returns the redirect URL. It grants no access right and cannot complete a
 * payment by itself: completion is `paytech-reconcile.ts` → the single
 * chokepoint → migration 062.
 *
 * ── NOTHING THE BROWSER SENDS IS TRUSTED EXCEPT THE COURSE ID ─────────────
 *
 * Price, currency (XOF only), title, eligibility, the payer and the order
 * reference are all derived here. Extra fields in the call are ignored.
 *
 * ── ONE CHARGEABLE ATTEMPT AT A TIME (safeguard 1) ────────────────────────
 *
 * An attempt that was OPENED (a token was stored and a URL handed
 * out) may have been paid, so it is never superseded on a guess. Checkout asks
 * the provider, through the confirmed contract, what happened to it:
 *
 *   paid               → the payment is completed now; the learner goes in
 *   failed / cancelled → it is closed, and a NEW attempt (new row, new
 *                        reference) may be opened
 *   pending            → the SAME checkout URL is offered again — not a new one
 *   unknown            → nothing is opened. The learner is told a payment is
 *                        being verified, with its reference. Only a confirmed
 *                        provider answer or a human's manual reconciliation
 *                        frees them.
 *
 * An attempt that was NEVER opened (no token, so no URL was ever handed out)
 * cannot have been paid, and may be closed and replaced.
 *
 * Every write is a compare-and-set, and migration 063 enforces the same
 * transitions in the database: `provider_token` is write-once and a completed
 * payment is final.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCourseAccessById } from '@/lib/auth/course-access'
import {
  requestPayment,
  PaytechApiError,
  PAYTECH_CURRENCY,
  PAYTECH_TIMEOUT_MS,
  isValidPaytechRedirectUrl,
} from '@/lib/payments/paytech-client'
import { resolvePaytechConfig } from '@/lib/payments/paytech-config'
import { paytechCheckoutAvailability } from '@/lib/payments/providers'
import { paymentDatabaseAuthority } from '@/lib/payments/payment-database-guard'
import { mintReference, paytechCallbackUrls } from '@/lib/payments/paytech-callbacks'
import { purchaseBlocker } from '@/lib/payments/purchase-eligibility'
import { closeUnopenedAttempt } from '@/lib/payments/payment-completion'
import { paymentExceptionBlock } from '@/lib/payments/payment-exceptions'
import {
  PAYTECH_PAYMENT_COLUMNS,
  reconcilePaytechPayment,
  type PaytechPaymentRow,
} from '@/lib/payments/paytech-reconcile'
import { UuidSchema } from '@/lib/validation/schemas'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/paytech-checkout')

export interface PaytechCheckoutResult {
  /** Where to pay. Always HTTPS on paytech.sn when present. */
  redirectUrl?: string
  /** A same-site path the learner should go to instead (they now have access). */
  accessUrl?: string
  /** A French, non-leaking message. Never a provider string. */
  error?: string
  /** The order reference an error concerns, so support can find it. */
  reference?: string
}

/**
 * How long a never-opened intent is presumed to be mid-initialisation.
 * Longer than one provider round trip, so a concurrent click never closes an
 * attempt whose checkout is being opened right now.
 */
const INITIALISATION_GRACE_MS = 2 * PAYTECH_TIMEOUT_MS + 30_000

const MSG = {
  unavailable:  "Ce moyen de paiement n'est pas disponible actuellement.",
  signIn:       'Vous devez être connecté pour effectuer un achat.',
  notFound:     'Formation introuvable.',
  entitled:     'Vous avez déjà accès à cette formation.',
  unverified:   'Confirmez votre adresse email avant de régler une formation.',
  inactive:     "Votre compte n'est pas actif. Contactez-nous.",
  notPayable:   "Cette formation n'est pas réglable en ligne.",
  conflict:     "Votre accès à cette formation fait l'objet d'une régularisation. Contactez-nous avant tout paiement.",
  initialising: "Un paiement est en cours d'initialisation pour cette formation. Réessayez dans une minute.",
  verifying:    "Un paiement est déjà en cours de vérification pour cette formation. S'il a abouti, votre accès s'activera automatiquement dès sa confirmation ; sinon, contactez-nous en indiquant la référence ci-dessous. Aucun nouveau paiement n'a été créé.",
  failed:       "L'initialisation du paiement a échoué. Veuillez réessayer.",
  provider:     'Le service de paiement est momentanément indisponible. Veuillez réessayer.',
  inProgress:   'Un paiement est déjà en cours pour cette formation. Réessayez dans un instant.',
  exception:    "Un paiement précédent pour cette formation est en cours de vérification. Aucun nouveau paiement n'a été créé. Contactez-nous en indiquant la référence ci-dessous.",
} as const

export async function startPaytechCheckout(input: {
  courseId: string
}): Promise<PaytechCheckoutResult> {
  // ── 1. may this deployment take NEW payments? ──
  const availability = paytechCheckoutAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'PayTech checkout refused: checkout unavailable')
    return { error: MSG.unavailable }
  }

  // ── 2. who is paying — the session, never the request ──
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: MSG.signIn }

  // Nothing below may write unless this deployment may act on this database.
  if (!(await paymentDatabaseAuthority()).allowed) return { error: MSG.unavailable }

  const parsed = UuidSchema.safeParse(input?.courseId)
  if (!parsed.success) return { error: MSG.notFound }
  const courseId = parsed.data

  // ── 3. eligibility — the single entitlement seam ──
  const access = await resolveCourseAccessById(courseId)
  if (access.allowed) return { error: MSG.entitled }
  if (access.reason === 'email_unverified') return { error: MSG.unverified }
  if (access.reason === 'account_inactive') return { error: MSG.inactive }

  // ── 4. the authoritative course record ──
  const admin = createAdminClient()
  const { data: course } = await admin
    .from('courses')
    .select('id, slug, title, price, currency, is_published')
    .eq('id', courseId)
    .maybeSingle()

  if (!course || !course.is_published) return { error: MSG.notFound }
  if (course.currency !== PAYTECH_CURRENCY) {
    log.error({ courseId }, 'course is not priced in XOF; refusing PayTech checkout')
    return { error: MSG.notPayable }
  }
  const price = Number(course.price)
  if (!Number.isInteger(price) || price <= 0) {
    log.error({ courseId }, 'course price is not a positive whole number')
    return { error: MSG.notPayable }
  }
  const accessUrl = `/courses/${encodeURIComponent(String(course.slug))}`

  // ── 5. would 062 fulfil it? Refuse BEFORE the money moves (READY-F3) ──
  const blocker = await purchaseBlocker(user.id, courseId)
  if (blocker) {
    log.warn({ courseId, blocker }, 'PayTech checkout refused: completion would be refused')
    return { error: MSG.conflict }
  }

  // ── 5b. might an earlier, closed attempt have been paid? ──
  // Safeguard 1: another chargeable attempt could take the money twice. Checked
  // before the in-flight read, so it also stops the SAME checkout being re-offered.
  const held = await paymentExceptionBlock(user.id, courseId)
  if (held.unreadable) return { error: MSG.failed }
  if (held.reference) {
    log.warn({ courseId }, 'PayTech checkout refused: an open payment exception concerns this course')
    return { error: MSG.exception, reference: held.reference }
  }

  // ── 6. an attempt already in flight? ──
  const { data: inflight, error: inflightError } = await admin
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('user_id', user.id)
    .eq('course_id', courseId)
    .in('status', ['pending', 'processing'])
    .maybeSingle()

  if (inflightError) {
    log.error({ courseId }, 'could not read the in-flight payment')
    return { error: MSG.failed }
  }

  if (inflight) {
    const row = inflight as PaytechPaymentRow

    if (!row.provider_token) {
      // Never opened: no URL was handed out, so it cannot have been paid.
      const age = Date.now() - new Date(row.created_at).getTime()
      if (row.provider === 'paytech' && age < INITIALISATION_GRACE_MS) {
        return { error: MSG.initialising }
      }
      const { changed } = await closeUnopenedAttempt({
        paymentId:     row.id,
        failureReason: row.provider === 'paytech' ? 'superseded_unopened' : 'superseded_legacy_intent',
      })
      if (!changed) return { error: MSG.inProgress }
      // fall through to a fresh attempt
    } else if (row.provider !== 'paytech') {
      // Opened with another provider. Not ours to judge.
      return { error: MSG.verifying, reference: row.reference }
    } else {
      // Opened: it may have been paid. Ask; never supersede on a guess.
      const result = await reconcilePaytechPayment(row, { source: 'checkout' })
      switch (result.kind) {
        case 'completed':
        case 'already_completed':
          return { accessUrl }
        case 'failed':
        case 'cancelled':
        case 'already_terminal':
          break   // reliably closed — a fresh attempt may be opened
        case 'pending': {
          const url = await storedCheckoutUrl(row.id)
          if (url) return { redirectUrl: url }   // the SAME checkout, not a new one
          return { error: MSG.verifying, reference: row.reference }
        }
        default:
          log.warn({ paymentId: row.id, result: result.kind }, 'PayTech checkout refused: earlier attempt unresolved')
          return { error: MSG.verifying, reference: row.reference }
      }
    }
  }

  // ── 7. re-check access AFTER the in-flight read (safeguard 5) ──
  // The check in step 3 ran before step 6. If an earlier attempt completed in
  // between — its notification, the sweep or an admin verify — step 6 found
  // nothing in flight and we would open a SECOND chargeable checkout for a
  // learner who now owns the course. Once step 6 has seen no attempt in
  // flight, any completion has already committed its entitlement (062 writes
  // both in one transaction), so this read is guaranteed to see it.
  const recheck = await resolveCourseAccessById(courseId)
  if (recheck.allowed) return { accessUrl }
  if (await purchaseBlocker(user.id, courseId)) return { error: MSG.conflict }
  const heldNow = await paymentExceptionBlock(user.id, courseId)
  if (heldNow.unreadable) return { error: MSG.failed }
  if (heldNow.reference) return { error: MSG.exception, reference: heldNow.reference }

  return openAttempt({ userId: user.id, course: { id: courseId, title: String(course.title), price } })
}

/** The checkout URL stored with an opened attempt, if it is still a valid PayTech URL. */
async function storedCheckoutUrl(paymentId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from('payments')
    .select('metadata')
    .eq('id', paymentId)
    .maybeSingle()
  const url = (data?.metadata as { checkoutUrl?: unknown } | null)?.checkoutUrl
  return isValidPaytechRedirectUrl(url) ? url : null
}

/**
 * Open ONE new attempt: a fresh row with a fresh reference, then the provider,
 * then the token — and only then a URL for the learner.
 */
async function openAttempt(args: {
  userId: string
  course: { id: string; title: string; price: number }
}): Promise<PaytechCheckoutResult> {
  const admin = createAdminClient()
  const config = resolvePaytechConfig()
  const reference = mintReference()

  // Provider identity is recorded at creation and never changes (063).
  const { data: created, error: insertError } = await admin
    .from('payments')
    .insert({
      user_id:       args.userId,
      course_id:     args.course.id,
      amount:        args.course.price,      // server-side price only
      currency:      PAYTECH_CURRENCY,
      method:        'card',                 // the payer chooses the instrument at PayTech
      status:        'pending',
      reference,
      provider:      'paytech',
      provider_mode: config.providerMode,
      metadata:      { provider: 'paytech' },
    })
    .select('id')
    .single()

  if (insertError || !created) {
    // 23505 on 058's in-flight index: a concurrent click created the attempt.
    // Nothing was sent to the provider.
    if ((insertError as { code?: string } | null)?.code === '23505') return { error: MSG.inProgress }
    log.error({ courseId: args.course.id }, 'could not create the pending payment intent')
    return { error: MSG.failed }
  }
  const paymentId = created.id as string

  const urls = paytechCallbackUrls()
  let checkout
  try {
    checkout = await requestPayment({
      itemPrice:   args.course.price,
      itemName:    args.course.title.slice(0, 120),
      commandName: `XP Client Academy — ${args.course.title}`.slice(0, 160),
      refCommand:  reference,
      ipnUrl:      urls.ipnUrl,
      successUrl:  urls.successUrl,
      cancelUrl:   urls.cancelUrl,
      // Correlation only — never trusted on the way back, and never read by the IPN.
      customField: { payment_id: paymentId },
    })
  } catch (err) {
    const reason = err instanceof PaytechApiError ? err.reason : 'unexpected'
    log.error({ paymentId, reason }, 'PayTech refused to open a checkout')
    // Even on a timeout the learner never received a URL, so nothing can be
    // paid against this attempt. Close it so it cannot block the next click.
    await closeUnopenedAttempt({ paymentId, failureReason: `provider_request_${reason}` })
    return { error: MSG.provider }
  }

  // The provider call can take many seconds, and a report on an earlier attempt may
  // have landed meanwhile. No URL has been handed out yet, so nothing can be paid
  // against this attempt, and it can still be closed safely.
  const heldAfter = await paymentExceptionBlock(args.userId, args.course.id)
  if (heldAfter.unreadable || heldAfter.reference) {
    await closeUnopenedAttempt({ paymentId, failureReason: 'superseded_by_exception' })
    return heldAfter.reference ? { error: MSG.exception, reference: heldAfter.reference } : { error: MSG.failed }
  }

  // Persist the correlation key BEFORE handing out the URL — compare-and-set,
  // so a concurrent closure wins and this URL is never handed out.
  const { data: persisted, error: tokenError } = await admin
    .from('payments')
    .update({
      provider_token:     checkout.token,
      provider_reference: reference,
      status:             'processing',
      metadata:           { provider: 'paytech', checkoutUrl: checkout.redirectUrl },
    })
    .eq('id', paymentId)
    .eq('status', 'pending')
    .is('provider_token', null)
    .select('id')

  if (tokenError || !Array.isArray(persisted) || persisted.length !== 1) {
    log.error({ paymentId }, 'could not persist the PayTech token; refusing to redirect')
    return { error: MSG.failed }
  }

  log.info({ paymentId, providerMode: checkout.providerMode }, 'PayTech checkout opened')
  return { redirectUrl: checkout.redirectUrl }
}
