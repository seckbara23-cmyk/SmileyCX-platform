// @vitest-environment node
/**
 * UAT-EXERCISE-CATEGORY-FK-01 — the server side of the repair.
 *
 * The builder is fixed at source (companion suite). This suite proves the
 * second line: an incoherent payload — from a stale tab, a future client
 * regression, or a hand-crafted POST — is refused in French BEFORE the first
 * database call, instead of reaching PostgreSQL and coming back as
 * `exercise_items_correct_category_id_fkey`.
 *
 * The final assertions pin the database contract itself, because the tempting
 * "fix" for a foreign-key error is to drop the foreign key. That constraint is
 * the only thing that stopped a broken exercise being persisted, where an item
 * would point at nothing and the learner-side scorer would mark every answer
 * wrong. It stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Counts every attempt to reach the database, whatever the table. */
let adminClientCalls = 0
const tablesTouched: string[] = []

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/session', () => ({ requirePlatformAdmin: async () => ({ id: 'admin' }) }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}))
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('REDIRECT') } }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    adminClientCalls++
    const chain = {
      insert: () => { return { select: () => ({ single: async () => ({ data: { id: 'ex-1' }, error: null }) }) } },
      delete: () => ({ eq: async () => ({ error: null }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }
    return { from: (t: string) => { tablesTouched.push(t); return chain } }
  },
}))

import { parseExercisePayload } from '@/lib/admin/exercise-payload'

