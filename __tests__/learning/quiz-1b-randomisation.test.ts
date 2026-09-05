// @vitest-environment node
/**
 * QUIZ-1B — randomisation activation (capabilities 1 and 2) and the formative
 * pre-submission copy fix.
 *
 * ── THE CORRECTNESS INVARIANT ─────────────────────────────────────────────
 *
 * `quiz_questions.correct_answer` is an INTEGER INDEX into `options`. Shuffling
 * what the learner sees would appear to move the correct answer. It does not,
 * because every displayed option carries the index it holds in the STORED
 * array and the learner submits THAT index. These tests run the real
 * presentation helpers and the real grading comparison to prove display order
 * and grading are decoupled — the one thing that must not be taken on trust
 * before two production flags are flipped.
 *
 * Capabilities 3 (question-bank subset) and 4 (random pick among quizzes) are
 * NOT approved for this phase and are asserted absent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildDisplayOptions, orderQuestions, seededRandom, shuffle, newAttemptSeed,
} from '@/lib/quiz/presentation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const QUIZ_PAGE = 'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx'
const EXAM_PAGE = 'app/(learn)/learn/[courseSlug]/final-exam/page.tsx'
const ACTION    = 'app/actions/quiz.ts'

/**
 * Structural stand-in for the production quiz: 3 multiple-choice questions,
 * 4 options each, correct answers [0, 1, 1].
 *
 * NOT the production rows verbatim. Production q2 stores its options as
 * ["Frustrante", "Correcte", "Mémorable", "Aucune de ces réponses"] — a
 * different order from q0/q1, which share the array below. That difference is
 * deliberately NOT reproduced: what is under test is that grading follows the
 * ORIGINAL INDEX and never the string sitting at it, so a fixture pinned to
 * production's exact text would prove strictly less than one exercised across
 * 200 seeds. Scores still match production exactly, because they are computed
 * from correct_answer rather than from text.
 */
const OPTIONS = ['Frustrante', 'Mémorable', 'Correcte', 'Aucune de ces réponses']
const QUESTIONS = [
  { id: 'q0', correct_answer: 0, options: OPTIONS },
  { id: 'q1', correct_answer: 1, options: OPTIONS },
  { id: 'q2', correct_answer: 1, options: OPTIONS },
]

/** The grader's comparison for multiple_choice, verbatim from app/actions/quiz.ts. */
const gradeOne = (submitted: unknown, correct: number) =>
  typeof submitted === 'number' && submitted === correct

