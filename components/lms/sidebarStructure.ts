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

export function isStandaloneModule(mod: SidebarModuleRow): boolean {
  return mod.order_index === 0
}

export function isIntroLesson(lesson: SidebarLessonRow): boolean {
  const slug = (lesson.slug ?? '').toLowerCase().trim()
  if (slug === 'introduction' || slug === 'intro') return true
  return /^introduction\b/i.test((lesson.title ?? '').trim())
}

export interface StandaloneLesson {
  lesson:   SidebarLessonRow
  moduleId: string // owning module — kept so the lesson's URL never changes
}

export interface SidebarStructure {
  /** Lessons rendered before the module list (in original order). */
  standalone: StandaloneLesson[]
  /** Modules rendered as numbered sections, with intro lessons removed. */
  modules:    SidebarModuleRow[]
}

/**
 * Split modules into a standalone intro section + the numbered module list.
 * A module left with no lessons after its intro lesson(s) are hoisted is
 * dropped from the numbered list (its content moved to the standalone section).
 */
export function buildSidebarStructure(modules: SidebarModuleRow[]): SidebarStructure {
  const standalone: StandaloneLesson[] = []
  const numbered:   SidebarModuleRow[] = []

  for (const mod of modules) {
    if (isStandaloneModule(mod)) {
      for (const lesson of mod.lessons) standalone.push({ lesson, moduleId: mod.id })
      continue
    }

    const introLessons = mod.lessons.filter(isIntroLesson)
    const restLessons  = mod.lessons.filter(l => !isIntroLesson(l))

    for (const lesson of introLessons) standalone.push({ lesson, moduleId: mod.id })

    // Keep the module in the numbered list as long as it still has visible
    // lessons (a module whose only lesson was the intro is fully hoisted).
    if (restLessons.length > 0) {
      numbered.push({ ...mod, lessons: restLessons })
    }
  }

  return { standalone, modules: numbered }
}
