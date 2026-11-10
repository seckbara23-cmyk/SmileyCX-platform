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
 *   pending            → the SAME checkout URL is offered again — not a new one —
 *                        and the result says so (`resumed`). PayTech's own
 *                        « Annuler » button only redirects the browser and
 *                        leaves the hosted page payable, so a cancelled
 *                        checkout is RESUMED here, never replaced (XP-LAUNCH-04)
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
 *
 * ── PACKS (XP-LAUNCH-FINAL-08, migration 065) ─────────────────────────────
 *
 * `startPaytechPackCheckout` sells a fixed pack as ONE payment: its price is the
 * pack row's, and completion opens every course of the pack for six months at the
 * same instant. The rule above becomes: at most one chargeable attempt per learner
 * and COURSE, across packs and single courses. A single-course checkout therefore
 * also settles an in-flight pack containing that course, and a pack checkout every
 * in-flight attempt for one of its courses, the same way: ask, never supersede on a
 * guess. Migration 065's `payments_offer_guard` refuses the overlap in the database
 * as well. A course already owned inside a pack is neither refunded nor replaced:
 * the learner must acknowledge exactly the owned courses the server finds, or
 * nothing is opened.
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
import {
  checkCheckoutConsent,
  checkoutConsentRecord,
  type CheckoutConsent,
  type CheckoutConsentRecord,
} from '@/lib/legal/checkout-consent'
import {
  packCodeFrom,
  loadPackForCheckout,
  packIdsContainingCourse,
  courseIdsOfPack,
} from '@/lib/commerce/packs'
import { createLogger } from '@/lib/logger'

const log = createLogger('actions/paytech-checkout')

export interface PaytechCheckoutResult {
  /** Where to pay. Always HTTPS on paytech.sn when present. */
  redirectUrl?: string
  /**
   * The redirect re-offers an attempt this learner had already opened: the SAME
   * hosted page, no new order, no new token. Absent for a new checkout.
   */
  resumed?: boolean
  /** A same-site path the learner should go to instead (they now have access). */
  accessUrl?: string
  /** A French, non-leaking message. Never a provider string. */
  error?: string
  /** The order reference the result concerns (an error, or a resumed attempt), so support can find it. */
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
  // XP-LAUNCH-FINAL-08 — packs.
  packInFlight: "Un paiement est déjà en cours pour un pack contenant cette formation. Terminez-le ou attendez sa confirmation ; aucun nouveau paiement n'a été créé.",
  courseInFlight: "Un paiement est déjà en cours pour une formation de ce pack. Terminez-le ou attendez sa confirmation ; aucun nouveau paiement n'a été créé.",
  packNotFound: 'Pack introuvable.',
  packNotPayable: "Ce pack n'est pas réglable en ligne pour le moment.",
  packOwned:    'Vous avez déjà accès à toutes les formations de ce pack.',
  packAck:      'Ce pack contient une formation que vous possédez déjà. Elle n’est ni remboursée ni remplacée : confirmez avoir lu l’avertissement avant de payer.',
  packAckChanged: 'Les formations que vous possédez ont changé depuis l’affichage de cette page. Rechargez-la et relisez l’avertissement avant de payer.',
  packEntitled: 'Vous avez maintenant accès à toutes les formations de ce pack.',
  // XP-LAUNCH-FINAL-11: the three boxes of CGV art. 4.
  consent:      'Cochez les trois cases (conditions générales, accès immédiat et âge) avant de payer.',
  consentStale: 'Les conditions ont été mises à jour depuis l’affichage de cette page. Rechargez-la et relisez-les avant de payer.',
} as const

