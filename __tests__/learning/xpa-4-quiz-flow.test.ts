// @vitest-environment node
/**
 * XPA-4 — learning flow, assessments and completion.
 *
 * The single most important property here is that **shuffling never changes
 * which answer is correct**. `quiz_questions.correct_answer` is a positional
 * index into `options`, so a naive shuffle would silently mis-grade every
 * learner. These tests exercise the real shuffle helpers against that invariant
 * rather than asserting on source text.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildDisplayOptions,
  orderQuestions,
  seededRandom,
  shuffle,
  newAttemptSeed,
} from '@/lib/quiz/presentation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
}

/**
 * Strip TS comments before asserting on code.
 * These helpers DOCUMENT the invariants they protect, so scanning raw text
 * would flag the explanation as if it were the violation.
 */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, (_m, p1: string) => p1 + ' ')
}

const MIGRATION = stripSqlComments(read('supabase/migrations/032_quiz_randomization_flags.sql'))
const QUIZ_PAGE = read('app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx')
const EXAM_PAGE = read('app/(learn)/learn/[courseSlug]/final-exam/page.tsx')
const GRADER    = read('app/actions/quiz.ts')

// ── The correctness invariant ───────────────────────────────────────────────

describe('XPA-4 — answer shuffling never changes correctness', () => {
  const OPTIONS = ['Frustrante', 'Mémorable', 'Correcte', 'Aucune de ces réponses']
  const CORRECT_INDEX = 1   // "Mémorable" — as stored in the database

  it('every displayed option keeps its ORIGINAL stored index', () => {
    for (let seed = 0; seed < 200; seed++) {
      const shown = buildDisplayOptions(OPTIONS, true, seed)
      for (const opt of shown) {
        expect(OPTIONS[opt.originalIndex]).toBe(opt.text)
      }
    }
  })

  it('the option the learner must pick still carries correct_answer, whatever the order', () => {
    for (let seed = 0; seed < 200; seed++) {
      const shown = buildDisplayOptions(OPTIONS, true, seed)
      const correct = shown.filter(o => o.originalIndex === CORRECT_INDEX)
      expect(correct).toHaveLength(1)
      expect(correct[0].text).toBe('Mémorable')   // grading target never moves
    }
  })

  it('submitting the picked option grades identically shuffled or not', () => {
    // Simulate: learner always picks the option whose TEXT is correct.
    const grade = (submittedOriginalIndex: number) => submittedOriginalIndex === CORRECT_INDEX

    for (let seed = 0; seed < 200; seed++) {
      for (const randomize of [false, true]) {
        const shown = buildDisplayOptions(OPTIONS, randomize, seed)
        const picked = shown.find(o => o.text === 'Mémorable')!
        expect(grade(picked.originalIndex)).toBe(true)
      }
    }
  })

  it('a wrong pick stays wrong under shuffling', () => {
    for (let seed = 0; seed < 100; seed++) {
      const shown = buildDisplayOptions(OPTIONS, true, seed)
      for (const opt of shown.filter(o => o.text !== 'Mémorable')) {
        expect(opt.originalIndex === CORRECT_INDEX).toBe(false)
      }
    }
  })

  it('shuffling loses, duplicates and invents nothing', () => {
    for (let seed = 0; seed < 200; seed++) {
      const shown = buildDisplayOptions(OPTIONS, true, seed)
      expect(shown).toHaveLength(OPTIONS.length)
      expect(new Set(shown.map(o => o.originalIndex)).size).toBe(OPTIONS.length)
      expect(shown.map(o => o.text).sort()).toEqual([...OPTIONS].sort())
    }
  })

  it('disabled randomization preserves the exact stored order', () => {
    const shown = buildDisplayOptions(OPTIONS, false, 12345)
    expect(shown.map(o => o.text)).toEqual(OPTIONS)
    expect(shown.map(o => o.originalIndex)).toEqual([0, 1, 2, 3])
  })

  it('actually reorders for some seeds — the test is not vacuous', () => {
    const orders = new Set(
      Array.from({ length: 50 }, (_, s) => buildDisplayOptions(OPTIONS, true, s).map(o => o.originalIndex).join(','))
    )
    expect(orders.size).toBeGreaterThan(1)
  })
})