/** Find a seed that actually permutes, so "may differ" becomes "does differ". */
const seedThatShuffles = <T,>(items: readonly T[], build: (_seed: number) => T[]): number => {
  for (let s = 1; s < 5000; s++) {
    const out = build(s)
    if (out.some((v, i) => v !== items[i])) return s
  }
  throw new Error('no permuting seed found')
}

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — capability 1: question order', () => {
  it('1. randomize_questions = true changes presentation order', () => {
    const seed = seedThatShuffles(QUESTIONS, s => orderQuestions(QUESTIONS, true, s))
    const out = orderQuestions(QUESTIONS, true, seed)
    expect(out.map(q => q.id)).not.toEqual(['q0', 'q1', 'q2'])
    // Nothing added, removed or duplicated — the denominator is untouched.
    expect([...out.map(q => q.id)].sort()).toEqual(['q0', 'q1', 'q2'])
  })

  it('2. randomize_questions = false preserves canonical order', () => {
    expect(orderQuestions(QUESTIONS, false, 12345).map(q => q.id)).toEqual(['q0', 'q1', 'q2'])
  })

  it('the input array is never mutated', () => {
    const before = QUESTIONS.map(q => q.id)
    orderQuestions(QUESTIONS, true, 99)
    expect(QUESTIONS.map(q => q.id)).toEqual(before)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — capability 2: option order', () => {
  it('3. randomize_options = true changes option presentation order', () => {
    const seed = seedThatShuffles(OPTIONS, s => buildDisplayOptions(OPTIONS, true, s).map(o => o.text))
    const shown = buildDisplayOptions(OPTIONS, true, seed)
    expect(shown.map(o => o.text)).not.toEqual(OPTIONS)
    expect([...shown.map(o => o.text)].sort()).toEqual([...OPTIONS].sort())
  })

  it('4. randomize_options = false preserves canonical order', () => {
    const shown = buildDisplayOptions(OPTIONS, false, 4242)
    expect(shown.map(o => o.text)).toEqual(OPTIONS)
    expect(shown.map(o => o.originalIndex)).toEqual([0, 1, 2, 3])
  })

  it('5. every option keeps its ORIGINAL index through the shuffle', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const shown = buildDisplayOptions(OPTIONS, true, seed)
      expect(shown).toHaveLength(OPTIONS.length)
      for (const o of shown) expect(OPTIONS[o.originalIndex]).toBe(o.text)
      expect([...shown.map(o => o.originalIndex)].sort()).toEqual([0, 1, 2, 3])
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — grading is unaffected by display order', () => {
  it('6. picking the correct option grades correct, wherever it is shown', () => {
    for (const q of QUESTIONS) {
      for (let seed = 1; seed <= 200; seed++) {
        const shown = buildDisplayOptions(q.options, true, seed)
        // The learner clicks the slot whose TEXT is the right answer…
        const slot = shown.findIndex(o => o.text === q.options[q.correct_answer])
        // …and what is submitted is that option's original index.
        expect(gradeOne(shown[slot].originalIndex, q.correct_answer)).toBe(true)
      }
    }
  })

  it('7. picking a wrong option stays wrong, wherever it is shown', () => {
    for (const q of QUESTIONS) {
      for (let seed = 1; seed <= 100; seed++) {
        const shown = buildDisplayOptions(q.options, true, seed)
        for (const o of shown) {
          if (o.originalIndex === q.correct_answer) continue
          expect(gradeOne(o.originalIndex, q.correct_answer)).toBe(false)
        }
      }
    }
  })

  it('8. shuffled and unshuffled grading agree for the same semantic answer', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let shuffledScore = 0
      let plainScore    = 0
      for (const q of QUESTIONS) {
        const chosenText = q.options[q.correct_answer]        // same semantic choice
        const shown  = buildDisplayOptions(q.options, true, seed)
        const plain  = buildDisplayOptions(q.options, false, seed)
        if (gradeOne(shown.find(o => o.text === chosenText)!.originalIndex, q.correct_answer)) shuffledScore++
        if (gradeOne(plain.find(o => o.text === chosenText)!.originalIndex, q.correct_answer)) plainScore++
      }
      expect(shuffledScore).toBe(plainScore)
      expect(shuffledScore).toBe(QUESTIONS.length)
    }
  })

  it('a partially-correct set scores identically shuffled vs not (the UAT 1/3 shape)', () => {
    // Exactly the production attempt: one right, two wrong.
    const picks = { q0: 2, q1: 1, q2: 0 }
    const score = (rand: boolean, seed: number) =>
      QUESTIONS.filter(q => {
        const shown = buildDisplayOptions(q.options, rand, seed)
        const text  = q.options[picks[q.id as keyof typeof picks]]
        return gradeOne(shown.find(o => o.text === text)!.originalIndex, q.correct_answer)
      }).length
    for (let seed = 1; seed <= 50; seed++) expect(score(true, seed)).toBe(score(false, seed))
    expect(score(false, 1)).toBe(1)   // 1 of 3 = 33%, as production recorded
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — seed behaviour', () => {
  it('9. the same seed gives a stable ordering', () => {
    for (const seed of [1, 7, 4242, 999999]) {
      expect(buildDisplayOptions(OPTIONS, true, seed)).toEqual(buildDisplayOptions(OPTIONS, true, seed))
      expect(orderQuestions(QUESTIONS, true, seed).map(q => q.id))
        .toEqual(orderQuestions(QUESTIONS, true, seed).map(q => q.id))
    }
  })

  it('10. different seeds can produce different orderings', () => {
    const seen = new Set<string>()
    for (let s = 1; s <= 60; s++) seen.add(buildDisplayOptions(OPTIONS, true, s).map(o => o.originalIndex).join(''))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('the PRNG is deterministic and bounded', () => {
    const a = seededRandom(123), b = seededRandom(123)
    for (let i = 0; i < 50; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('shuffle is a permutation, never a rewrite', () => {
    const out = shuffle(OPTIONS, seededRandom(77))
    expect([...out].sort()).toEqual([...OPTIONS].sort())
    expect(OPTIONS).toEqual(['Frustrante', 'Mémorable', 'Correcte', 'Aucune de ces réponses'])
  })

  it('newAttemptSeed produces a usable 32-bit seed', () => {
    for (let i = 0; i < 20; i++) {
      const s = newAttemptSeed()
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(0x100000000)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — formative pre-submission copy', () => {
  const src = () => stripJs(read(QUIZ_PAGE))

  it('11. a formative quiz no longer claims a minimum score is required', () => {
    const s = src()
    expect(s).toMatch(/\{isFormativeLessonQuiz \? \([\s\S]{0,240}ne bloque pas la suite du cours/)
  })

  it('12. a module-gated quiz keeps the pass-score instruction', () => {
    const s = src()
    // Still present, but now the ELSE branch of the formative check.
    expect(s).toMatch(/\) : \([\s\S]{0,200}au moins \{requiredScore\}&nbsp;% pour valider ce module/)
  })

  it('the two branches are mutually exclusive — no quiz sees both', () => {
    const s = src()
    const block = s.slice(s.indexOf('Instructions'), s.indexOf('autant de fois que n&eacute;cessaire'))
    expect((block.match(/isFormativeLessonQuiz \? \(/g) ?? []).length).toBe(1)
    expect((block.match(/pour valider ce module/g) ?? []).length).toBe(1)
  })

  it('13. the final exam has its own page and is untouched by this change', () => {
    const exam = read(EXAM_PAGE)
    expect(exam).toMatch(/attemptsRemaining/)
    // The formative wording must not have leaked into the exam surface.
    expect(stripJs(exam)).not.toContain('ne bloque pas la suite du cours')
  })

  it('the post-submission formative copy still agrees with the new instruction', () => {
    expect(src()).toMatch(/ne conditionne\s*\n?\s*ni la suite du cours ni votre certificat/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — formative success copy', () => {
  const src = () => stripJs(read(QUIZ_PAGE))

  /** The post-submission PASS branch, isolated from the fail branches. */
  const passBranch = () => {
    const s = src()
    const start = s.indexOf('{quizPassed ? (')
    const end   = s.indexOf(') : isFormativeLessonQuiz ? (', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return s.slice(start, end)
  }

  it('17. a passing FORMATIVE quiz does not claim the module was validated', () => {
    const b = passBranch()
    const guard    = b.indexOf('isFormativeLessonQuiz')
    const exercise = b.indexOf('r&eacute;ussi cet exercice')
    expect(guard).toBeGreaterThan(-1)
    // The formative wording is reached only through the guard.
    expect(exercise).toBeGreaterThan(guard)
  })

  it('18. a passing MODULE-GATED quiz still claims the module was validated', () => {
    // The else arm, and it must come after the formative arm.
    const b = passBranch()
    const exercise = b.indexOf('r&eacute;ussi cet exercice')
    const module_  = b.indexOf('valid&eacute; ce module')
    expect(module_).toBeGreaterThan(-1)
    // Still present, but now the ELSE arm of the formative check.
    expect(module_).toBeGreaterThan(exercise)
  })

  it('the two success branches are mutually exclusive — no quiz sees both', () => {
    const b = passBranch()
    expect((b.match(/isFormativeLessonQuiz/g)        ?? []).length).toBe(1)
    expect((b.match(/r&eacute;ussi cet exercice/g)   ?? []).length).toBe(1)
    expect((b.match(/valid&eacute; ce module/g)      ?? []).length).toBe(1)
  })

  it('the page carries no UNGUARDED module-validation claim', () => {
    const s = src()
    expect((s.match(/valid&eacute; ce module/g) ?? []).length).toBe(1)
    expect(s).toContain('? <>Bravo&nbsp;! Vous avez r&eacute;ussi cet exercice.</>')
    expect(s).toContain(': <>Bravo&nbsp;! Vous avez valid&eacute; ce module.</>')
  })

  it('19. the final exam keeps its own success copy and is untouched', () => {
    const exam = stripJs(read(EXAM_PAGE))
    expect(exam).toMatch(/Vous avez valid&eacute; l&apos;examen final/)
    expect(exam).not.toContain('r&eacute;ussi cet exercice')
    expect(exam).not.toContain('valid&eacute; ce module')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1B — security and scope', () => {
  it('14. no answer key is selected client-side before submission', () => {
    const s = stripJs(read(QUIZ_PAGE))
    for (const key of ['correct_answer', 'drag_match_answers'])
      expect(s, `quiz page selects ${key}`).not.toMatch(new RegExp(`select\\([^)]*${key}`))
  })

  it('15. entitlement remains the access authority in the grader', () => {
    const a = stripJs(read(ACTION))
    expect(a).toMatch(/resolveCourseAccessById\(context\.courseId\)/)
    expect(a).toMatch(/if \(!access\.allowed \|\| !access\.userId\)/)
  })

  it('16. the quiz page cannot resolve a withdrawn course', () => {
    const s = stripJs(read(QUIZ_PAGE))
    expect(s).toMatch(/from\('courses'\)/)
    expect(s).toMatch(/router\.push\('\/courses'\)/)
  })

  it('capability 3 (question bank) and 4 (multi-quiz pick) are NOT implemented', () => {
    const pres = stripJs(read('lib/quiz/presentation.ts'))
    for (const forbidden of ['bank', 'subset', 'sample', 'pickQuiz'])
      expect(pres.toLowerCase(), `presentation implements ${forbidden}`).not.toContain(forbidden)
    // Quiz selection stays deterministic, not random.
    const s = stripJs(read(QUIZ_PAGE))
    expect(s).toMatch(/\.order\('created_at', \{ ascending: true \}\)/)
  })

  it('no randomisation flag is written from application code', () => {
    for (const f of [QUIZ_PAGE, ACTION]) {
      const s = stripJs(read(f))
      expect(s, `${f} writes a randomize flag`).not.toMatch(/randomize_(questions|options)\s*:\s*(true|false)/)
    }
  })
})