export async function startPaytechCheckout(input: {
  courseId: string
  consent: CheckoutConsent | null
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

  // ── 2b. the three boxes of CGV art. 4, at the version this server offers ──
  // Before anything is read or asked of the provider, a resume included.
  const consentRefusal = consentRefused(input?.consent)
  if (consentRefusal) return { error: consentRefusal }

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
    // Paid → in; closed → a fresh attempt; pending → the SAME page, said to be a
    // resume; unknown → nothing opened. See settleInflight below.
    const settled = await settleInflight(inflight as PaytechPaymentRow, { sameProduct: true, accessUrl })
    if (settled) return settled
  }

  // ── 6b. a PACK in flight that contains this course? (065) ──
  // One chargeable attempt per learner and COURSE: a pack being paid would open this
  // course too. It is settled the same way, and never superseded on a guess.
  const containing = await inflightPacksContaining(user.id, courseId)
  if (containing === null) return { error: MSG.failed }
  for (const row of containing) {
    const settled = await settleInflight(row, { sameProduct: false, accessUrl, otherInFlight: MSG.packInFlight })
    if (settled) return settled
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

  return openAttempt({
    userId: user.id,
    product: { kind: 'course', id: courseId, title: String(course.title), price, courseIds: [courseId] },
    legal: checkoutConsentRecord(new Date()),
  })
}

/**
 * Buy a fixed pack — XP-LAUNCH-FINAL-08, migration 065.
 *
 * The browser sends the pack code and the ids of the courses it showed as already
 * owned. Everything else — the price, the composition, who is paying, what they own —
 * is derived here. `acknowledgedCourseIds` must equal, exactly, the owned courses the
 * server finds: the learner confirms the warning for THAT set, or nothing is opened.
 */
export async function startPaytechPackCheckout(input: {
  packCode: string
  acknowledgedCourseIds?: string[]
  consent: CheckoutConsent | null
}): Promise<PaytechCheckoutResult> {
  // ── 1. may this deployment take NEW payments? ──
  const availability = paytechCheckoutAvailability()
  if (!availability.available) {
    log.warn({ blockedBy: availability.blockedBy }, 'PayTech pack checkout refused: checkout unavailable')
    return { error: MSG.unavailable }
  }

  // ── 2. who is paying — the session, never the request ──
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: MSG.signIn }
  if (!(await paymentDatabaseAuthority()).allowed) return { error: MSG.unavailable }

  const code = packCodeFrom(input?.packCode)
  if (!code) return { error: MSG.packNotFound }

  // ── 2b. the three boxes of CGV art. 4 (as for a course) ──
  const consentRefusal = consentRefused(input?.consent)
  if (consentRefusal) return { error: consentRefusal }

  // ── 3. the authoritative pack: price and composition from the database ──
  const pack = await loadPackForCheckout(code)
  if (pack === undefined) return { error: MSG.failed }
  if (!pack || !pack.isPublished) return { error: MSG.packNotFound }
  if (pack.currency !== PAYTECH_CURRENCY || !Number.isInteger(pack.price) || pack.price <= 0) {
    log.error({ pack: pack.code }, 'pack price is not a positive whole number of XOF')
    return { error: MSG.packNotPayable }
  }
  // Every course must be published and priced in XOF: a pack is never sold short.
  if (pack.courses.length === 0 || pack.courses.some(c => !c.isPublished || c.currency !== PAYTECH_CURRENCY)) {
    log.error({ pack: pack.code }, 'a course of the pack is not sellable')
    return { error: MSG.packNotPayable }
  }
  const courseIds = pack.courses.map(c => c.id)
  const accessUrl = '/dashboard'

  // ── 4. eligibility, course by course — the single entitlement seam ──
  const owned = await ownedCourses(courseIds)
  if (owned === 'email_unverified') return { error: MSG.unverified }
  if (owned === 'account_inactive') return { error: MSG.inactive }
  if (owned.length === courseIds.length) return { error: MSG.packOwned }

  // ── 4b. the warning, acknowledged for exactly what the learner owns ──
  const acknowledged = acknowledgedIds(input?.acknowledgedCourseIds)
  if (acknowledged === null || !sameSet(acknowledged, owned)) {
    if (acknowledged !== null && acknowledged.length === 0 && owned.length > 0) {
      const titles = pack.courses.filter(c => owned.includes(c.id)).map(c => c.title).join(', ')
      return { error: `${MSG.packAck} (${titles})` }
    }
    return { error: MSG.packAckChanged }
  }

  // ── 5. would 065 fulfil it? Refuse BEFORE the money moves, for every course ──
  for (const courseId of courseIds) {
    const blocker = await purchaseBlocker(user.id, courseId)
    if (blocker) {
      log.warn({ pack: pack.code, blocker }, 'PayTech pack checkout refused: completion would be refused')
      return { error: MSG.conflict }
    }
  }

  // ── 5b. might an earlier, closed attempt for one of its courses have been paid? ──
  for (const courseId of courseIds) {
    const held = await paymentExceptionBlock(user.id, courseId)
    if (held.unreadable) return { error: MSG.failed }
    if (held.reference) return { error: MSG.exception, reference: held.reference }
  }

  // ── 6. this pack already in flight? ──
  const admin = createAdminClient()
  const { data: inflight, error: inflightError } = await admin
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('user_id', user.id)
    .eq('pack_id', pack.id)
    .in('status', ['pending', 'processing'])
    .maybeSingle()
  if (inflightError) {
    log.error({ pack: pack.code }, 'could not read the in-flight pack payment')
    return { error: MSG.failed }
  }
  if (inflight) {
    const settled = await settleInflight(inflight as PaytechPaymentRow, { sameProduct: true, accessUrl })
    if (settled) return settled
  }

  // ── 6b. any OTHER attempt in flight that would open one of its courses? ──
  const overlapping = await inflightOverlapping(user.id, pack.id, courseIds)
  if (overlapping === null) return { error: MSG.failed }
  for (const row of overlapping) {
    const settled = await settleInflight(row, { sameProduct: false, accessUrl, otherInFlight: MSG.courseInFlight })
    if (settled) return settled
  }

  // ── 7. re-check AFTER the in-flight reads (safeguard 5) ──
  const ownedNow = await ownedCourses(courseIds)
  if (ownedNow === 'email_unverified') return { error: MSG.unverified }
  if (ownedNow === 'account_inactive') return { error: MSG.inactive }
  if (ownedNow.length === courseIds.length) return { accessUrl }
  if (!sameSet(ownedNow, owned)) return { error: MSG.packAckChanged }
  for (const courseId of courseIds) {
    if (await purchaseBlocker(user.id, courseId)) return { error: MSG.conflict }
    const heldNow = await paymentExceptionBlock(user.id, courseId)
    if (heldNow.unreadable) return { error: MSG.failed }
    if (heldNow.reference) return { error: MSG.exception, reference: heldNow.reference }
  }

  return openAttempt({
    userId: user.id,
    product: {
      kind: 'pack', id: pack.id, title: pack.title, price: pack.price, courseIds,
      metadata: { code: pack.code, courseIds, ownedCourseIds: owned },
    },
    legal: checkoutConsentRecord(new Date()),
  })
}

