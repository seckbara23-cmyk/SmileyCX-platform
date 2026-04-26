'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export async function createModule(formData: FormData) {
  await requirePlatformAdmin()

  const courseId    = formData.get('courseId') as string
  const title       = (formData.get('title') as string).trim()
  const slug        = (formData.get('slug') as string).trim()
  const description = (formData.get('description') as string | null)?.trim() || null
  const orderIndex  = parseInt(formData.get('orderIndex') as string, 10) || 0

  if (!courseId || !title || !slug) throw new Error('courseId, title, and slug are required')

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('modules')
    .insert({ course_id: courseId, title, slug, description, order_index: orderIndex })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create module: ${error.message}`)

  redirect(`/admin/modules/${data.id}/edit`)
}
