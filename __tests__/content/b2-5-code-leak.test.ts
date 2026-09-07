// @vitest-environment node
/**
 * B-2.5 — internal catalogue codes must not be visible to the public.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `public_learning_paths.code` — PM-CONS, PM-MAN, SEC-COM, SEC-BQA … — is an
 * internal identifier. It is a join key, a React key and a URL segment. None of
 * those require it to be PRINTED, and three public components printed it in
 * monospace anyway:
 *
 *   app/(public)/courses/[slug]/page.tsx   the "Cette formation fait partie
 *                                          des parcours" membership chips
 *   components/courses/PathCard.tsx        /parcours and /secteurs index cards
 *   components/courses/PathDetail.tsx      the eyebrow above the path title
 *
 * It was also usually redundant: the professional path titles already read
 * "Parcours Conseiller", "Parcours Manager", so `PM-CONS Parcours Conseiller`
 * said the same thing twice, once in machine language. C1-F1 belongs to all
 * fifteen paths, so its page rendered fifteen of them.
 *
 * ── WHY THESE ASSERTIONS ARE SHAPED THIS WAY ──────────────────────────────
 *
 * The obvious test — "the file does not contain the string `{p.code}`" — is
 * too weak in one direction and too strong in the other. Too strong, because
 * `key={p.code}` and `pathHref(path)` are legitimate and must survive. Too
 * weak, because it would pass the moment someone moved the code into a
 * different visible element, or interpolated it into a template string.
 *
 * So the guard is POSITIONAL: a `{…code}` expression may appear as an ATTRIBUTE
 * VALUE (preceded by `=`) and nowhere else. A JSX child, a template literal or
 * an aria-label carrying it all fail. That is the property worth pinning —
 * "not rendered" — rather than the particular way it stopped being rendered.
 *
 * All assertions run against comment-stripped source, so the explanatory
 * comments left at the three removal sites cannot satisfy their own test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
/** Blank JSX and TS comments, preserving line structure. */
const strip = (s: string) =>
  s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const COURSE_PAGE = 'app/(public)/courses/[slug]/page.tsx'
const CARD        = 'components/courses/PathCard.tsx'
const DETAIL      = 'components/courses/PathDetail.tsx'
const INDEX       = 'components/courses/PathIndex.tsx'
const CATALOGUE   = 'lib/queries/catalogue.ts'
const ADMIN       = 'app/(admin)/admin/catalogue/page.tsx'
const CONTENT     = 'app/(public)/courses/content.ts'

const PUBLIC_SURFACES = [COURSE_PAGE, CARD, DETAIL, INDEX]

/**
 * A `{…code}` used as a JSX CHILD rather than as an attribute value.
 * `key={p.code}` and `href={pathHref(p)}` are preceded by `=`; a rendered
 * expression is not.
 */
const RENDERED_CODE = /(?<![=])\{\s*(?:p|path|c)\.code(?:\s+as\s+string)?\s*\}/

const LIVE_CODES = [
  'PM-CONS', 'PM-OPT', 'PM-COM', 'PM-MAN', 'PM-QVC',
  'PM-RH', 'PM-DIG', 'PM-PRO', 'PM-DIR',
  'SEC-COM', 'SEC-SAN', 'SEC-ADM', 'SEC-TEL', 'SEC-LOG', 'SEC-BQA',
]

