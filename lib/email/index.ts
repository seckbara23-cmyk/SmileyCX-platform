/**
 * Email service layer.
 *
 * Provider: Resend (https://resend.com).
 * All sending is server-side only — never import this in client components.
 *
 * Setup:
 *   1. Create a Resend account and verify your sending domain.
 *   2. Add RESEND_API_KEY to .env.local (and Vercel env vars).
 *   3. Set EMAIL_FROM to your verified sender address on the academy domain.
 *
 * In development without a real API key, emails are logged to the console
 * instead of sent. Set EMAIL_DRY_RUN=true to force this behavior in any env.
 */

import { Resend } from 'resend'
import { createLogger } from '@/lib/logger'
import {
  welcomeEmailHtml,
  welcomeEmailText,
  type WelcomeEmailData,
} from './templates/welcome'
import {
  enrollmentEmailHtml,
  enrollmentEmailText,
  type EnrollmentEmailData,
} from './templates/enrollment'
import {
  verificationEmailHtml,
  verificationEmailText,
  type VerificationEmailData,
} from './templates/verification'

const log = createLogger('email')

/**
 * Sender identity.
 *
 * XPA-1 corrected the DISPLAY NAME to the full brand. The sending ADDRESS is
 * deliberately left on its current domain and driven entirely by EMAIL_FROM.
 *
 * Rationale (decision register Q-D): Resend only delivers from a domain it has
 * verified. Switching this fallback to @xpclient-academy.com before that domain
 * is verified would make every transactional email fail — welcome, enrollment
 * and password mail — with no error surfaced to the user. Completing the
 * migration is a one-variable operator action: verify the domain in Resend,
 * then set EMAIL_FROM. No code change is required.
 */
const FROM = process.env.EMAIL_FROM ?? 'XP Client Academy <noreply@smileycx.com>'
const DRY_RUN =
  process.env.EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY

function getResend(): Resend {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set')
  }
  return new Resend(process.env.RESEND_API_KEY)
}

interface SendResult {
  success: boolean
  error?:  string
}

async function sendEmail(params: {
  to:      string
  subject: string
  html:    string
  text:    string
}): Promise<SendResult> {
  if (DRY_RUN) {
    log.info({ to: params.to, subject: params.subject }, '[DRY RUN] Email not sent')
    return { success: true }
  }

  try {
    const resend = getResend()
    const { error } = await resend.emails.send({
      from:    FROM,
      to:      params.to,
      subject: params.subject,
      html:    params.html,
      text:    params.text,
    })

    if (error) {
      log.error({ error, to: params.to }, 'Resend error sending email')
      return { success: false, error: error.message }
    }

    log.info({ to: params.to, subject: params.subject }, 'Email sent')
    return { success: true }
  } catch (err) {
    log.error({ err, to: params.to }, 'Unexpected email send failure')
    return { success: false, error: 'Unexpected error' }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendWelcomeEmail(
  to: string,
  data: WelcomeEmailData,
): Promise<SendResult> {
  return sendEmail({
    to,
    subject: 'Bienvenue sur XP Client Academy !',
    html:    welcomeEmailHtml(data),
    text:    welcomeEmailText(data),
  })
}

export async function sendEnrollmentEmail(
  to: string,
  data: EnrollmentEmailData,
): Promise<SendResult> {
  return sendEmail({
    to,
    subject: `Inscription confirmée — ${data.courseTitle}`,
    html:    enrollmentEmailHtml(data),
    text:    enrollmentEmailText(data),
  })
}

/**
 * XPA-6A — account email verification.
 *
 * ⚠️ OPERATIONAL DEPENDENCY, stated rather than assumed: this is the only
 * channel by which a learner can activate an account, so if Resend is in dry-run
 * (no RESEND_API_KEY, or an unverified sender domain — decision register Q-D)
 * every public registration produces an account that can never be used. The
 * caller treats a send failure as non-fatal and surfaces "resend"; the failure
 * is logged and audited, never silent.
 */
export async function sendVerificationEmail(
  to: string,
  data: VerificationEmailData,
): Promise<SendResult> {
  return sendEmail({
    to,
    subject: 'Confirmez votre adresse email — XP Client Academy',
    html:    verificationEmailHtml(data),
    text:    verificationEmailText(data),
  })
}
