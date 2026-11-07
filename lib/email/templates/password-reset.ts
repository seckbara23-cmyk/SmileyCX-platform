/**
 * Password-reset template (XP-LAUNCH-01).
 *
 * The reset URL is composed by the caller from PUBLIC_SITE_URL and passed in,
 * exactly as the verification template works: this file never reads the
 * request origin, so it cannot emit a link on the internal deployment host.
 */
import { BRAND_NAME, PUBLIC_SITE_URL, CONTACT_EMAIL } from '@/lib/brand'

export interface PasswordResetEmailData {
  resetUrl: string
}

export function passwordResetEmailHtml(data: PasswordResetEmailData): string {
  const url = escapeHtml(data.resetUrl)
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#151b26;">
              Réinitialisez votre mot de passe
            </h1>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4a5262;">Bonjour,</p>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4a5262;">
              Vous avez demandé à réinitialiser le mot de passe de votre compte
              ${escapeHtml(BRAND_NAME)}. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td style="border-radius:10px;background:#2563eb;">
                <a href="${url}"
                   style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                  Choisir un nouveau mot de passe
                </a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
              Ce lien est à usage unique et expire dans une heure. Si le bouton ne fonctionne
              pas, copiez ce lien dans votre navigateur :
            </p>
            <p style="margin:0 0 24px;font-size:12px;line-height:1.5;color:#2563eb;word-break:break-all;">
              ${url}
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
              Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email —
              votre mot de passe reste inchangé.
            </p>
          </td></tr>
        </table>
        <p style="margin:20px 0 0;font-size:12px;color:#8b94a5;">
          ${escapeHtml(BRAND_NAME)} — <a href="${PUBLIC_SITE_URL}" style="color:#8b94a5;">${PUBLIC_SITE_URL.replace(/^https:\/\//, '')}</a>
          &nbsp;·&nbsp; ${escapeHtml(CONTACT_EMAIL)}
        </p>
      </td></tr>
    </table>
  </body>
</html>`
}

export function passwordResetEmailText(data: PasswordResetEmailData): string {
  return `Bonjour,

Vous avez demandé à réinitialiser le mot de passe de votre compte ${BRAND_NAME}.

Choisissez un nouveau mot de passe en ouvrant ce lien :
${data.resetUrl}

Ce lien est à usage unique et expire dans une heure.

Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre
mot de passe reste inchangé.

${BRAND_NAME} — ${PUBLIC_SITE_URL}
${CONTACT_EMAIL}
`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