// ══════════════════════════════════════════════════════════════════════════
describe('B-2.5 — no internal code is rendered on any public surface', () => {
  it('A. the course-page membership chips do not render p.code', () => {
    const s = strip(read(COURSE_PAGE))
    expect(s, 'a code expression is rendered as a JSX child').not.toMatch(RENDERED_CODE)
    // The specific removed element must not come back in any form.
    expect(s).not.toMatch(/<span[^>]*font-mono[^>]*>\s*\{\s*p\.code/)
  })

  it('B. PathCard does not render path.code', () => {
    const s = strip(read(CARD))
    expect(s).not.toMatch(RENDERED_CODE)
    expect(s).not.toMatch(/font-mono/)
  })

  it('C. PathDetail does not render path.code', () => {
    const s = strip(read(DETAIL))
    expect(s).not.toMatch(RENDERED_CODE)
    expect(s).not.toMatch(/font-mono/)
  })

  it('the code cannot be smuggled back through a template literal or a label', () => {
    // The relocation this suite exists to prevent: same value, different
    // element. A template literal, an aria-label, a title attribute or an alt
    // text carrying the code is still a leak.
    for (const f of PUBLIC_SURFACES) {
      const s = strip(read(f))
      expect(s, `${f} interpolates a code into a template literal`)
        .not.toMatch(/\$\{\s*(?:p|path|c)\.code/)
      for (const attr of ['aria-label', 'title', 'alt', 'placeholder']) {
        expect(s, `${f} puts a code in ${attr}`)
          .not.toMatch(new RegExp(`${attr}=\\{[^}]*\\.code`))
      }
    }
  })

  it('no live path code is hard-coded as a literal in a public surface', () => {
    for (const f of PUBLIC_SURFACES) {
      const s = strip(read(f))
      for (const code of LIVE_CODES)
        expect(s, `${f} hard-codes ${code}`).not.toContain(code)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('B-2.5 — everything the chips are actually for still works', () => {
  it('D. the human-readable titles are still what gets rendered', () => {
    expect(strip(read(COURSE_PAGE))).toMatch(/\{p\.title\}/)
    expect(strip(read(CARD))).toMatch(/\{path\.title\}/)
    expect(strip(read(DETAIL))).toMatch(/\{path\.title\}/)
  })

  it('E. "Cette formation fait partie des parcours" remains', () => {
    // Legitimate product copy (XPA-3, V4 section 8). Only the code went.
    expect(strip(read(COURSE_PAGE))).toContain('Cette formation fait partie des parcours')
  })

  it('F. navigation is untouched — pathHref still builds every link', () => {
    const page = strip(read(COURSE_PAGE))
    expect(page).toMatch(/href=\{pathHref\(p\)\}/)
    expect(page, 'the React key must survive; it is not a rendered value')
      .toMatch(/key=\{p\.code\}/)
    expect(strip(read(CARD))).toMatch(/href=\{pathHref\(path\)\}/)
    // pathHref itself is explicitly NOT part of B-2.5: the URL keeps the code.
    const cat = strip(read(CATALOGUE))
    expect(cat).toMatch(/export function pathHref/)
    expect(cat).toMatch(/p\.code\.toLowerCase\(\)/)
  })

  it('the membership data is still fetched and still keyed by code', () => {
    const cat = strip(read(CATALOGUE))
    expect(cat).toMatch(/getPublicPathsForCourse/)
    expect(cat).toMatch(/\.eq\('course_code', courseCode\)/)
    expect(cat).toMatch(/select\('code, kind, title, objective, position'\)/)
    expect(strip(read(DETAIL))).toMatch(/getPublicPathCourses\(path\.code\)/)
  })

  it('PathCard keeps its title, objective, link and arrow', () => {
    const s = strip(read(CARD))
    expect(s).toMatch(/\{path\.objective\}/)
    expect(s).toMatch(/<ArrowRight/)
    // The arrow sat opposite the code under justify-between; ml-auto replaces
    // that so it stays right-aligned rather than collapsing left.
    expect(s).toMatch(/ArrowRight[\s\S]{0,200}ml-auto/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('B-2.5 — internal surfaces keep their codes', () => {
  it('G. the admin catalogue still shows the complete internal matrix', () => {
    const s = strip(read(ADMIN))
    // XPA-3 requires this page to expose the full code matrix. B-2.5 is about
    // the PUBLIC surface only; removing it here would be the opposite mistake.
    expect(s).toMatch(/\{c\.code as string\}/)
    expect(s).toMatch(/\{p\.code as string\}/)
    expect(s).toMatch(/from\('course_codes'\)/)
  })

  it('H. codes remain available to the code that legitimately needs them', () => {
    const cat = strip(read(CATALOGUE))
    // The type still carries it, the query still selects it, the router still
    // uses it. B-2.5 removed a rendering, not a field.
    expect(cat).toMatch(/code/)
    expect(strip(read(INDEX))).toMatch(/key=\{p\.code\}/)
    expect(strip(read(INDEX))).toMatch(/getPublicPathCourses\(p\.code\)/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('B-2.5 — adjacent learner-facing labelling did not regress', () => {
  it('I. Fondations / Intermédiaire / Avancé are unchanged', () => {
    const s = read(CONTENT)
    expect(s).toMatch(/label:\s*'Fondations'/)
    expect(s).toMatch(/badge:\s*'Parcours Fondations'/)
    expect(s).toMatch(/'Intermédiaire'/)
    expect(s).toMatch(/'Avancé'/)
    // And the internal ids are still ids, not captions (PILOT-UX-1's ruling).
    expect(s).toMatch(/export type ParcoursId = 'debutant' \| 'intermediaire' \| 'avance'/)
    expect(s, 'levelLabel must still resolve the DB value and the legacy label')
      .toMatch(/level === 'beginner' \|\| level === 'Débutant' \|\| level === 'Fondations'/)
  })

  it('no course slug or route was touched by B-2.5', () => {
    const s = strip(read(COURSE_PAGE))
    // The URL ruling: codes stay in /parcours/<code> and /secteurs/<code>.
    expect(strip(read(CATALOGUE))).toMatch(/'\/secteurs' : '\/parcours'/)
    // And the course page still resolves its own route helpers unchanged.
    expect(s).toMatch(/learnEntryHref\(slug, modules\)/)
    expect(s).toMatch(/coursePageHref\(slug\)/)
  })
})
