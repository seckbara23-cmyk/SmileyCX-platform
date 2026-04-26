'use server'
import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

/**
 * PILOT: Manually activate enrollment for a pending payment.
 * In production, this should be handled by webhook after gateway confirmation.
 */
export async function activateEnrollment(formData: FormData) {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const paymentId = formData.get('paymentId') as string
  if (!paymentId) throw new Error('Payment ID required')

  // Get payment details
  const { data: payment } = await supabase
    .from('payments')
    .select('id, user_id, course_id, status')
    .eq('id', paymentId)
    .single()

  if (!payment) throw new Error('Payment not found')
  if (payment.status === 'completed') throw new Error('Payment already completed')

  // Update payment to completed
  const { error: payErr } = await supabase
    .from('payments')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', paymentId)

  if (payErr) throw new Error('Failed to update payment')

  // Create enrollment
  const { error: enrollErr } = await supabase
    .from('enrollments')
    .upsert({
      user_id: payment.user_id,
      course_id: payment.course_id,
      payment_id: paymentId,
      status: 'active',
    }, {
      onConflict: 'user_id,course_id'
    })

  if (enrollErr) throw new Error('Failed to create enrollment')

  revalidatePath('/admin/payments')
}