'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export async function deleteUser(formData: FormData) {
  await requirePlatformAdmin()

  const userId = formData.get('userId') as string
  if (!userId) throw new Error('Missing userId')

  const adminClient = createAdminClient()

  // Delete the Auth user — cascades to profile via DB trigger/FK
  const { error } = await adminClient.auth.admin.deleteUser(userId)
  if (error) throw new Error(`Failed to delete user: ${error.message}`)

  redirect('/admin/users')
}
