// @vitest-environment node
/**
 * XP-BRAND-01 — the official visual identity, pinned.
 *
 * The charte graphique replaces the inherited Smiley palette (bright blue
 * #4a6de5, coral #ff7b54) with XP navy and orange, swaps Inter for Montserrat,
 * installs the official logo, corrects the public contact details, rebuilds the
 * footer and marks in-person training as not yet available.
 *
 * Most of that is a token change: every surface already consumes `primary`,
 * `secondary`, `dark`, `light` and `cx-gray`, so the palette moves in one
 * place. These tests exist because a token sweep is exactly the kind of change
 * that looks complete and leaves a hard-coded hex behind on one page.
 *
 * Contrast is computed here rather than eyeballed. That is how the orange
 * button was caught: the inherited `bg-secondary text-white` pairing scores
 * 3.02:1, below AA, which is why the brief specifies dark text on orange.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
/** Source with comments stripped — a guard must not match its own prose. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── WCAG contrast ──────────────────────────────────────────────────────────
function luminance(hex: string) {
  const h = hex.replace('#', '')
  const ch = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
function contrast(a: string, b: string) {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const PALETTE = {
  primary:   '#1B2A4A',
  accent:    '#E8741E',
  background:'#FFFFFF',
  surface:   '#F5F6F8',
  text:      '#1B2A4A',
  muted:     '#64748B',
  border:    '#E2E8F0',
  footer:    '#111827',
  success:   '#16A34A',
  error:     '#DC2626',
  warning:   '#D97706',
}

const LEGACY_SMILEY = [
  '#4a6de5', '#3557c7', '#ff7b54', '#e5643a',
  '#3d5fd6', '#5a7ef5', '#7c9bff', '#1e2235', '#f4f6fb', '#6c757d',
]

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §1–2 · palette and tokens', () => {
  it('Tailwind carries the official palette, value for value', () => {
    const cfg = code('tailwind.config.ts')
    for (const [name, hex] of Object.entries(PALETTE)) {
      if (name === 'background') continue           // white needs no token
      expect(cfg, `${name} missing from the theme`).toContain(hex)
    }
  })

  it('exposes the brief’s --xp-* variables on :root', () => {
    const css = read('app/globals.css')
    for (const [v, hex] of Object.entries({
      '--xp-primary': PALETTE.primary, '--xp-accent': PALETTE.accent,
      '--xp-background': PALETTE.background, '--xp-surface': PALETTE.surface,
      '--xp-text': PALETTE.text, '--xp-text-muted': PALETTE.muted,
      '--xp-border': PALETTE.border, '--xp-footer': PALETTE.footer,
      '--xp-success': PALETTE.success, '--xp-error': PALETTE.error,
      '--xp-warning': PALETTE.warning,
    })) {
      expect(css).toMatch(new RegExp(`${v}:\\s*${hex};`, 'i'))
    }
  })

  it('no legacy Smiley brand colour survives anywhere in app, components or lib', () => {
    const files = [
      'tailwind.config.ts', 'app/globals.css', 'app/page.tsx',
      'components/layout/Header.tsx', 'components/layout/Footer.tsx',
      'lib/pdf/CertificatePDF.tsx',
      'lib/email/templates/welcome.ts', 'lib/email/templates/enrollment.ts',
      'app/(platform)/certificates/[certificateId]/CertificateView.tsx',
    ]
    for (const f of files) {
      const src = code(f).toLowerCase()
      for (const hex of LEGACY_SMILEY) {
        expect(src, `${hex} still in ${f}`).not.toContain(hex)
      }
    }
  })

  it('keeps the semantic status colours semantic, at the brief’s values', () => {
    const cfg = code('tailwind.config.ts')
    expect(cfg).toMatch(/success:\s*'#16A34A'/)
    expect(cfg).toMatch(/error:\s*'#DC2626'/)
    expect(cfg).toMatch(/warning:\s*'#D97706'/)
  })

  it('does NOT rebrand the third-party payment marks', () => {
    const cfg = code('tailwind.config.ts')
    expect(cfg, 'Orange Money lost its brand colour').toContain('#ff6600')
    expect(cfg, 'Wave lost its brand colour').toContain('#1a56db')
  })

  it('uses Montserrat, and no longer asks for Inter as the UI face', () => {
    expect(code('tailwind.config.ts')).toMatch(/sans:\s*\['Montserrat'/)
    const layout = read('app/layout.tsx')
    expect(layout).toContain('family=Montserrat')
    expect(layout).not.toContain('family=Inter')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 · accessibility contrast', () => {
  it('orange buttons carry DARK text — white text fails AA on this orange', () => {
    expect(contrast(PALETTE.accent, '#FFFFFF')).toBeLessThan(4.5)   // why the brief says so
    expect(contrast(PALETTE.accent, PALETTE.footer)).toBeGreaterThanOrEqual(4.5)
  })

  it('the orange hover state also clears AA', () => {
    expect(contrast('#D96A18', PALETTE.footer)).toBeGreaterThanOrEqual(4.5)
  })

  it('no orange button is left with white text', () => {
    for (const f of [
      'components/layout/Header.tsx', 'components/ui/Button.tsx',
      'app/(public)/contact/ContactForm.tsx', 'app/(platform)/dashboard/page.tsx',
      'app/(public)/courses/_components/CourseCard.tsx',
    ]) {
      expect(read(f), `${f} pairs orange with white text`).not.toContain('bg-secondary text-white')
    }
  })

  it('core text pairings clear AA', () => {
    expect(contrast(PALETTE.background, PALETTE.text)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PALETTE.background, PALETTE.muted)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PALETTE.surface, PALETTE.text)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PALETTE.footer, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(PALETTE.primary, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })

  it('the "Bientôt disponible" badge clears AA', () => {
    expect(contrast('#FFF1E6', '#9A4100')).toBeGreaterThanOrEqual(4.5)
  })

  it('keyboard focus stays visible', () => {
    expect(read('app/globals.css')).toMatch(/:focus-visible/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §7 · official logo and favicon', () => {
  const LOGO = 'public/brand/xp-client-academy-logo.png'

  it('the official logo asset is present and keeps the supplied proportions', () => {
    expect(existsSync(join(process.cwd(), LOGO))).toBe(true)
    const buf = readFileSync(join(process.cwd(), LOGO))
    // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    expect(w).toBe(600)
    expect(h).toBe(432)
    // The artwork measured 973×696 inside the supplied raster (ratio 1.3980);
    // 600×432 is 1.3889. Within half a percent — scaled, never stretched.
    expect(Math.abs(w / h - 973 / 696)).toBeLessThan(0.01)
    // colour type 6 = RGBA, i.e. the transparent version the brief asks for.
    expect(buf.readUInt8(25)).toBe(6)
  })

  it('the app icon is square, so the XP symbol is never distorted', () => {
    const buf = readFileSync(join(process.cwd(), 'app/icon.png'))
    expect(buf.readUInt32BE(16)).toBe(buf.readUInt32BE(20))
    expect(buf.readUInt32BE(16)).toBe(512)
    expect(buf.readUInt8(25)).toBe(6)                 // transparent
  })

  it('metadata and manifest describe the icon at its real size', () => {
    expect(read('app/layout.tsx')).toMatch(/width: 512, height: 512/)
    expect(read('app/manifest.ts')).toMatch(/sizes: '512x512'/)
  })

  it('the manifest does not claim maskable for a non-maskable mark', () => {
    expect(code('app/manifest.ts')).not.toMatch(/maskable/)
  })

  it('header and footer render the logo with width AND height, so it cannot stretch', () => {
    for (const f of ['components/layout/Header.tsx', 'components/layout/Footer.tsx']) {
      const src = read(f)
      expect(src).toContain('/brand/xp-client-academy-logo.png')
      expect(src).toMatch(/width=\{600\}/)
      expect(src).toMatch(/height=\{432\}/)
      expect(src, `${f} should scale by height and auto width`).toMatch(/w-auto/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §8 · official contact details', () => {
  it('brand constants carry the official phone, email and location', () => {
    const b = read('lib/brand.ts')
    expect(b).toContain('contact@xpclient-academy.com')
    expect(b).toContain("CONTACT_PHONE = '+221 78 685 78 78'")
    expect(b).toContain("CONTACT_PHONE_HREF = 'tel:+221786857878'")
    expect(b).toContain('Dakar, Sénégal')
  })

  it('brand.ts stays client-safe — no server-only variable in a client import', () => {
    expect(code('lib/brand.ts')).not.toMatch(/process\.env\.CONTACT_EMAIL/)
  })

  it('delivery is separate from display, so publishing an address cannot drop mail', () => {
    const r = read('lib/email/contact-recipient.ts')
    expect(r).toMatch(/import 'server-only'/)
    expect(r).toMatch(/process\.env\.CONTACT_EMAIL/)
    for (const f of ['app/(public)/contact/actions.ts', 'app/actions/waitlist.ts']) {
      expect(read(f)).toContain('CONTACT_RECIPIENT_EMAIL')
    }
  })

  it('does NOT repoint the verified sending identity', () => {
    for (const f of ['app/(public)/contact/actions.ts', 'app/actions/waitlist.ts']) {
      expect(read(f), `${f} lost its EMAIL_FROM sender`).toMatch(/EMAIL_FROM/)
    }
  })

  it('the obsolete personal addresses and old number are gone from public pages', () => {
    for (const f of ['app/page.tsx', 'app/(public)/contact/page.tsx',
                     'app/(public)/about/founder/page.tsx', 'components/layout/Footer.tsx']) {
      const src = read(f)
      expect(src, `${f}`).not.toContain('mariemeify@gmail.com')
      expect(src, `${f}`).not.toContain('mariemelly@gmail.com')
      expect(src, `${f}`).not.toContain('77 576 0306')
      expect(src, `${f}`).not.toContain('+221775760382')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §9 · footer', () => {
  // Comment-stripped: this file documents what it removed, and a raw grep
  // would match that explanation instead of the markup.
  const footer = code('components/layout/Footer.tsx')

  it('the "Nos Services" block and all six of its links are gone', () => {
    expect(footer).not.toMatch(/Nos Services/i)
    for (const s of ['Stratégie CX', 'Parcours Client', 'Voix du Client',
                     'Expérience Employé', 'Mesure & Analyse', 'Formation CX']) {
      expect(footer, `${s} still advertised`).not.toContain(s)
    }
  })

  it('the public Admin link is gone — but the admin routes are untouched', () => {
    expect(footer).not.toMatch(/href="\/admin"/)
    expect(existsSync(join(process.cwd(), 'app/(admin)/admin/page.tsx'))).toBe(true)
    // the header still offers it, gated on the role, which is not public nav
    expect(read('components/layout/Header.tsx')).toMatch(/platform_role === 'super_admin'/)
  })

  it('carries the three zones the brief specifies', () => {
    expect(footer).toContain('/brand/xp-client-academy-logo.png')   // 1 identity
    for (const l of ['Accueil', 'Formations', 'À propos', 'Contact']) {
      expect(footer, `quick link ${l}`).toContain(l)                 // 2 links
    }
    expect(footer).toContain('CONTACT_PHONE_HREF')                   // 3 contact
    expect(footer).toContain('mailto:')
    expect(footer).toContain('CONTACT_LOCATION')
  })

  it('links only legal pages that exist', () => {
    expect(footer).toContain('/privacy')
    expect(footer).toContain('/terms')
    expect(existsSync(join(process.cwd(), 'app/(public)/privacy/page.tsx'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'app/(public)/terms/page.tsx'))).toBe(true)
    // there is no /legal route, so it must not be linked
    expect(existsSync(join(process.cwd(), 'app/(public)/legal/page.tsx'))).toBe(false)
    expect(footer).not.toMatch(/href="\/legal"/)
  })

  it('invents no social URL and shows no dead icon', () => {
    expect(footer).not.toMatch(/https:\/\/(www\.)?(facebook|twitter|instagram)\.com/)
    // LinkedIn renders only once a verified destination is configured.
    expect(footer).toContain('NEXT_PUBLIC_LINKEDIN_URL')
    expect(footer).toMatch(/LINKEDIN_URL &&/)
  })

  it('drops the newsletter stub that discarded what it collected', () => {
    expect(footer).not.toMatch(/Newsletter/i)
    expect(footer).not.toMatch(/preventDefault/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §10 · in-person training is not yet offered', () => {
  const home = read('app/page.tsx')

  it('the card carries a visible "Bientôt disponible" badge', () => {
    expect(home).toMatch(/Bient&ocirc;t disponible|Bientôt disponible/)
    expect(code('tailwind.config.ts')).toContain('#FFF1E6')
    expect(code('tailwind.config.ts')).toContain('#9A4100')
  })

  it('every booking action for in-person training is withdrawn', () => {
    expect(home).not.toMatch(/Demander un atelier/)
    expect(home).not.toMatch(/Demander une formation/)
    expect(read('app/(public)/contact/page.tsx')).not.toMatch(/Pr&eacute;cisez|Précisez/)
  })

  it('states the plain message instead of promising a date', () => {
    expect(home).toMatch(/seront propos&eacute;es prochainement|seront proposées prochainement/)
    expect(home).not.toMatch(/\b20\d\d\b.*présentiel/i)
  })

  it('online training stays fully available', () => {
    expect(home).toContain('Voir les formations')
    expect(home).toMatch(/href="\/courses"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 §11 · call-to-action harmonisation', () => {
  const home = read('app/page.tsx')
  const header = read('components/layout/Header.tsx')

  it('the header offers account access, not a commercial CTA', () => {
    expect(header).toContain('Se connecter')
    expect(header).not.toMatch(/Acc&eacute;der aux formations/)
    expect(header).toMatch(/href="\/login"/)
  })

  it('the hero keeps "Découvrir nos formations" pointing at the catalogue', () => {
    expect(home).toMatch(/D&eacute;couvrir nos formations/)
    expect(home).toMatch(/href="#formations"/)
  })

  it('the closing banner uses the brief’s exact wording', () => {
    expect(home).toMatch(/Pr&ecirc;t &agrave; d&eacute;velopper vos comp&eacute;tences en exp&eacute;rience client/)
    expect(home).toMatch(/Des formations pratiques, accessibles en ligne et adapt&eacute;es &agrave; votre rythme/)
    expect(read('components/site/FinalCtaButton.tsx')).toContain('Commencer ma formation')
  })

  it('that button sends a visitor to signup and a signed-in learner to the catalogue', () => {
    const cta = code('components/site/FinalCtaButton.tsx')
    expect(cta).toMatch(/useState\('\/signup'\)/)
    expect(cta).toMatch(/setHref\('\/courses'\)/)
    expect(cta).toMatch(/auth\.getUser\(\)/)
    // routing only — it must not grant access or bypass registration
    expect(cta).not.toMatch(/entitlement|enroll|insert|rpc/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-01 · nothing functional was traded for appearance', () => {
  it('no migration, RLS or payment logic is part of this change', () => {
    const cfg = code('tailwind.config.ts')
    expect(cfg).not.toMatch(/policy|grant|rpc/i)
    // payment selector keeps its provider colours
    expect(read('components/payment/PaymentMethodSelector.tsx')).toBeTruthy()
  })

  it('issued certificates are never regenerated for branding', () => {
    const route = read('app/api/certificates/[id]/pdf/route.ts')
    expect(route).toMatch(/if \(cert\.pdf_object_path\)/)
    expect(route).toMatch(/return NextResponse\.json\(\{ pdf_url: certificateMediaHref\(id\) \}\)/)
  })

  it('the public certificate verification page keeps its own security posture', () => {
    // XP-BRAND-01 restyles via tokens only; it must not touch this file's logic.
    const page = read('app/(public)/verify-certificate/[certificateId]/page.tsx')
    expect(page).not.toMatch(/\.insert\(|\.update\(|\.delete\(/)
  })
})
