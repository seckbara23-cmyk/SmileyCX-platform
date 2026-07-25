'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit/log'
import { redirect } from 'next/navigation'

/**
 * The ONLY account-provisioning path on the platform (SEC-2 §1, §3).
 *
 * Controls, in order: platform-admin authorization → role validation →
 * rate limit → creation → audit. Every outcome, success and failure, is
 * written to the append-only audit trail.
 */

// 20 provisioning attempts per admin per hour: generous for legitimate
// onboarding, tight enough to bound damage from a compromised admin session.
const PROVISION_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 }

const VALID_ROLES = ['user', 'super_admin', 'consultant'] as const
type PlatformRole = (typeof VALID_ROLES)[number]

export async function createUser(formData: FormData) {
  const admin = await requirePlatformAdmin()

  const email     = ((formData.get('email') as string | null) ?? '').trim()
  const password  = (formData.get('password') as string | null) ?? ''
  const fullName  = (formData.get('fullName') as string | null)?.trim() || null
  const roleInput = ((formData.get('platformRole') as string | null) ?? 'user').trim()

  if (!email || !password) throw new Error('Email and password are required')

  // Never trust a client-supplied role string.
  if (!(VALID_ROLES as readonly string[]).includes(roleInput)) {
    await logAuditEvent({
      eventType:    'user.created',
      actorType:    'admin',
      actorId:      admin.id,
      actorEmail:   admin.email,
      subjectEmail: email,
      method:       'admin_panel',
      outcome:      'failure',
      reason:       'invalid platform_role requested',
      metadata:     { requestedRole: roleInput },
    })
    throw new Error('Invalid platform role')
  }
  const platformRole = roleInput as PlatformRole

  // Rate limit per acting admin (fails open on infrastructure errors).
  const rl = await rateLimitDb(`admin-provision:${admin.id}`, PROVISION_RATE_LIMIT)
  if (!rl.success) {
    await logAuditEvent({
      eventType:    'user.created',
      actorType:    'admin',
      actorId:      admin.id,
      actorEmail:   admin.email,
      subjectEmail: email,
      method:       'admin_panel',
      outcome:      'failure',
      reason:       'rate limit exceeded',
    })
    throw new Error('Too many user creations. Please wait before trying again.')
  }

  const adminClient = createAdminClient()

  // Create the Auth user (email confirmed automatically via admin API)
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })

  if (error || !data?.user) {
    await logAuditEvent({
      eventType:    'user.created',
      actorType:    'admin',
      actorId:      admin.id,
      actorEmail:   admin.email,
      subjectEmail: email,
      method:       'admin_panel',
      outcome:      'failure',
      reason:       error?.message ?? 'unknown error',
    })
    throw new Error(`Failed to create user: ${error?.message ?? 'unknown error'}`)
  }

  // Upsert profile with correct platform_role (the DB trigger creates it, but
  // we update immediately to set the role without a second round-trip).
  // Runs as service_role, which the 027 role-change trigger permits.
  await adminClient
    .from('profiles')
    .upsert({
      id:            data.user.id,
      email,
      full_name:     fullName,
      platform_role: platformRole,
    })

  await logAuditEvent({
    eventType:     'user.created',
    actorType:     'admin',
    actorId:       admin.id,
    actorEmail:    admin.email,
    subjectUserId: data.user.id,
    subjectEmail:  email,
    method:        'admin_panel',
    outcome:       'success',
    metadata:      { platformRole, emailConfirmed: true },
  })

  // A privileged role granted at creation time is recorded separately so role
  // grants remain queryable independently of account creation.
  if (platformRole !== 'user') {
    await logAuditEvent({
      eventType:     'user.role_changed',
      actorType:     'admin',
      actorId:       admin.id,
      actorEmail:    admin.email,
      subjectUserId: data.user.id,
      subjectEmail:  email,
      method:        'admin_panel',
      outcome:       'success',
      metadata:      { from: 'user', to: platformRole, atCreation: true },
    })
  }

  redirect(`/admin/users/${data.user.id}`)
}
