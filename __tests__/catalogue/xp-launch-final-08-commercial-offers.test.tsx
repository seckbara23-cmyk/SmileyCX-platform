/**
 * XP-LAUNCH-FINAL-08 — the commercial offers in the interface.
 *
 * The database half (prices, six months, packs, renewal, overlap) runs on a real
 * engine in `__tests__/payments/xp-paytech-ready-01-integration.test.ts`. This file
 * covers what a visitor and a learner see: the three offers, the pack page, the pack
 * checkout and its warning, the six-month wording, the hidden pathways, and that
 * certificates never depend on course access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** Digits only, so the thin spaces `toLocaleString('fr-FR')` inserts never matter. */
const digits = (html: string) => html.replace(/[\s  ]/g, '')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel))
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, join(ROOT, rel)).replace(/\\/g, '/'))
  }
  return out
}

const COURSES = {
  'C1-F1': { id: '00000000-0000-4000-8000-0000000000c1', slug: 'c1-f1', title: 'Les fondamentaux de l’expérience client', price: 9900 },
  'C1-F2': { id: '00000000-0000-4000-8000-0000000000c2', slug: 'c1-f2', title: 'Les fondamentaux du service client', price: 9900 },
  'C1-F3': { id: '00000000-0000-4000-8000-0000000000c3', slug: 'c1-f3', title: 'Communiquer sur les canaux digitaux', price: 9900 },
  'C2-F4': { id: '00000000-0000-4000-8000-0000000000c4', slug: 'c2-f4', title: 'Gérer les réclamations', price: 14900 },
  'C2-F1': { id: '00000000-0000-4000-8000-0000000000d1', slug: 'c2-f1', title: 'Manager une équipe orientée client', price: 14900 },
  'C2-F2': { id: '00000000-0000-4000-8000-0000000000d2', slug: 'c2-f2', title: 'Mesurer l’expérience client', price: 14900 },
  'C2-F5': { id: '00000000-0000-4000-8000-0000000000d5', slug: 'c2-f5', title: 'Développer une culture client', price: 14900 },
} as const
const course = (code: keyof typeof COURSES) => ({ ...COURSES[code], code, currency: 'XOF', isPublished: true })
const PACKS = [
  { id: 'p1', code: 'PACK-CONSEILLER', title: 'Pack Conseiller', description: '', price: 37900, currency: 'XOF', isPublished: true,
    courses: (['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4'] as const).map(course) },
  { id: 'p2', code: 'PACK-MANAGER', title: 'Pack Manager', description: '', price: 38000, currency: 'XOF', isPublished: true,
    courses: (['C2-F1', 'C2-F2', 'C2-F5'] as const).map(course) },
]

const S = {
  packs: PACKS as typeof PACKS,
  user: null as null | { id: string },
  owned: new Set<string>(),
  available: true,
}
const startPaytechPackCheckout = vi.fn(async () => ({ error: 'stub' }))

vi.mock('@/lib/commerce/packs', async (orig) => {
  const real = await orig<typeof import('@/lib/commerce/packs')>()
  return {
    ...real,
    getPublishedPacks: async () => S.packs,
    getPublishedPack: async (c: string) => S.packs.find(p => p.code === real.packCodeFrom(c)) ?? null,
  }
})
vi.mock('@/lib/queries/catalogue', () => ({
  getPublicPaths: async () => [{ code: 'PM-CONS', kind: 'professional', title: 'Parcours', objective: null, position: 1 }],
  getPublicPath: async () => null,
  getPublicPathCourses: async () => [],
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: S.user } }) },
    from: () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'not']) c[m] = () => c
      c.single = async () => ({ data: S.user ? { id: S.user.id } : null, error: null })
      c.maybeSingle = c.single
      c.then = (res: (_v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return c
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'not']) c[m] = () => c
    c.then = (res: (_v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
    return { from: () => c }
  },
}))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async (id: string) => (S.owned.has(id) ? { allowed: true } : { allowed: false, reason: 'not_entitled' }),
}))
vi.mock('@/lib/payments/providers', () => ({ paytechCheckoutAvailability: () => ({ available: S.available }) }))
vi.mock('@/app/actions/paytech-checkout', () => ({
  startPaytechCheckout: vi.fn(),
  startPaytechPackCheckout: (...a: unknown[]) => startPaytechPackCheckout(...(a as [])),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) },
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  usePathname: () => '/',
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode; className?: string }) =>
    <a href={href} {...rest}>{children}</a>,
}))

