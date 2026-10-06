// @vitest-environment node
/**
 * UAT-FINAL-EXAM-SUBMIT-01 — a final exam could not be submitted.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * A learner opened a final exam, answered every question, pressed "Vérifier mes
 * réponses" and received "Données invalides." — on every final exam.
 *
 * `submitQuizAnswers` validated drag_match placement ids as UUIDs:
 *
 *   const DMAnswerSchema = z.record(z.string().uuid(), z.string().uuid())
 *
 * But the two admin builders disagreed on the format. `NewQuizForm` minted
 * `Math.random().toString(36).slice(2)` — "8o0moanogal" — while `EditQuizForm`
 * minted `crypto.randomUUID()`. All 20 drag_match questions in production were
 * authored through the former.
 *
 * Zod validates the WHOLE object, so one such id rejected an otherwise perfect
 * 20-question submission before the action reached the authority check, the
 * attempt budget or scoring. Every final exam in production contained at least
 * one drag_match question; every module quiz was pure multiple_choice. That is
 * exactly the blast radius the learner reported, and it is a property of the
 * CONTENT, not of the exam mechanism.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────
 *
 * The fixture below is the REAL placement map from a live production question,
 * so these tests fail against the old schema and pass against the fix. The
 * relaxation is bounded: charset and length are still constrained, and the
 * final two describes prove that a placement id the server does not recognise
 * scores as incorrect rather than being trusted — scoring iterates the
 * server-side answer key, never the learner's payload.
 *
 * Nothing else is relaxed: quiz and question ids stay UUID-only, option indices
 * stay bounded, and a validation failure still costs no attempt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const QUIZ    = '11111111-1111-4111-8111-111111111111'
const MODULE  = '99999999-9999-4999-8999-999999999999'
const Q_MC    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q_TF    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const Q_MA    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const Q_DM    = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** VERBATIM from production `quiz_questions.options` on a live final exam. */
const PRODUCTION_PLACEMENTS = {
  '8o0moanogal': 'ysdi104x4c',
  '8r6c1kp0prl': '40tqjspz5ry',
  '07kkses75but': '1y7o9htzuub',
}
const UUID_PLACEMENTS = {
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
}

/**
 * The live schema, rebuilt from the action's own source text.
 *
 * Re-declaring it would let this suite pass while the real one stayed broken.
 * Instead the three answer schemas and SubmitSchema are extracted from
 * `app/actions/quiz.ts` and evaluated, so the assertions run against the
 * shipped definition.
 */
function liveSubmitSchema() {
  const src = read('app/actions/quiz.ts')
  const slice = (from: string, to: string) => {
    const i = src.indexOf(from)
    const j = src.indexOf(to, i)
    expect(i, `anchor not found: ${from}`).toBeGreaterThan(-1)
    expect(j, `end anchor not found: ${to}`).toBeGreaterThan(i)
    return src.slice(i, j)
  }
  const defs = slice('const MCAnswerSchema', 'export interface QuizSubmitResult')
    // Strip comments so a doc block cannot satisfy the evaluation.
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const body = `${defs}\nreturn SubmitSchema`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('z', 'UuidSchema', body) as (
    zod: typeof z, uuid: z.ZodTypeAny,
  ) => z.ZodTypeAny
  return factory(z, z.string().uuid())
}

