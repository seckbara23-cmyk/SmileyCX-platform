'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function updateCourse(formData: FormData) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const id          = formData.get('id') as string
  const title       = (formData.get('title') as string).trim()
  const description = (formData.get('description') as string).trim()
  const price       = parseFloat(formData.get('price') as string) || 0
  const level       = formData.get('level') as string
  const duration    = parseInt(formData.get('duration_hours') as string, 10) || null
  const is_free     = formData.get('is_free') === 'on'
  const is_published = formData.get('is_published') === 'on'

  const cover_url = (formData.get('cover_url') as string | null)?.trim() || undefined

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
      ...(cover_url !== undefined ? { cover_url } : {}),
      updated_at:     new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/courses')
  revalidatePath('/admin/courses')
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