beforeEach(() => {
  S.packs = PACKS
  S.user = null
  S.owned = new Set()
  S.available = true
  startPaytechPackCheckout.mockClear()
})
afterEach(() => cleanup())

describe('XP-LAUNCH-FINAL-08 · the three commercial offers (V4 §17)', () => {
  it('shows exactly three cards: the two packs from the database and Pack Entreprises on quotation', async () => {
    const { default: CommercialOffers } = await import('@/components/catalogue/CommercialOffers')
    const html = renderToStaticMarkup((await CommercialOffers({})) as ReactElement)
    for (const name of ['Pack Conseiller', 'Pack Manager', 'Pack Entreprises']) expect(html).toContain(name)
    expect(html.match(/Découvrir le pack/g)).toHaveLength(2)
    expect(html).toContain('Demander un devis')
    expect(html).toContain('Sur devis')
    expect(html).toContain('href="/packs/pack-conseiller"')
    expect(html).toContain('href="/packs/pack-manager"')
    expect(html).toContain('href="/contact?offre=pack-entreprises"')
    const d = digits(html)
    expect(d).toContain('37900FCFA')
    expect(d).toContain('38000FCFA')
    expect(d).toContain('44600FCFA')   // C1-F1 + C1-F2 + C1-F3 + C2-F4 at the unit prices
    expect(d).toContain('44700FCFA')   // C2-F1 + C2-F2 + C2-F5
    // No promise the business offer cannot keep.
    expect(html).not.toMatch(/portail|configurateur|coaching|atelier/i)
  })

  it('shows nothing rather than something wrong when the packs cannot be read', async () => {
    S.packs = []
    const { default: CommercialOffers } = await import('@/components/catalogue/CommercialOffers')
    expect(await CommercialOffers({})).toBeNull()
  })

  it('appears on the home page and under the catalogue; individual courses stay purchasable', () => {
    expect(code('app/page.tsx')).toMatch(/<CommercialOffers \/>/)
    expect(code('app/(public)/courses/page.tsx')).toMatch(/<CommercialOffers \/>/)
    expect(code('app/(public)/courses/page.tsx')).toMatch(/<CoursesView courses=\{courses\} \/>/)
  })

  it('pack prices and contents come from the database: nothing in the code hardcodes them', () => {
    for (const f of ['components/catalogue/CommercialOffers.tsx', 'app/(public)/packs/[code]/page.tsx',
                     'app/(platform)/checkout/PackCheckout.tsx', 'lib/commerce/packs.ts', 'app/actions/paytech-checkout.ts']) {
      expect(code(f), f).not.toMatch(/37[\s.]?900|38[\s.]?000|44[\s.]?600/)
    }
    const m065 = read('supabase/migrations/065_commercial_offers.sql')
    expect(m065).toMatch(/\('PACK-CONSEILLER', 'Pack Conseiller',[\s\S]*?37900, 'XOF', true, 1\)/)
    expect(m065).toMatch(/\('PACK-MANAGER', 'Pack Manager',[\s\S]*?38000, 'XOF', true, 2\)/)
  })
})

