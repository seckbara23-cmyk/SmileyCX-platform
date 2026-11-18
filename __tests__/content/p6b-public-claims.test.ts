/**
 * P6B — public claims match what is sold and what the legal texts say.
 *
 * Each pin below was a live discrepancy before the public launch:
 *   - /courses claimed in-person sessions; the home page says in-person is « Bientôt disponible »;
 *   - three pages promised a reply « sous 24h »; CGV art. 13, the mentions légales and the
 *     privacy policy say « 48 heures ouvrées »;
 *   - the cancel page stated « aucun montant n'a été débité » without checking anything;
 *   - CGV art. 11 promises a receipt with RCCM and NINEA for each sale; the confirmation
 *     e-mail carried neither.
 * Absence checks read comment-stripped source, so prose explaining a removal cannot trip them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CGU, CGV, LEGAL_NOTICE, legalTextPlain } from '@/lib/legal/documents'
import { SELLER_IDENTITY } from '@/lib/brand'
import {
  paymentConfirmationEmailHtml, paymentConfirmationEmailText, sellerLine,
  type PaymentConfirmationEmailData,
} from '@/lib/email/templates/payment-confirmation'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const strip = (s: string) =>
  s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

describe('P6B · public pages promise only what exists', () => {
  it('/courses no longer offers in-person sessions', () => {
    const content = strip(read('app/(public)/courses/content.ts'))
    expect(content).not.toMatch(/présentiel|lors de nos sessions/i)
  })

  it('every public reply-time promise is the legal « 48 heures ouvrées »', () => {
    for (const f of ['app/page.tsx', 'app/(public)/contact/page.tsx', 'app/payment/cancel/page.tsx']) {
      const src = strip(read(f))
      expect(src, f).not.toMatch(/sous 24\s*h|24&nbsp;h|sous 24h/)
      expect(src, f).toMatch(/48(&nbsp;|\s)heures ouvr(é|&eacute;)es/)
    }
    expect(legalTextPlain(CGV)).toMatch(/48 heures ouvrées/)
  })

  it('the cancel page no longer asserts that nothing was debited', () => {
    const src = strip(read('app/payment/cancel/page.tsx'))
    expect(src).not.toMatch(/n&apos;a été débité/)
    expect(src).toMatch(/tant que le paiement n&apos;est pas validé sur la page de PayTech/)
  })
})

describe('P6B · the confirmation e-mail is the receipt of CGV art. 11', () => {
  const base: PaymentConfirmationEmailData = {
    fullName: 'Awa', productTitle: 'Les fondamentaux de l’expérience client', packCourses: [],
    amount: '9 900 FCFA', reference: 'SCX-REF-1', paidOn: '18 novembre 2026', accessEndsOn: '18 mai 2027',
    acceptedTerms: 'CGU 1.0 et CGV 1.0', dashboardUrl: 'https://example.test/dashboard', contactEmail: 'contact@example.test',
  }

  it('carries the date, the amount, the reference and the seller with its RCCM and NINEA', () => {
    for (const out of [paymentConfirmationEmailText(base), paymentConfirmationEmailHtml(base)]) {
      expect(out).toContain('Date du paiement')
      expect(out).toContain('18 novembre 2026')
      expect(out).toContain('Ce message vaut reçu de paiement.')
      expect(out).toContain(`RCCM : ${SELLER_IDENTITY.rccm}`)
      expect(out).toContain(`NINEA : ${SELLER_IDENTITY.ninea}`)
      expect(out).toContain(SELLER_IDENTITY.legalName)
      expect(out).not.toMatch(/TVA|facture n°/i)
    }
  })

  it('omits the date line, not the receipt, when the date cannot be read', () => {
    const text = paymentConfirmationEmailText({ ...base, paidOn: null })
    expect(text).not.toContain('Date du paiement')
    expect(text).toContain(sellerLine())
  })

  it('the seller identity it prints is the one the legal texts publish', () => {
    const published = legalTextPlain(LEGAL_NOTICE) + '\n' + legalTextPlain(CGU)
    expect(published).toContain(SELLER_IDENTITY.rccm)
    expect(published).toContain(SELLER_IDENTITY.ninea)
    expect(published).toContain(SELLER_IDENTITY.tradeName)
    expect(published).toContain('Ngor Cité SOCABEG, villa n° 16, Dakar')
    expect(published).toMatch(/XP CLIENT,? SUARL/)
  })

  it('the confirmation reads the payment date from the completed payment', () => {
    const src = read('lib/payments/payment-confirmation.ts')
    expect(src).toMatch(/select\('[^']*\bcompleted_at\b[^']*'\)/)
    expect(src).toMatch(/paidOn: typeof p\.completed_at === 'string' \? dayOf\(p\.completed_at\) : null/)
  })
})