const CAT_A = '11111111-1111-4111-8111-111111111111'
const CAT_B = '22222222-2222-4222-8222-222222222222'
const ITEM_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const cats = (over: unknown[] = []) => JSON.stringify(over.length ? over : [
  { id: CAT_A, name: 'A', color: '', order_index: 0 },
  { id: CAT_B, name: 'B', color: '', order_index: 1 },
])
const itemsJson = (over: unknown[] = []) => JSON.stringify(over.length ? over : [
  { id: ITEM_1, label: 'L1', correctCategoryId: CAT_A, order_index: 0 },
  { id: ITEM_2, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
])

beforeEach(() => { adminClientCalls = 0; tablesTouched.length = 0 })

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — payload validation (behavioural)', () => {
  it('1. a coherent payload is accepted and normalised', () => {
    const r = parseExercisePayload(cats(), itemsJson())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.categories.map(c => c.id)).toEqual([CAT_A, CAT_B])
    expect(r.items.map(i => i.correctCategoryId)).toEqual([CAT_A, CAT_B])
    // order_index is derived from position, never trusted from the client.
    expect(r.categories.map(c => c.order_index)).toEqual([0, 1])
    expect(r.items.map(i => i.order_index)).toEqual([0, 1])
  })

  it('2. THE DEFECT: an item referencing an unsubmitted category is refused', () => {
    const orphan = '99999999-9999-4999-8999-999999999999'
    const r = parseExercisePayload(cats(), itemsJson([
      { id: ITEM_1, label: 'Un client se plaint', correctCategoryId: orphan, order_index: 0 },
      { id: ITEM_2, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
    ]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Names the offending element so the author can act on it.
    expect(r.error).toContain('Un client se plaint')
    expect(r.error).toMatch(/catégorie qui n'existe pas/)
    // And says nothing about PostgreSQL.
    expect(r.error).not.toMatch(/foreign key|constraint|exercise_items/i)
  })

  it('3. duplicate category ids are refused', () => {
    const r = parseExercisePayload(cats([
      { id: CAT_A, name: 'A', color: '', order_index: 0 },
      { id: CAT_A, name: 'B', color: '', order_index: 1 },
    ]), itemsJson())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/même identifiant/)
  })

  it('4. a non-uuid category id is refused before the column type can reject it', () => {
    for (const bad of ['cat-1', '0', '', 'not-a-uuid', '11111111-1111-4111-8111-11111111111']) {
      const r = parseExercisePayload(cats([
        { id: bad, name: 'A', color: '', order_index: 0 },
        { id: CAT_B, name: 'B', color: '', order_index: 1 },
      ]), itemsJson([
        { id: ITEM_1, label: 'L1', correctCategoryId: bad, order_index: 0 },
        { id: ITEM_2, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
      ]))
      expect(r.ok, `accepted category id ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('5. a duplicate or malformed ITEM id is refused', () => {
    const dup = parseExercisePayload(cats(), itemsJson([
      { id: ITEM_1, label: 'L1', correctCategoryId: CAT_A, order_index: 0 },
      { id: ITEM_1, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
    ]))
    expect(dup.ok).toBe(false)
    const bad = parseExercisePayload(cats(), itemsJson([
      { id: 'item-1', label: 'L1', correctCategoryId: CAT_A, order_index: 0 },
      { id: ITEM_2,   label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
    ]))
    expect(bad.ok).toBe(false)
  })

  it('6. the pre-existing author rules still hold', () => {
    const one = parseExercisePayload(JSON.stringify([{ id: CAT_A, name: 'A', color: '', order_index: 0 }]), itemsJson())
    expect(one.ok).toBe(false)
    if (!one.ok) expect(one.error).toMatch(/Au moins 2 catégories/)

    const noName = parseExercisePayload(cats([
      { id: CAT_A, name: '   ', color: '', order_index: 0 },
      { id: CAT_B, name: 'B', color: '', order_index: 1 },
    ]), itemsJson())
    expect(noName.ok).toBe(false)
    if (!noName.ok) expect(noName.error).toMatch(/noms de catégories/)

    const noCat = parseExercisePayload(cats(), itemsJson([
      { id: ITEM_1, label: 'L1', correctCategoryId: '', order_index: 0 },
      { id: ITEM_2, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
    ]))
    expect(noCat.ok).toBe(false)
    if (!noCat.ok) expect(noCat.error).toMatch(/catégorie correcte/)

    for (const junk of ['', 'null', '{}', '[1,2]', 'not json'])
      expect(parseExercisePayload(junk, itemsJson()).ok, `accepted ${junk}`).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — nothing reaches the database', () => {
  const form = (over: Record<string, string> = {}) => {
    const fd = new FormData()
    fd.set('title', 'Exercice')
    fd.set('instructions', '')
    fd.set('lesson_id', 'lesson-1')
    fd.set('exercise_id', 'ex-1')
    fd.set('is_published', 'false')
    fd.set('categories_json', cats())
    fd.set('items_json', itemsJson())
    for (const [k, v] of Object.entries(over)) fd.set(k, v)
    return fd
  }
  const orphanItems = itemsJson([
    { id: ITEM_1, label: 'L1', correctCategoryId: '99999999-9999-4999-8999-999999999999', order_index: 0 },
    { id: ITEM_2, label: 'L2', correctCategoryId: CAT_B, order_index: 1 },
  ])

  it('7. createExercise refuses an orphaned item WITHOUT opening a client', async () => {
    const { createExercise } = await import('@/app/(admin)/admin/exercises/new/actions')
    const r = await createExercise(form({ items_json: orphanItems }))
    expect(r?.error).toMatch(/catégorie qui n'existe pas/)
    expect(adminClientCalls, 'the database was contacted before validating').toBe(0)
    expect(tablesTouched).toEqual([])
  })

  it('8. updateExercise refuses it too — and it DELETES before re-inserting', async () => {
    const { updateExercise } = await import('@/app/(admin)/admin/exercises/[id]/edit/actions')
    const r = await updateExercise(form({ items_json: orphanItems }))
    expect(r?.error).toMatch(/catégorie qui n'existe pas/)
    // This is the important one: had validation run after the delete, an
    // incoherent payload would have destroyed a working exercise.
    expect(adminClientCalls).toBe(0)
    expect(tablesTouched).toEqual([])
  })

  it('9. duplicate category ids never reach the database either', async () => {
    const { createExercise } = await import('@/app/(admin)/admin/exercises/new/actions')
    const r = await createExercise(form({ categories_json: cats([
      { id: CAT_A, name: 'A', color: '', order_index: 0 },
      { id: CAT_A, name: 'B', color: '', order_index: 1 },
    ]) }))
    expect(r?.error).toMatch(/même identifiant/)
    expect(adminClientCalls).toBe(0)
  })

  it('10. both actions validate through the SAME module — one definition, not two', () => {
    for (const f of ['app/(admin)/admin/exercises/new/actions.ts',
                     'app/(admin)/admin/exercises/[id]/edit/actions.ts']) {
      const s = read(f)
      expect(s, `${f} does not use the shared validator`)
        .toMatch(/import \{ parseExercisePayload \} from '@\/lib\/admin\/exercise-payload'/)
      expect(s).toMatch(/const parsed = parseExercisePayload\(catJson, itemJson\)/)
      // The validator must run before the client is ever created.
      expect(s.indexOf('parseExercisePayload(catJson'), `${f} validates after opening a client`)
        .toBeLessThan(s.indexOf('createAdminClient()'))
      // And the hand-rolled checks it replaced must not creep back.
      expect(s, `${f} re-implements validation locally`).not.toMatch(/JSON\.parse\(catJson\)/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-EXERCISE-CATEGORY-FK-01 — the database contract is untouched', () => {
  const M023 = read('supabase/migrations/023_exercises_system.sql')

  it('11. the foreign key still points at exercise_categories(id) and is NOT NULL', () => {
    expect(M023).toMatch(
      /correct_category_id\s+uuid\s+not null\s+references public\.exercise_categories\(id\)\s+on delete restrict/)
  })

  it('12. no migration weakens or drops it', () => {
    const { readdirSync } = require('fs') as typeof import('fs')
    const dir = join(ROOT, 'supabase', 'migrations')
    for (const f of readdirSync(dir).filter(n => n.endsWith('.sql'))) {
      const s = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '')
      expect(s, `${f} drops the constraint`)
        .not.toMatch(/drop constraint[\s\S]{0,80}correct_category_id/i)
      expect(s, `${f} makes the column nullable`)
        .not.toMatch(/alter column correct_category_id drop not null/i)
      expect(s, `${f} alters exercise_items' foreign key`)
        .not.toMatch(/alter table[\s\S]{0,60}exercise_items[\s\S]{0,120}(drop constraint|add constraint)/i)
    }
  })

  it('13. this fix added no migration; 058-060 came later and leave the exercise tables alone', () => {
    const { readdirSync, readFileSync } = require('fs') as typeof import('fs')
    const DIR = join(ROOT, 'supabase', 'migrations')
    const files = readdirSync(DIR).filter(n => n.endsWith('.sql'))
    const nums = files.map(f => /^(\d{3})_/.exec(f)?.[1]).filter(Boolean).map(Number)
    // This fix was application-only. PAY-1 later authored 058 (payment
    // provider foundation), PAY-1B(b) 059 (payment column SELECT security) and
    // PAY-2B 060 (the payment completion contract); excluding those three, the
    // set this fix shipped against is unchanged. The invariant that matters is
    // not "no migration above 057" but that nothing above it weakens the FK
    // this suite exists to protect.
    const LATER = ['058_payment_provider_foundation.sql', '059_payment_column_select_security.sql',
                   '060_payment_completion_contract.sql']
    expect(files.filter(f => parseInt(f, 10) > 57)).toEqual(LATER)
    expect(Math.max(...nums)).toBe(60)
    for (const later of LATER) {
      const s = readFileSync(join(DIR, later), 'utf8').replace(/--[^\n]*/g, '')
      for (const t of ['exercises', 'exercise_categories', 'exercise_items',
                       'exercise_submissions', 'exercise_answers']) {
        expect(s, `${later} touches public.${t}`).not.toContain(t)
      }
      expect(s, `${later} alters a correct_category_id constraint`)
        .not.toMatch(/correct_category_id/i)
    }
  })
})