const SubmitSchema = liveSubmitSchema()
const parse = (payload: unknown) => SubmitSchema.safeParse(payload)
const exam = (answers: Record<string, unknown>) => ({ quizId: QUIZ, moduleId: null, answers })

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-FINAL-EXAM-SUBMIT-01 — the production payload is accepted', () => {
  it('A. THE REGRESSION: historical base-36 drag_match ids are accepted', () => {
    const r = parse(exam({ [Q_DM]: PRODUCTION_PLACEMENTS }))
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true)
  })

  it('B. uuid drag_match ids are accepted — the edit builder must not break', () => {
    expect(parse(exam({ [Q_DM]: UUID_PLACEMENTS })).success).toBe(true)
  })

  it('C. a complete final exam of all four answered types passes as a whole', () => {
    const r = parse(exam({
      [Q_MC]: 2,
      [Q_TF]: 0,
      [Q_MA]: [1, 3],
      [Q_DM]: PRODUCTION_PLACEMENTS,
    }))
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true)
  })

  it('C2. a module quiz (uuid moduleId, multiple_choice only) still passes', () => {
    expect(SubmitSchema.safeParse({ quizId: QUIZ, moduleId: MODULE, answers: { [Q_MC]: 2 } }).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-FINAL-EXAM-SUBMIT-01 — the relaxation stays bounded', () => {
  it('D. malformed drag ids are still rejected', () => {
    const bad: [string, unknown][] = [
      ['empty key',            { '': 'ysdi104x4c' }],
      ['empty value',          { '8o0moanogal': '' }],
      ['key over 64 chars',    { ['a'.repeat(65)]: 'ysdi104x4c' }],
      ['value over 64 chars',  { '8o0moanogal': 'a'.repeat(65) }],
      ['path traversal',       { '../../etc/passwd': 'ysdi104x4c' }],
      ['forward slash',        { 'a/b': 'ysdi104x4c' }],
      ['dot',                  { 'a.b': 'ysdi104x4c' }],
      ['space',                { 'a b': 'ysdi104x4c' }],
      ['newline',              { 'a\nb': 'ysdi104x4c' }],
      ['null byte',            { 'a\u0000b': 'ysdi104x4c' }],
      ['angle brackets',       { '<script>': 'ysdi104x4c' }],
      ['percent encoding',     { 'a%2Fb': 'ysdi104x4c' }],
      ['quote',               { "a'b": 'ysdi104x4c' }],
    ]
    for (const [label, placements] of bad) {
      expect(parse(exam({ [Q_DM]: placements })).success, `accepted ${label}`).toBe(false)
    }
  })

  it('D2. the id schema is bounded in length and charset, not a bare string', () => {
    const src = read('app/actions/quiz.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(src, 'the drag id schema must constrain length').toMatch(/\.min\(1\)[\s\S]{0,40}\.max\(64\)/)
    expect(src, 'the drag id schema must constrain charset').toMatch(/regex\(\/\^\[A-Za-z0-9_-\]\+\$\/\)/)
    expect(src, 'a bare z.string() would accept anything')
      .not.toMatch(/DMAnswerSchema\s*=\s*z\.record\(z\.string\(\)\s*,/)
  })

  it('E. question and quiz ids remain UUID-only', () => {
    expect(parse(exam({ 'not-a-uuid': 2 })).success, 'non-uuid question id accepted').toBe(false)
    expect(parse(exam({ '8o0moanogal': 2 })).success, 'base-36 question id accepted').toBe(false)
    expect(SubmitSchema.safeParse({ quizId: 'nope', moduleId: null, answers: { [Q_MC]: 2 } }).success).toBe(false)
    expect(SubmitSchema.safeParse({ quizId: QUIZ, moduleId: 'nope', answers: { [Q_MC]: 2 } }).success).toBe(false)
    // moduleId is a required union of uuid|null — undefined is not null.
    expect(SubmitSchema.safeParse({ quizId: QUIZ, answers: { [Q_MC]: 2 } }).success).toBe(false)
  })

  it('F. option-index bounds remain enforced', () => {
    for (const v of [-1, 11, 1.5, Number.NaN, '2', true, null]) {
      expect(parse(exam({ [Q_MC]: v })).success, `accepted single answer ${String(v)}`).toBe(false)
    }
    for (const v of [[-1], [11], [1.5], ['2'], [null]]) {
      expect(parse(exam({ [Q_MA]: v })).success, `accepted multi answer ${JSON.stringify(v)}`).toBe(false)
    }
    expect(parse(exam({ [Q_MC]: 0 })).success).toBe(true)
    expect(parse(exam({ [Q_MC]: 10 })).success).toBe(true)
    expect(parse(exam({ [Q_MA]: [0, 10] })).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('UAT-FINAL-EXAM-SUBMIT-01 — the authoring contract is one format', () => {
  const NEW  = 'app/(admin)/admin/quizzes/new/NewQuizForm.tsx'
  const EDIT = 'app/(admin)/admin/quizzes/[id]/edit/EditQuizForm.tsx'
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('H. both quiz builders mint identifiers with crypto.randomUUID()', () => {
    for (const f of [NEW, EDIT]) {
      const src = strip(read(f))
      expect(src, `${f} does not use crypto.randomUUID()`).toMatch(/crypto\.randomUUID\(\)/)
      expect(src, `${f} still mints ids with Math.random()`)
        .not.toMatch(/Math\.random\(\)[\s\S]{0,40}toString\(36\)/)
    }
  })

  it('I. no identifier is minted during render or inside a state updater', () => {
    for (const f of [NEW, EDIT]) {
      const src = strip(read(f))
      // A generator inside `setX(prev => …)` is called by a function React may
      // invoke twice; one inside a useState initialiser or the render body
      // differs between the SSR pass and the hydration pass — the defect class
      // of UAT-EXERCISE-CATEGORY-FK-01.
      for (const m of src.matchAll(/set[A-Z]\w*\(\s*(?:prev|\w+)\s*=>/g)) {
        // Balanced-brace scan: a fixed character window runs past the end of
        // the updater and flags generators in the NEXT function.
        const open = src.indexOf('{', m.index!)
        if (open < 0) continue
        let depth = 0, end = open
        for (let i = open; i < src.length; i++) {
          if (src[i] === '{') depth++
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
        }
        const body = src.slice(open, end + 1)
        expect(body, `${f}: identifier minted inside a state updater`)
          .not.toMatch(/crypto\.randomUUID\(\)|genId\(\)/)
      }
      expect(src, `${f}: non-lazy useState initialiser minting ids`)
        .not.toMatch(/useState[^(]*\(\s*\[?\s*\{[^}]*(crypto\.randomUUID|genId)\(\)/)
    }
    // The first question's id comes from useId(), which React guarantees is
    // identical on the server and the client.
    expect(strip(read(NEW))).toMatch(/const initId = useId\(\)/)
    expect(strip(read(NEW))).toMatch(/useState<QuestionDraft\[\]>\(\(\) =>/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Behavioural: the attempt budget, and what an unknown placement scores.
// ═══════════════════════════════════════════════════════════════════════════
const inserted: { table: string; row: Record<string, unknown> }[] = []
let questionRows: Record<string, unknown>[] = []
let attemptCount = 0

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => ({ allowed: true, userId: '00000000-0000-4000-8000-000000000001', courseId: 'c1' }),
}))
vi.mock('@/lib/learn/assessment', () => ({
  FINAL_EXAM_MAX_ATTEMPTS: 3,
  resolveQuizContext: async () => ({
    context: { quizId: QUIZ, courseId: 'c1', kind: 'final_exam', passingScore: 80 },
    failed: false,
  }),
  countAttempts: async () => attemptCount,
  courseRequiresFinalExam: async () => true,
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'is']) chain[m] = () => chain
      chain.insert = async (row: Record<string, unknown>) => {
        inserted.push({ table, row })
        return { error: null }
      }
      // Attempt-budget read, then the scoring read.
      if (table === 'quiz_attempts') {
        chain.select = () => ({
          eq: () => ({ eq: async () => ({ count: attemptCount, data: [], error: null }) }),
          ...chain,
        })
        ;(chain as { then?: unknown }).then = (res: (v: unknown) => void) =>
          res({ data: [], count: attemptCount, error: null })
      }
      if (table === 'quiz_questions') {
        ;(chain as { then?: unknown }).then = (res: (v: unknown) => void) =>
          res({ data: questionRows, error: null })
      }
      return chain
    },
  }),
}))

describe('UAT-FINAL-EXAM-SUBMIT-01 — attempt budget and scoring', () => {
  beforeEach(() => {
    inserted.length = 0
    attemptCount = 0
    questionRows = [{
      id: Q_DM,
      question_type: 'drag_match',
      correct_answer: null,
      drag_match_answers: PRODUCTION_PLACEMENTS,
      explanation: null,
    }]
    vi.resetModules()
  })

  it('G1. an unknown placement id cannot score correct, and does not throw', async () => {
    const { submitQuizAnswers } = await import('@/app/actions/quiz')
    const r = await submitQuizAnswers({
      quizId: QUIZ,
      moduleId: null,
      // Valid shape, ids the server's answer key does not contain.
      answers: { [Q_DM]: { 'unknownitem': 'unknowncat' } },
    })
    expect(r.error, 'a well-formed but wrong payload must not error').toBeUndefined()
    expect(r.correctCount, 'an unknown placement scored as correct').toBe(0)
    expect(r.passed).toBe(false)
  })

  it('G2. the correct production placements score correct', async () => {
    const { submitQuizAnswers } = await import('@/app/actions/quiz')
    const r = await submitQuizAnswers({
      quizId: QUIZ, moduleId: null, answers: { [Q_DM]: PRODUCTION_PLACEMENTS },
    })
    expect(r.error).toBeUndefined()
    expect(r.correctCount).toBe(1)
  })

  it('5a. a VALIDATION rejection consumes no attempt — nothing is persisted', async () => {
    const { submitQuizAnswers } = await import('@/app/actions/quiz')
    const r = await submitQuizAnswers({
      quizId: QUIZ, moduleId: null,
      answers: { [Q_DM]: { 'a/b': 'ysdi104x4c' } } as never,
    })
    expect(r.error).toBe('Données invalides.')
    expect(inserted.filter(i => i.table === 'quiz_attempts'),
      'a rejected submission recorded an attempt').toHaveLength(0)
  })

  it('5b. a valid submission records EXACTLY ONE attempt', async () => {
    const { submitQuizAnswers } = await import('@/app/actions/quiz')
    await submitQuizAnswers({ quizId: QUIZ, moduleId: null, answers: { [Q_DM]: PRODUCTION_PLACEMENTS } })
    const attempts = inserted.filter(i => i.table === 'quiz_attempts')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].row.quiz_id).toBe(QUIZ)
    expect(attempts[0].row.module_id).toBeNull()
  })

  it('5c. the three-attempt policy is unchanged in source', () => {
    const src = read('app/actions/quiz.ts')
    expect(src).toMatch(/Final exams allow three attempts/)
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/3/)
  })
})