describe('XP-LAUNCH-FINAL-08 · the pack page', () => {
  async function renderPack(code = 'pack-conseiller') {
    const { default: PackPage } = await import('@/app/(public)/packs/[code]/page')
    return renderToStaticMarkup((await PackPage({ params: Promise.resolve({ code }) })) as ReactElement)
  }

  it('lists the courses with their unit prices, the unit total, the saving and the six-month access', async () => {
    const html = await renderPack()
    for (const c of ['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4'] as const) expect(html).toContain(`href="/courses/${COURSES[c].slug}"`)
    expect(html).not.toContain('href="/courses/c2-f1"')
    const d = digits(html)
    expect(d).toContain('44600FCFA')
    expect(d).toContain('6700FCFA')
    expect(d).toContain('37900FCFA')
    expect(html).toContain('Accès 6 mois')
    expect(html).toContain('activées ensemble')
  })

  it('sends a visitor to sign in first, and a signed-in learner to the pack checkout', async () => {
    expect(await renderPack()).toContain(`href="/login?next=${encodeURIComponent('/checkout?pack=PACK-CONSEILLER')}"`)
    S.user = { id: 'u1' }
    expect(await renderPack()).toContain('href="/checkout?pack=PACK-CONSEILLER"')
  })

  it('warns a learner who already owns a course of the pack, before the checkout', async () => {
    S.user = { id: 'u1' }
    S.owned = new Set([COURSES['C1-F1'].id])
    const html = await renderPack()
    expect(html).toContain('Vous possédez déjà')
    expect(html).toMatch(/ni remboursée ni remplacée/)
  })

  it('an unknown or malformed pack is a 404', async () => {
    await expect(renderPack('pack-inconnu')).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(renderPack('../etc')).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe('XP-LAUNCH-FINAL-08 · buying a pack', () => {
  it('the checkout page shows the pack, its unit total and its price, and asks nothing when nothing is owned', async () => {
    S.user = { id: 'u1' }
    const { default: CheckoutPage } = await import('@/app/(platform)/checkout/page')
    const html = renderToStaticMarkup((await CheckoutPage({ searchParams: Promise.resolve({ pack: 'pack-manager' }) })) as ReactElement)
    expect(html).toContain('Acheter le Pack Manager')
    const d = digits(html)
    expect(d).toContain('44700FCFA')
    expect(d).toContain('38000FCFA')
    expect(html).toContain('Accès 6 mois à compter de la validation du paiement')
    expect(html).not.toContain('Vous possédez déjà')
  })

  it('a learner who owns every course of the pack is sent to the dashboard', async () => {
    S.user = { id: 'u1' }
    S.owned = new Set(PACKS[1].courses.map(c => c.id))
    const { default: CheckoutPage } = await import('@/app/(platform)/checkout/page')
    await expect(CheckoutPage({ searchParams: Promise.resolve({ pack: 'PACK-MANAGER' }) })).rejects.toThrow('NEXT_REDIRECT:/dashboard')
  })

  it('the warning locks the button until it is acknowledged, then sends exactly the owned courses', async () => {
    const { default: PackCheckoutPanel } = await import('@/components/payment/PackCheckoutPanel')
    const owned = [{ id: COURSES['C1-F1'].id, title: COURSES['C1-F1'].title }]
    render(<PackCheckoutPanel packCode="PACK-CONSEILLER" ownedCourses={owned} />)
    expect(screen.getByText(/ni remboursée ni/)).toBeTruthy()
    const button = screen.getByRole('button', { name: /Payer avec PayTech/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(startPaytechPackCheckout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(startPaytechPackCheckout).toHaveBeenCalledTimes(1))
    expect(startPaytechPackCheckout.mock.calls[0]).toEqual([{ packCode: 'PACK-CONSEILLER', acknowledgedCourseIds: [COURSES['C1-F1'].id] }])
  })

  it('without an owned course there is no box, and the click sends an empty acknowledgement', async () => {
    const { default: PackCheckoutPanel } = await import('@/components/payment/PackCheckoutPanel')
    render(<PackCheckoutPanel packCode="PACK-MANAGER" ownedCourses={[]} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Payer avec PayTech/ }))
    await waitFor(() => expect(startPaytechPackCheckout).toHaveBeenCalledTimes(1))
    expect(startPaytechPackCheckout.mock.calls[0]).toEqual([{ packCode: 'PACK-MANAGER', acknowledgedCourseIds: [] }])
  })

  it('the payment button itself still renders no input: the box lives in the panel (safeguard 7)', () => {
    expect(read('components/payment/PaytechCheckoutButton.tsx')).not.toMatch(/<input|<Input/)
    expect(code('components/payment/PaytechCheckoutButton.tsx')).toMatch(/startPaytechCheckout\(\{ courseId \}\)/)
  })
})

describe('XP-LAUNCH-FINAL-08 · six months, said everywhere (decision D1)', () => {
  it('no page or component promises lifetime access to a paid course any more', () => {
    for (const f of [...sources('app'), ...sources('components')]) {
      const src = read(f)
      // Spelled with or without HTML entities: the catalogue card wrote « Acc&egrave;s &agrave; vie ».
      expect(src, f).not.toMatch(/(Accès|Acc&egrave;s|Contenu)( complet)? (à|&agrave;) vie/)
    }
  })

  it('the course page and the course checkout say six months; the free course has no end date', () => {
    const page = read('app/(public)/courses/[slug]/page.tsx')
    expect(page).toMatch(/Accès 6 mois/)
    expect(page).toMatch(/isFree \? 'Accès sans limite de durée' : 'Accès 6 mois'/)
    expect(page).toMatch(/Renouveler mon accès \(6 mois\)/)
    const checkout = read('app/(platform)/checkout/page.tsx')
    expect(checkout).toMatch(/Accès 6 mois/)
  })
})

describe('XP-LAUNCH-FINAL-08 · the V8 pathways: configured, kept, hidden (V4 §13)', () => {
  it('are hidden by one flag, and nothing was deleted', async () => {
    const { PUBLIC_PATHWAYS_VISIBLE } = await import('@/lib/catalogue/visibility')
    expect(PUBLIC_PATHWAYS_VISIBLE).toBe(false)
    for (const f of ['app/(public)/parcours/page.tsx', 'app/(public)/secteurs/page.tsx',
                     'app/(public)/parcours/[code]/page.tsx', 'app/(public)/secteurs/[code]/page.tsx',
                     'components/courses/PathIndex.tsx', 'components/courses/PathDetail.tsx']) {
      expect(() => read(f), f).not.toThrow()
    }
  })

  it('the pathway pages redirect to the catalogue', async () => {
    const { default: Parcours } = await import('@/app/(public)/parcours/page')
    const { default: Secteurs } = await import('@/app/(public)/secteurs/page')
    expect(() => Parcours()).toThrow('NEXT_REDIRECT:/courses')
    expect(() => Secteurs()).toThrow('NEXT_REDIRECT:/courses')
    const { default: Path } = await import('@/app/(public)/parcours/[code]/page')
    await expect(Path({ params: Promise.resolve({ code: 'pm-cons' }) } as never)).rejects.toThrow('NEXT_REDIRECT:/courses')
  })

  it('the navigation, the course page and the sitemap no longer show them; the packs are in the sitemap', async () => {
    expect(code('components/layout/Header.tsx')).toMatch(/\.filter\(l => PUBLIC_PATHWAYS_VISIBLE \|\| \(l\.href !== '\/parcours' && l\.href !== '\/secteurs'\)\)/)
    expect(code('app/(public)/courses/[slug]/page.tsx')).toMatch(/const memberPaths\s+= PUBLIC_PATHWAYS_VISIBLE/)
    const { default: sitemap } = await import('@/app/sitemap')
    const urls = (await sitemap()).map(e => e.url)
    expect(urls.some(u => /\/parcours|\/secteurs/.test(u))).toBe(false)
    expect(urls.some(u => u.endsWith('/packs/pack-conseiller'))).toBe(true)
    expect(urls.some(u => u.endsWith('/packs/pack-manager'))).toBe(true)
  })

  it('pack pages are public like the catalogue; buying stays behind sign-in', () => {
    const mw = code('middleware.ts')
    const exempt = /const PRIVATE_MODE_EXEMPT = \[([\s\S]*?)\]/.exec(mw)?.[1] ?? ''
    expect(exempt).toMatch(/'\/packs',/)
    expect(exempt).toMatch(/'\/courses',/)
    expect(exempt).not.toMatch(/'\/checkout'/)
  })
})

describe('XP-LAUNCH-FINAL-08 · certificates outlive the access (decision D10)', () => {
  it('the certificate page, its PDF, its media and its public verification never ask for course access', () => {
    for (const f of ['app/(platform)/certificates/[certificateId]/page.tsx', 'app/api/certificates/[id]/pdf/route.ts',
                     'app/api/media/certificate/[certificateId]/route.ts', 'app/(public)/verify-certificate/[certificateId]/page.tsx']) {
      expect(code(f), f).not.toMatch(/resolveCourseAccess|has_course_access|isEntitlementAccessible|my_course_access/)
    }
    // And 065 touches no certificate.
    expect(read('supabase/migrations/065_commercial_offers.sql')).not.toMatch(/certificates/)
  })
})

describe('XP-LAUNCH-FINAL-08 · the controlled price update', () => {
  it('the read-only verifier holds the confirmed V4 prices and packs, and uses the public key only', () => {
    const v = read('scripts/security/verify-commercial-offers.mjs')
    for (const [c, p] of [['C1-F1', 9900], ['C1-F2', 9900], ['C1-F3', 9900], ['C2-F4', 14900], ['C2-F1', 14900], ['C2-F2', 14900], ['C2-F5', 14900], ['C1-F4', 0]] as const) {
      expect(v).toMatch(new RegExp(`'${c}': ${p}`))
    }
    expect(v).toMatch(/'PACK-CONSEILLER': \{ price: 37900, courses: \['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4'\] \}/)
    expect(v).toMatch(/'PACK-MANAGER':\s+\{ price: 38000, courses: \['C2-F1', 'C2-F2', 'C2-F5'\] \}/)
    expect(v).not.toMatch(/SERVICE_ROLE|method:\s*'(POST|PATCH|DELETE)'/)
  })
})