// ── shared by both actions ──────────────────────────────────────────────────

/**
 * What to do with an attempt already in flight. `null` means: nothing stands in the
 * way, a fresh attempt may be opened. Never supersedes an OPENED attempt on a guess.
 *
 *   never opened, young  → « en cours d'initialisation »
 *   never opened, stale  → closed (it cannot have been paid), then null
 *   paid                 → the learner goes in
 *   failed / cancelled   → null
 *   pending              → the SAME product: the same hosted page, `resumed`;
 *                          another product: refused with its reference
 *   unknown              → nothing opened, « en cours de vérification »
 */
async function settleInflight(
  row: PaytechPaymentRow,
  opts: { sameProduct: boolean; accessUrl: string; otherInFlight?: string },
): Promise<PaytechCheckoutResult | null> {
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
    return null   // a fresh attempt may be opened
  }
  if (row.provider !== 'paytech') {
    // Opened with another provider. Not ours to judge.
    return { error: MSG.verifying, reference: row.reference }
  }

  // Opened: it may have been paid. Ask; never supersede on a guess.
  const result = await reconcilePaytechPayment(row, { source: 'checkout' })
  switch (result.kind) {
    case 'completed':
    case 'already_completed':
      return { accessUrl: opts.accessUrl }
    case 'failed':
    case 'cancelled':
    case 'already_terminal':
      return null   // reliably closed — a fresh attempt may be opened
    case 'pending': {
      if (!opts.sameProduct) {
        return { error: opts.otherInFlight ?? MSG.verifying, reference: row.reference }
      }
      const url = await storedCheckoutUrl(row.id)
      if (url) {
        // The SAME checkout, not a new one — and said to be, because the learner
        // may have left it by « Annuler » and would otherwise be sent back without a word.
        log.info({ paymentId: row.id }, 'PayTech checkout resumed: the same hosted page offered again')
        return { redirectUrl: url, resumed: true, reference: row.reference }
      }
      return { error: MSG.verifying, reference: row.reference }
    }
    default:
      log.warn({ paymentId: row.id, result: result.kind }, 'PayTech checkout refused: earlier attempt unresolved')
      return { error: MSG.verifying, reference: row.reference }
  }
}

