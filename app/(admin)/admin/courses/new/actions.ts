'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { recordPublicationTransition } from '@/lib/admin/publication-audit'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function createCourse(formData: FormData) {
  const admin = await requirePlatformAdmin()
  const supabase = createAdminClient()

  const title       = (formData.get('title') as string ?? '').trim()
  const rawSlug     = (formData.get('slug') as string ?? '').trim()
  const description = (formData.get('description') as string ?? '').trim()
  const price       = parseFloat(formData.get('price') as string) || 0
  const level       = formData.get('level') as string
  const duration    = parseInt(formData.get('duration_hours') as string, 10) || null
  const is_free     = formData.get('is_free') === 'on'
  const is_published = formData.get('is_published') === 'on'

  if (!title || !description) {
    throw new Error('Titre et description sont requis.')
  }

  // Generate slug from title if the field was left empty
  const slugSource = rawSlug || title
  const slug = slugSource
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  if (!slug) {
    throw new Error('Impossible de générer un slug valide depuis le titre.')
  }

  const { data, error } = await supabase
    .from('courses')
    .insert({
      title,
      slug,
      description,
      price:          is_free ? 0 : price,
      currency:       'XOF',
      level,
      duration_hours: duration,
      is_free,
      is_published,
      language:       'fr',
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)

  // A course created with the box ticked becomes publicly discoverable the
  // moment it exists. That is a publication transition even though no previous
  // row existed, and auditing only the edit form would leave this path silent —
  // reproducing the exact gap F-5 exists to close. `previousIsPublished: null`
  // is what distinguishes it from a re-publication.
  if (is_published) {
    await recordPublicationTransition({
      courseId:            data.id,
      courseTitle:         title,
      courseSlug:          slug,
      previousIsPublished: null,
      newIsPublished:      true,
      actorId:             admin.id,
      actorEmail:          admin.email,
      outcome:             'success',
    })
  }

  revalidatePath('/courses')
  revalidatePath(`/courses/${slug}`)
  redirect(`/admin/courses/${data.id}/edit`)
}
