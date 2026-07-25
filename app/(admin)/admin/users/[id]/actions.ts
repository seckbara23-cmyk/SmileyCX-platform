'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { logAuditEvent } from '@/lib/audit/log'
import { redirect } from 'next/navigation'

/**
 * User deletion (SEC-2 §6, closing SEC-1 finding F-7).
 *
 * Deletion is destructive and cascading: the auth.users row goes, and the
 * profile follows via ON DELETE CASCADE. In the SEC-1 incident this destroyed
 * the only remaining evidence about two unknown accounts.
 *
 * A snapshot of the subject is now captured BEFORE deletion and written to the
 * append-only audit_log, which deliberately has no foreign key to auth.users so
 * the record outlives the user it describes.
 */
export async function deleteUser(formData: FormData) {
  const admin = await requirePlatformAdmin()

  const userId = formData.get('userId') as string
  if (!userId) throw new Error('Missing userId')

  const adminClient = createAdminClient()

  // Snapshot the subject before it is destroyed (evidence preservation).
  const { data: subject } = await adminClient
    .from('profiles')
    .select('id, email, full_name, platform_role, created_at')
    .eq('id', userId)
    .maybeSingle()

  // Delete the Auth user — cascades to profile via FK
  const { error } = await adminClient.auth.admin.deleteUser(userId)

  if (error) {
    await logAuditEvent({
      eventType:     'user.deleted',
      actorType:     'admin',
      actorId:       admin.id,
      actorEmail:    admin.email,
      subjectUserId: userId,
      subjectEmail:  subject?.email ?? null,
      method:        'admin_panel',
      outcome:       'failure',
      reason:        error.message,
    })
    throw new Error(`Failed to delete user: ${error.message}`)
  }

  await logAuditEvent({
    eventType:     'user.deleted',
    actorType:     'admin',
    actorId:       admin.id,
    actorEmail:    admin.email,
    subjectUserId: userId,
    subjectEmail:  subject?.email ?? null,
    method:        'admin_panel',
    outcome:       'success',
    // Snapshot of the deleted row — exactly the evidence missing in SEC-1.
    metadata: {
      deletedProfile: subject
        ? {
            email:         subject.email,
            full_name:     subject.full_name,
            platform_role: subject.platform_role,
            created_at:    subject.created_at,
          }
        : null,
    },
  })

  redirect('/admin/users')
}
