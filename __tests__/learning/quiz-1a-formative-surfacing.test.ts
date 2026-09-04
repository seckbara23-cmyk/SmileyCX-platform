// @vitest-environment node
/**
 * QUIZ-1A — surface formative quizzes, stop the auto-skip.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Navigation discovered quizzes with `quizzes.module_id IN (module ids)`. The
 * one quiz in production — the C1-F1 warm-up "Échauffement — Repérez le
 * niveau" — is LESSON-scoped: `lesson_id` set, `module_id` and `course_id`
 * NULL. It was therefore invisible to navigation: `currentModHasQuiz` was
 * false, `getAutoAdvanceTarget()` fell through to the next lesson, and the
 * post-video countdown carried the learner straight past the quiz.
 *
 * ── RULING 1: OFFER, NOT GATE ─────────────────────────────────────────────
 *
 * The quiz is now the auto-advance destination and gets a CTA, but it is not
 * a gate. `nextIsBlocked` is untouched, no passing score is required to
 * continue, and neither `requires_final_exam` nor certificate eligibility is
 * affected. Module-scoped gating is pre-existing behaviour and is preserved
 * exactly.
 *
 * ── THE SECOND SKIP, FOUND WHILE FIXING THE FIRST ─────────────────────────
 *
 * The quiz page's "continue" resolved to the NEXT MODULE's first lesson —
 * correct for a module quiz taken at a module boundary. The production warm-up
 * sits on lesson 4 of 7, so routing there would have skipped lessons 5, 6 and
 * 7: a new skip bug in place of the old one. A lesson-scoped quiz now resolves
 * to the next lesson of its own module.
 *
 * Source assertions read comment-stripped code — the comments quote the very
 * patterns being asserted absent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { moduleQuizHref } from '@/lib/learn/routes'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const LESSON = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const QUIZ   = 'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx'
const ACTION = 'app/actions/quiz.ts'
const ASSESS = 'lib/learn/assessment.ts'

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A — discovery', () => {
  const src = () => stripJs(read(LESSON))

  it('1. lesson-scoped formative quizzes are discovered', () => {
    const s = src()
    expect(s).toMatch(/\.select\('id, lesson_id'\)/)
    expect(s).toMatch(/\.in\('lesson_id', lessonIds\)/)
    // Scoped to genuinely formative rows: a module quiz or a final exam must
    // not be picked up by this lookup.
    expect(s).toMatch(/\.is\('module_id', null\)/)
    expect(s).toMatch(/\.is\('course_id', null\)/)
  })

  it('2. module-scoped discovery is preserved unchanged', () => {
    const s = src()
    expect(s).toMatch(/\.select\('module_id'\)\.in\('module_id', modIds\)/)
    expect(s).toMatch(/setModulesWithQuiz\(gated\)/)
  })

  it('the two lookups stay separate — the gate set is not widened', () => {
    const s = src()
    // A lesson quiz must never be added to modulesWithQuiz; that set is the gate.
    const gateBlock = s.slice(s.indexOf('const gated = new Set'), s.indexOf('setModulesWithQuiz(gated)'))
    expect(gateBlock).not.toContain('lesson_id')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A — offer, not gate (Ruling 1)', () => {
  const src = () => stripJs(read(LESSON))

  it('3. auto-advance targets the quiz instead of the next lesson', () => {
    const s = src()
    expect(s).toMatch(/if \(lessonQuizId && !attemptedQuizzes\.has\(lessonQuizId\)\)/)
    expect(s).toMatch(/label: 'Faire le quiz'/)
  })

  it('4. the CTA/route is built through moduleQuizHref, never string-concatenated', () => {
    const s = src()
    const branch = s.slice(s.indexOf('if (lessonQuizId'))
    expect(branch.slice(0, 400)).toMatch(/moduleQuizHref\(courseSlug, module\)/)
    // UAT-ROUTE-01 invariant: no manufactured segments.
    expect(branch.slice(0, 400)).not.toMatch(/\$\{module\?\.id\}/)
  })

  it('6/7. the formative quiz is NOT part of the blocking condition', () => {
    const s = src()
    const line = s.split('\n').find(l => l.includes('const nextIsBlocked'))
    expect(line, 'nextIsBlocked must exist').toBeTruthy()
    expect(line).not.toContain('lessonQuiz')
    expect(line).not.toContain('attemptedQuizzes')
    // Its terms are exactly the pre-existing module-gate terms.
    expect(line).toContain('currentModHasQuiz')
    expect(line).toContain('currentModPassed')
  })

  it('the module gate is evaluated BEFORE the formative offer, so a gate is never bypassed', () => {
    const s = src()
    const gateAt  = s.indexOf("label: 'Quiz du module'")
    const offerAt = s.indexOf("label: 'Faire le quiz'")
    expect(gateAt).toBeGreaterThan(-1)
    expect(offerAt).toBeGreaterThan(gateAt)
  })

  it('8. requires_final_exam / certificate authority is untouched by this phase', () => {
    const s = src()
    expect(s).not.toContain('requires_final_exam')
    // The certificate contract lives in assessment.ts and is not edited here.
    const a = stripJs(read(ASSESS))
    expect(a).toMatch(/FINAL_EXAM_MAX_ATTEMPTS/)
    expect(a).toMatch(/requires_final_exam/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A — forward resolution and loop safety', () => {
  const q = () => stripJs(read(QUIZ))

  it('13. re-offering stops once the quiz has been attempted', () => {
    // This is what makes lesson -> quiz -> lesson terminate: after an attempt
    // (pass OR fail) the auto-advance target reverts to the next lesson.
    const s = stripJs(read(LESSON))
    expect(s).toMatch(/!attemptedQuizzes\.has\(lessonQuizId\)/)
    expect(s).toMatch(/setAttemptedQuizzes\(/)
    expect(s).toMatch(/\.select\('quiz_id'\)/)
  })

  it('a mid-module quiz continues to the NEXT LESSON, not the next module', () => {
    const s = q()
    expect(s).toMatch(/setNextInModule\(/)
    expect(s).toMatch(/curLessons\[at \+ 1\]\?\.id/)
    expect(s).toMatch(/const formativeNextHref = nextInModule/)
  })

  it('the forward link is shown pass OR fail — a formative quiz never traps', () => {
    const s = q()
    expect(s).toMatch(/isFormativeLessonQuiz && formativeNextHref/)
    // The module-quiz forward links stay gated on isPassed; the formative one
    // must NOT be, or a failing learner would have no way onward.
    const fwd = s.slice(s.indexOf('isFormativeLessonQuiz && formativeNextHref'))
    expect(fwd.slice(0, 260)).not.toMatch(/isPassed/)
  })

  it('"back" returns to the quiz’s own lesson, not the module’s last lesson', () => {
    const s = q()
    expect(s).toMatch(/const backHref = quizLessonId/)
  })

  it('the "you must reach X%" claim is not shown for a formative quiz', () => {
    const s = q()
    expect(s).toMatch(/\) : isFormativeLessonQuiz \? \(/)
    const idx = s.indexOf('isFormativeLessonQuiz ? (')
    const pass = s.indexOf('pour passer au module suivant')
    expect(idx).toBeGreaterThan(-1)
    expect(pass).toBeGreaterThan(idx)   // the strict message is the later branch
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A — rendering and security invariants', () => {
  it('5. the quiz page renders questions with their response options', () => {
    const s = stripJs(read(QUIZ))
    expect(s).toMatch(/buildDisplayOptions/)
    expect(s).toMatch(/\.select\('id, question, options, order_index, question_type, question_image_url'\)/)
  })

  it('12. no answer key is selected client-side', () => {
    const s = stripJs(read(QUIZ))
    for (const key of ['correct_answer', 'drag_match_answers', 'explanation'])
      expect(s, `quiz page selects ${key}`).not.toMatch(new RegExp(`select\\([^)]*${key}`))
  })

  it('the grader remains the sole authority, with the entitlement seam intact', () => {
    const s = stripJs(read(ACTION))
    expect(s).toMatch(/resolveCourseAccessById\(context\.courseId\)/)
    expect(s).toMatch(/createAdminClient\(\)/)
    expect(s).toMatch(/FINAL_EXAM_MAX_ATTEMPTS/)
  })

  it('9/10. neither navigation file became an access authority', () => {
    for (const f of [LESSON, QUIZ]) {
      const s = stripJs(read(f))
      // Access is resolved by the entitlement seam server-side, never here.
      expect(s, `${f} must not grant access`).not.toMatch(/createAdminClient/)
      expect(s, `${f} must not read entitlements directly`).not.toMatch(/from\('entitlements'\)/)
    }
  })

  it('11. the quiz page only reaches courses that are published', () => {
    const s = stripJs(read(QUIZ))
    expect(s).toMatch(/from\('courses'\)/)
    // A withdrawn course cannot be resolved, so its quiz is unreachable.
    expect(s).toMatch(/router\.push\('\/courses'\)/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('QUIZ-1A — route construction (real behaviour)', () => {
  it('moduleQuizHref builds a valid quiz route', () => {
    expect(moduleQuizHref('c1-f1', { id: 'mod-1' })).toBe('/learn/c1-f1/mod-1/quiz')
  })

  it('and refuses to manufacture one from an unresolved module', () => {
    expect(moduleQuizHref('c1-f1', null)).toBeNull()
    expect(moduleQuizHref('c1-f1', { id: '' })).toBeNull()
  })
})
