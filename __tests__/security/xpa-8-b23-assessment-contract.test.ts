// @vitest-environment node
/**
 * XPA-8 B-2.3A — the assessment contract.
 *
 * ── WHAT THIS PHASE SETTLED ───────────────────────────────────────────────
 *
 * B-2.3's audit found the machinery built and the assessments absent. B-2.3A
 * adds the contract without authoring a single question:
 *
 *   * a certificate needs every required lesson, plus a passing final exam
 *     ONLY when the course sets `requires_final_exam`;
 *   * a final exam is a COURSE-scoped quiz — structural, server-derived;
 *   * final exams withhold answer-key material and allow three attempts;
 *   * formative quizzes keep full feedback and gate nothing;
 *   * `PLATFORM_MODE` has zero authority over any of it.
 *
 * ── WHY THIS SUITE EXECUTES THE CODE ──────────────────────────────────────
 *
 * A source match proves a line exists, not that it decides anything. The
 * matrices below run the real resolver and the real scoring action against a
 * mocked database, and assert on what came back and what got written. The
 * database half — direct PostgREST after migration 046 — is proved against
 * production by `scripts/security/verify-xpa-8-b23.mjs`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
const stripSql = (s: string) => s.replace(/--[^\n]*/g, blank)

vi.mock('server-only', () => ({}))

const COURSE  = '11111111-1111-4111-8111-111111111111'
const OTHER   = '22222222-2222-4222-8222-222222222222'
const EXAM    = '33333333-3333-4333-8333-333333333333'
const FORM    = '44444444-4444-4444-8444-444444444444'
const LEARNER = '55555555-5555-4555-8555-555555555555'
const Q1      = '66666666-6666-4666-8666-666666666666'
const LESSON  = '77777777-7777-4777-8777-777777777777'

interface Res { data: unknown; error: unknown }

const state: {
  quiz: Res
  rpcCourse: Res
  courseRow: Res
  modules: Res
  progressCount: { count: number | null; error: unknown }
  attemptCount:  { count: number | null; error: unknown }
  examRow: Res
  passRow: Res
  questions: Res
  access: { allowed: boolean; reason?: string; userId?: string }
  inserts: Array<{ table: string; payload: Record<string, unknown> }>
  tables: string[]
} = {
  quiz:          { data: null, error: null },
  rpcCourse:     { data: null, error: null },
  courseRow:     { data: { requires_final_exam: false }, error: null },
  modules:       { data: [{ id: 'm1', lessons: [{ id: LESSON }] }], error: null },
  progressCount: { count: 1, error: null },
  attemptCount:  { count: 0, error: null },
  examRow:       { data: null, error: null },
  passRow:       { data: null, error: null },
  questions:     { data: [], error: null },
  access:        { allowed: true, userId: LEARNER },
  inserts:       [],
  tables:        [],
}

/**
 * A chainable stub shaped like the slice of postgrest-js these modules touch.
 *
 * `quizzes` and `quiz_attempts` are each queried in more than one shape, so the
 * stub distinguishes them by the terminal call: a head+count select is the
 * attempt tally, `maybeSingle` after `.eq('passed', true)` is the pass lookup.
 */
const makeFrom = (table: string) => {
  state.tables.push(table)
  let head = false
  let passFilter = false
  const chain: Record<string, unknown> = {}
  chain.select = (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) head = true; return chain }
  chain.eq = (col: string, val: unknown) => { if (col === 'passed' && val === true) passFilter = true; return chain }
  chain.in = () => chain
  chain.limit = () => chain
  chain.order = () => chain
  chain.maybeSingle = async () => {
    if (table === 'quizzes')  return passFilter ? state.examRow : (state.examLookup ? state.examRow : state.quiz)
    if (table === 'courses')  return state.courseRow
    if (table === 'quiz_attempts') return state.passRow
    return { data: null, error: null }
  }
  chain.insert = async (payload: Record<string, unknown>) => {
    state.inserts.push({ table, payload })
    return { error: null }
  }
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
    let out: unknown
    if (head) out = table === 'lesson_progress' ? state.progressCount : state.attemptCount
    else if (table === 'modules')        out = state.modules
    else if (table === 'quiz_questions') out = state.questions
    else out = { data: [], error: null }
    return Promise.resolve(out).then(res, rej)
  }
  return chain
}
// `quizzes` is read twice with maybeSingle — once for the quiz, once for the
// course's exam. A flag switches which row the stub serves.
;(state as Record<string, unknown>).examLookup = false

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => makeFrom(t),
    rpc:  async () => state.rpcCourse,
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: LEARNER, email: 'l@x.test' } } }) },
  }),
}))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => state.access,
}))

