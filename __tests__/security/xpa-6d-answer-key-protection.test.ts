// @vitest-environment node
/**
 * XPA-6D — answer-key protection across quizzes AND exercises.
 *
 * One invariant carries this phase:
 *
 *   No learner-facing payload may contain an authoritative answer key before
 *   scoring.
 *
 * Two findings violated it, with very different severity:
 *
 *   B-4 (quizzes)   RLS is row-level, so an entitled learner could select
 *                   `correct_answer` via PostgREST. The UI hand-picked safe
 *                   columns, so it never leaked by accident — but that is UI
 *                   hiding, and UI hiding is not protection.
 *
 *   EXERCISES       Worse. The learner lesson page is a browser component and
 *                   it SELECTED `correct_category_id` outright, then compared
 *                   placements against it in the browser. The key shipped to
 *                   every learner on every render, and scoring was client-side.
 *
 * The static assertions below strip comments first. That matters: the source
 * files legitimately *mention* these column names in comments explaining why
 * they must not be selected, and a naive grep would both false-positive on
 * those and let a real regression hide inside a commented-out line.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { scoreExercise } from '@/lib/exercises/scoring'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

const MIGRATION = 'supabase/migrations/038_answer_key_protection.sql'
const sql = stripSql(read(MIGRATION))

const LEARNER_QUIZ    = 'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx'
const LEARNER_EXAM    = 'app/(learn)/learn/[courseSlug]/final-exam/page.tsx'
const LEARNER_LESSON  = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const EXERCISE_BLOCK  = 'components/lms/ExerciseBlock.tsx'
const EXERCISE_ACTION = 'app/actions/exercise.ts'
const QUIZ_ACTION     = 'app/actions/quiz.ts'

/** Every column list passed to a `.select(...)` in a file, comments stripped. */
const projectionsIn = (rel: string): string[] => {
  const src = stripTs(read(rel))
  return [...src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map(m => m[2])
}

const QUIZ_KEY_COLUMNS     = ['correct_answer', 'drag_match_answers', 'explanation']
const QUIZ_SAFE_COLUMNS    = ['id', 'quiz_id', 'question', 'options',
                              'order_index', 'question_type', 'question_image_url']
const EXERCISE_KEY_COLUMN  = 'correct_category_id'
const EXERCISE_SAFE_COLUMNS = ['id', 'exercise_id', 'label', 'order_index']

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSIONS — these two must never be deleted or renamed
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A finding B-4 — quiz_questions.correct_answer must not reach a learner', () => {
  it('B-4: migration 038 withholds every quiz answer-key column from both app roles', () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.quiz_questions\s+from\s+anon,\s*authenticated/i)

    const grant = sql.match(/grant\s+select\s*\(([^)]*)\)\s*on\s+public\.quiz_questions/i)
    expect(grant, 'no column-scoped grant on quiz_questions').toBeTruthy()

    const granted = grant![1].split(',').map(c => c.trim()).filter(Boolean)
    for (const key of QUIZ_KEY_COLUMNS) {
      expect(granted, `${key} must not be granted to a learner role`).not.toContain(key)
    }
    expect(granted.sort()).toEqual([...QUIZ_SAFE_COLUMNS].sort())
  })

  it('B-4: no learner-facing quiz query selects an answer-key column', () => {
    for (const file of [LEARNER_QUIZ, LEARNER_EXAM]) {
      // Assert on the PROJECTIONS, not the whole file. These pages legitimately
      // reference `explanations` — the post-submission feedback payload the
      // scoring action returns — and that must not be confused with selecting
      // the `explanation` column from the table.
      for (const projection of projectionsIn(file)) {
        for (const key of QUIZ_KEY_COLUMNS) {
          expect(projection.split(/[\s,()]+/), `${file} selects ${key}`).not.toContain(key)
        }
        expect(projection.trim(), `${file} uses select('*')`).not.toBe('*')
      }
    }
  })
})

