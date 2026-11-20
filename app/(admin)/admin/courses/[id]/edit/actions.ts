'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { recordPublicationTransition } from '@/lib/admin/publication-audit'
import { createLogger } from '@/lib/logger'
import { resolveCourseCodeAssignment } from '@/lib/admin/course-codes'
import { changeCommercialPrice, decidePriceChange } from '@/lib/catalogue/commercial-price'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const log = createLogger('admin/courses')

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function updateCourse(formData: FormData) {
  const admin = await requirePlatformAdmin()
  const supabase = createAdminClient()

  const id          = formData.get('id') as string
  const title       = (formData.get('title') as string).trim()
  const rawSlug     = (formData.get('slug') as string ?? '').trim()
  const slug        = rawSlug ? normalizeSlug(rawSlug) : null
  const description = (formData.get('description') as string).trim()
  const price       = parseFloat(formData.get('price') as string) || 0
  const level       = formData.get('level') as string
  const duration    = parseInt(formData.get('duration_hours') as string, 10) || null
  const is_free     = formData.get('is_free') === 'on'
  const is_published = formData.get('is_published') === 'on'

  const cover_url       = (formData.get('cover_url')       as string | null)?.trim() || undefined
  const intro_video_url = (formData.get('intro_video_url') as string | null)?.trim() || null

  // XPA-8 F-5 — snapshot publication state BEFORE the write. It is the only
  // way to record a TRANSITION rather than a destination, and it is read from
  // the row rather than trusted from the form, because the form reflects what
  // the operator was shown, not what the row currently holds.
  const { data: prior, error: priorError } = await supabase
    .from('courses')
    .select('is_published, slug')
    .eq('id', id)
    .maybeSingle()

  // F-5.2 — FAIL CLOSED.
  //
  // This snapshot is the only thing that turns the write below into a recorded
  // TRANSITION rather than an unexplained destination. The previous version
  // discarded the error, so a failed read became `prior = null`, which became
  // `publicationChanged = false`, and the UPDATE proceeded anyway — publishing
  // or withdrawing a course with no audit trail at all. That is the fail-open
  // behind the 2026-09-05 change nobody could attribute.
  //
  // A lookup FAILURE and a genuinely missing row are different facts and get
  // different messages, but neither may proceed: without a trustworthy prior
  // state there is no honest way to record what changed.
  if (priorError) {
    log.error({ courseId: id, error: priorError.message },
      'AUDIT GAP - refusing course update: prior publication state unreadable')
    throw new Error(
      "Impossible de lire l'état de publication actuel de ce cours. " +
      'Aucune modification enregistrée. Réessayez.',
    )
  }
  if (!prior) {
    log.error({ courseId: id },
      'AUDIT GAP - refusing course update: course row not found')
    throw new Error('Cours introuvable. Aucune modification enregistrée.')
  }

  const publicationChanged = prior.is_published !== is_published

  // ── CAT-1: academic identity ─────────────────────────────────────────
  //
  // Read separately rather than widening the F-5.2 prior-state select, which
  // is pinned by the publication-governance suite. Same fail-closed rule
  // applies: without a trustworthy current code there is no safe way to tell
  // an assignment from a replacement, so refuse rather than guess.
  const { data: codeRow, error: codeReadError } = await supabase
    .from('courses')
    .select('code')
    .eq('id', id)
    .maybeSingle()

  if (codeReadError || !codeRow) {
    log.error({ courseId: id, error: codeReadError?.message },
      'CAT-1 — refusing course update: academic code unreadable')
    throw new Error(
      "Impossible de lire le code académique actuel de ce cours. " +
      'Aucune modification enregistrée. Réessayez.',
    )
  }

  const codeAssignment = await resolveCourseCodeAssignment(
    codeRow.code as string | null, formData.get('code') as string | null, id,
  )
  if (!codeAssignment.ok) {
    log.error({ courseId: id, reason: codeAssignment.error },
      'CAT-1 — refusing course update: invalid academic code assignment')
    throw new Error(codeAssignment.error)
  }

  // ── P7: the commercial price (migration 067) ─────────────────────────
  //
  // Read separately, like the code above, so the pinned F-5.2 select stays as it
  // is. Fail closed: without the current price there is no honest way to tell a
  // change from no change. A change of price or free flag never rides on the
  // generic UPDATE below: it goes through the one confirmed database path, with
  // the administrator from the server session, and is recorded and alerted there.
  const { data: priceRow, error: priceReadError } = await supabase
    .from('courses')
    .select('price, is_free')
    .eq('id', id)
    .maybeSingle()

  if (priceReadError || !priceRow) {
    log.error({ courseId: id, error: priceReadError?.message },
      'P7 — refusing course update: current price unreadable')
    throw new Error(
      'Impossible de lire le prix actuel de ce cours. Aucune modification enregistrée. Réessayez.',
    )
  }

  const currentPrice = Number(priceRow.price)
  const nextPrice    = is_free ? 0 : price
  const pricing = decidePriceChange(
    { price: currentPrice, isFree: priceRow.is_free === true, isPublished: prior.is_published === true },
    { price: nextPrice,    isFree: is_free,                   isPublished: is_published },
    { confirm: formData.get('price_confirm'), reason: formData.get('price_reason') },
  )
  if (pricing.kind === 'refuse') throw new Error(pricing.message)
  if (pricing.kind === 'change') {
    const changed = await changeCommercialPrice({
      kind: 'course', id, code: codeRow.code as string | null, title,
      expectedPrice: currentPrice, newPrice: nextPrice, newIsFree: is_free,
      reason: pricing.reason,
      actor: { id: admin.id, email: admin.email ?? null },
    })
    if (!changed.ok) throw new Error(changed.message)
  }

  const { error } = await supabase
    .from('courses')
    .update({
      title,
      description,
      level,
      duration_hours: duration,
      is_published,
      intro_video_url,
      // Present only on a genuine first assignment. An unchanged or absent
      // code never reaches the UPDATE, so the immutability trigger is never
      // even asked a question it would have to refuse.
      ...(codeAssignment.code ? { code: codeAssignment.code } : {}),
      ...(cover_url !== undefined ? { cover_url } : {}),
      ...(slug ? { slug } : {}),
      updated_at:     new Date().toISOString(),
    })
    .eq('id', id)

  // A REFUSED publication change is worth as much as a successful one: it is
  // either an operator hitting a constraint or an attempt that should not have
  // been made. Audited before the throw, on the same reasoning as user.deleted.
  if (error) {
    if (publicationChanged) {
      await recordPublicationTransition({
        courseId:            id,
        courseTitle:         title,
        courseSlug:          slug ?? prior.slug ?? null,
        previousIsPublished: prior.is_published,
        newIsPublished:      is_published,
        actorId:             admin.id,
        actorEmail:          admin.email,
        outcome:             'failure',
        reason:              error.message,
      })
    }
    throw new Error(error.message)
  }

  // Only TRANSITIONS. Editing the title of an already-published course is not
  // a publication event.
  if (publicationChanged) {
    await recordPublicationTransition({
      courseId:            id,
      courseTitle:         title,
      courseSlug:          slug ?? prior.slug ?? null,
      previousIsPublished: prior.is_published,
      newIsPublished:      is_published,
      actorId:             admin.id,
      actorEmail:          admin.email,
      outcome:             'success',
    })
  }

  revalidatePath('/courses')
  revalidatePath('/admin/courses')
  if (slug) revalidatePath(`/courses/${slug}`)
  redirect('/admin/courses')
}

export async function deleteCourse(formData: FormData) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()
  const id = formData.get('id') as string

  const { error } = await supabase.from('courses').delete().eq('id', id)
  if (error) throw new Error(error.message)

  redirect('/admin/courses')
}
