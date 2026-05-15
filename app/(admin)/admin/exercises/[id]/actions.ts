'use server'

import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function deleteExercise(formData: FormData) {
  await requirePlatformAdmin()

  const exerciseId = formData.get('exerciseId') as string
  if (!exerciseId) throw new Error('Missing exerciseId')

  const supabase = createAdminClient()
  const { error } = await supabase.from('exercises').delete().eq('id', exerciseId)
  if (error) throw new Error(`Failed to delete exercise: ${error.message}`)

  revalidatePath('/admin/exercises')
  revalidatePath('/learn', 'layout')
  redirect('/admin/exercises')
}
