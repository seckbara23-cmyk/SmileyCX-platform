'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { logAuditEvent } from '@/lib/audit/log'
import { redirect } from 'next/navigation'
import { eraseVoiceDataForUser } from '@/lib/voice/erasure'

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
 *
 * XP-F2-04: deleting the account cascades to the learner's voice sessions, and
 * with them the only references to their conversations at the voice provider.
 * So the provider copies are dealt with FIRST: each is deleted there, or queued
 * for retry without any link to the learner (lib/voice/erasure.ts). If a
 * reference can be neither deleted nor queued, the account is NOT deleted: the
 * administrator is told, and can retry. The audit record carries the counts.
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

  // Voice data at the provider, before the cascade destroys the references.
  const voice = await eraseVoiceDataForUser(adminClient, userId, {
    reason: 'account_deletion',
    apiKey: process.env.ELEVENLABS_API_KEY,
    deleteSessions: false,
  })
  if (!voice.ok) {
    await logAuditEvent({
      eventType:     'user.deleted',
      actorType:     'admin',
      actorId:       admin.id,
      actorEmail:    admin.email,
      subjectUserId: userId,
      subjectEmail:  subject?.email ?? null,
      method:        'admin_panel',
      outcome:       'failure',
      reason:        `voice_erasure_${voice.step}`,
    })
    throw new Error('Account not deleted: the voice-provider erasure could not be completed or recorded. Nothing was deleted. Try again.')
  }
  const voiceErasure = { sessions: voice.sessions, providerDeleted: voice.providerDeleted, providerQueued: voice.providerQueued }

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
      voiceErasure,
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