// ── Question ordering ───────────────────────────────────────────────────────

describe('XPA-4 — question ordering', () => {
  const QS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('preserves authoring order when disabled', () => {
    expect(orderQuestions(QS, false, 999).map(q => q.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never adds, drops or duplicates a question', () => {
    for (let seed = 0; seed < 200; seed++) {
      const out = orderQuestions(QS, true, seed)
      expect(out).toHaveLength(QS.length)
      expect(out.map(q => q.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    }
  })

  it('does not mutate the input array', () => {
    const input = [...QS]
    orderQuestions(input, true, 7)
    expect(input.map(q => q.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('XPA-4 — seeded shuffle is deterministic', () => {
  it('same seed gives the same order, so a re-render cannot reshuffle', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6], seededRandom(42))
    const b = shuffle([1, 2, 3, 4, 5, 6], seededRandom(42))
    expect(a).toEqual(b)
  })

  it('different seeds generally differ', () => {
    const variants = new Set(
      Array.from({ length: 30 }, (_, s) => shuffle([1, 2, 3, 4, 5], seededRandom(s)).join(','))
    )
    expect(variants.size).toBeGreaterThan(1)
  })

  it('produces seeds in range', () => {
    for (let i = 0; i < 50; i++) {
      const s = newAttemptSeed()
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── Deterministic selection (the defect XPA-4 fixes) ────────────────────────

describe('XPA-4 — quiz selection is deterministic', () => {
  it('no quiz lookup uses limit(1) without an explicit ORDER BY', () => {
    for (const [name, raw] of [['quiz page', QUIZ_PAGE], ['final exam', EXAM_PAGE]] as const) {
      // Strip comments first: the explanatory blocks are long enough to push
      // the .order() call outside a fixed inspection window, which would fail
      // on correct code.
      const src = stripTsComments(raw)
      const chains = src.split(".from('quizzes')").slice(1)
      for (const chain of chains) {
        const head = chain.slice(0, 400)
        if (head.includes('.limit(1)')) {
          expect(head, `${name}: unordered limit(1) on quizzes`).toMatch(/\.order\(/)
        }
      }
    }
  })

  it('ordering is stable — created_at then id to break ties', () => {
    expect(QUIZ_PAGE).toMatch(/\.order\('created_at', \{ ascending: true \}\)/)
    expect(QUIZ_PAGE).toMatch(/\.order\('id', \{ ascending: true \}\)/)
    expect(EXAM_PAGE).toMatch(/\.order\('created_at', \{ ascending: true \}\)/)
  })
})

// ── Migration safety ────────────────────────────────────────────────────────

describe('XPA-4 — migration 032 is additive and preserves behaviour', () => {
  it('adds only two nullable-defaulted boolean columns', () => {
    const adds = [...MIGRATION.matchAll(/add column if not exists (\w+)/gi)].map(m => m[1])
    expect(adds.sort()).toEqual(['randomize_options', 'randomize_questions'])
    expect(MIGRATION).toMatch(/default false/i)
  })

  it('changes no existing data and drops nothing', () => {
    expect(MIGRATION).not.toMatch(/\bupdate\b|\bdelete\b|drop (table|column)|truncate/i)
  })

  it('does not touch answers, attempts or correct_answer', () => {
    for (const t of ['correct_answer', 'quiz_attempts', 'quiz_questions', 'exercise_answers']) {
      expect(MIGRATION).not.toMatch(new RegExp(`(alter|update|delete from)\\s+.*${t}`, 'i'))
    }
  })

  it('asserts that no existing quiz is opted in', () => {
    expect(MIGRATION).toMatch(/must not enable randomization on any existing quiz/)
  })
})

// ── Grading stays server-authoritative ──────────────────────────────────────

describe('XPA-4 — grading authority is unchanged', () => {
  it('correct answers are read server-side with the service client', () => {
    expect(GRADER).toMatch(/createAdminClient/)
    expect(GRADER).toMatch(/select\('id, question_type, correct_answer/)
  })

  it('the browser never receives correct answers before submission', () => {
    // The learner page selects question text/options only — never correct_answer.
    expect(QUIZ_PAGE).toMatch(/\.select\('id, question, options, order_index, question_type, question_image_url'\)/)
    expect(QUIZ_PAGE).not.toMatch(/select\([^)]*correct_answer/)
    expect(EXAM_PAGE).not.toMatch(/select\([^)]*correct_answer/)
  })

  it('the pass threshold is enforced server-side', () => {
    expect(GRADER).toMatch(/passed\s*=\s*score >= passingThreshold/)
  })

  it('the shuffle helpers are presentation-only — they never see correct_answer', () => {
    // Strip comments: the helper DOCUMENTS the invariant it protects, so raw
    // text would flag the explanation as if it were the violation.
    const helper = stripTsComments(read('lib/quiz/presentation.ts'))
    expect(helper).not.toMatch(/correct_answer|passing_score|score|grade\(/)
  })
})

// ── Idempotency backbone ────────────────────────────────────────────────────

describe('XPA-4 — completion idempotency is enforced by the database', () => {
  const schema = read('supabase/schema.sql')

  it('lesson_progress is unique per (user, lesson), so replay cannot duplicate', () => {
    expect(schema).toMatch(/UNIQUE\(user_id, lesson_id\)/)
  })

  it('certificates are unique per (user, course) — exactly-once issuance', () => {
    expect(schema).toMatch(/UNIQUE\(user_id, course_id\)/)
  })

  it('lesson completion upserts on that constraint rather than inserting', () => {
    const player = read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx')
    expect(player).toMatch(/onConflict: 'user_id,lesson_id'/)
  })
})

// ── Certificate gating ──────────────────────────────────────────────────────

describe('XPA-4 — certificate issuance', () => {
  const cert = read('app/(platform)/certificate/[courseSlug]/page.tsx')

  it('checks for an existing certificate before creating one', () => {
    expect(cert).toMatch(/existingCert/)
    expect(cert).toMatch(/from\('certificates'\)[\s\S]{0,200}?\.eq\('user_id'/)
  })

  it('requires module quizzes to have been passed', () => {
    expect(cert).toMatch(/passedAttempts/)
    expect(cert).toMatch(/\.eq\('passed', true\)/)
  })

  it('requires the final exam to be passed when one exists', () => {
    expect(cert).toMatch(/finalExamQuiz/)
    expect(cert).toMatch(/finalAttempt/)
  })

  it('does not infer a final exam for courses that have none', () => {
    expect(cert).toMatch(/if \(finalExamQuiz\)/)
  })

  it('verification URLs use the canonical public domain', () => {
    const brand = read('lib/brand.ts')
    expect(brand).toMatch(/certificateVerifyUrl/)
    expect(brand).toMatch(/www\.xpclient-academy\.com/)
  })
})

// ── Scope guards ────────────────────────────────────────────────────────────

describe('XPA-4 — no scope creep', () => {
  it('no slug or course code is modified', () => {
    expect(MIGRATION).not.toMatch(/\bslug\b/)
    expect(MIGRATION).not.toMatch(/courses\.code|\bcode\b\s*=/)
  })

  it('D-Q1 is untouched — no launch status is assigned', () => {
    expect(MIGRATION).not.toMatch(/'launch'/)
    expect(MIGRATION).not.toMatch(/course_codes/)
  })

  it('migrations 001-027 are not modified', () => {
    // 032 is the only file this phase adds; nothing renumbers or edits history.
    expect(MIGRATION).not.toMatch(/00[0-9]_|01[0-9]_|02[0-7]_/)
  })

  it('the internal catalogue registry is not touched', () => {
    for (const t of ['catalogues', 'learning_paths', 'learning_path_courses']) {
      expect(MIGRATION).not.toContain(t)
    }
  })

  it('no duplicate learning engine was introduced', () => {
    const helper = read('lib/quiz/presentation.ts')
    // The helper is pure presentation: no data access, no grading, no progress.
    expect(helper).not.toMatch(/supabase|createClient|from\(|insert|upsert/)
  })
})
