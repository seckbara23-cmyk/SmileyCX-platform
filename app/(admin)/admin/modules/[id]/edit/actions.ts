'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

// ── Module ────────────────────────────────────────────────────────────────────

export async function updateModule(formData: FormData) {
  await requirePlatformAdmin()

  const moduleId    = formData.get('moduleId') as string
  const courseId    = formData.get('courseId') as string
  const title       = (formData.get('title') as string).trim()
  const slug        = (formData.get('slug') as string).trim()
  const description = (formData.get('description') as string | null)?.trim() || null
  const orderIndex  = parseInt(formData.get('orderIndex') as string, 10) || 0

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('modules')
    .update({ course_id: courseId, title, slug, description, order_index: orderIndex })
    .eq('id', moduleId)

  if (error) throw new Error(`Failed to update module: ${error.message}`)

  revalidatePath('/courses', 'layout')
  redirect('/admin/modules')
}

export async function deleteModule(formData: FormData) {
  await requirePlatformAdmin()

  const moduleId = formData.get('moduleId') as string
  if (!moduleId) throw new Error('Missing moduleId')

  const supabase = createAdminClient()
  const { error } = await supabase.from('modules').delete().eq('id', moduleId)
  if (error) throw new Error(`Failed to delete module: ${error.message}`)

  redirect('/admin/modules')
}

// ── Lessons ───────────────────────────────────────────────────────────────────

/**
 * XPA-8 W3 (F-2): one submitted value, two possible columns.
 *
 * The editor posts whatever identifies the asset. An absolute URL means
 * somebody else hosts it and belongs in `*_url`; anything else is an object
 * path in the PRIVATE course-content bucket and belongs in `*_object_path`.
 *
 * Splitting here — rather than trusting the client to say which it is — means
 * a browser cannot talk the server into recording a public URL as a protected
 * path, or the reverse. The database also refuses a URL in a path column, so
 * a mistake here fails loudly instead of silently un-protecting a lesson.
 */
function splitAsset(raw: string | null): { url: string | null; path: string | null } {
  const v = raw?.trim() || null
  if (!v) return { url: null, path: null }
  return /^[a-z]+:\/\//i.test(v) ? { url: v, path: null } : { url: null, path: v }
}

function parseLesson(formData: FormData) {
  const video    = splitAsset(formData.get('video_asset') as string | null)
  const pdf      = splitAsset(formData.get('pdf_asset') as string | null)
  const subtitle = splitAsset(formData.get('subtitle_asset') as string | null)

  return {
    title:            (formData.get('title') as string).trim(),
    slug:             (formData.get('slug') as string).trim(),
    content:          (formData.get('content') as string | null)?.trim() || null,
    video_url:            video.url,
    video_object_path:    video.path,
    pdf_url:              pdf.url,
    pdf_object_path:      pdf.path,
    subtitle_url:         subtitle.url,
    subtitle_object_path: subtitle.path,
    duration_minutes: parseInt(formData.get('duration_minutes') as string, 10) || null,
    order_index:      parseInt(formData.get('order_index') as string, 10) || 0,
    is_preview:       formData.get('is_preview') === 'true',
  }
}

export async function createLesson(formData: FormData): Promise<{ error?: string }> {
  await requirePlatformAdmin()

  const moduleId = formData.get('module_id') as string
  if (!moduleId) return { error: 'module_id manquant' }

  const fields = parseLesson(formData)
  if (!fields.title || !fields.slug) return { error: 'Titre et slug obligatoires' }

  const supabase = createAdminClient()
  const { error } = await supabase.from('lessons').insert({ module_id: moduleId, ...fields })

  if (error) return { error: error.message }

  revalidatePath(`/admin/modules/${moduleId}/edit`)
  revalidatePath('/courses', 'layout')
  return {}
}

export async function updateLesson(formData: FormData): Promise<{ error?: string }> {
  await requirePlatformAdmin()

  const lessonId = formData.get('lesson_id') as string
  const moduleId = formData.get('module_id') as string
  if (!lessonId || !moduleId) return { error: 'IDs manquants' }

  const fields = parseLesson(formData)

  const supabase = createAdminClient()
  const { error } = await supabase.from('lessons').update(fields).eq('id', lessonId)

  if (error) return { error: error.message }

  revalidatePath(`/admin/modules/${moduleId}/edit`)
  revalidatePath('/courses', 'layout')
  return {}
}

export async function deleteLesson(formData: FormData): Promise<{ error?: string }> {
  await requirePlatformAdmin()

  const lessonId = formData.get('lesson_id') as string
  const moduleId = formData.get('module_id') as string
  if (!lessonId) return { error: 'lesson_id manquant' }

  const supabase = createAdminClient()
  const { error } = await supabase.from('lessons').delete().eq('id', lessonId)

  if (error) return { error: error.message }

  revalidatePath(`/admin/modules/${moduleId}/edit`)
  revalidatePath('/courses', 'layout')
  return {}
}
