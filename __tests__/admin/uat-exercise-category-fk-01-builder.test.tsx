// @vitest-environment jsdom
/**
 * UAT-EXERCISE-CATEGORY-FK-01 — the exercise builder, proved at the DOM.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Marième reported that "Créer l'exercice" failed with
 *
 *   insert or update on table "exercise_items" violates foreign key
 *   constraint "exercise_items_correct_category_id_fkey"
 *
 * The builder minted a `crypto.randomUUID()` per category DURING RENDER, via a
 * non-lazy `useState([newCat(), newCat()])`. That expression runs on every
 * render pass; SSR and hydration are two passes. The server therefore sent
 * `<option value="A">` while the hydrated state held `B`, React did not rewrite
 * the attribute, and selecting a category stored the SSR uuid. The submitted
 * items referenced a category that was never inserted, and PostgreSQL refused
 * them — correctly.
 *
 * ── WHY THESE TESTS RENDER FOR REAL ───────────────────────────────────────
 *
 * A source-reading test cannot see this: every file involved was internally
 * consistent. The bug lived in the GAP between two renders, so the tests below
 * reproduce that gap literally — renderToString, then hydrateRoot over the
 * resulting HTML, then a change event carrying whatever value the DOM actually
 * holds, then submit. Test 1 fails against the original component and passes
 * against the fix.
 *
 * The server action is mocked here only to capture the payload; what it does
 * with an incoherent one is proven in the companion suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToString } from 'react-dom/server'
import { hydrateRoot, createRoot } from 'react-dom/client'
import { act } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'

const created: FormData[] = []
const updated: FormData[] = []
vi.mock('@/app/(admin)/admin/exercises/new/actions', () => ({
  createExercise: async (fd: FormData) => { created.push(fd); return {} },
}))
vi.mock('@/app/(admin)/admin/exercises/[id]/edit/actions', () => ({
  updateExercise: async (fd: FormData) => { updated.push(fd); return {} },
}))

import NewExerciseForm from '@/app/(admin)/admin/exercises/new/NewExerciseForm'
import EditExerciseForm from '@/app/(admin)/admin/exercises/[id]/edit/EditExerciseForm'

const COURSES = [{
  id: 'course-1', title: 'Formation', modules: [
    { id: 'mod-1', title: 'Module', order_index: 0, lessons: [{ id: 'lesson-1', title: 'Leçon', order_index: 0 }] },
  ],
}]

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** The selects that choose an item's category (the colour pickers are not these). */
const itemSelects = (el: HTMLElement) =>
  ([...el.querySelectorAll('select')] as HTMLSelectElement[])
    .filter(s => s.options[0]?.textContent?.includes('— Catégorie —'))

/** What the form would send: every item's target, and the categories on offer. */
function payloadOf(fd: FormData) {
  const categories = JSON.parse(fd.get('categories_json') as string) as { id: string; name: string }[]
  const items      = JSON.parse(fd.get('items_json') as string) as { id: string; label: string; correctCategoryId: string }[]
  const ids        = new Set(categories.map(c => c.id))
  return { categories, items, ids, orphans: items.filter(i => i.correctCategoryId && !ids.has(i.correctCategoryId)) }
}

