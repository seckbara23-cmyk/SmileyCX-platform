// @vitest-environment node
/**
 * CAT-02 — database-backed catalogue pricing.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * CAT-01 found three defects, all live:
 *
 *   1. The catalogue showed NO price. `lib/queries/catalogue.ts` selected no
 *      pricing column, `CourseItem` had no price field, and the card rendered
 *      none — while an unused `components/courses/CourseCard.tsx` did it
 *      correctly.
 *   2. The course detail page replaced the price with "Gratuit — phase pilote"
 *      whenever PILOT_MODE or FREE_ACCESS_MODE was set, so all eight courses
 *      read as free regardless of what the database said.
 *   3. `/courses/comprendre-client-qualite-experience` returned 200 and
 *      advertised a course as GRATUIT that does not exist in `courses` — the
 *      seed escape hatch in the notFound() guard, rendering `data/seed.ts`
 *      whose price is 0 with a note to restore 45000 later.
 *
 * ── WHAT THIS ASSERTS ─────────────────────────────────────────────────────
 *
 * Prices come from the database and from nowhere else; obsolete pilot and
 * manual-activation copy is gone from public student surfaces; the CTA cannot
 * promise what the access gate refuses; and nothing commercial became an
 * authorization. The last group matters most: CAT-02 is presentation, and the
 * tests exist to prove it stayed presentation.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const QUERIES   = 'lib/queries/catalogue.ts'
const CONTENT   = 'app/(public)/courses/content.ts'
const CAT_PAGE  = 'app/(public)/courses/page.tsx'
const CARD      = 'app/(public)/courses/_components/CourseCard.tsx'
const DETAIL    = 'app/(public)/courses/[slug]/page.tsx'
const PRICING   = 'app/(public)/courses/_components/PricingSection.tsx'
const DEAD_CARD = 'components/courses/CourseCard.tsx'

/** Comments blanked, so prose explaining a removal cannot trip a removal check. */
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, m => m.replace(/[^\n]/g, ' '))
   .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
   .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))

