/**
 * XP-PAYTECH-P7 — to the owners (ADMIN_OWNER_EMAILS) when a commercial price changes.
 * It says what changed, from what to what, who confirmed it and why, and the
 * number of the append-only record (migration 067). No learner data.
 */

export interface CommercialPriceAlertData {
  kind: 'course' | 'pack'
  code: string | null
  title: string
  oldPrice: number
  newPrice: number
  actorEmail: string | null
  reason: string
  changeId: number | null
}

const fcfa = (n: number) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} FCFA`
const label = (d: CommercialPriceAlertData) =>
  `${d.kind === 'pack' ? 'Pack' : 'Formation'} ${d.code ?? ''} « ${d.title} »`.replace(/\s+/g, ' ').trim()

export function commercialPriceAlertSubject(d: CommercialPriceAlertData): string {
  return `Prix modifié — ${d.code ?? d.title} : ${fcfa(d.oldPrice)} → ${fcfa(d.newPrice)}`
}

export function commercialPriceAlertText(d: CommercialPriceAlertData): string {
  return [
    'Prix modifié sur XP Client Academy',
    '',
    label(d),
    `Ancien prix : ${fcfa(d.oldPrice)}`,
    `Nouveau prix : ${fcfa(d.newPrice)}`,
    `Confirmé par : ${d.actorEmail ?? 'administrateur (adresse inconnue)'}`,
    `Motif : ${d.reason}`,
    d.changeId ? `Enregistrement n° ${d.changeId} (commercial_price_changes)` : 'Enregistrement : voir commercial_price_changes',
    '',
    'Le nouveau prix s’applique aux prochains paiements. Si ce changement n’était pas prévu, rétablissez le prix approuvé et vérifiez les accès administrateur.',
  ].join('\n')
}

export function commercialPriceAlertHtml(d: CommercialPriceAlertData): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#888">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8" /><title>${esc(commercialPriceAlertSubject(d))}</title></head>
<body style="margin:0;padding:24px;background:#F5F6F8;font-family:Montserrat,Inter,Arial,sans-serif;color:#1B2A4A">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px 32px">
    <h2 style="margin:0 0 12px">Prix modifié</h2>
    <p>${esc(label(d))}</p>
    <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
      ${row('Ancien prix', fcfa(d.oldPrice))}
      ${row('Nouveau prix', fcfa(d.newPrice))}
      ${row('Confirmé par', d.actorEmail ?? 'administrateur (adresse inconnue)')}
      ${row('Motif', d.reason)}
      ${row('Enregistrement', d.changeId ? `n° ${d.changeId}` : 'commercial_price_changes')}
    </table>
    <p style="font-size:13px;color:#666">Le nouveau prix s’applique aux prochains paiements. Si ce changement n’était pas prévu, rétablissez le prix approuvé et vérifiez les accès administrateur.</p>
  </div>
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── The daily integrity summary (reconciliation cron) ────────────────────────

export interface CommercialIntegrityAlertData {
  /** Every price change of the last hours, confirmed or not. */
  priceChanges: readonly {
    at: string; kind: string; code: string | null; oldPrice: number | null; newPrice: number | null
    confirmedInApp: boolean; actorEmail: string | null
  }[]
  /** Completed payments with no recorded access: an access-grant failure. Order references only. */
  accessLinkMissing: readonly string[]
  windowHours: number
}

export function commercialIntegrityAlertSubject(d: CommercialIntegrityAlertData): string {
  const parts = [
    d.priceChanges.length ? `${d.priceChanges.length} changement(s) de prix` : '',
    d.accessLinkMissing.length ? `${d.accessLinkMissing.length} paiement(s) sans accès` : '',
  ].filter(Boolean)
  return `Contrôle quotidien — ${parts.join(', ')}`
}

const amount = (n: number | null) => (n === null ? '—' : fcfa(n))

export function commercialIntegrityAlertText(d: CommercialIntegrityAlertData): string {
  const lines = ['Contrôle quotidien XP Client Academy', '']
  if (d.priceChanges.length) {
    lines.push(`Changements de prix des ${d.windowHours} dernières heures :`)
    for (const c of d.priceChanges) {
      lines.push(`- ${c.at} ${c.kind} ${c.code ?? ''} : ${amount(c.oldPrice)} → ${amount(c.newPrice)} — ${
        c.confirmedInApp ? `confirmé dans l’administration par ${c.actorEmail ?? 'un administrateur'}` : 'HORS DE L’ADMINISTRATION, à vérifier'}`)
    }
    lines.push('')
  }
  if (d.accessLinkMissing.length) {
    lines.push('Paiements terminés sans accès enregistré (à vérifier dans Admin › Paiements) :')
    for (const r of d.accessLinkMissing) lines.push(`- ${r}`)
    lines.push('')
  }
  lines.push('Ce message n’est envoyé que lorsqu’il y a quelque chose à signaler.')
  return lines.join('\n')
}

export function commercialIntegrityAlertHtml(d: CommercialIntegrityAlertData): string {
  const body = commercialIntegrityAlertText(d).split('\n').map(l => esc(l)).join('<br />')
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8" /><title>${esc(commercialIntegrityAlertSubject(d))}</title></head>
<body style="margin:0;padding:24px;background:#F5F6F8;font-family:Montserrat,Inter,Arial,sans-serif;color:#1B2A4A">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px 32px;font-size:14px;line-height:1.6">${body}</div>
</body>
</html>`
}