describe('XPA-6D — exercises must not ship correct_category_id to the browser', () => {
  it('CLIENT-KEY: the learner lesson page does not select the exercise answer key', () => {
    const projections = projectionsIn(LEARNER_LESSON)
    expect(projections.length, 'no .select() found — has the page been rewritten?').toBeGreaterThan(0)
    for (const projection of projections) {
      expect(projection.split(/[\s,()]+/), 'the browser query still selects the key')
        .not.toContain(EXERCISE_KEY_COLUMN)
    }
  })

  it('CLIENT-KEY: ExerciseBlock neither receives nor compares the answer key', () => {
    const src = stripTs(read(EXERCISE_BLOCK))
    expect(src, 'ExerciseBlock still references the key column').not.toContain(EXERCISE_KEY_COLUMN)
    // The browser must never decide correctness. The old code did exactly this.
    expect(src, 'ExerciseBlock still grades locally')
      .not.toMatch(/placements\[[^\]]+\]\s*===\s*\w+\.correct/)
  })

  it('CLIENT-KEY: migration 038 withholds the exercise key from both app roles', () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.exercise_items\s+from\s+anon,\s*authenticated/i)

    const grant = sql.match(/grant\s+select\s*\(([^)]*)\)\s*on\s+public\.exercise_items/i)
    expect(grant, 'no column-scoped grant on exercise_items').toBeTruthy()

    const granted = grant![1].split(',').map(c => c.trim()).filter(Boolean)
    expect(granted).not.toContain(EXERCISE_KEY_COLUMN)
    expect(granted.sort()).toEqual([...EXERCISE_SAFE_COLUMNS].sort())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE TRUSTED SCORING BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6D scoring runs server-side with service-role reads', () => {
  it('the exercise action reads the key with the admin client, not the session', () => {
    const src = stripTs(read(EXERCISE_ACTION))
    expect(src).toContain('createAdminClient')
    // The key read must be on the admin handle. A session-client read would
    // now fail 42501 anyway, but failing loudly in CI beats failing in prod.
    expect(src).toMatch(/admin\s*\r?\n?\s*\.from\(['"`]exercise_items['"`]\)/)
  })

  it('the quiz action still reads the key with the admin client', () => {
    const src = stripTs(read(QUIZ_ACTION))
    expect(src).toContain('createAdminClient')
    expect(src).toMatch(/admin\s*\r?\n?\s*\.from\(['"`]quiz_questions['"`]\)/)
  })

  it('the browser never receives a service-role key', () => {
    for (const file of [LEARNER_LESSON, EXERCISE_BLOCK, LEARNER_QUIZ, LEARNER_EXAM]) {
      const src = stripTs(read(file))
      expect(src, `${file} references the service role`).not.toContain('SERVICE_ROLE')
      expect(src, `${file} imports the admin client`).not.toContain('supabase/admin')
    }
  })
})

describe('XPA-6D exercise scoring behaviour', () => {
  const items = [
    { id: 'i1', correct_category_id: 'c1' },
    { id: 'i2', correct_category_id: 'c2' },
    { id: 'i3', correct_category_id: 'c1' },
  ]

  it('scores a fully correct submission 100', () => {
    const r = scoreExercise(items, { i1: 'c1', i2: 'c2', i3: 'c1' })
    expect(r).toMatchObject({ score: 100, correct: 3, total: 3 })
    expect(Object.values(r.itemResults).every(x => x.correct)).toBe(true)
  })

  it('scores a fully incorrect submission 0', () => {
    const r = scoreExercise(items, { i1: 'c2', i2: 'c1', i3: 'c2' })
    expect(r).toMatchObject({ score: 0, correct: 0, total: 3 })
    expect(Object.values(r.itemResults).some(x => x.correct)).toBe(false)
  })

  it('rounds a partially correct submission', () => {
    const r = scoreExercise(items, { i1: 'c1', i2: 'c1', i3: 'c1' })
    expect(r).toMatchObject({ score: 67, correct: 2, total: 3 })
    expect(r.itemResults.i2.correct).toBe(false)
  })

  it('treats an unplaced item as incorrect, so a partial answer cannot outscore a wrong one', () => {
    const r = scoreExercise(items, { i1: 'c1' })
    expect(r).toMatchObject({ score: 33, correct: 1, total: 3 })
    expect(r.itemResults.i2.correct).toBe(false)
    expect(r.itemResults.i3.correct).toBe(false)
  })

  it('does not divide by zero on an empty exercise', () => {
    expect(scoreExercise([], {})).toMatchObject({ score: 0, correct: 0, total: 0 })
  })

  it('returns the correct category only in the result, which is post-submission by construction', () => {
    const r = scoreExercise(items, { i1: 'c2', i2: 'c2', i3: 'c1' })
    expect(r.itemResults.i1.correctCategoryId).toBe('c1')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION DISCIPLINE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6D migration discipline', () => {
  it('038 wraps itself in a transaction', () => {
    // 037 declared "run as a SINGLE TRANSACTION" but did not wrap itself, so
    // atomicity depended on the operator's tool. 038 does not repeat that.
    expect(sql).toMatch(/^\s*begin\s*;/im)
    expect(sql).toMatch(/commit\s*;\s*$/im)
  })

  it('038 leaves no table-level privilege for an app role to inherit', () => {
    expect(sql).toMatch(/role_table_grants/)
    expect(sql).toMatch(/table-level privileges survive/i)
  })

  it('038 asserts the learner-safe projection still works, not merely that the key is denied', () => {
    // A seam that denies everyone is broken, not secure.
    expect(sql).toMatch(/cannot read the learner-safe quiz projection/i)
    expect(sql).toMatch(/cannot read the learner-safe exercise projection/i)
  })

  it('038 asserts service-role scoring survives', () => {
    expect(sql).toMatch(/scoring is broken/i)
  })

  it('does not edit an already-applied migration', () => {
    // 037 is applied in production. Its content is not this phase's business.
    expect(read('supabase/migrations/037_entitlements.sql')).not.toContain('xpa6d')
  })
})
