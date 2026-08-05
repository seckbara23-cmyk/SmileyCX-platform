'use server'

import { createLogger } from '@/lib/logger'
import { Resend } from 'resend'
import { BRAND_NAME, CONTACT_EMAIL } from '@/lib/brand'

const log = createLogger('contact')

const SERVICE_LABELS: Record<string, string> = {
  online:      'Formation en ligne',
  presentiel:  'Formation en présentiel',
  autre:       'Autre',
}

export async function sendContactMessage(
  formData: FormData,
): Promise<{ error?: string }> {
  const name    = (formData.get('name') as string | null)?.trim()
  const email   = (formData.get('email') as string | null)?.trim()
  const service = (formData.get('service') as string | null)?.trim() || 'non précisé'
  const subject = (formData.get('subject') as string | null)?.trim()
  const message = (formData.get('message') as string | null)?.trim()

  if (!name || !email || !subject || !message) {
    return { error: 'Veuillez remplir tous les champs obligatoires.' }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Adresse email invalide.' }
  }

  const serviceLabel = SERVICE_LABELS[service] ?? service

  const isDryRun = process.env.EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY

  if (isDryRun) {
    log.info({ name, email, service, subject }, 'Contact form submission (DRY RUN)')
    return {}
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const from = process.env.EMAIL_FROM ?? `${BRAND_NAME} <noreply@smileycx.com>`
    const to   = process.env.CONTACT_EMAIL ?? CONTACT_EMAIL

    await resend.emails.send({
      from,
      to,
      reply_to: email,
      subject: `[Contact XP Client] ${subject}`,
      html: `
        <p><strong>Nom :</strong> ${name}</p>
        <p><strong>Email :</strong> ${email}</p>
        <p><strong>Service :</strong> ${serviceLabel}</p>
        <p><strong>Sujet :</strong> ${subject}</p>
        <hr />
        <p>${message.replace(/\n/g, '<br/>')}</p>
      `,
      text: `Nom: ${name}\nEmail: ${email}\nService: ${serviceLabel}\nSujet: ${subject}\n\n${message}`,
    })

    log.info({ email, subject }, 'Contact form sent')
    return {}
  } catch (err) {
    log.error({ err }, 'Failed to send contact email')
    return { error: 'Une erreur est survenue. Réessayez ou contactez-nous directement.' }
  }
}
