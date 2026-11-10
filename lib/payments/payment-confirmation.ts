import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { sendPaymentConfirmationEmail } from '@/lib/email'
import { CONTACT_EMAIL } from '@/lib/brand'
import { formatPrice } from '@/lib/utils/cn'
import { paytechCallbackBaseUrl } from '@/lib/payments/paytech-callbacks'

const log = createLogger('payments/confirmation')

/**
 * The purchase confirmation e-mail — XP-LAUNCH-FINAL-11 (CGV art. 4.4).
 *
 * Called once, right after `complete_payment` reports a FRESH completion (never
 * on `already_completed`), so a payment confirmed by several paths at once is
 * announced once. It only reads: the payment, the learner's address, what the
 * payment opened (065's `payment_entitlements`) and the conditions recorded on
 * the order. It NEVER throws and never blocks the completion: a failure is
 * logged with the payment id and nothing else (no address, no amount).
 *
 * Not retried. A learner who did not receive it still has their access, the
 * success page and the dashboard; support can confirm by reference.
 */
export async function sendPaymentConfirmation(paymentId: string): Promise<'sent' | 'dry_run' | 'skipped' | 'failed'> {
  try {
    const admin = createAdminClient()

    const { data: payment, error: paymentError } = await admin
      .from('payments')
      .select('id, user_id, course_id, pack_id, amount, currency, reference, status, metadata')
      .eq('id', paymentId)
      .maybeSingle()
    if (paymentError || !payment) return failed(paymentId, 'payment_unreadable')
    const p = payment as {
      user_id: string | null; course_id: string | null; pack_id: string | null
      amount: number | string; currency: string; reference: string; status: string
      metadata: { legal?: { cgu?: unknown; cgv?: unknown } } | null
    }
    if (p.status !== 'completed' || !p.user_id) return skipped(paymentId, 'not_completed')

    const { data: profile } = await admin.from('profiles').select('email, full_name').eq('id', p.user_id).maybeSingle()
    const to = (profile as { email?: string | null } | null)?.email?.trim()
    if (!to) return skipped(paymentId, 'no_address')
    const fullName = (profile as { full_name?: string | null }).full_name?.trim() || 'apprenant'

    const productTitle = await titleOf(p.course_id, p.pack_id)
    if (!productTitle) return failed(paymentId, 'product_unreadable')

    const { data: links } = await admin
      .from('payment_entitlements')
      .select('course_id, entitlement_id, preexisting')
      .eq('payment_id', paymentId)
    const opened = (Array.isArray(links) ? links : []) as { course_id: string; entitlement_id: string; preexisting: boolean }[]

    const newIds = opened.filter(l => l.preexisting === false).map(l => l.entitlement_id)
    let accessEndsOn: string | null = null
    if (newIds.length > 0) {
      const { data: ents } = await admin.from('entitlements').select('id, expires_at').in('id', newIds)
      const ends = ((Array.isArray(ents) ? ents : []) as { expires_at: string | null }[])
        .map(e => e.expires_at).filter((v): v is string => typeof v === 'string').sort()
      if (ends.length > 0) accessEndsOn = dayOf(ends[0])
    }

    let packCourses: { title: string; preexisting: boolean }[] = []
    if (p.pack_id && opened.length > 0) {
      const { data: courses } = await admin.from('courses').select('id, title').in('id', opened.map(l => l.course_id))
      const titles = new Map(((Array.isArray(courses) ? courses : []) as { id: string; title: string }[]).map(c => [c.id, c.title]))
      packCourses = opened.map(l => ({ title: titles.get(l.course_id) ?? 'Formation', preexisting: l.preexisting === true }))
    }

    const legal = p.metadata?.legal
    const acceptedTerms = typeof legal?.cgu === 'string' && typeof legal?.cgv === 'string'
      ? `CGU ${legal.cgu} et CGV ${legal.cgv}`
      : null

    const result = await sendPaymentConfirmationEmail(to, {
      fullName,
      productTitle,
      packCourses,
      amount: formatPrice(Number(p.amount), p.currency),
      reference: p.reference,
      accessEndsOn,
      acceptedTerms,
      dashboardUrl: `${paytechCallbackBaseUrl().replace(/\/+$/, '')}/dashboard`,
      contactEmail: CONTACT_EMAIL,
    })
    if (!result.success) return failed(paymentId, 'send_failed')
    log.info({ paymentId, dryRun: result.dryRun === true }, 'purchase confirmation e-mail handed to the mailer')
    return result.dryRun ? 'dry_run' : 'sent'
  } catch {
    return failed(paymentId, 'threw')
  }
}

async function titleOf(courseId: string | null, packId: string | null): Promise<string | null> {
  const admin = createAdminClient()
  if (packId) {
    const { data } = await admin.from('course_packs').select('title').eq('id', packId).maybeSingle()
    return (data as { title?: string } | null)?.title ?? null
  }
  if (courseId) {
    const { data } = await admin.from('courses').select('title').eq('id', courseId).maybeSingle()
    return (data as { title?: string } | null)?.title ?? null
  }
  return null
}

function dayOf(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Africa/Dakar' }).format(new Date(iso))
}

function failed(paymentId: string, reason: string): 'failed' {
  log.error({ paymentId, reason }, 'purchase confirmation e-mail not sent')
  return 'failed'
}

function skipped(paymentId: string, reason: string): 'skipped' {
  log.warn({ paymentId, reason }, 'purchase confirmation e-mail skipped')
  return 'skipped'
}
