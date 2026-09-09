// @vitest-environment node
/**
 * CAT-1 — catalogue completeness through assignable academic identity.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `courses.code` is the permanent academic identity. The public catalogue
 * groups by its catalogue prefix (`getPublishedCoursesByCatalogue`, which
 * excludes null-code rows with `.not('code','is',null)`), and every parcours
 * membership is keyed on it. Neither Admin course action wrote it — not on
 * create, not on edit — so every course authored through Admin was born with
 * `code = NULL` and appeared in no catalogue and no path.
 *
 * That is UAT-FU-1, reported by Marième on 19 August 2026 as "not all 7
 * published formations appear". It was a systemic authoring gap, not a content
 * omission: `developper-une-culture-client` is published, renders its own page,
 * and is invisible everywhere else.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ──────────────────────────────────
 *
 * `resolveCourseCodeAssignment` is exercised for real, with the Supabase admin
 * client mocked, so the DECISION logic — assign / no-op / refuse — is tested
 * behaviourally rather than by reading source. Those are assertions 1-5.
 *
 * The UI and wiring assertions read source, because a vitest run has no DOM and
 * no database. They are labelled as such and make no claim to observe a render.
 *
 * The database is the final authority and is NOT weakened by any of this.
 * Migration 028 gives `courses.code` a FK to the registry, a UNIQUE constraint,
 * and the `courses_code_immutable` BEFORE UPDATE trigger. This suite asserts
 * those remain untouched: the application refuses earlier and in French, the
 * database refuses last and absolutely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('server-only', () => ({}))

/** One chainable PostgREST-ish stub per table, fed by the fixture below. */
const state = {
  registry: [] as { code: string; status: string | null }[],
  courses:  [] as { id: string; code: string | null; slug: string }[],
  registryError: null as null | { message: string },
  coursesError:  null as null | { message: string },
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {}
      let wantedCode: string | null = null
      const api = {
        select: () => api,
        order:  () => api,
        not:    () => api,
        eq: (col: string, val: string) => { if (col === 'code') wantedCode = val; return api },
        maybeSingle: async () => {
          if (table === 'course_codes') {
            if (state.registryError) return { data: null, error: state.registryError }
            return { data: state.registry.find(r => r.code === wantedCode) ?? null, error: null }
          }
          if (state.coursesError) return { data: null, error: state.coursesError }
          return { data: state.courses.find(c => c.code === wantedCode) ?? null, error: null }
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            table === 'course_codes'
              ? { data: state.registry, error: state.registryError }
              : { data: state.courses.filter(c => c.code), error: state.coursesError },
          ).then(res),
      }
      return Object.assign(api, q)
    },
  }),
}))

const {
  resolveCourseCodeAssignment, listAssignableCourseCodes, COURSE_CODE_PATTERN,
} = await import('@/lib/admin/course-codes')

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const EDIT_ACTION = 'app/(admin)/admin/courses/[id]/edit/actions.ts'
const EDIT_PAGE   = 'app/(admin)/admin/courses/[id]/edit/page.tsx'
const NEW_ACTION  = 'app/(admin)/admin/courses/new/actions.ts'
const NEW_FORM    = 'app/(admin)/admin/courses/new/NewCourseForm.tsx'
const CATALOGUE   = 'lib/queries/catalogue.ts'
const M028        = 'supabase/migrations/028_academic_model.sql'

beforeEach(() => {
  state.registry = [
    { code: 'C2-F3', status: 'undecided' },
    { code: 'C2-F5', status: 'undecided' },
    { code: 'C2-F6', status: 'backlog' },
    { code: 'C1-F1', status: 'undecided' },
    { code: 'C9-F9', status: 'retired' },
  ]
  state.courses = [
    { id: 'course-owned',  code: 'C1-F1', slug: 'les-fondamentaux-de-l-experience-client' },
    { id: 'course-nocode', code: null,    slug: 'developper-une-culture-client' },
  ]
  state.registryError = null
  state.coursesError = null
})

