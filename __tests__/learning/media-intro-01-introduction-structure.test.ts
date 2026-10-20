// @vitest-environment node
/**
 * MEDIA-INTRO-01 — the Introduction section contract.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Commit 5f3b356 ("fix(learn): render introduction outside course modules",
 * 2 July 2026) fixed a real production defect: C1-F1's Introduction lesson was
 * rendered INSIDE the first module ("Comprendre la CX") instead of standalone
 * above it. That commit changed three files and shipped zero tests, and nothing
 * has referenced `sidebarStructure` from a test since — so for three months the
 * fix was held in place by the code alone.
 *
 * MEDIA-INTRO-01 adds an Introduction lesson to six further courses, which
 * means it changes that logic's inputs sixfold. These tests pin the contract
 * first, so the defect cannot come back silently.
 *
 * ── WHAT IS PINNED ────────────────────────────────────────────────────────
 *
 *   1. INTRODUCTION is standalone, first, and unnumbered.
 *   2. It is never nested in a numbered module.
 *   3. It never appears twice.
 *   4. Instructional modules keep their numbers.
 *   5. No instructional lesson is lost or duplicated.
 *   6. prev/next visits the Introduction exactly once.
 *   7. Lesson URLs keep the RAW owning module id — hoisting is presentation.
 *   8. The order is a function of the data, even when `order_index` collides.
 *
 * Every assertion runs against the real exported functions. The fixtures model
 * the live shape measured on production: a first module at `order_index = 1`
 * holding the Introduction at `order_index = 1`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSidebarStructure,
  buildLessonSequence,
  isIntroLesson,
  isStandaloneModule,
  compareLessons,
  compareModules,
} from '@/components/lms/sidebarStructure'
import type { SidebarLessonRow, SidebarModuleRow } from '@/components/lms/LessonSidebar'

// ── fixtures ───────────────────────────────────────────────────────────────

function lesson(
  id: string, slug: string, title: string, order_index: number,
): SidebarLessonRow {
  return { id, slug, title, order_index, content: null, duration_minutes: 5 }
}

function mod(
  id: string, order_index: number, title: string, lessons: SidebarLessonRow[],
): SidebarModuleRow {
  return { id, slug: `m-${order_index}`, title, order_index, lessons }
}

/** The shape MEDIA-INTRO-01 produces: intro first inside module 1. */
function courseWithIntro(): SidebarModuleRow[] {
  return [
    mod('mod-1', 1, 'Comprendre la CX', [
      lesson('intro-1', 'introduction', 'Introduction', 1),
      lesson('l-1a', 'cx-definition', 'Définir la CX', 2),
      lesson('l-1b', 'cx-enjeux', 'Les enjeux', 3),
    ]),
    mod('mod-2', 2, 'Parcours client', [
      lesson('l-2a', 'moments', 'Moments de vérité', 1),
      lesson('l-2b', 'cartographie', 'Cartographier', 2),
    ]),
    mod('mod-3', 3, 'Mesurer', [
      lesson('l-3a', 'nps', 'NPS et CSAT', 1),
    ]),
  ]
}

/** The shape BEFORE this slice: no Introduction anywhere (six of seven courses). */
function courseWithoutIntro(): SidebarModuleRow[] {
  return [
    mod('mod-1', 1, 'Le service client', [
      lesson('l-1a', 'bases', 'Les bases', 1),
      lesson('l-1b', 'posture', 'La posture', 2),
    ]),
    mod('mod-2', 2, 'Communiquer', [
      lesson('l-2a', 'ecoute', 'Écouter', 1),
    ]),
  ]
}

