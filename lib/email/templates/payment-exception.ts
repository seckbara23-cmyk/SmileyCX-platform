/**
 * Alert to an allowlisted administrator about a payment exception (XP-PAYTECH-05).
 *
 * The order reference is the only payment fact in it. Mail passes through other
 * systems, so the learner, the amount and any token stay inside the admin page.
 */

export interface PaymentExceptionEmailData {
  reference: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function paymentExceptionEmailText({ reference }: PaymentExceptionEmailData): string {
  return [
    'Un paiement demande une vérification.',
    '',
    `Référence : ${reference}`,
    '',
    "PayTech a signalé un paiement que la plateforme ne peut pas traiter automatiquement. Cette alerte n'accorde aucun accès et n'effectue aucun remboursement.",
    '',
    'Consultez Admin > Paiements > Anomalies.',
  ].join('\n')
}

export function paymentExceptionEmailHtml({ reference }: PaymentExceptionEmailData): string {
  return `<!doctype html>
<html lang="fr">
  <body style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <p><strong>Un paiement demande une vérification.</strong></p>
    <p>Référence&nbsp;: <code>${escapeHtml(reference)}</code></p>
    <p>PayTech a signalé un paiement que la plateforme ne peut pas traiter automatiquement. Cette alerte n'accorde aucun accès et n'effectue aucun remboursement.</p>
    <p>Consultez <strong>Admin &gt; Paiements &gt; Anomalies</strong>.</p>
  </body>
</html>`
}
