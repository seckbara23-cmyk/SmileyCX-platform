'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { recordPublicationTransition } from '@/lib/admin/publication-audit'
import { createLogger } from '@/lib/logger'
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

  const { error } = await supabase
    .from('courses')
    .update({
      title,
      description,
      price:          is_free ? 0 : price,
      level,
      duration_hours: duration,
      is_free,
      is_published,
      intro_video_url,
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