/** The learner's in-flight PACK attempts whose pack contains this course. `null` if unreadable. */
async function inflightPacksContaining(userId: string, courseId: string): Promise<PaytechPaymentRow[] | null> {
  const packIds = await packIdsContainingCourse(courseId)
  if (packIds.length === 0) return []
  const { data, error } = await createAdminClient()
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .in('pack_id', packIds)
  if (error) {
    log.error({ courseId }, 'could not read the in-flight pack payments')
    return null
  }
  return (Array.isArray(data) ? (data as unknown as PaytechPaymentRow[]) : [])
    .filter(r => typeof r.pack_id === 'string' && packIds.includes(r.pack_id))
}

/**
 * The learner's OTHER in-flight attempts that would open a course of this pack: a
 * single course of it, or another pack sharing one of its courses. `null` if unreadable.
 */
async function inflightOverlapping(userId: string, packId: string, courseIds: string[]): Promise<PaytechPaymentRow[] | null> {
  const { data, error } = await createAdminClient()
    .from('payments')
    .select(PAYTECH_PAYMENT_COLUMNS)
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
  if (error) {
    log.error('could not read the in-flight payments of a pack buyer')
    return null
  }
  const rows = Array.isArray(data) ? (data as unknown as PaytechPaymentRow[]) : []
  const out: PaytechPaymentRow[] = []
  for (const r of rows) {
    if (typeof r.course_id === 'string' && courseIds.includes(r.course_id)) { out.push(r); continue }
    if (typeof r.pack_id === 'string' && r.pack_id !== packId) {
      const theirs = await courseIdsOfPack(r.pack_id)
      if (theirs.some(id => courseIds.includes(id))) out.push(r)
    }
  }
  return out
}

/** The courses of this list the signed-in learner can already open, or why none can be bought. */
async function ownedCourses(courseIds: string[]): Promise<string[] | 'email_unverified' | 'account_inactive'> {
  const owned: string[] = []
  for (const id of courseIds) {
    const access = await resolveCourseAccessById(id)
    if (access.allowed) { owned.push(id); continue }
    if (access.reason === 'email_unverified') return 'email_unverified'
    if (access.reason === 'account_inactive') return 'account_inactive'
  }
  return owned
}

/** The acknowledged ids as sent: an array of uuids, or null if the shape is wrong. */
function acknowledgedIds(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 20) return null
  const ids: string[] = []
  for (const v of raw) {
    const parsed = UuidSchema.safeParse(v)
    if (!parsed.success) return null
    ids.push(parsed.data)
  }
  return ids
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every(x => sb.has(x))
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

/** What an attempt buys: one course, or one pack (065). */
interface Product {
  kind: 'course' | 'pack'
  id: string
  title: string
  price: number
  /** Every course the attempt would open: re-checked for exceptions after the provider call. */
  courseIds: string[]
  /** For a pack: its code, its courses and the owned courses the learner acknowledged. */
  metadata?: Record<string, unknown>
}

