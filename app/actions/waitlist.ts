'use server'
import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { BRAND_NAME, CONTACT_EMAIL } from '@/lib/brand'

const log = createLogger('actions/waitlist')

const WaitlistSchema = z.object({
  name:  z.string().min(2).max(120).trim(),
  email: z.string().email().max(255).trim(),
})

export async function joinWaitlist(
  input: { name: string; email: string }
): Promise<{ error?: string }> {
  const parsed = WaitlistSchema.safeParse(input)
  if (!parsed.success) {
    return { error: 'Veuillez renseigner un nom (2 caractères min.) et un email valide.' }
  }

  const { name, email } = parsed.data
  const adminEmail = process.env.CONTACT_EMAIL ?? CONTACT_EMAIL
  const from       = process.env.EMAIL_FROM    ?? `${BRAND_NAME} <noreply@smileycx.com>`
  const isDryRun   = process.env.EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY

  if (isDryRun) {
    log.info({ name, email }, '[DRY RUN] Waitlist request received')
    return {}
  }

  try {
    const { Resend } = await import('resend')
    const resend = new Resend(process.env.RESEND_API_KEY!)
    const { error } = await resend.emails.send({
      from,
      to:      adminEmail,
      subject: `[XP Client Academy] Nouvelle demande d'accès — ${name}`,
      html:    `<p><strong>${name}</strong> (<a href="mailto:${email}">${email}</a>) souhaite rejoindre la plateforme XP Client Academy.</p>`,
      text:    `Nouvelle demande d'accès\n\nNom : ${name}\nEmail : ${email}\n`,
    })
    if (error) {
      log.error({ error }, 'Resend error sending waitlist notification')
      return { error: "Erreur lors de l'envoi. Réessayez plus tard." }
    }
  } catch (err) {
    log.error({ err }, 'Unexpected waitlist action failure')
    return { error: 'Erreur inattendue. Réessayez plus tard.' }
  }

  return {}
}
