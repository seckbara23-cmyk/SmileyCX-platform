import type { SidebarModuleRow, SidebarLessonRow } from './LessonSidebar'

// ── Standalone (intro) detection ──────────────────────────────────────────────
//
// A lesson can be pulled out of its module and shown as a standalone item at the
// top of the sidebar (right after the progression block, before the numbered
// modules). Two data-driven, admin-controllable signals trigger this — no schema
// change and no lesson move is required, so lesson URLs stay unchanged:
//
//   1. The lesson lives in a module whose `order_index` is 0. A module ordered 0
//      is treated as a pre-module "intro section": all of its lessons render
//      standalone. (Set a module's order to 0 from the admin panel.)
//   2. The lesson itself is an introduction by naming convention: its slug is
//      `introduction` / `intro`, or its title begins with "Introduction". This
//      matches the current seed/live data where an Introduction lesson sits
//      inside the first content module.
//
// MEDIA-INTRO-01 keeps that contract exactly and hardens two things around it:
// the ordering is now deterministic even when `order_index` collides, and the
// navigation sequence is derived here rather than rebuilt by each caller, so the
// sidebar and the prev/next controls cannot drift apart.

export function isStandaloneModule(mod: SidebarModuleRow): boolean {
  return mod.order_index === 0
}

export function isIntroLesson(lesson: SidebarLessonRow): boolean {
  const slug = (lesson.slug ?? '').toLowerCase().trim()
  if (slug === 'introduction' || slug === 'intro') return true
  return /^introduction\b/i.test((lesson.title ?? '').trim())
}

// ── Deterministic ordering ───────────────────────────────────────────────────
//
// `lessons.order_index` and `modules.order_index` are plain NOT NULL integers:
// nothing in the schema makes them unique per parent. Two rows sharing an index
// are therefore ordered by whatever the database happened to return, and
// `Array.prototype.sort` being stable preserves that arbitrary order rather than
// fixing it — so the same course could render in a different order on two
// requests. Tie-breaking on the primary key makes the result a function of the
// data alone. For the distinct indices the live data actually has, this is
// byte-for-byte the previous order.

const byIndexThenId = (
  ai: number, bi: number, aid: string, bid: string,
): number => (ai !== bi ? ai - bi : aid < bid ? -1 : aid > bid ? 1 : 0)

export function compareLessons(a: SidebarLessonRow, b: SidebarLessonRow): number {
  return byIndexThenId(a.order_index, b.order_index, a.id, b.id)
}

export function compareModules(a: SidebarModuleRow, b: SidebarModuleRow): number {
  return byIndexThenId(a.order_index, b.order_index, a.id, b.id)
}

export interface StandaloneLesson<L extends SidebarLessonRow = SidebarLessonRow> {
  lesson:   L
  moduleId: string // owning module — kept so the lesson's URL never changes
}

export interface SidebarStructure<M extends SidebarModuleRow = SidebarModuleRow> {
  /** Lessons rendered before the module list (in deterministic order). */
  standalone: StandaloneLesson<M['lessons'][number]>[]
  /** Modules rendered as numbered sections, with intro lessons removed. */
  modules:    M[]
}

/**
 * Split modules into a standalone intro section + the numbered module list.
 * A module left with no lessons after its intro lesson(s) are hoisted is
 * dropped from the numbered list (its content moved to the standalone section).
 *
 * Pure: the same input always yields the same output, which is what keeps the
 * Introduction in place across a refresh or a re-entry into the course.
 */
export function buildSidebarStructure<M extends SidebarModuleRow>(
  modules: M[],
): SidebarStructure<M> {
  type L = M['lessons'][number]
  const standalone: StandaloneLesson<L>[] = []
  const numbered:   M[] = []

  for (const mod of [...modules].sort(compareModules)) {
    const lessons = ([...(mod.lessons ?? [])] as L[]).sort(compareLessons)

    if (isStandaloneModule(mod)) {
      for (const lesson of lessons) standalone.push({ lesson, moduleId: mod.id })
      continue
    }

    const introLessons = lessons.filter(isIntroLesson)
    const restLessons  = lessons.filter(l => !isIntroLesson(l))

    for (const lesson of introLessons) standalone.push({ lesson, moduleId: mod.id })

    // Keep the module in the numbered list as long as it still has visible
    // lessons (a module whose only lesson was the intro is fully hoisted).
    // The cast carries M's own extra fields through the sorted-lessons rebuild.
    if (restLessons.length > 0) {
      numbered.push({ ...mod, lessons: restLessons } as M)
    }
  }

  return { standalone, modules: numbered }
}

/**
 * The lesson order the learner actually travels: standalone intro lessons
 * first, then each numbered module's remaining lessons.
 *
 * Every entry keeps its *raw* owning module, not the rebuilt one, because the
 * URL `/learn/<course>/<moduleId>/<lessonId>` and the quiz gating are both
 * keyed on the real module — hoisting is presentation only. Derived here and
 * not in the page so that prev/next, auto-advance and the sidebar are the same
 * sequence by construction.
 */
export function buildLessonSequence<M extends SidebarModuleRow>(
  modules: M[],
): Array<M['lessons'][number] & { module: M }> {
  const structure  = buildSidebarStructure(modules)
  const rawById    = new Map(modules.map(m => [m.id, m]))

  return [
    ...structure.standalone.map(s => ({ ...s.lesson, module: rawById.get(s.moduleId)! })),
    ...structure.modules.flatMap(m =>
      m.lessons.map(l => ({ ...l, module: rawById.get(m.id)! })),
    ),
  ]
}
