'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export async function deleteQuiz(formData: FormData) {
  await requirePlatformAdmin()

  const quizId = formData.get('quizId') as string
  if (!quizId) throw new Error('Missing quizId')

  const supabase = createAdminClient()
  const { error } = await supabase.from('quizzes').delete().eq('id', quizId)
  if (error) throw new Error(`Failed to delete quiz: ${error.message}`)

  redirect('/admin/quizzes')
}