// ══════════════════════════════════════════════════════════════════════════
describe('CAT-1 — assignment decisions (behavioural)', () => {
  it('1. a null-code course can receive a valid canonical code', async () => {
    const r = await resolveCourseCodeAssignment(null, 'C2-F5', 'course-nocode')
    expect(r).toEqual({ ok: true, code: 'C2-F5' })
  })

  it('the value is normalised, so casing and whitespace cannot create a near-miss', async () => {
    expect(await resolveCourseCodeAssignment(null, '  c2-f5 ', 'course-nocode'))
      .toEqual({ ok: true, code: 'C2-F5' })
  })

  it('2. an existing code cannot be REPLACED', async () => {
    const r = await resolveCourseCodeAssignment('C1-F1', 'C2-F5', 'course-owned')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/permanent/i)
  })

  it('3. an existing code cannot be REMOVED', async () => {
    const r = await resolveCourseCodeAssignment('C1-F1', '', 'course-owned')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/supprim/i)
  })

  it('resubmitting the SAME code is a no-op, so an ordinary save still works', async () => {
    // The locked field resubmits the current value. If that read as a change,
    // every save of a coded course would fail.
    expect(await resolveCourseCodeAssignment('C1-F1', 'C1-F1', 'course-owned')).toEqual({ ok: true })
    // And an absent field says nothing about the code at all.
    expect(await resolveCourseCodeAssignment('C1-F1', null, 'course-owned')).toEqual({ ok: true })
  })

  it('4. an unknown or non-canonical code is rejected', async () => {
    const unknown = await resolveCourseCodeAssignment(null, 'C7-F7', 'course-nocode')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toMatch(/inconnu/i)

    for (const bad of ['NOPE', 'PM-CONS', 'C2F5', '../C2-F5', 'C2-F5; drop table courses']) {
      const r = await resolveCourseCodeAssignment(null, bad, 'course-nocode')
      expect(r.ok, `${bad} was accepted`).toBe(false)
    }
  })

  it('5. a code already carried by another course is rejected', async () => {
    const r = await resolveCourseCodeAssignment(null, 'C1-F1', 'course-nocode')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/déjà attribué/i)
  })

  it('a RETIRED code can never be reassigned', async () => {
    const r = await resolveCourseCodeAssignment(null, 'C9-F9', 'course-nocode')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/retir/i)
  })

  it('choosing no code is allowed and writes nothing', async () => {
    expect(await resolveCourseCodeAssignment(null, '',   'x')).toEqual({ ok: true })
    expect(await resolveCourseCodeAssignment(null, null, 'x')).toEqual({ ok: true })
  })

  it('an unreadable registry FAILS CLOSED rather than assigning unverified identity', async () => {
    state.registryError = { message: 'connection reset' }
    const r = await resolveCourseCodeAssignment(null, 'C2-F5', 'course-nocode')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Aucune modification enregistrée/)
  })

  it('an unreadable courses table also fails closed', async () => {
    state.coursesError = { message: 'timeout' }
    const r = await resolveCourseCodeAssignment(null, 'C2-F5', 'course-nocode')
    expect(r.ok).toBe(false)
  })

  it('listAssignableCourseCodes excludes taken and retired codes', async () => {
    const list = await listAssignableCourseCodes('course-nocode')
    const codes = list.map(c => c.code)
    expect(codes).toContain('C2-F5')
    expect(codes).toContain('C2-F3')
    expect(codes, 'C1-F1 is already carried by another course').not.toContain('C1-F1')
    expect(codes, 'a retired code must never be offered').not.toContain('C9-F9')
  })

  it('the format pattern accepts the registry shape and rejects path codes', () => {
    expect(COURSE_CODE_PATTERN.test('C2-F5')).toBe(true)
    expect(COURSE_CODE_PATTERN.test('C3-F12')).toBe(true)
    expect(COURSE_CODE_PATTERN.test('PM-CONS')).toBe(false)
    expect(COURSE_CODE_PATTERN.test('SEC-COM')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('CAT-1 — server actions enforce it (static)', () => {
  it('the edit action validates before writing, and fails closed on an unreadable code', () => {
    const s = stripJs(read(EDIT_ACTION))
    expect(s).toMatch(/resolveCourseCodeAssignment\(/)
    const resolve = s.indexOf('resolveCourseCodeAssignment(')
    const update  = s.indexOf('.update({')
    expect(resolve).toBeGreaterThan(-1)
    expect(resolve, 'validation must precede the UPDATE').toBeLessThan(update)
    expect(s).toMatch(/if \(codeReadError \|\| !codeRow\)[\s\S]{0,400}throw new Error/)
    expect(s).toMatch(/if \(!codeAssignment\.ok\)[\s\S]{0,300}throw new Error\(codeAssignment\.error\)/)
  })

  it('6/7. the code reaches the UPDATE only on a genuine first assignment', () => {
    const s = stripJs(read(EDIT_ACTION))
    // Conditional spread: an unchanged or absent code never reaches the write,
    // so the immutability trigger is never asked a question it must refuse.
    expect(s).toMatch(/\.\.\.\(codeAssignment\.code \? \{ code: codeAssignment\.code \} : \{\}\)/)
  })

  it('8. course creation supports a canonical code, validated the same way', () => {
    const s = stripJs(read(NEW_ACTION))
    expect(s).toMatch(/resolveCourseCodeAssignment\(null, formData\.get\('code'\)/)
    expect(s).toMatch(/if \(!codeAssignment\.ok\) throw new Error\(codeAssignment\.error\)/)
    expect(s).toMatch(/\.\.\.\(codeAssignment\.code \? \{ code: codeAssignment\.code \} : \{\}\)/)
  })

  it('validation is never left to the browser alone', () => {
    // A disabled control is not a control. Both write paths call the resolver.
    for (const f of [EDIT_ACTION, NEW_ACTION])
      expect(stripJs(read(f)), `${f} does not validate server-side`)
        .toMatch(/resolveCourseCodeAssignment/)
  })

  it('F-5.2 fail-closed publication accountability is untouched', () => {
    const s = stripJs(read(EDIT_ACTION))
    expect(s).toMatch(/const \{ data: prior, error: priorError \}/)
    expect(s).toMatch(/if \(priorError\)[\s\S]{0,400}throw new Error/)
    expect(s).toMatch(/const publicationChanged = prior\.is_published !== is_published/)
    expect((s.match(/recordPublicationTransition\(\{/g) ?? []).length).toBe(2)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('CAT-1 — Admin UI reflects permanence (static)', () => {
  it('6. the selector is offered only while the code is null', () => {
    const s = read(EDIT_PAGE)
    expect(s).toMatch(/course\.code \? \(/)
    expect(s).toMatch(/const assignableCodes = course\.code \? \[\] : await listAssignableCourseCodes/)
  })

  it('7. an assigned code is displayed, locked, and resubmitted unchanged', () => {
    const s = read(EDIT_PAGE)
    expect(s).toMatch(/<input type="hidden" name="code" value=\{course\.code as string\} \/>/)
    expect(s).toMatch(/Définitif/)
    expect(s).toMatch(/ne peut être ni/)
    // No second editable control once it is set.
    const locked = s.slice(s.indexOf('course.code ? ('), s.indexOf(') : ('))
    expect(locked, 'a coded course must not be offered a select').not.toMatch(/<select/)
  })

  it('the create form offers the same canonical list and says it is permanent', () => {
    const s = read(NEW_FORM)
    expect(s).toMatch(/name="code"/)
    expect(s).toMatch(/assignableCodes\.map/)
    expect(s).toMatch(/Définitif une fois enregistré/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('CAT-1 — the database remains the final authority', () => {
  const sql = () => read(M028)

  it('the immutability trigger is untouched and still refuses any change', () => {
    const s = sql()
    expect(s).toMatch(/create or replace function public\.enforce_course_code_immutable/)
    expect(s).toMatch(/if OLD\.code is not null and NEW\.code is distinct from OLD\.code then/)
    expect(s).toMatch(/create trigger courses_code_immutable[\s\S]{0,120}before update on public\.courses/)
  })

  it('the FK and UNIQUE constraints are untouched', () => {
    const s = sql()
    expect(s).toMatch(/add constraint courses_code_fkey[\s\S]{0,120}references public\.course_codes\(code\)/)
    expect(s).toMatch(/add constraint courses_code_unique unique \(code\)/)
  })

  it('9/10. the public catalogue projection is NOT relaxed to paper over the defect', () => {
    const s = stripJs(read(CATALOGUE))
    // Deleting this filter would surface null-code courses with no catalogue
    // tier to land in — hiding the authoring defect instead of fixing it.
    expect(s, 'the null-code exclusion must remain').toMatch(/\.not\('code', 'is', null\)/)
    expect(s).toMatch(/\.eq\('is_published', true\)/)
    // Once a code exists the existing projection surfaces the course with no
    // further change — that is why CAT-1 needs no catalogue edit at all.
    expect(s).toMatch(/getPublishedCoursesByCatalogue/)
  })

  it('11. internal codes stay out of public presentation (B-2.5 unchanged)', () => {
    const RENDERED = /(?<![=])\{\s*(?:p|path)\.code\s*\}/
    for (const f of ['app/(public)/courses/[slug]/page.tsx',
                     'components/courses/PathCard.tsx',
                     'components/courses/PathDetail.tsx'])
      expect(stripJs(read(f)), `${f} renders a code`).not.toMatch(RENDERED)
  })

  it('12/13. entitlement remains the access authority; enrollment grants nothing', () => {
    const q = stripJs(read('app/actions/quiz.ts'))
    expect(q).toMatch(/resolveCourseAccessById\(context\.courseId\)/)
    expect(q).toMatch(/if \(!access\.allowed \|\| !access\.userId\)/)
    // CAT-1 touches identity, never access.
    for (const f of [EDIT_ACTION, NEW_ACTION, 'lib/admin/course-codes.ts']) {
      const s = stripJs(read(f))
      for (const t of ['has_course_access', 'entitlement', 'enrollment'])
        expect(s, `${f} touches ${t}`).not.toContain(t)
    }
  })

  it('14. CAT-1 introduced no migration', () => {
    const { readdirSync } = require('fs') as typeof import('fs')
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'))
    expect(files).toHaveLength(50)
    const nums = files.map(f => /^(\d{3})_/.exec(f)?.[1]).filter(Boolean).map(Number)
    expect(Math.max(...nums)).toBe(53)
    expect(files.filter(f => f.startsWith('054'))).toEqual([])
  })
})