const {
  resolveQuizContext,
  resolveCertificateEligibility,
  courseRequiresFinalExam,
  FINAL_EXAM_MAX_ATTEMPTS,
} = await import('@/lib/learn/assessment')
const { submitQuizAnswers } = await import('@/app/actions/quiz')

const examQuiz = { id: EXAM, course_id: COURSE, module_id: null, lesson_id: null, passing_score: 80 }
const formQuiz = { id: FORM, course_id: null, module_id: null, lesson_id: LESSON, passing_score: 70 }

beforeEach(() => {
  state.quiz          = { data: examQuiz, error: null }
  state.rpcCourse     = { data: COURSE, error: null }
  state.courseRow     = { data: { requires_final_exam: false }, error: null }
  state.modules       = { data: [{ id: 'm1', lessons: [{ id: LESSON }] }], error: null }
  state.progressCount = { count: 1, error: null }
  state.attemptCount  = { count: 0, error: null }
  state.examRow       = { data: null, error: null }
  state.passRow       = { data: null, error: null }
  state.questions     = { data: [{ id: Q1, question_type: 'multiple_choice', correct_answer: 2, drag_match_answers: null, explanation: 'Parce que…' }], error: null }
  state.access        = { allowed: true, userId: LEARNER }
  state.inserts       = []
  state.tables        = []
  ;(state as Record<string, unknown>).examLookup = false
})

