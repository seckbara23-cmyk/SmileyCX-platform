// @vitest-environment jsdom
/**
 * XP-BRAND-04A — the official contact address, pinned so it cannot cramp again.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `contact@xpclient-academy.com` measures 227px in Montserrat 400 at 14px
 * (`text-sm`), measured from the real font rather than estimated. In the
 * "Nos coordonnées" card the text column is the sidebar grid track minus the
 * card padding (`p-6` → 48px) and the icon row (`w-4` + `gap-3` → 28px):
 *
 *     /contact  280px track → 280 − 48 − 28 = 204px   (23px short)
 *     home      260px track → 260 − 48 − 28 = 184px   (43px short)
 *
 * So the address wrapped. CSS's only default break opportunity inside it is
 * the hyphen, which produced `contact@xpclient-` / `academy.com` — a break
 * that reads like a hyphenated word. The home card papered over it with
 * `break-all`, which is worse: that breaks at an arbitrary character.
 *
 * ── WHY THESE TESTS LOOK THE WAY THEY DO ──────────────────────────────────
 *
 * The budget is asserted as ARITHMETIC, not as a screenshot. No browser is
 * available in CI, and a class-name grep would not notice someone narrowing
 * the track back to 280px. Encoding `track − padding − iconRow >= 227` makes
 * a future narrowing fail here instead of in production.
 *
 * Source assertions read COMMENT-STRIPPED code. The fix documents itself with
 * the very numbers these guards forbid ("a 280px track left only 204px"), so
 * a naive grep would match the explanation of the bug and pass or fail for
 * the wrong reason.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ContactEmailLink, { splitEmailForWrap } from '@/components/site/ContactEmailLink'
import { CONTACT_EMAIL, CONTACT_PHONE, CONTACT_PHONE_HREF } from '@/lib/brand'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
/** Source with comments stripped — a guard must not match its own prose. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const CONTACT_PAGE = 'app/(public)/contact/page.tsx'
const HOME_PAGE = 'app/page.tsx'

/** Measured with PIL against Montserrat[wght].ttf at weight 400, size 14px. */
const EMAIL_WIDTH_PX = 227
const CARD_PADDING_PX = 48 // p-6, both sides
const ICON_ROW_PX = 28 // w-4 (16) + gap-3 (12)

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-04A · the address is intact and clickable', () => {
  const html = renderToStaticMarkup(<ContactEmailLink className="text-sm text-dark" />)

  it('links the full address with mailto:, exactly', () => {
    expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`)
    expect(CONTACT_EMAIL).toBe('contact@xpclient-academy.com')
  })

  it('renders the complete address as visible text', () => {
    // <wbr> is a zero-width break opportunity, not a character: strip the tags
    // and the remaining text must be the whole address, nothing elided.
    const text = html.replace(/<wbr\s*\/?>/g, '').replace(/<[^>]+>/g, '')
    expect(text).toBe(CONTACT_EMAIL)
  })

  it('never truncates or ellipsises', () => {
    expect(html).not.toMatch(/truncate|text-ellipsis|overflow-hidden/)
  })

  it('applies the caller’s classes to the anchor', () => {
    expect(html).toMatch(/<a[^>]*class="text-sm text-dark"/)
  })
})

describe('XP-BRAND-04A · it breaks at the @, never mid-domain', () => {
  const html = renderToStaticMarkup(<ContactEmailLink />)

  it('offers its only break opportunity straight after the @', () => {
    expect(html).toMatch(/contact@<wbr\s*\/?>/)
  })

  it('holds the domain together so the hyphen cannot be chosen', () => {
    // Without this the browser breaks at the hyphen in "xpclient-academy",
    // which is the awkward wrap this slice exists to remove.
    expect(html).toMatch(/<span class="whitespace-nowrap">xpclient-academy\.com<\/span>/)
  })

  it('does not use break-all, which breaks at an arbitrary character', () => {
    expect(code(CONTACT_PAGE)).not.toContain('break-all')
    expect(code(HOME_PAGE)).not.toContain('break-all')
  })
})

describe('XP-BRAND-04A · splitEmailForWrap', () => {
  it('splits on the @, keeping it with the local part', () => {
    expect(splitEmailForWrap('contact@xpclient-academy.com'))
      .toEqual({ local: 'contact@', domain: 'xpclient-academy.com' })
  })

  it('splits on the LAST @ so a local part containing one is safe', () => {
    expect(splitEmailForWrap('a@b@example.com'))
      .toEqual({ local: 'a@b@', domain: 'example.com' })
  })

  it('invents no break point when there is no @', () => {
    expect(splitEmailForWrap('not-an-address'))
      .toEqual({ local: 'not-an-address', domain: '' })
  })

  it('renders a @-less value verbatim, with no wbr', () => {
    // The guard matters: a stray <wbr> in a non-address would be invisible
    // locally and wrong everywhere.
    const { local, domain } = splitEmailForWrap('support')
    expect(local).toBe('support')
    expect(domain).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-04A · the layout budget actually fits the address', () => {
  const trackOf = (p: string) => {
    const m = code(p).match(/md:grid-cols-\[1fr_(\d+)px\]/)
    expect(m, `no md:grid-cols-[1fr_<n>px] found in ${p}`).toBeTruthy()
    return Number(m![1])
  }

  for (const page of [CONTACT_PAGE, HOME_PAGE]) {
    it(`${page} leaves at least ${EMAIL_WIDTH_PX}px for the address`, () => {
      const textColumn = trackOf(page) - CARD_PADDING_PX - ICON_ROW_PX
      expect(textColumn).toBeGreaterThanOrEqual(EMAIL_WIDTH_PX)
    })
  }

  it('uses one consistent track on both cards', () => {
    expect(trackOf(CONTACT_PAGE)).toBe(trackOf(HOME_PAGE))
  })

  it('does not reintroduce the tracks that were too narrow', () => {
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      expect(code(page)).not.toContain('[1fr_280px]')
      expect(code(page)).not.toContain('[1fr_260px]')
    }
  })

  it('lets the flex text column shrink (min-w-0), so it cannot overflow', () => {
    // A flex item defaults to min-width:auto and refuses to shrink below its
    // min-content width, which is how a long address pushes a card wider.
    // Asserted as ADJACENCY, not as a count: counting min-w-0 across the file
    // would break the moment someone legitimately used it elsewhere.
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      const rows = [...code(page).matchAll(/className="flex items-start gap-3"([\s\S]{0,220})/g)]
      expect(rows.length, `expected 3 icon rows in ${page}`).toBe(3)
      for (const [, body] of rows) {
        expect(body, `an icon row in ${page} has no min-w-0 text column`)
          .toMatch(/<div className="min-w-0">/)
      }
    }
  })

  it('keeps the page container unwidened', () => {
    // The brief forbids widening the page to solve this.
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      expect(code(page)).toContain('cx-container max-w-4xl')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('XP-BRAND-04A · nothing else about the card moved', () => {
  it('leaves the phone number and its tel: link alone', () => {
    expect(CONTACT_PHONE).toBe('+221 78 685 78 78')
    expect(CONTACT_PHONE_HREF).toBe('tel:+221786857878')
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      expect(code(page)).toContain('CONTACT_PHONE_HREF')
    }
  })

  it('keeps the card styling, spacing and palette tokens', () => {
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      const c = code(page)
      expect(c).toContain('cx-card p-6')
      expect(c).toContain('gap-10')
      expect(c).toContain('flex flex-col gap-4')
      expect(c).toContain('text-primary')
      expect(c).toContain('text-cx-gray')
      expect(c).toContain('text-sm text-dark')
    }
  })

  it('keeps the "Bientôt disponible" présentiel card untouched', () => {
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      expect(code(page)).toContain('bg-soon-bg')
      expect(code(page)).toContain('text-soon-fg')
    }
  })

  it('introduces no hard-coded address anywhere', () => {
    // CONTACT_EMAIL stays the single source of truth.
    expect(code('components/site/ContactEmailLink.tsx')).toContain('CONTACT_EMAIL')
    for (const page of [CONTACT_PAGE, HOME_PAGE]) {
      expect(code(page)).not.toContain('xpclient-academy.com')
    }
  })
})
