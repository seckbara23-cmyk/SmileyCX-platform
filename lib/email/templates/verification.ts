/**
 * Email-verification template (XPA-6A).
 *
 * The verify URL is composed by the caller from PUBLIC_SITE_URL and passed in.
 * This template never reads the request origin, so it cannot emit a link on the
 * internal deployment hostname — a learner must never receive one.
 */
import { BRAND_NAME, PUBLIC_SITE_URL, CONTACT_EMAIL } from '@/lib/brand'

export interface VerificationEmailData {
  /** May be empty (resend flow, where we do not look the name up). */
  firstName: string
  verifyUrl: string
}

export function verificationEmailHtml(data: VerificationEmailData): string {
  const greeting = data.firstName ? `Bonjour ${escapeHtml(data.firstName)},` : 'Bonjour,'
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#151b26;">
              Confirmez votre adresse email
            </h1>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4a5262;">${greeting}</p>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4a5262;">
              Merci d'avoir créé votre compte ${escapeHtml(BRAND_NAME)}. Confirmez votre adresse
              email pour activer votre compte.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td style="border-radius:10px;background:#2563eb;">
                <a href="${data.verifyUrl}"
                   style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                  Confirmer mon adresse email
                </a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
              Ce lien est à usage unique. Si le bouton ne fonctionne pas, copiez ce lien
              dans votre navigateur :
            </p>
            <p style="margin:0 0 24px;font-size:12px;line-height:1.5;color:#2563eb;word-break:break-all;">
              ${data.verifyUrl}
            </p>
            <p style="margin:0 0 24px;padding:14px 16px;background:#f4f5f7;border-radius:10px;font-size:13px;line-height:1.6;color:#4a5262;">
              La création d'un compte ne donne pas accès aux formations. L'accès à une
              formation est activé séparément.
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
              Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email —
              aucun compte ne sera activé.
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

export function verificationEmailText(data: VerificationEmailData): string {
  const greeting = data.firstName ? `Bonjour ${data.firstName},` : 'Bonjour,'
  return `${greeting}

Merci d'avoir créé votre compte ${BRAND_NAME}.

Confirmez votre adresse email pour activer votre compte :
${data.verifyUrl}

Ce lien est à usage unique.

La création d'un compte ne donne pas accès aux formations. L'accès à une
formation est activé séparément.

Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — aucun
compte ne sera activé.

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
