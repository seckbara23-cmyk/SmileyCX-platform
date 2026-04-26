'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function createCourse(formData: FormData) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const title       = (formData.get('title') as string).trim()
  const rawSlug     = (formData.get('slug') as string).trim()
  const slug        = rawSlug
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const description = (formData.get('description') as string).trim()
  const price       = parseFloat(formData.get('price') as string) || 0
  const level       = formData.get('level') as string
  const duration    = parseInt(formData.get('duration_hours') as string, 10) || null
  const is_free     = formData.get('is_free') === 'on'
  const is_published = formData.get('is_published') === 'on'

  if (!title || !slug || !description) {
    throw new Error('Titre, slug et description sont requis.')
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

  revalidatePath('/courses')
  redirect(`/admin/courses/${data.id}/edit`)
}