// ═══════════════════════════════════════════════════════════════════════════
// FINAL EXAM VERSUS FORMATIVE — the structural distinction
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — a final exam is a COURSE-scoped quiz', () => {
  it('course-scoped resolves as final_exam', async () => {
    state.quiz = { data: examQuiz, error: null }
    const { context } = await resolveQuizContext(EXAM)
    expect(context?.kind).toBe('final_exam')
    expect(context?.courseId).toBe(COURSE)
  })

  it('lesson-scoped resolves as formative — C1-F1\'s warm-up', async () => {
    state.quiz = { data: formQuiz, error: null }
    const { context } = await resolveQuizContext(FORM)
    expect(context?.kind).toBe('formative')
  })

  it('module-scoped resolves as formative', async () => {
    state.quiz = { data: { ...formQuiz, lesson_id: null, module_id: 'm1' }, error: null }
    expect((await resolveQuizContext(FORM)).context?.kind).toBe('formative')
  })

  it('the kind is never taken from the caller', () => {
    const src = stripJs(read('lib/learn/assessment.ts'))
    expect(src).toMatch(/quiz\.course_id \? 'final_exam' : 'formative'/)
    expect(src).not.toMatch(/function resolveQuizContext\([^)]*kind/)
  })

  it('a lookup FAILURE is distinguished from a missing quiz', async () => {
    state.quiz = { data: null, error: { message: 'timeout' } }
    const r = await resolveQuizContext(EXAM)
    expect(r.failed).toBe(true)
    expect(r.context).toBeNull()
  })

  it('an orphaned quiz resolves to nothing rather than a wrong course', async () => {
    state.quiz = { data: { ...formQuiz }, error: null }
    state.rpcCourse = { data: null, error: null }
    const r = await resolveQuizContext(FORM)
    expect(r.context).toBeNull()
    expect(r.failed).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ENTITLEMENT — the A–F matrix at the application boundary
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — submission requires current course access', () => {
  const CASES = [
    { id: 'A', label: 'entitlement + enrollment',   access: { allowed: true,  userId: LEARNER }, allow: true },
    { id: 'B', label: 'entitlement, no enrollment', access: { allowed: true,  userId: LEARNER }, allow: true },
    { id: 'C', label: 'enrollment only',            access: { allowed: false, reason: 'not_entitled' }, allow: false },
    { id: 'D', label: 'expired entitlement',        access: { allowed: false, reason: 'access_ended' }, allow: false },
    { id: 'E', label: 'revoked entitlement',        access: { allowed: false, reason: 'access_ended' }, allow: false },
    { id: 'F', label: 'neither',                    access: { allowed: false, reason: 'not_entitled' }, allow: false },
  ] as const

  for (const c of CASES) {
    it(`${c.id} — ${c.label} → ${c.allow ? 'ALLOWED' : 'DENIED'}`, async () => {
      state.access = { ...c.access }
      const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })

      if (c.allow) {
        expect(r.error).toBeUndefined()
        expect(state.inserts.filter(i => i.table === 'quiz_attempts')).toHaveLength(1)
      } else {
        expect(r.error).toBeDefined()
        expect(state.inserts, 'an attempt was recorded anyway').toHaveLength(0)
      }
    })
  }

  it('the recorded user_id comes from the access seam, never from input', async () => {
    await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })
    expect(state.inserts[0].payload).toMatchObject({ user_id: LEARNER, quiz_id: EXAM })
  })

  it('the course is resolved from the QUIZ, so a cross-course claim cannot widen access', () => {
    const src = stripJs(read('app/actions/quiz.ts'))
    expect(src).toMatch(/resolveCourseAccessById\(context\.courseId\)/)
    // moduleId is caller-supplied and must never be the authorization key.
    expect(src).not.toMatch(/resolveCourseAccessById\(moduleId/)
  })

  it('enrollment is never consulted — a transcript is not a key (Q-L)', async () => {
    await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })
    expect(state.tables).not.toContain('enrollments')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// FEEDBACK — the XPA-6D harvest-and-retry residual
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — final exams reveal no answer-key material', () => {
  it('a final exam returns the outcome and nothing replayable', async () => {
    const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 0 } })
    expect(r.restrictedFeedback).toBe(true)
    expect(r.score).toBeTypeOf('number')
    expect(r.passed).toBeTypeOf('boolean')
    expect(r.correctAnswers).toBeUndefined()
    expect(r.multipleAnswerCorrect).toBeUndefined()
    expect(r.dragMatchAnswers).toBeUndefined()
    expect(r.explanations).toBeUndefined()
  })

  it('not even a wrong answer leaks the right one', async () => {
    const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 0 } })
    expect(JSON.stringify(r)).not.toContain('Parce que')
    expect(r.passed).toBe(false)
  })

  it('a FORMATIVE quiz keeps its full pedagogical feedback', async () => {
    state.quiz = { data: formQuiz, error: null }
    const r = await submitQuizAnswers({ quizId: FORM, moduleId: null, answers: { [Q1]: 0 } })
    expect(r.restrictedFeedback).toBe(false)
    expect(r.correctAnswers).toEqual({ [Q1]: 2 })
    expect(r.explanations).toEqual({ [Q1]: 'Parce que…' })
  })

  it('the restriction is keyed on the KIND, not on a caller-supplied flag', () => {
    const src = stripJs(read('app/actions/quiz.ts'))
    expect(src).toMatch(/const isFinalExam = context\.kind === 'final_exam'/)
    expect(src).toMatch(/if \(isFinalExam\) \{[\s\S]{0,400}?restrictedFeedback: true/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — three attempts on a final exam', () => {
  it('the ratified budget is 3', () => {
    expect(FINAL_EXAM_MAX_ATTEMPTS).toBe(3)
  })

  for (const used of [0, 1, 2]) {
    it(`attempt ${used + 1} of 3 is accepted`, async () => {
      state.attemptCount = { count: used, error: null }
      const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })
      expect(r.error).toBeUndefined()
      expect(r.attemptsUsed).toBe(used + 1)
      expect(r.attemptsRemaining).toBe(2 - used)
      expect(state.inserts).toHaveLength(1)
    })
  }

  it('attempt 4 is REFUSED and records nothing', async () => {
    state.attemptCount = { count: 3, error: null }
    const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })
    expect(r.error).toBeDefined()
    expect(r.attemptsRemaining).toBe(0)
    expect(state.inserts, 'a fourth attempt was recorded').toHaveLength(0)
  })

  it('a formative quiz has NO budget — a warm-up is not rationed', async () => {
    state.quiz = { data: formQuiz, error: null }
    state.attemptCount = { count: 99, error: null }
    const r = await submitQuizAnswers({ quizId: FORM, moduleId: null, answers: { [Q1]: 2 } })
    expect(r.error).toBeUndefined()
    expect(r.attemptsRemaining).toBeUndefined()
    expect(state.inserts).toHaveLength(1)
  })

  it('a failed attempt count read refuses rather than granting a free attempt', async () => {
    state.attemptCount = { count: null, error: { message: 'boom' } }
    const r = await submitQuizAnswers({ quizId: EXAM, moduleId: null, answers: { [Q1]: 2 } })
    expect(r.error).toBeDefined()
    expect(state.inserts).toHaveLength(0)
  })

  it('no automatic reset or fourth-attempt escape hatch was invented', () => {
    const src = stripJs(read('lib/learn/assessment.ts')) + stripJs(read('app/actions/quiz.ts'))
    expect(src).not.toMatch(/reset|cooldown|bonusAttempt|extraAttempt/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CERTIFICATE ELIGIBILITY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — certificate eligibility', () => {
  it('incomplete lessons → refused', async () => {
    state.progressCount = { count: 0, error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('lessons_incomplete')
  })

  it('a course with no lessons cannot be certified', async () => {
    state.modules = { data: [], error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('lessons_incomplete')
    expect(e.totalLessons).toBe(0)
  })

  it('requires_final_exam = false → lessons alone certify (today\'s contract)', async () => {
    state.courseRow = { data: { requires_final_exam: false }, error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(true)
  })

  it('requires_final_exam = true with NO exam → FAILS CLOSED', async () => {
    state.courseRow = { data: { requires_final_exam: true }, error: null }
    ;(state as Record<string, unknown>).examLookup = true
    state.examRow = { data: null, error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible, 'a misconfigured flag minted a certificate').toBe(false)
    expect(e.reason).toBe('final_exam_missing')
  })

  it('exam present, not passed → refused, and points at the exam', async () => {
    state.courseRow = { data: { requires_final_exam: true }, error: null }
    ;(state as Record<string, unknown>).examLookup = true
    state.examRow = { data: { id: EXAM }, error: null }
    state.passRow = { data: null, error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('final_exam_not_passed')
    expect(e.examQuizId).toBe(EXAM)
  })

  it('exam present and passed, lessons complete → eligible', async () => {
    state.courseRow = { data: { requires_final_exam: true }, error: null }
    ;(state as Record<string, unknown>).examLookup = true
    state.examRow = { data: { id: EXAM }, error: null }
    state.passRow = { data: { id: 'attempt-1' }, error: null }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(true)
  })

  it('a pass endures — best passing result, never revoked by a later failure', () => {
    // The lookup asks only whether ANY passed attempt exists; it never reads
    // the most recent one.
    const src = stripJs(read('lib/learn/assessment.ts'))
    const body = src.slice(src.indexOf('export async function resolveCertificateEligibility'))
    expect(body).toMatch(/\.eq\('passed', true\)/)
    expect(body).not.toMatch(/order\(['"]created_at/)
  })

  it('a lookup failure refuses rather than certifying', async () => {
    state.progressCount = { count: null, error: { message: 'boom' } }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('lookup_failed')
  })

  it('access is NOT decided here — the caller asks the seam first', () => {
    const src = stripJs(read('lib/learn/assessment.ts'))
    const body = src.slice(src.indexOf('export async function resolveCertificateEligibility'))
    expect(body).not.toMatch(/resolveCourseAccess/)
    expect(stripJs(read('app/(platform)/certificate/[courseSlug]/page.tsx')))
      .toMatch(/resolveCourseAccess\(courseSlug\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE MISSING COLUMN, BEFORE MIGRATION 047
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — the flag column may not exist yet', () => {
  it('42703 (undefined_column) reads as false — the pre-B-2.3 contract', async () => {
    state.courseRow = { data: null, error: { code: '42703', message: 'column does not exist' } }
    expect(await courseRequiresFinalExam(COURSE)).toBe(false)
  })

  it('…so eligibility still works before 047 is applied', async () => {
    state.courseRow = { data: null, error: { code: '42703', message: 'column does not exist' } }
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(true)
  })

  it('any OTHER error fails CLOSED', async () => {
    state.courseRow = { data: null, error: { code: '08006', message: 'connection failure' } }
    expect(await courseRequiresFinalExam(COURSE)).toBeNull()
    const e = await resolveCertificateEligibility(LEARNER, COURSE)
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('lookup_failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM_MODE IS NOT AN ACADEMIC AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — the operating mode decides nothing academic', () => {
  it('no assessment module consults the mode', () => {
    for (const f of ['lib/learn/assessment.ts', 'app/actions/quiz.ts']) {
      expect(stripJs(read(f)), `${f} consults the operating mode`)
        .not.toMatch(/PILOT_MODE|PLATFORM_MODE/)
    }
  })

  it('the certificate gate no longer wraps its checks in !PILOT_MODE', () => {
    const s = stripJs(read('app/(platform)/certificate/[courseSlug]/page.tsx'))
    expect(s).not.toMatch(/if \(!PILOT_MODE\)/)
    expect(s).toMatch(/resolveCertificateEligibility/)
  })

  it('the final-exam page reads a learner\'s pass in EVERY mode', () => {
    const s = stripJs(read('app/(learn)/learn/[courseSlug]/final-exam/page.tsx'))
    expect(s).not.toMatch(/PILOT_MODE/)
    expect(s).toMatch(/\.eq\('passed', true\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE WARM-UP GATES NOTHING
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — a lesson-scoped quiz gates nothing', () => {
  const PLAYER = stripJs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))

  it('only MODULE-scoped quizzes contribute to the module gate', () => {
    expect(PLAYER).toMatch(/from\('quizzes'\)\.select\('module_id'\)\.in\('module_id', modIds\)/)
    // The retired lesson-scoped arm must not creep back.
    expect(PLAYER, 'lesson-scoped quizzes gate modules again')
      .not.toMatch(/select\('lesson_id'\)[\s\S]{0,200}?modulesWithQuiz/)
    expect(PLAYER).not.toMatch(/lessonIdSet/)
  })

  it('module-quiz infrastructure is preserved, not deleted', () => {
    expect(PLAYER).toMatch(/modulesWithQuiz/)
    expect(PLAYER).toMatch(/currentModHasQuiz/)
  })

  it('certification does not depend on module quizzes at all', () => {
    const src  = stripJs(read('lib/learn/assessment.ts'))
    const body = src.slice(src.indexOf('export async function resolveCertificateEligibility'))
    expect(body).not.toMatch(/module_id/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATIONS — SHAPE ONLY; APPLICATION IS THE OPERATOR'S
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 B-2.3A — there is deliberately NO migration 046', () => {
  // ── THE CORRECTION ────────────────────────────────────────────────────────
  //
  // B-2.3A was scoped to include a 046 splitting `quiz_attempts` RLS the way
  // 044 split `lesson_progress`. It was written and then WITHDRAWN, because the
  // premise was false: the B-2.3 audit read migration 001's `attempts_own FOR
  // ALL` and reported it as live, without checking whether a later migration
  // superseded it. Migration 011 did, and nothing has since.
  //
  // 011 is STRICTER than the proposed 046. Replacing `WITH CHECK (false)` with
  // `user_id = auth.uid() AND has_course_access(...)` would have newly PERMITTED
  // an entitled learner to POST a fabricated passing attempt straight to
  // PostgREST — a regression dressed as a hardening.
  it('the file does not exist', () => {
    expect(existsSync(join(ROOT, 'supabase/migrations/046_quiz_attempts_access_boundary.sql')))
      .toBe(false)
  })

  it('011 already closed the direct-INSERT path, and is not superseded', () => {
    const m011 = stripSql(read('supabase/migrations/011_security_fixes.sql'))
    expect(m011).toMatch(/drop policy if exists "attempts_own"\s+on quiz_attempts/i)
    expect(m011).toMatch(/create policy "attempts_insert_service"[\s\S]{0,120}?with check \(false\)/i)
    expect(m011).toMatch(/create policy "attempts_select_own"/i)

    // No migration after 011 may reopen it.
    const later = readdirSync(join(ROOT, 'supabase/migrations'))
      .filter(f => /^\d+/.test(f) && parseInt(f, 10) > 11 && f.endsWith('.sql'))
      .map(f => stripSql(read(`supabase/migrations/${f}`)))
      .join('\n')
    expect(later, 'a later migration re-created a writable attempts policy')
      .not.toMatch(/create policy\s+"attempts_/i)
  })

  it('the withdrawal and its reason are recorded where the next reader looks', () => {
    const m047 = read('supabase/migrations/047_courses_requires_final_exam.sql')
    expect(m047).toMatch(/WHY THERE IS NO MIGRATION 046/)
    expect(m047).toMatch(/security regression dressed as a hardening/)
    expect(m047).toMatch(/Migration 011 already replaced it/)
  })

  it('the genuinely open half — the ACTION — is what B-2.3A fixed', () => {
    // The service role bypasses RLS, so `submitQuizAnswers` was the only gate
    // on who may record an attempt, and it had none.
    expect(stripJs(read('app/actions/quiz.ts')))
      .toMatch(/resolveCourseAccessById\(context\.courseId\)/)
  })
})

describe('XPA-8 B-2.3A — migration 047 adds the flag', () => {
  const M = read('supabase/migrations/047_courses_requires_final_exam.sql')

  it('is additive, NOT NULL, default false', () => {
    expect(stripSql(M)).toMatch(/add column if not exists requires_final_exam boolean not null default false/)
  })

  it('asserts it enabled nothing', () => {
    expect(M).toMatch(/must change no behaviour/)
    expect(M).toMatch(/where requires_final_exam/)
  })

  it('records why B-2.3A ships no 046', () => {
    expect(M).toMatch(/WHY THERE IS NO MIGRATION 046/)
    expect(M).toMatch(/ONLY migration B-2.3A ships/)
  })

  it('records that no course may be flipped in this phase', () => {
    expect(M).toMatch(/NOT flipped for any course|Do NOT flip the flag/i)
  })
})
