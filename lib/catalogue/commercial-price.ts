import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'
import { ownerEmails } from '@/lib/auth/owner-email'
import { sendCommercialPriceAlert } from '@/lib/email'

/**
 * XP-PAYTECH-P7 — the commercial price of a course or pack changes only with an
 * explicit, recorded confirmation (migration 067).
 *
 * The database refuses a change of a PUBLISHED price unless it goes through
 * public.admin_change_commercial_price(), which re-checks the administrator,
 * the price the operator saw and the reason, and writes the append-only record.
 * This module is the application's side: it decides whether the form carries a
 * valid confirmation, calls the function with the administrator from the
 * server session (never from the form), and alerts the owners afterwards.
 */

const log = createLogger('catalogue/commercial-price')

export interface PriceState { price: number; isFree: boolean; isPublished: boolean }

export type PriceDecision =
  | { kind: 'none' }
  | { kind: 'change'; reason: string }
  | { kind: 'refuse'; message: string }

/** Reason recorded for a draft that was never published: no confirmation is asked there. */
export const DRAFT_REASON = 'Brouillon non publié'

export const PRICE_MESSAGES = {
  confirm:   'Changement de prix non confirmé : pour une formation publiée, retapez le nouveau prix dans « Confirmer le nouveau prix » et indiquez un motif. Aucune modification enregistrée.',
  whole:     'Prix invalide : indiquez un nombre entier de FCFA. Aucune modification enregistrée.',
  commercial_price_stale:      'Le prix a changé depuis l’ouverture de cette page. Rechargez-la et recommencez. Aucune modification enregistrée.',
  commercial_actor_not_admin:  'Seul un administrateur actif peut changer un prix. Aucune modification enregistrée.',
  commercial_reason_required:  'Indiquez le motif du changement de prix (3 caractères au moins). Aucune modification enregistrée.',
  commercial_price_invalid:    'Prix invalide : un nombre entier de FCFA, 0 seulement pour une formation gratuite. Aucune modification enregistrée.',
  commercial_price_unchanged:  'Le prix est déjà celui-ci. Aucune modification enregistrée.',
  commercial_item_not_found:   'Formation introuvable. Aucune modification enregistrée.',
  commercial_price_unconfirmed:'Changement de prix refusé par la base : il doit être confirmé. Aucune modification enregistrée.',
  unavailable: 'La protection des prix n’est pas disponible : le prix n’a pas été modifié. Les autres champs n’ont pas été enregistrés non plus.',
} as const

/**
 * What the form asks for. A change of price or of the free flag needs, when the
 * course is published before OR after the save, the new price typed again and a
 * reason. An unpublished draft changes freely (and is still recorded).
 */
export function decidePriceChange(
  prior: PriceState,
  next: PriceState,
  form: { confirm: FormDataEntryValue | null; reason: FormDataEntryValue | null },
): PriceDecision {
  if (prior.price === next.price && prior.isFree === next.isFree) return { kind: 'none' }
  if (!Number.isInteger(next.price) || next.price < 0) return { kind: 'refuse', message: PRICE_MESSAGES.whole }

  const reason = typeof form.reason === 'string' ? form.reason.trim() : ''
  if (!prior.isPublished && !next.isPublished) return { kind: 'change', reason: reason.length >= 3 ? reason : DRAFT_REASON }

  const typed = typeof form.confirm === 'string' ? form.confirm.replace(/[\s  ]/g, '') : ''
  if (!/^\d+$/.test(typed) || Number(typed) !== next.price || reason.length < 3) {
    return { kind: 'refuse', message: PRICE_MESSAGES.confirm }
  }
  return { kind: 'change', reason }
}

export interface PriceChangeRequest {
  kind: 'course' | 'pack'
  id: string
  code: string | null
  title: string
  expectedPrice: number
  newPrice: number
  newIsFree: boolean | null
  reason: string
  /** From requirePlatformAdmin(): the server-verified session, never the form. */
  actor: { id: string; email: string | null }
}

export type PriceChangeResult = { ok: true; changeId: number | null } | { ok: false; message: string }

/** Calls the one confirmed path of 067, then alerts the owners. Never throws. */
export async function changeCommercialPrice(r: PriceChangeRequest): Promise<PriceChangeResult> {
  const { data, error } = await createAdminClient().rpc('admin_change_commercial_price', {
    p_kind:           r.kind,
    p_item_id:        r.id,
    p_expected_price: r.expectedPrice,
    p_new_price:      r.newPrice,
    p_new_is_free:    r.newIsFree,
    p_reason:         r.reason,
    p_actor_id:       r.actor.id,
    p_actor_email:    r.actor.email,
  })
  if (error) {
    const code = Object.keys(PRICE_MESSAGES).find(k => k.startsWith('commercial_') && (error.message ?? '').includes(k))
    log.warn({ kind: r.kind, id: r.id, code: code ?? 'other', pgCode: (error as { code?: string }).code }, 'commercial price change refused')
    return { ok: false, message: code ? PRICE_MESSAGES[code as keyof typeof PRICE_MESSAGES] : PRICE_MESSAGES.unavailable }
  }

  const changeId = Number((data as { changeId?: unknown } | null)?.changeId) || null
  log.warn({ kind: r.kind, id: r.id, code: r.code, from: r.expectedPrice, to: r.newPrice, changeId }, 'commercial price changed')
  await alertOwners(r, changeId)
  return { ok: true, changeId }
}

async function alertOwners(r: PriceChangeRequest, changeId: number | null): Promise<void> {
  try {
    const to = ownerEmails()
    if (to.length === 0) {
      log.error({ changeId }, 'commercial price changed but no owner address is configured for the alert')
      return
    }
    for (const address of to) {
      const sent = await sendCommercialPriceAlert(address, {
        kind: r.kind, code: r.code, title: r.title,
        oldPrice: r.expectedPrice, newPrice: r.newPrice,
        actorEmail: r.actor.email, reason: r.reason, changeId,
      })
      if (!sent.success) log.error({ changeId }, 'commercial price alert not sent')
    }
  } catch {
    log.error({ changeId }, 'commercial price alert failed')
  }
}
