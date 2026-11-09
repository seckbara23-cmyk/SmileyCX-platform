/**
 * Purchase confirmation — XP-LAUNCH-FINAL-11 (CGV art. 4.4: « Vous recevez une
 * confirmation par e-mail et l'accès à votre formation est activé automatiquement »).
 *
 * Sent once, to the learner, when a payment is completed. It states what was
 * bought, the amount, the order reference, until when the access runs, and the
 * versions of the conditions accepted at checkout. It is a confirmation, not an
 * invoice: the CGV say a facture or reçu is sent on request.
 */

export interface PaymentConfirmationEmailData {
  fullName: string
  /** The course title, or the pack title. */
  productTitle: string
  /** For a pack, the courses it opened or already held; empty for a course. */
  packCourses: readonly { title: string; preexisting: boolean }[]
  amount: string
  reference: string
  /** « 9 mai 2027 », or null if it could not be read (the e-mail then says where to see it). */
  accessEndsOn: string | null
  /** e.g. « CGU 1.0 et CGV 1.0 », or null when the order carries no acceptance. */
  acceptedTerms: string | null
  dashboardUrl: string
  contactEmail: string
}

export function paymentConfirmationSubject(d: Pick<PaymentConfirmationEmailData, 'productTitle'>): string {
  return `Paiement confirmé — ${d.productTitle}`
}

function accessLine(d: PaymentConfirmationEmailData): string {
  return d.accessEndsOn
    ? `Votre accès est ouvert pour six mois, jusqu’au ${d.accessEndsOn}.`
    : 'Votre accès est ouvert pour six mois ; sa date de fin figure dans votre espace.'
}

const PREEXISTING_NOTE =
  'Les formations que vous possédiez déjà conservent leur accès actuel : elles ne sont ni remboursées ni remplacées.'

export function paymentConfirmationEmailText(d: PaymentConfirmationEmailData): string {
  const lines = [
    'Paiement confirmé',
    '',
    `Bonjour ${d.fullName},`,
    '',
    `Votre paiement pour « ${d.productTitle} » est confirmé.`,
  ]
  if (d.packCourses.length > 0) {
    lines.push('', 'Formations du pack :')
    for (const c of d.packCourses) lines.push(`- ${c.title}${c.preexisting ? ' (déjà possédée)' : ''}`)
  }
  lines.push(
    '',
    `Montant : ${d.amount}`,
    `Référence de commande : ${d.reference}`,
    accessLine(d),
  )
  if (d.packCourses.some(c => c.preexisting)) lines.push(PREEXISTING_NOTE)
  if (d.acceptedTerms) lines.push(`Conditions acceptées lors de la commande : ${d.acceptedTerms}.`)
  lines.push(
    '',
    `Commencer : ${d.dashboardUrl}`,
    '',
    `Une question, une facture ou un reçu : ${d.contactEmail}, en indiquant votre référence de commande.`,
    '',
    'XP Client Academy',
  )
  return lines.join('\n')
}

export function paymentConfirmationEmailHtml(d: PaymentConfirmationEmailData): string {
  const courses = d.packCourses.length === 0 ? '' : `
      <p style="margin:16px 0 4px;font-weight:600">Formations du pack :</p>
      <ul style="margin:0 0 16px;padding-left:20px">
        ${d.packCourses.map(c => `<li>${esc(c.title)}${c.preexisting ? ' <em>(déjà possédée)</em>' : ''}</li>`).join('\n        ')}
      </ul>`
  const preexisting = d.packCourses.some(c => c.preexisting) ? `<p>${esc(PREEXISTING_NOTE)}</p>` : ''
  const terms = d.acceptedTerms ? `<p style="font-size:13px;color:#666">Conditions acceptées lors de la commande : ${esc(d.acceptedTerms)}.</p>` : ''
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(paymentConfirmationSubject(d))}</title>
</head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:Montserrat,Inter,Arial,sans-serif;color:#1B2A4A">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:10px;overflow:hidden">
    <div style="background:#1B2A4A;padding:28px 40px;text-align:center">
      <h1 style="color:#ffffff;margin:0;font-size:24px">XP Client Academy</h1>
    </div>
    <div style="padding:32px 40px;font-size:15px;line-height:1.6;color:#444">
      <h2 style="font-size:20px;margin:0 0 12px;color:#1B2A4A">Paiement confirmé</h2>
      <p>Bonjour ${esc(d.fullName)},</p>
      <p>Votre paiement pour <strong>« ${esc(d.productTitle)} »</strong> est confirmé.</p>${courses}
      <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
        <tr><td style="padding:4px 16px 4px 0;color:#888">Montant</td><td style="padding:4px 0">${esc(d.amount)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#888">Référence</td><td style="padding:4px 0;font-family:monospace">${esc(d.reference)}</td></tr>
      </table>
      <p>${esc(accessLine(d))}</p>
      ${preexisting}
      <p style="text-align:center;margin:24px 0">
        <a href="${esc(d.dashboardUrl)}" style="display:inline-block;background:#E8741E;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600">Commencer ma formation</a>
      </p>
      ${terms}
      <p style="font-size:13px;color:#666">Une question, une facture ou un reçu : écrivez à ${esc(d.contactEmail)} en indiquant votre référence de commande.</p>
    </div>
  </div>
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
