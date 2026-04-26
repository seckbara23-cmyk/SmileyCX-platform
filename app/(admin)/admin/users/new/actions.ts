'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'

export async function createUser(formData: FormData) {
  await requirePlatformAdmin()

  const email        = (formData.get('email') as string).trim()
  const password     = formData.get('password') as string
  const fullName     = (formData.get('fullName') as string | null)?.trim() || null
  const platformRole = (formData.get('platformRole') as string) || 'user'

  if (!email || !password) throw new Error('Email and password are required')

  const adminClient = createAdminClient()

  // Create the Auth user (email confirmed automatically via admin API)
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })

  if (error || !data?.user) {
    throw new Error(`Failed to create user: ${error?.message ?? 'unknown error'}`)
  }

  // Upsert profile with correct platform_role (the DB trigger creates it, but
  // we update immediately to set the role without a second round-trip)
  await adminClient
    .from('profiles')
    .upsert({
      id:            data.user.id,
      email,
      full_name:     fullName,
      platform_role: platformRole,
    })

  redirect(`/admin/users/${data.user.id}`)
}