/** The overlap refusal of 065's payments_offer_guard, with the other attempt's reference. */
function overlapRefusal(error: unknown): string | null {
  const e = error as { code?: string; details?: string; message?: string } | null
  if (!e || e.code !== 'P0001') return null
  const text = `${e.details ?? ''} ${e.message ?? ''}`
  if (!text.includes('inflight_overlap')) return null
  const m = /"reference"\s*:\s*"([A-Za-z0-9_-]{4,64})"/.exec(text)
  return m ? m[1] : ''
}

/**
 * Open ONE new attempt: a fresh row with a fresh reference, then the provider,
 * then the token — and only then a URL for the learner.
 */
/** The refusal for boxes left unticked or shown at another version, or null when all three hold. */
function consentRefused(raw: unknown): string | null {
  const check = checkCheckoutConsent(raw)
  if (check === 'accepted') return null
  return check === 'stale' ? MSG.consentStale : MSG.consent
}

async function openAttempt(args: {
  userId: string
  product: Product
  /** The checked consent, recorded on the order with the server's clock (CGV art. 4). */
  legal: CheckoutConsentRecord
}): Promise<PaytechCheckoutResult> {
  const admin = createAdminClient()
  const config = resolvePaytechConfig()
  const reference = mintReference()
  const isPack = args.product.kind === 'pack'
  const meta = isPack
    ? { provider: 'paytech', pack: args.product.metadata ?? {}, legal: args.legal }
    : { provider: 'paytech', legal: args.legal }

  // Provider identity is recorded at creation and never changes (063). A payment
  // buys one course OR one pack, never both (065).
  const { data: created, error: insertError } = await admin
    .from('payments')
    .insert({
      user_id:       args.userId,
      course_id:     isPack ? null : args.product.id,
      pack_id:       isPack ? args.product.id : null,
      amount:        args.product.price,     // server-side price only
      currency:      PAYTECH_CURRENCY,
      method:        'card',                 // the payer chooses the instrument at PayTech
      status:        'pending',
      reference,
      provider:      'paytech',
      provider_mode: config.providerMode,
      metadata:      meta,
    })
    .select('id')
    .single()

  if (insertError || !created) {
    // 23505 on 058's or 065's in-flight index: a concurrent click created the attempt.
    // Nothing was sent to the provider.
    if ((insertError as { code?: string } | null)?.code === '23505') return { error: MSG.inProgress }
    // 065's guard: another attempt of this learner would open one of these courses.
    const other = overlapRefusal(insertError)
    if (other !== null) {
      return { error: isPack ? MSG.courseInFlight : MSG.packInFlight, ...(other ? { reference: other } : {}) }
    }
    log.error({ product: args.product.kind, id: args.product.id }, 'could not create the pending payment intent')
    return { error: MSG.failed }
  }
  const paymentId = created.id as string

  const urls = paytechCallbackUrls()
  let checkout
  try {
    checkout = await requestPayment({
      itemPrice:   args.product.price,
      itemName:    args.product.title.slice(0, 120),
      commandName: `XP Client Academy — ${args.product.title}`.slice(0, 160),
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
  for (const courseId of args.product.courseIds) {
    const heldAfter = await paymentExceptionBlock(args.userId, courseId)
    if (heldAfter.unreadable || heldAfter.reference) {
      await closeUnopenedAttempt({ paymentId, failureReason: 'superseded_by_exception' })
      return heldAfter.reference ? { error: MSG.exception, reference: heldAfter.reference } : { error: MSG.failed }
    }
  }

  // Persist the correlation key BEFORE handing out the URL — compare-and-set,
  // so a concurrent closure wins and this URL is never handed out.
  const { data: persisted, error: tokenError } = await admin
    .from('payments')
    .update({
      provider_token:     checkout.token,
      provider_reference: reference,
      status:             'processing',
      metadata:           { ...meta, checkoutUrl: checkout.redirectUrl },
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