const idsOf = (ms: SidebarModuleRow[]) =>
  ms.flatMap(m => m.lessons.map(l => l.id)).sort()

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-01 · 2.1 sidebar structure', () => {
  it('hoists an Introduction identified by slug `introduction`', () => {
    const s = buildSidebarStructure(courseWithIntro())
    expect(s.standalone.map(x => x.lesson.id)).toEqual(['intro-1'])
  })

  it('hoists the supported legacy slug `intro`', () => {
    const ms = [mod('mod-1', 1, 'M1', [
      lesson('x', 'intro', 'Bienvenue', 1),
      lesson('y', 'autre', 'Autre', 2),
    ])]
    expect(buildSidebarStructure(ms).standalone.map(x => x.lesson.id)).toEqual(['x'])
  })

  it('hoists a lesson whose TITLE begins with Introduction', () => {
    const ms = [mod('mod-1', 1, 'M1', [
      lesson('x', 'bienvenue', "Introduction à l'expérience client", 1),
      lesson('y', 'autre', 'Autre', 2),
    ])]
    expect(buildSidebarStructure(ms).standalone.map(x => x.lesson.id)).toEqual(['x'])
  })

  it('does NOT hoist a lesson that merely mentions introduction mid-title', () => {
    // Otherwise an instructional lesson would silently jump to the top of the
    // course. The predicate is anchored, and that anchoring is the contract.
    const ms = [mod('mod-1', 1, 'M1', [
      lesson('x', 'cadre', 'Une introduction au cadre légal', 1),
      lesson('y', 'autre', 'Autre', 2),
    ])]
    const s = buildSidebarStructure(ms)
    expect(s.standalone).toHaveLength(0)
    expect(s.modules[0].lessons.map(l => l.id)).toEqual(['x', 'y'])
  })

  it('treats a module at order_index 0 as a standalone intro section', () => {
    expect(isStandaloneModule(mod('m', 0, 'Intro', []))).toBe(true)
    expect(isStandaloneModule(mod('m', 1, 'M1', []))).toBe(false)

    const ms = [
      mod('mod-0', 0, 'Introduction', [lesson('a', 'a', 'A', 1), lesson('b', 'b', 'B', 2)]),
      mod('mod-1', 1, 'M1', [lesson('c', 'c', 'C', 1)]),
    ]
    const s = buildSidebarStructure(ms)
    expect(s.standalone.map(x => x.lesson.id)).toEqual(['a', 'b'])
    expect(s.modules.map(m => m.id)).toEqual(['mod-1'])
  })

  it('produces EXACTLY ONE Introduction entry for a course with one intro lesson', () => {
    const s = buildSidebarStructure(courseWithIntro())
    expect(s.standalone).toHaveLength(1)
  })

  it('places the Introduction before every numbered module', () => {
    const seq = buildLessonSequence(courseWithIntro())
    expect(seq[0].id).toBe('intro-1')
    const firstNumbered = seq.findIndex(l => l.id === 'l-1a')
    expect(firstNumbered).toBeGreaterThan(0)
  })

  it('renders no lesson twice — every id appears exactly once', () => {
    const s = buildSidebarStructure(courseWithIntro())
    const all = [
      ...s.standalone.map(x => x.lesson.id),
      ...s.modules.flatMap(m => m.lessons.map(l => l.id)),
    ]
    expect(all).toHaveLength(new Set(all).size)
    expect(all.sort()).toEqual(idsOf(courseWithIntro()))
  })

  it('loses no instructional lesson', () => {
    const input = courseWithIntro()
    const s = buildSidebarStructure(input)
    const out = [
      ...s.standalone.map(x => x.lesson.id),
      ...s.modules.flatMap(m => m.lessons.map(l => l.id)),
    ].sort()
    expect(out).toEqual(idsOf(input))
  })

  it('leaves a course with no Introduction completely untouched', () => {
    // Six of the seven target courses are in this state today. Nothing may be
    // hoisted, and the module list must be identical.
    const input = courseWithoutIntro()
    const s = buildSidebarStructure(input)
    expect(s.standalone).toHaveLength(0)
    expect(s.modules.map(m => m.id)).toEqual(['mod-1', 'mod-2'])
    expect(s.modules.flatMap(m => m.lessons.map(l => l.id)))
      .toEqual(['l-1a', 'l-1b', 'l-2a'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-01 · 2.2 module numbering', () => {
  it('keeps Module 1 as 1 and Module 2 as 2 once the intro is hoisted', () => {
    const s = buildSidebarStructure(courseWithIntro())
    // The sidebar numbers by position: index 0 renders "1.".
    expect(s.modules.map(m => m.title)).toEqual([
      'Comprendre la CX', 'Parcours client', 'Mesurer',
    ])
    expect(s.modules.findIndex(m => m.title === 'Comprendre la CX')).toBe(0)
    expect(s.modules.findIndex(m => m.title === 'Parcours client')).toBe(1)
  })

  it('numbering stays contiguous 1..N', () => {
    const s = buildSidebarStructure(courseWithIntro())
    const labels = s.modules.map((_, i) => i + 1)
    expect(labels).toEqual([1, 2, 3])
  })

  it('the Introduction consumes no module number', () => {
    const withIntro    = buildSidebarStructure(courseWithIntro())
    const withoutIntro = buildSidebarStructure(
      courseWithIntro().map(m => ({ ...m, lessons: m.lessons.filter(l => l.id !== 'intro-1') })),
    )
    expect(withIntro.modules).toHaveLength(withoutIntro.modules.length)
    expect(withIntro.modules).toHaveLength(3)
  })

  it('a module whose ONLY lesson is the intro is dropped, and the rest renumber', () => {
    // Documented, intended behaviour — pinned so it is a decision, not a drift.
    const ms = [
      mod('mod-1', 1, 'Intro only', [lesson('i', 'introduction', 'Introduction', 1)]),
      mod('mod-2', 2, 'Real one',   [lesson('a', 'a', 'A', 1)]),
    ]
    const s = buildSidebarStructure(ms)
    expect(s.standalone.map(x => x.lesson.id)).toEqual(['i'])
    expect(s.modules.map(m => m.id)).toEqual(['mod-2'])
    expect(s.modules[0].title).toBe('Real one')   // now renders as "1."
  })

  it('LESSON order is deterministic when order_index collides', () => {
    // `lessons.order_index` is not unique in the schema. Two rows sharing an
    // index must still order identically on every request.
    const a = lesson('zzz', 'a', 'A', 2)
    const b = lesson('aaa', 'b', 'B', 2)
    const ms1 = [mod('mod-1', 1, 'M1', [a, b])]
    const ms2 = [mod('mod-1', 1, 'M1', [b, a])]

    const o1 = buildSidebarStructure(ms1).modules[0].lessons.map(l => l.id)
    const o2 = buildSidebarStructure(ms2).modules[0].lessons.map(l => l.id)
    expect(o1).toEqual(o2)
    expect(o1).toEqual(['aaa', 'zzz'])          // tie broken on id, ascending
    expect(compareLessons(a, b)).toBeGreaterThan(0)
    expect(compareLessons(b, a)).toBeLessThan(0)
    expect(compareLessons(a, a)).toBe(0)
  })

  it('MODULE order is deterministic when order_index collides', () => {
    const m1 = mod('zzz', 2, 'Z', [lesson('x', 'x', 'X', 1)])
    const m2 = mod('aaa', 2, 'A', [lesson('y', 'y', 'Y', 1)])
    expect(buildSidebarStructure([m1, m2]).modules.map(m => m.id))
      .toEqual(buildSidebarStructure([m2, m1]).modules.map(m => m.id))
    expect(buildSidebarStructure([m1, m2]).modules.map(m => m.id)).toEqual(['aaa', 'zzz'])
    expect(compareModules(m1, m2)).toBeGreaterThan(0)
  })

  it('sorts modules by order_index regardless of input order', () => {
    const input = courseWithIntro()
    const shuffled = [input[2], input[0], input[1]]
    expect(buildSidebarStructure(shuffled).modules.map(m => m.order_index)).toEqual([1, 2, 3])
  })

  it('is referentially stable: repeated calls agree exactly', () => {
    const input = courseWithIntro()
    const a = JSON.stringify(buildSidebarStructure(input))
    const b = JSON.stringify(buildSidebarStructure(input))
    const c = JSON.stringify(buildSidebarStructure(courseWithIntro()))
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('does not mutate its input', () => {
    const input = courseWithIntro()
    const before = JSON.stringify(input)
    buildSidebarStructure(input)
    buildLessonSequence(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-01 · 2.3 navigation', () => {
  it('the Introduction is the FIRST lesson of the sequence', () => {
    expect(buildLessonSequence(courseWithIntro())[0].id).toBe('intro-1')
  })

  it('next from the Introduction lands on the first instructional lesson', () => {
    const seq = buildLessonSequence(courseWithIntro())
    const i = seq.findIndex(l => l.id === 'intro-1')
    expect(seq[i + 1].id).toBe('l-1a')
  })

  it('previous from the first instructional lesson returns to the Introduction', () => {
    const seq = buildLessonSequence(courseWithIntro())
    const i = seq.findIndex(l => l.id === 'l-1a')
    expect(seq[i - 1].id).toBe('intro-1')
  })

  it('a full traversal visits every lesson exactly once — no skip, no repeat', () => {
    const input = courseWithIntro()
    const seq = buildLessonSequence(input)
    const visited: string[] = []
    for (let i = 0; i < seq.length; i++) visited.push(seq[i].id)

    expect(visited).toHaveLength(idsOf(input).length)
    expect(visited).toHaveLength(new Set(visited).size)
    expect([...visited].sort()).toEqual(idsOf(input))
  })

  it('every entry keeps its RAW owning module id, so lesson URLs are unchanged', () => {
    const seq = buildLessonSequence(courseWithIntro())
    const intro = seq.find(l => l.id === 'intro-1')!
    // The hoisted lesson still belongs to module 1 — this is what keeps
    // /learn/<course>/<moduleId>/<lessonId> and the quiz gating working.
    expect(intro.module.id).toBe('mod-1')
    expect(intro.module.order_index).toBe(1)
    for (const entry of seq) {
      const owner = courseWithIntro().find(m => m.lessons.some(l => l.id === entry.id))!
      expect(entry.module.id).toBe(owner.id)
    }
  })

  it('the raw module carries its FULL lesson list, not the hoisted remainder', () => {
    // Module 1 really has 3 lessons; the sidebar shows 2. Navigation state such
    // as isLastLessonInModule reads the raw module, so it must see all 3.
    const seq = buildLessonSequence(courseWithIntro())
    const intro = seq.find(l => l.id === 'intro-1')!
    expect(intro.module.lessons.map(l => l.id)).toEqual(['intro-1', 'l-1a', 'l-1b'])
  })

  it('the sequence equals the sidebar render order', () => {
    const input = courseWithIntro()
    const s = buildSidebarStructure(input)
    const rendered = [
      ...s.standalone.map(x => x.lesson.id),
      ...s.modules.flatMap(m => m.lessons.map(l => l.id)),
    ]
    expect(buildLessonSequence(input).map(l => l.id)).toEqual(rendered)
  })

  it('a course with no Introduction navigates exactly as before', () => {
    expect(buildLessonSequence(courseWithoutIntro()).map(l => l.id))
      .toEqual(['l-1a', 'l-1b', 'l-2a'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-01 · 2.4 one shared sidebar, desktop and mobile', () => {
  const SIDEBAR = readFileSync(join(process.cwd(), 'components/lms/LessonSidebar.tsx'), 'utf8')
  const LEARN   = readFileSync(
    join(process.cwd(), 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'), 'utf8')

  it('exactly ONE LessonSidebar is instantiated across the app', () => {
    // Desktop and mobile cannot disagree about ordering if there is only one
    // component rendering it. A second instance would be the regression.
    const uses = (LEARN.match(/<LessonSidebar\b/g) ?? []).length
    expect(uses).toBe(1)
  })

  it('no second, mobile-specific sorting mechanism exists', () => {
    // The sidebar must derive its order from the shared module, never re-sort.
    expect(SIDEBAR).toContain('buildSidebarStructure')
    expect(SIDEBAR).not.toMatch(/\.sort\s*\(/)
  })

  it('the learn page derives its sequence from the shared module too', () => {
    expect(LEARN).toContain('buildLessonSequence')
  })

  it('the Introduction heading is rendered outside the numbered module loop', () => {
    const introAt    = SIDEBAR.indexOf('Introduction')
    const numberedAt = SIDEBAR.indexOf('numberedModules.map')
    expect(introAt).toBeGreaterThan(-1)
    expect(numberedAt).toBeGreaterThan(-1)
    expect(introAt).toBeLessThan(numberedAt)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('MEDIA-INTRO-01 · 2.5 regression protection', () => {
  it('FAILS if the Introduction is nested inside a numbered module', () => {
    const s = buildSidebarStructure(courseWithIntro())
    for (const m of s.modules) {
      expect(m.lessons.map(l => l.id), `intro leaked into ${m.title}`).not.toContain('intro-1')
      expect(m.lessons.some(isIntroLesson), `an intro lesson is numbered under ${m.title}`).toBe(false)
    }
  })

  it('FAILS if the Introduction is placed below a numbered module', () => {
    const seq = buildLessonSequence(courseWithIntro())
    const introIdx = seq.findIndex(l => l.id === 'intro-1')
    const firstNumberedIdx = seq.findIndex(l => !isIntroLesson(l))
    expect(introIdx).toBe(0)
    expect(introIdx).toBeLessThan(firstNumberedIdx)
  })

  it('FAILS if a duplicate Introduction entry is produced', () => {
    const s = buildSidebarStructure(courseWithIntro())
    expect(s.standalone.filter(x => x.lesson.id === 'intro-1')).toHaveLength(1)
    const seq = buildLessonSequence(courseWithIntro())
    expect(seq.filter(l => l.id === 'intro-1')).toHaveLength(1)
  })

  it('FAILS if two intro lessons in one module are collapsed or dropped', () => {
    // Data is not supposed to look like this, but silently losing one would be
    // worse than showing both: UNIQUE(module_id, slug) cannot stop a second
    // lesson merely TITLED "Introduction ...".
    const ms = [mod('mod-1', 1, 'M1', [
      lesson('i1', 'introduction', 'Introduction', 1),
      lesson('i2', 'bienvenue', 'Introduction bis', 2),
      lesson('a', 'a', 'A', 3),
    ])]
    const s = buildSidebarStructure(ms)
    expect(s.standalone.map(x => x.lesson.id)).toEqual(['i1', 'i2'])
    expect(s.modules[0].lessons.map(l => l.id)).toEqual(['a'])
  })

  it('FAILS if existing lesson navigation breaks for the live C1-F1 shape', () => {
    // Module 1 of C1-F1 really holds 7 lessons, the first being the
    // Introduction (measured on production, 2026-10-20).
    const ms = [
      mod('95b7dcaf', 1, 'Comprendre la CX', [
        lesson('cd363ae6', 'introduction', 'Introduction', 1),
        ...Array.from({ length: 6 }, (_, i) => lesson(`c1f1-l${i}`, `l${i}`, `Leçon ${i + 1}`, i + 2)),
      ]),
      mod('0aa997a0', 2, 'Parcours client & moments de vérité',
        Array.from({ length: 5 }, (_, i) => lesson(`m2-l${i}`, `m2l${i}`, `M2 Leçon ${i + 1}`, i + 1))),
      mod('3fd3e0ca', 3, 'Écouter & mesurer la voix du client',
        Array.from({ length: 5 }, (_, i) => lesson(`m3-l${i}`, `m3l${i}`, `M3 Leçon ${i + 1}`, i + 1))),
      mod('e0c36509', 4, 'Conclusion Formation', [lesson('m4-l0', 'conclusion', 'Conclusion', 1)]),
    ]
    const s   = buildSidebarStructure(ms)
    const seq = buildLessonSequence(ms)

    expect(s.standalone.map(x => x.lesson.id)).toEqual(['cd363ae6'])
    expect(s.modules).toHaveLength(4)                    // all four still numbered
    expect(s.modules[0].lessons).toHaveLength(6)         // 7 minus the hoisted intro
    expect(seq).toHaveLength(18)                         // the live lesson count
    expect(seq[0].id).toBe('cd363ae6')
    expect(seq[seq.length - 1].id).toBe('m4-l0')         // conclusion stays last
    expect(seq.map(l => l.id)).toHaveLength(new Set(seq.map(l => l.id)).size)
  })

  it('holds for the shape MEDIA-INTRO-01 creates in the six other courses', () => {
    // Intro inserted at order_index 1, existing lessons reindexed +1.
    const ms = [
      mod('mod-1', 1, 'Le service client, concrètement', [
        lesson('new-intro', 'introduction', 'Introduction', 1),
        lesson('old-a', 'bases', 'Les bases', 2),
        lesson('old-b', 'posture', 'La posture', 3),
      ]),
      mod('mod-2', 2, 'Bien communiquer', [lesson('old-c', 'ecoute', 'Écouter', 1)]),
    ]
    const s   = buildSidebarStructure(ms)
    const seq = buildLessonSequence(ms)

    expect(s.standalone.map(x => x.lesson.id)).toEqual(['new-intro'])
    expect(s.modules.map(m => m.id)).toEqual(['mod-1', 'mod-2'])   // numbering intact
    expect(s.modules[0].lessons.map(l => l.id)).toEqual(['old-a', 'old-b'])
    expect(seq.map(l => l.id)).toEqual(['new-intro', 'old-a', 'old-b', 'old-c'])
    expect(seq[0].module.id).toBe('mod-1')                         // URL unchanged
  })
})
