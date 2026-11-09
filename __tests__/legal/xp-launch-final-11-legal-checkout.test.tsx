/**
 * XP-LAUNCH-FINAL-11 — the legal texts at version 1.0, and the three boxes of CGV art. 4.
 *
 * The database half (refusal without the boxes, the record on the order, the one
 * confirmation e-mail) runs on a real engine in
 * `__tests__/payments/xp-paytech-ready-01-integration.test.ts`. This file covers
 * what is published and what a learner sees and ticks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { CGU, CGV, PRIVACY, LEGAL_NOTICE, legalTextPlain, type LegalText } from '@/lib/legal/documents'
import {
  LEGAL_NOTICE_VERSION, LEGAL_TEXT_PENDING_REVIEW, PRIVACY_VERSION, SALES_TERMS_VERSION, TERMS_VERSION,
} from '@/lib/legal/versions'
import {
  CHECKOUT_TERMS_VERSION, checkCheckoutConsent, checkoutConsentRecord, tickedCheckoutConsent,
} from '@/lib/legal/checkout-consent'
import {
  paymentConfirmationEmailHtml, paymentConfirmationEmailText, paymentConfirmationSubject,
  type PaymentConfirmationEmailData,
} from '@/lib/email/templates/payment-confirmation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const digits = (s: string) => s.replace(/[\s  ]/g, '')

const startPaytechCheckout = vi.fn(async (..._a: unknown[]) => ({ error: 'stop' }))
vi.mock('@/app/actions/paytech-checkout', () => ({
  startPaytechCheckout: (...a: unknown[]) => startPaytechCheckout(...a),
  startPaytechPackCheckout: vi.fn(),
}))

beforeEach(() => { startPaytechCheckout.mockClear() })
afterEach(() => cleanup())

const DOCS: [string, LegalText, string][] = [
  ['CGU', CGU, TERMS_VERSION],
  ['CGV', CGV, SALES_TERMS_VERSION],
  ['privacy', PRIVACY, PRIVACY_VERSION],
  ['legal notice', LEGAL_NOTICE, LEGAL_NOTICE_VERSION],
]

describe('XP-LAUNCH-FINAL-11 · the four texts, version 1.0', () => {
  it.each(DOCS)('%s: version 1.0, the same number the platform records', (_n, doc, constant) => {
    expect(doc.version).toBe('1.0')
    expect(constant).toBe('1.0')
  })

  it.each(DOCS)('%s: only the public text — none of the internal working notes', (_n, doc) => {
    const text = legalTextPlain(doc)
    expect(text).not.toMatch(/Note de travail|à retirer avant publication|Où on en est|Points à montrer à l.avocat|Ce que la plateforme doit faire|Informations encore à confirmer|\bToi\b|la technique/i)
    expect(text).not.toMatch(/à compléter|\[.*\]|TODO|XXX/)
  })

  it.each(DOCS)('%s: never claims a lawyer approved it, and never promises lifetime access', (_n, doc) => {
    const text = legalTextPlain(doc)
    expect(text).not.toMatch(/(validé|validée|approuvé|approuvée|relu|relue)s? par (un|une|notre) (avocat|juriste|conseil)/i)
    expect(text).not.toMatch(/à vie|illimité|sans limite de durée/i)
  })

  it('the CGV list exactly the V4 prices, the free course, and the two packs', () => {
    const prices = CGV.sections.find(s => s.id === 'article-2')!.blocks.find(b => 'table' in b) as { table: { rows: string[][] } }
    expect(Object.fromEntries(prices.table.rows.map(r => [r[0], digits(r[2])]))).toEqual({
      'C1-F1': '9900', 'C1-F2': '9900', 'C1-F3': '9900', 'C2-F4': '14900',
      'C2-F1': '14900', 'C2-F2': '14900', 'C2-F5': '14900', 'C1-F4': 'Gratuite',
    })
    const packs = CGV.sections.find(s => s.id === 'article-3')!.blocks.find(b => 'table' in b) as { table: { rows: string[][] } }
    expect(packs.table.rows.map(r => [r[0], r[1], digits(r[2])])).toEqual([
      ['Pack Conseiller', 'C1-F1 + C1-F2 + C1-F3 + C2-F4', '37900'],
      ['Pack Manager', 'C2-F1 + C2-F2 + C2-F5', '38000'],
    ])
  })

  it('the CGV say six months from the validation of the payment, packs together, C1-F4 without an end, certificates kept', () => {
    const text = legalTextPlain(CGV)
    expect(text).toMatch(/\*\*six \(6\) mois calendaires\*\* pour chaque formation payante, à compter de la validation du paiement/)
    expect(text).toMatch(/toutes les formations du pack sont activées en même temps.*et expirent ensemble/)
    expect(text).toMatch(/La formation gratuite \(C1-F4\) est accessible pour une durée indéterminée/)
    expect(text).toMatch(/Un certificat déjà obtenu reste valide et vérifiable/)
  })

  it('the immediate-access request keeps the buyer\'s statutory rights (CGV 7.1, 7.2)', () => {
    const text = legalTextPlain(CGV)
    expect(text).toMatch(/Cette demande ne prive pas le Client des droits qui lui sont reconnus par la législation sénégalaise/)
    expect(text).toMatch(/bénéficie du droit de rétractation prévu par la réglementation sénégalaise/)
  })
})

describe('XP-LAUNCH-FINAL-11 · the four pages', () => {
  const PAGES: [string, string, string][] = [
    ['app/(public)/terms/page', '/terms', 'Conditions générales d’utilisation (CGU)'],
    ['app/(public)/cgv/page', '/cgv', 'Conditions générales de vente (CGV)'],
    ['app/(public)/privacy/page', '/privacy', 'Politique de confidentialité'],
    ['app/(public)/mentions-legales/page', '/mentions-legales', 'Mentions légales'],
  ]

  it.each(PAGES)('%s renders its text at version 1.0 and links the three others', async (mod, href, title) => {
    const { default: Page } = await import(`@/${mod}`)
    const html = renderToStaticMarkup(Page() as ReactElement)
    expect(html).toContain(title)
    expect(html).toContain('Version 1.0 — novembre 2026')
    for (const [, other] of PAGES) {
      if (other === href) continue
      expect(html).toContain(`href="${other}"`)
    }
    expect(html).toContain('mailto:contact@xpclient-academy.com')
  })

  it('while the review is pending the pages say so, factually, and claim no approval', async () => {
    expect(LEGAL_TEXT_PENDING_REVIEW).toBe(true)
    const { default: Page } = await import('@/app/(public)/cgv/page')
    const html = renderToStaticMarkup(Page() as ReactElement)
    expect(html).toContain('Une relecture juridique de ce texte est en cours')
    expect(html).not.toMatch(/(validé|approuvé|relu)e?s? par (un|une|notre) (avocat|juriste|conseil)/i)
  })

  it('the footer links the four, the private mode lets visitors read them, and the sitemap lists them', () => {
    const footer = read('components/layout/Footer.tsx')
    for (const href of ['/mentions-legales', '/terms', '/cgv', '/privacy']) expect(footer).toContain(`href="${href}"`)
    const mw = read('middleware.ts')
    expect(mw).toMatch(/'\/cgv',/)
    expect(mw).toMatch(/'\/mentions-legales',/)
    const sitemap = read('app/sitemap.ts')
    expect(sitemap).toMatch(/path: '\/cgv'/)
    expect(sitemap).toMatch(/path: '\/mentions-legales'/)
  })
})

describe('XP-LAUNCH-FINAL-11 · the consent rule', () => {
  it('accepts only all three boxes, exactly true, at the version on offer', () => {
    expect(CHECKOUT_TERMS_VERSION).toBe('1.0+1.0')
    expect(checkCheckoutConsent(tickedCheckoutConsent())).toBe('accepted')
    for (const bad of [null, undefined, 'yes', 1, {}, { ...tickedCheckoutConsent(), terms: false },
      { ...tickedCheckoutConsent(), immediateAccess: 'true' }, { ...tickedCheckoutConsent(), adultOrGuardian: undefined }]) {
      expect(checkCheckoutConsent(bad)).toBe('incomplete')
    }
    expect(checkCheckoutConsent({ ...tickedCheckoutConsent(), version: '0.9' })).toBe('stale')
  })

  it('records the versions and the server time, never a browser\'s', () => {
    const at = new Date('2026-11-09T15:00:00.000Z')
    expect(checkoutConsentRecord(at)).toEqual({
      cgu: '1.0', cgv: '1.0', acceptedAt: '2026-11-09T15:00:00.000Z',
      immediateAccessRequested: true, adultOrGuardianCertified: true,
    })
    const action = read('app/actions/paytech-checkout.ts')
    expect(action).toMatch(/legal: checkoutConsentRecord\(new Date\(\)\)/)
    expect(action).not.toMatch(/input\??\.consent\??\.acceptedAt|consent\.version\s*\)/)
  })
})

describe('XP-LAUNCH-FINAL-11 · the three boxes at checkout', () => {
  async function panel() {
    const { default: CourseCheckoutPanel } = await import('@/components/payment/CourseCheckoutPanel')
    render(<CourseCheckoutPanel courseId="00000000-0000-4000-8000-0000000000c1" />)
    return screen.getByRole('button', { name: /Payer avec PayTech/ }) as HTMLButtonElement
  }

  it('three boxes, none ticked, and the button locked', async () => {
    const button = await panel()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(3)
    expect(boxes.every(b => !b.checked)).toBe(true)
    expect(button.disabled).toBe(true)
  })

  it('the wording: CGU and CGV 1.0 linked, immediate access WITHOUT giving up legal rights, 18 or a guardian', async () => {
    await panel()
    expect(screen.getByRole('link', { name: /Conditions générales d’utilisation/ }).getAttribute('href')).toBe('/terms')
    expect(screen.getByRole('link', { name: /Conditions générales de vente/ }).getAttribute('href')).toBe('/cgv')
    expect(screen.getByRole('checkbox', { name: /version 1\.0.*version 1\.0/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /activation immédiate.*ne me prive pas des droits que me reconnaît la législation sénégalaise/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /18 ans ou plus, ou acheter en tant que parent ou représentant légal/ })).toBeTruthy()
  })

  it('two boxes are not enough; the third unlocks it, and the click sends the course and the three boxes', async () => {
    const button = await panel()
    fireEvent.click(screen.getByRole('checkbox', { name: /J’ai lu et j’accepte/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /activation immédiate/ }))
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(startPaytechCheckout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /18 ans ou plus/ }))
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(startPaytechCheckout).toHaveBeenCalledTimes(1))
    expect(startPaytechCheckout.mock.calls[0]).toEqual([{ courseId: '00000000-0000-4000-8000-0000000000c1', consent: tickedCheckoutConsent() }])
  })

  it('unticking one locks it again', async () => {
    const button = await panel()
    for (const name of [/J’ai lu et j’accepte/, /activation immédiate/, /18 ans ou plus/]) fireEvent.click(screen.getByRole('checkbox', { name }))
    expect(button.disabled).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: /activation immédiate/ }))
    expect(button.disabled).toBe(true)
  })

  it('the payment button itself still renders no input: the boxes live in the panels (safeguard 7)', () => {
    expect(read('components/payment/PaytechCheckoutButton.tsx')).not.toMatch(/<input|<Input/)
    expect(read('components/payment/PackCheckoutPanel.tsx')).toMatch(/<CheckoutConsents scope="pack"/)
  })
})

describe('XP-LAUNCH-FINAL-11 · the purchase confirmation e-mail (CGV art. 4.4)', () => {
  const base: PaymentConfirmationEmailData = {
    fullName: 'Awa', productTitle: 'Les fondamentaux de l’expérience client', packCourses: [],
    amount: '9 900 FCFA', reference: 'SCX-REF-1', accessEndsOn: '9 mai 2027',
    acceptedTerms: 'CGU 1.0 et CGV 1.0', dashboardUrl: 'https://example.test/dashboard', contactEmail: 'contact@example.test',
  }

  it('says what, how much, the reference, six months and its end, and the conditions accepted', () => {
    for (const out of [paymentConfirmationEmailText(base), paymentConfirmationEmailHtml(base)]) {
      expect(out).toContain('9 900 FCFA')
      expect(out).toContain('SCX-REF-1')
      expect(out).toContain('six mois, jusqu’au 9 mai 2027')
      expect(out).toContain('CGU 1.0 et CGV 1.0')
      expect(out).toContain('https://example.test/dashboard')
      expect(out).not.toMatch(/à vie|facture n°|TVA/i)
    }
    expect(paymentConfirmationSubject(base)).toBe('Paiement confirmé — Les fondamentaux de l’expérience client')
  })

  it('for a pack, lists its courses and says the owned ones keep their access, neither refunded nor replaced', () => {
    const d = { ...base, productTitle: 'Pack Conseiller', packCourses: [{ title: 'A', preexisting: true }, { title: 'B', preexisting: false }] }
    const text = paymentConfirmationEmailText(d)
    expect(text).toContain('- A (déjà possédée)')
    expect(text).toContain('- B')
    expect(text).toContain('ni remboursées ni remplacées')
  })

  it('escapes what it prints', () => {
    expect(paymentConfirmationEmailHtml({ ...base, productTitle: '<b>x' })).not.toContain('<b>x')
  })

  it('is sent once, on the fresh completion only, and never blocks it', () => {
    const src = read('lib/payments/paytech-reconcile.ts')
    const fresh = src.indexOf("if (outcome.kind === 'already_completed') return outcome")
    const send = src.indexOf('await sendPaymentConfirmation(row.id)')
    expect(fresh).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(fresh)
    expect(src.match(/sendPaymentConfirmation\(/g)).toHaveLength(1)
    const mod = read('lib/payments/payment-confirmation.ts')
    expect(mod).toMatch(/\} catch \{\r?\n\s*return failed\(paymentId, 'threw'\)/)
    expect(mod).not.toMatch(/log\.(info|warn|error)\(\{[^}]*\b(to|email|amount)\b/)
  })
})