const PUBLIC_SURFACES = [CARD, DETAIL, CAT_PAGE, PRICING, CONTENT] as const

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 1. the query layer reads the pricing columns', () => {
  const src = read(QUERIES)

  it('a single shared constant names the public course columns', () => {
    // CAT-01's defect was one select missing a column the other had.
    expect(src).toMatch(/const PUBLIC_COURSE_COLUMNS\s*=/)
    const m = /const PUBLIC_COURSE_COLUMNS\s*=\s*\n?\s*'([^']+)'/.exec(src)
    expect(m, 'PUBLIC_COURSE_COLUMNS is no longer a plain string').toBeTruthy()
    const cols = m![1].split(',').map(c => c.trim())
    for (const needed of ['price', 'currency', 'is_free']) {
      expect(cols, `the public course select omits ${needed}`).toContain(needed)
    }
  })

  it('EVERY courses select in the module uses that constant', () => {
    const code = strip(src)
    const selects = [...code.matchAll(/\.from\('courses'\)\s*\n?\s*\.select\(([^)]*)\)/g)]
    expect(selects.length, 'no courses select found — the module moved').toBeGreaterThan(0)
    for (const s of selects) {
      expect(s[1].trim(), 'a courses select hardcodes its columns again')
        .toBe('PUBLIC_COURSE_COLUMNS')
    }
  })

  it('PublicCourse carries price, currency and is_free', () => {
    const body = /export interface PublicCourse \{([\s\S]*?)\n\}/.exec(src)
    expect(body).toBeTruthy()
    expect(body![1]).toMatch(/\bprice:\s*number/)
    expect(body![1]).toMatch(/\bcurrency:\s*string/)
    expect(body![1]).toMatch(/\bis_free:\s*boolean/)
  })

  it('still reads through the cookie-less ANON client, not service-role', () => {
    // Pricing is public data; this must not have quietly become a privileged read.
    const code = strip(src)
    expect(code).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/)
    expect(code, 'the catalogue reached for the service-role key')
      .not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createAdminClient/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 2. the price reaches the card from the database', () => {
  it('CourseItem requires price, currency and isFree', () => {
    const body = /export type CourseItem = \{([\s\S]*?)\n\}/.exec(read(CONTENT))
    expect(body).toBeTruthy()
    expect(body![1]).toMatch(/\bprice:\s*number/)
    expect(body![1]).toMatch(/\bcurrency:\s*string/)
    expect(body![1]).toMatch(/\bisFree:\s*boolean/)
  })

  it('the catalogue page maps them from the course row, coercing numeric', () => {
    const code = strip(read(CAT_PAGE))
    expect(code).toMatch(/price:\s*Number\(c\.price\)/)
    expect(code).toMatch(/currency:\s*c\.currency/)
    expect(code).toMatch(/isFree:\s*c\.is_free === true/)
  })

  it('the card renders the price, and "Gratuit" only for a free course', () => {
    const code = strip(read(CARD))
    expect(code).toMatch(/formatPrice\(course\.price,\s*course\.currency\)/)
    expect(code).toMatch(/course\.isFree\s*\?/)
  })

  it('the card opens no database read of its own', () => {
    const code = strip(read(CARD))
    expect(code).not.toMatch(/createClient|createAdminClient|\.from\(/)
  })

  it('the dead price-rendering CourseCard is gone', () => {
    // It was the only component that rendered a DB price, and nothing imported
    // it. Keeping two cards is how one of them drifts.
    expect(existsSync(join(ROOT, DEAD_CARD))).toBe(false)
    const importers: string[] = []
    const walk = (d: string) => {
      let e
      try { e = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
      for (const x of e) {
        const p = `${d}/${x.name}`
        if (x.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(x.name)) continue
        if (/components\/courses\/CourseCard/.test(read(p))) importers.push(p)
      }
    }
    ;['app', 'components', 'lib'].forEach(walk)
    expect(importers).toEqual([])
  })

  it('the STATIC_CATALOG pilot fallback is gone', () => {
    const code = strip(read(CONTENT))
    expect(code, 'the hardcoded pilot course list is back').not.toMatch(/STATIC_CATALOG/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 3. the detail page price is the database price', () => {
  const code = strip(read(DETAIL))

  it('price and currency come from dbCourse with no seed fallback', () => {
    expect(code).toMatch(/const price\s*=\s*Number\(dbCourse\.price\)/)
    expect(code).toMatch(/const currency\s*=\s*String\(dbCourse\.currency\)/)
    expect(code, 'the seed price fallback is back')
      .not.toMatch(/price\s*=[^\n]*FLAGSHIP_COURSE\.price/)
    expect(code, 'the seed currency fallback is back')
      .not.toMatch(/currency\s*=[^\n]*FLAGSHIP_COURSE\.currency/)
  })

  it('a slug the database does not publish is a 404 — no seed escape hatch', () => {
    expect(code).toMatch(/if \(!dbCourse\) notFound\(\)/)
    expect(code, 'the FLAGSHIP_COURSE escape hatch is back')
      .not.toMatch(/!dbCourse && slug !== FLAGSHIP_COURSE\.slug/)
  })

  it('the seed module is no longer a source of course identity at all', () => {
    // CAT-02 removed the last four `dbCourse?.x ?? FLAGSHIP_COURSE.x` display
    // fallbacks and the phantom metadata branch, leaving the import unused.
    expect(code, 'FLAGSHIP_COURSE is a course-identity source again')
      .not.toMatch(/FLAGSHIP_COURSE/)
  })

  it('isFree drives the free label, not the deployment mode', () => {
    expect(code).toMatch(/const isFree\s*=\s*dbCourse\.is_free === true/)
    // The removed branches keyed "Gratuit" off PILOT_MODE / FREE_ACCESS_MODE.
    expect(code).not.toMatch(/FREE_ACCESS_MODE \|\| PILOT_MODE \?/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 4. obsolete pilot and manual-access copy is gone', () => {
  const FORBIDDEN: [RegExp, string][] = [
    [/Activation par un administrateur/, 'manual admin activation'],
    [/Acc[eè]s sur demande/i,            'access-on-request'],
    [/[Pp]hase pilote/,                  'pilot phase'],
    [/Demander un acc[eè]s/i,            'request access'],
    [/Acc[eè]s sur invitation/i,         'invitation only'],
    [/liste d.attente/i,                 'waiting list'],
  ]

  it('no public student surface carries any of it', () => {
    const hits: string[] = []
    for (const f of PUBLIC_SURFACES) {
      const code = strip(read(f))
      for (const [re, label] of FORBIDDEN) {
        if (re.test(code)) hits.push(`${f}: ${label}`)
      }
    }
    expect(hits, `obsolete copy still rendered: ${hits.join(' | ')}`).toEqual([])
  })

  it('"Accès gratuit" is no longer rendered unconditionally by mode', () => {
    for (const f of PUBLIC_SURFACES) {
      const code = strip(read(f))
      // A free course may say "Gratuit"; nothing may say it because of a mode.
      expect(code, `${f} ties a free label to a deployment mode`)
        .not.toMatch(/(PILOT_MODE|FREE_ACCESS_MODE)[^\n]{0,80}[Gg]ratuit/)
    }
  })

  it('the subscription plans keep their legitimate "Sur devis"', () => {
    // Enterprise pricing genuinely is quote-based — this is not pilot copy.
    expect(read(PRICING)).toMatch(/Sur devis/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 5. the CTA cannot promise what the gate refuses', () => {
  const code = strip(read(DETAIL))

  it('access is still decided by resolveCourseAccess, not by price', () => {
    expect(code).toMatch(/resolveCourseAccess\(slug\)/)
    expect(code).toMatch(/ctaAccess\.allowed/)
  })

  it('a logged-in learner is NOT sent to checkout while payments are off', () => {
    // /checkout under PILOT_MODE redirects into /learn, which the gate then
    // refuses — the dead end CAT-01 found.
    // XP-PAYTECH-04: the server-side PayTech checkout availability, not a NEXT_PUBLIC flag.
    expect(code).toMatch(/paidPurchaseAvailable\s*=\s*paytechCheckoutAvailability\(\)\.available && !isFree/)
    expect(code).toMatch(/paidPurchaseAvailable[\s\S]{0,160}\/checkout\?course=/)
    expect(code).toMatch(/Inscription bient[oô]t disponible/)
  })

  it('a guest is sent to log in, returning to the lesson', () => {
    expect(code).toMatch(/!user[\s\S]{0,120}\/login\?next=/)
    expect(code).toMatch(/Cr[eé]er mon compte/)
  })

  it('one derived label serves every CTA — no mode ternaries left', () => {
    expect(code).toMatch(/const accessRequestLabel\s*=/)
    const ctas = [...code.matchAll(/ctaAccess\.allowed/g)]
    expect(ctas.length, 'the CTA branches changed shape').toBeGreaterThanOrEqual(2)
    expect(code).not.toMatch(/PILOT_MODE \|\| FREE_ACCESS_MODE\s*\n?\s*\?\s*'Demander/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CAT-02 · 6. SECURITY: presentation stayed presentation', () => {
  it('no public surface grants an entitlement or enrollment', () => {
    for (const f of PUBLIC_SURFACES) {
      const code = strip(read(f))
      for (const t of ['entitlements', 'enrollments', 'payments']) {
        expect(code, `${f} writes ${t}`)
          .not.toMatch(new RegExp(`from\\(\\s*['"]${t}['"]\\s*\\)[\\s\\S]{0,120}\\.(insert|upsert|update|delete)\\(`))
      }
      expect(code, `${f} calls an RPC`).not.toMatch(/\.rpc\(/)
      expect(code, `${f} reaches the service-role client`)
        .not.toMatch(/createAdminClient|SUPABASE_SERVICE_ROLE_KEY/)
    }
  })

  it('the authorization gate is untouched and still pilot-independent', () => {
    const gate = read('lib/auth/course-access.ts')
    expect(gate).toMatch(/email_confirmed_at/)
    expect(gate, 'a pilot flag entered the access gate')
      .not.toMatch(/PILOT_MODE|FREE_ACCESS_MODE|PAYMENTS_ENABLED|PLATFORM_MODE/)
  })

  it('free self-enrollment is still closed, and fail-closed', () => {
    const enr = read('app/actions/enrollment.ts')
    expect(enr).toMatch(/NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT === 'true'/)
    expect(enr).toMatch(/if \(!SELF_ENROLLMENT_OPEN\)/)
    if (existsSync(join(ROOT, '.env.local'))) {
      expect(read('.env.local'), 'free self-enrollment was switched on')
        .not.toMatch(/^NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT\s*=\s*true/m)
    }
  })

  it('payments are still inactive, and completion has exactly one chokepoint', () => {
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      expect(read('.env.local')).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
      expect(read('.env.local')).not.toMatch(/^PAYDUNYA_/m)
    }
    const callers: string[] = []
    const walk = (d: string) => {
      let e
      try { e = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
      for (const x of e) {
        const p = `${d}/${x.name}`
        if (x.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(x.name)) continue
        const c = strip(read(p))
        // Matched as an IMPORT for the transport, because the PayTech modules
        // cite paydunya-client.ts in prose to record which of its behaviours
        // could be reused and which could not.
        if (/from\s+['"][^'"]*paydunya-client['"]/.test(c)
            || /\.rpc\(\s*['"]complete_payment/.test(c)) callers.push(p)
      }
    }
    ;['app', 'components', 'lib'].forEach(walk)
    // The PayDunya transport still has no caller. Completion now has exactly
    // one — migration 062's obligation 5 — so the chokepoint is named rather
    // than the list being required to be empty.
    expect(callers, `payment callers: ${callers.join(', ')}`)
      .toEqual(['lib/payments/payment-completion.ts'])
  })

  it('no migration was added and 062 is byte-identical', () => {
    const migs = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    // XP-PAYTECH-04 authored 063 (the payment state machine); it is admitted by name.
    expect(migs).toHaveLength(61)
    expect(migs).toContain('063_payment_state_machine.sql')
    const { createHash } = require('crypto') as typeof import('crypto')
    const raw = readFileSync(join(ROOT, 'supabase/migrations/062_atomic_payment_completion.sql'))
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('899cd3832573383b20df4dc09003f702a860c4ccb4651caead1a0bee817f31bb')
  })

  it('protected lesson content is still gated, and previews unchanged', () => {
    // CAT-02 must not have widened what an anonymous visitor can read.
    const q = strip(read(QUERIES))
    expect(q, 'the catalogue began reading lesson bodies')
      .not.toMatch(/\bcontent\b|video_url|subtitle_url|pdf_url/)
    expect(read(DETAIL)).toMatch(/public_course_modules/)
    expect(read(DETAIL)).toMatch(/public_course_lessons/)
  })
})