beforeEach(() => { created.length = 0; updated.length = 0; document.body.innerHTML = '' })

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — a hard page load (SSR then hydration)', () => {
  it('1. THE REGRESSION: every submitted item references a submitted category', async () => {
    const html = renderToString(<NewExerciseForm courses={COURSES} />)
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    await act(async () => { hydrateRoot(container, <NewExerciseForm courses={COURSES} />) })

    const selects = itemSelects(container)
    expect(selects.length).toBeGreaterThanOrEqual(2)

    // Pick using the value the DOM actually carries — exactly what a browser
    // reports in e.target.value. This is where the old build diverged.
    for (const [i, sel] of selects.entries()) {
      const optionValues = [...sel.options].map(o => o.value).filter(Boolean)
      await act(async () => { fireEvent.change(sel, { target: { value: optionValues[i % optionValues.length] } }) })
    }
    await act(async () => { fireEvent.submit(container.querySelector('form')!) })

    expect(created).toHaveLength(1)
    const { orphans, items } = payloadOf(created[0])
    expect(items.every(i => i.correctCategoryId), 'an item lost its category').toBe(true)
    expect(orphans, 'items reference a category that is not being inserted').toHaveLength(0)
  })

  it('2. the option values in the DOM survive hydration unchanged', async () => {
    const html = renderToString(<NewExerciseForm courses={COURSES} />)
    // Both item selects list the same categories, so dedupe to the category set.
    const ssrValues = [...new Set(
      [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>Catégorie \(sans titre\)/g)].map(m => m[1])
    )]
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    await act(async () => { hydrateRoot(container, <NewExerciseForm courses={COURSES} />) })

    const domValues = [...itemSelects(container)[0].options].map(o => o.value).filter(Boolean)
    // The point of the fix: the keys are derived from useId() and a lazy
    // counter, so the server and the client agree instead of racing.
    expect(ssrValues.length).toBeGreaterThan(0)
    expect(domValues).toEqual(ssrValues)
  })

  it('3. no database identity is minted during render', () => {
    // The uuid is created in the submit handler, so the payload carries real
    // uuids even though the DOM carries local keys.
    const src = read('app/(admin)/admin/exercises/new/NewExerciseForm.tsx')
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const calls = [...body.matchAll(/crypto\.randomUUID\(\)/g)]
    expect(calls.length, 'the builder still mints uuids').toBeGreaterThan(0)
    // Every call site must sit inside handleSubmit — never in a useState
    // initialiser, and never in the render body.
    const submitStart = body.indexOf('function handleSubmit')
    const submitEnd   = body.indexOf('startTransition(')
    for (const m of calls) {
      expect(m.index!, 'crypto.randomUUID() outside the submit handler').toBeGreaterThan(submitStart)
      expect(m.index!).toBeLessThan(submitEnd)
    }
    expect(body, 'useState initialisers must be lazy').not.toMatch(/useState<[^>]*>\(\[\s*new(Cat|Item)\(\)/)
    expect(body).toMatch(/useState<CategoryDraft\[\]>\(\(\) =>/)
    expect(body).toMatch(/useState<ItemDraft\[\]>\(\(\) =>/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — a client-side navigation (no SSR)', () => {
  it('4. mounting straight on the client is self-consistent too', async () => {
    // This path always worked, which is why the defect looked intermittent:
    // arriving via an in-app <Link> produced no server HTML to disagree with.
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => { createRoot(container).render(<NewExerciseForm courses={COURSES} />) })

    const selects = itemSelects(container)
    for (const [i, sel] of selects.entries()) {
      const values = [...sel.options].map(o => o.value).filter(Boolean)
      await act(async () => { fireEvent.change(sel, { target: { value: values[i % values.length] } }) })
    }
    await act(async () => { fireEvent.submit(container.querySelector('form')!) })

    const { orphans, items } = payloadOf(created[0])
    expect(items).toHaveLength(2)
    expect(orphans).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — add / remove / select invariants', () => {
  async function mount() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => { createRoot(container).render(<NewExerciseForm courses={COURSES} />) })
    return container
  }
  const addCategory = (el: HTMLElement) =>
    [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Ajouter une catégorie'))!
  const trashButtons = (el: HTMLElement) => {
    // The category block is the first card that owns an "Ajouter une catégorie".
    const blocks = [...el.querySelectorAll('div.bg-white')]
    const catBlock = blocks.find(b => b.textContent?.includes('Ajouter une catégorie'))!
    return [...catBlock.querySelectorAll('button')].filter(b => b.querySelector('svg') && !b.textContent?.includes('Ajouter'))
  }

  it('5. removing a category clears exactly that category on every item', async () => {
    const el = await mount()
    await act(async () => { fireEvent.click(addCategory(el)) })      // 3 categories

    const selects = itemSelects(el)
    const values  = [...selects[0].options].map(o => o.value).filter(Boolean)
    await act(async () => { fireEvent.change(selects[0], { target: { value: values[0] } }) })
    await act(async () => { fireEvent.change(selects[1], { target: { value: values[2] } }) })

    // Remove the FIRST category: item 0 loses its choice, item 1 keeps its own.
    await act(async () => { fireEvent.click(trashButtons(el)[0]) })
    await act(async () => { fireEvent.submit(el.querySelector('form')!) })

    const { items, orphans, categories } = payloadOf(created[0])
    expect(categories).toHaveLength(2)
    expect(orphans, 'an item was left pointing at the removed category').toHaveLength(0)
    expect(items[0].correctCategoryId, 'the removed category was not cleared').toBe('')
    expect(items[1].correctCategoryId, 'an unrelated item lost its category').not.toBe('')
  })

  it('6. TWO removals inside ONE React batch cannot orphan an item', async () => {
    // The index-based version failed exactly here: the handler read
    // categories[idx] from the render-time array while the updater filtered the
    // running one, so "delete 0 then delete 1" removed the third category while
    // clearing the second.
    const el = await mount()
    await act(async () => { fireEvent.click(addCategory(el)) })
    await act(async () => { fireEvent.click(addCategory(el)) })      // 4 categories

    const selects = itemSelects(el)
    const values  = [...selects[0].options].map(o => o.value).filter(Boolean)
    await act(async () => { fireEvent.change(selects[0], { target: { value: values[2] } }) })
    await act(async () => { fireEvent.change(selects[1], { target: { value: values[3] } }) })

    const trash = trashButtons(el)
    await act(async () => {
      fireEvent.click(trash[0])
      fireEvent.click(trash[1])   // same batch — no re-render between them
    })
    await act(async () => { fireEvent.submit(el.querySelector('form')!) })

    const { orphans, categories } = payloadOf(created[0])
    expect(categories).toHaveLength(2)
    expect(orphans, 'a batched double-delete orphaned an item').toHaveLength(0)
  })

  it('7. adding a category after assigning items disturbs nothing', async () => {
    const el = await mount()
    const selects = itemSelects(el)
    const values  = [...selects[0].options].map(o => o.value).filter(Boolean)
    await act(async () => { fireEvent.change(selects[0], { target: { value: values[0] } }) })
    await act(async () => { fireEvent.change(selects[1], { target: { value: values[1] } }) })
    await act(async () => { fireEvent.click(addCategory(el)) })
    await act(async () => { fireEvent.submit(el.querySelector('form')!) })

    const { orphans, items, categories } = payloadOf(created[0])
    expect(categories).toHaveLength(3)
    expect(orphans).toHaveLength(0)
    expect(items.every(i => i.correctCategoryId)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — the edit form', () => {
  const PROPS = {
    exerciseId: 'ex-1', initialTitle: 'T', initialInstructions: '', initialCourseId: 'course-1',
    initialModuleId: 'mod-1', initialLessonId: 'lesson-1', initialIsPublished: false,
    initialCategories: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'A', color: '' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'B', color: '' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'C', color: '' },
    ],
    initialItems: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'L1', correctCategoryId: '11111111-1111-4111-8111-111111111111' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'L2', correctCategoryId: '33333333-3333-4333-8333-333333333333' },
    ],
    courses: COURSES,
  }

  it('8. it was never affected: its ids come from props, identical on both renders', async () => {
    const html = renderToString(<EditExerciseForm {...PROPS} />)
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    await act(async () => { hydrateRoot(container, <EditExerciseForm {...PROPS} />) })
    await act(async () => { fireEvent.submit(container.querySelector('form')!) })

    const { orphans, items } = payloadOf(updated[0])
    expect(orphans).toHaveLength(0)
    expect(items.map(i => i.correctCategoryId))
      .toEqual(['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'])
  })

  it('9. batched double-delete is safe here too', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => { createRoot(container).render(<EditExerciseForm {...PROPS} />) })

    const blocks   = [...container.querySelectorAll('div.bg-white')]
    const catBlock = blocks.find(b => b.textContent?.includes('Ajouter une catégorie'))!
    const trash    = [...catBlock.querySelectorAll('button')].filter(b => b.querySelector('svg') && !b.textContent?.includes('Ajouter'))

    await act(async () => { fireEvent.click(trash[0]); fireEvent.click(trash[1]) })
    await act(async () => { fireEvent.submit(container.querySelector('form')!) })

    const { orphans, categories } = payloadOf(updated[0])
    expect(categories).toHaveLength(1)
    expect(orphans, 'a batched double-delete orphaned an item in the edit form').toHaveLength(0)
  })

  it('10. the edit form addresses rows by id, not by index', () => {
    const src = read('app/(admin)/admin/exercises/[id]/edit/EditExerciseForm.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(src).toMatch(/function removeCategory\(id: string\)/)
    expect(src).toMatch(/function removeItem\(id: string\)/)
    expect(src, 'an index-addressed mutation returned')
      .not.toMatch(/(update|remove)(Category|Item)\((ci|ii|idx)[,)]/)
    expect(src).not.toMatch(/filter\(\(_, i\) => i !== idx\)/)
  })
})
