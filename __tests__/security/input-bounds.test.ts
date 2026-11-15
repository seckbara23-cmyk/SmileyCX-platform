// @vitest-environment node
/**
 * Oversized input is refused before Zod sees it.
 *
 * Zod 3 keeps one issue for every failing element and does not stop early, not even
 * for `.max()`. The proof here is Zod's own error map, which runs once for every issue it
 * builds: at zero calls, Zod did no such work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { withinInputBounds } from '@/lib/validation/input-bounds'

// The first test to reach an action pays for importing it, which can be slow on CI.
vi.setConfig({ testTimeout: 30_000 })

const H = vi.hoisted(() => ({ reached: 0 }))

/** Anything past validation lands here, and gets nothing useful back. */
const chain = (): unknown => new Proxy(function () { /* callable */ }, {
  get: (_t, key) => {
    if (key === 'then') return (ok: (_v: unknown) => unknown) => ok({ data: null, error: { message: 'harness' } })
    return chain()
  },
  apply: () => chain(),
})

vi.mock('server-only', () => ({}))
// XP-F2-01: these tests check the size limits of an OPEN voice practice; closed, every
// voice action answers « pas encore ouvert » before any parsing (pinned elsewhere).
vi.mock('@/lib/ai/flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/flags')>()),
  VOICE_PRACTICE_OPEN: true,
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => { H.reached += 1; return chain() },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    H.reached += 1
    return { auth: { getUser: async () => ({ data: { user: null }, error: null }) }, from: () => chain() }
  },
}))
vi.mock('@/lib/auth/course-access', () => ({
  resolveCourseAccessById: async () => { H.reached += 1; return { allowed: false, reason: 'not_found' } },
  denialMessage: () => 'refused',
}))

const UUID = '11111111-1111-4111-8111-111111111111'
const MB = 1024 * 1024
const INVALID = 'Données invalides.'
const bounds = { maxNodes: 10, maxDepth: 2, maxChars: 20 }

describe('withinInputBounds', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 1],
    ['a boolean', true],
    ['a short string', 'abc'],
    ['an empty object', {}],
    ['an empty array', []],
    ['a small record', { a: 1, b: 'x' }],
    ['a small nested value', { a: [1, 2] }],
    ['an object with no prototype', Object.assign(Object.create(null), { a: 1 })],
  ])('accepts %s', (_name, value) => {
    expect(withinInputBounds(value, bounds)).toBe(true)
  })

  it.each([
    ['too many array elements', new Array(11).fill(1)],
    ['too many keys', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1]))],
    ['too long a string', 'x'.repeat(21)],
    ['too long a key', { ['k'.repeat(21)]: 1 }],
    ['too many characters across values', { a: 'x'.repeat(10), b: 'y'.repeat(10) }],
    ['too deep', { a: { b: { c: 1 } } }],
    ['nodes spread across containers', { a: [1, 2, 3, 4], b: [1, 2, 3, 4] }],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a Date', new Date()],
    ['a class instance', new (class Thing { x = 1 })()],
    ['a bigint', BigInt(1)],
    ['an own key named __proto__, as JSON.parse delivers it', JSON.parse('{"__proto__":{"polluted":1},"a":1}')],
    ['a key named constructor', { constructor: { prototype: { x: 1 } } }],
    ['a nested key named prototype', { a: [{ prototype: 1 }] }],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
  ])('refuses %s', (_name, value) => {
    expect(withinInputBounds(value, bounds)).toBe(false)
  })

  it('counts exactly at its limits', () => {
    expect(withinInputBounds(new Array(9).fill(1), bounds)).toBe(true)
    expect(withinInputBounds(new Array(10).fill(1), bounds)).toBe(false)
    expect(withinInputBounds('x'.repeat(20), bounds)).toBe(true)
    expect(withinInputBounds({ a: 1 }, { maxNodes: 2, maxDepth: 1, maxChars: 1 })).toBe(true)
    expect(withinInputBounds({ a: { b: 1 } }, { maxNodes: 9, maxDepth: 1, maxChars: 9 })).toBe(false)
    expect(withinInputBounds(1, { maxNodes: 0, maxDepth: 1, maxChars: 1 })).toBe(false)
  })

  it('refuses a huge record without reading its values', () => {
    let reads = 0
    const huge: Record<string, unknown> = {}
    for (let i = 0; i < 1000; i++) {
      Object.defineProperty(huge, `k${i}`, { enumerable: true, get: () => { reads += 1; return 1 } })
    }
    expect(withinInputBounds(huge, { maxNodes: 10, maxDepth: 2, maxChars: 100_000 })).toBe(false)
    expect(reads).toBe(0)
  })

  it('refuses a huge array without reading its elements', () => {
    let reads = 0
    const huge = new Proxy(new Array(1_000_000), {
      get: (t, key, r) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1
        return Reflect.get(t, key, r)
      },
    })
    expect(withinInputBounds(huge, bounds)).toBe(false)
    expect(reads).toBe(0)
  })

  it('survives nesting that would overflow a recursive walk', () => {
    let deep: unknown = 1
    for (let i = 0; i < 200_000; i++) deep = [deep]
    expect(withinInputBounds(deep, { maxNodes: 1_000_000, maxDepth: 1_000_000, maxChars: 10 })).toBe(true)
    expect(withinInputBounds(deep, bounds)).toBe(false)
  })
})

describe('the four actions refuse oversized input before Zod does any work', () => {
  let issues = 0

  beforeEach(() => {
    issues = 0
    H.reached = 0
    z.setErrorMap((_issue, ctx) => { issues += 1; return { message: ctx.defaultError } })
  })
  afterEach(() => { z.setErrorMap(z.defaultErrorMap) })

  const saveAiTurns = async (input: unknown) => (await import('@/app/actions/ai-practice')).saveAiTurns(input as never)
  const saveSelfAssessment = async (input: unknown) => (await import('@/app/actions/ai-practice')).saveSelfAssessment(input as never)
  const submitQuizAnswers = async (input: unknown) => (await import('@/app/actions/quiz')).submitQuizAnswers(input as never)
  const submitExercise = async (input: unknown) => (await import('@/app/actions/exercise')).submitExercise(input as never)
  const keyed = (n: number, value: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value]))

  it.each([
    ['saveAiTurns, a million failing fields', saveAiTurns, () => ({ sessionId: UUID, turns: Array.from({ length: Math.floor(MB / 3) }, () => ({})) })],
    ['saveAiTurns, an oversized transcript', saveAiTurns, () => ({ sessionId: UUID, turns: [{ speaker: 'agent', transcript: 'x'.repeat(MB), turnIndex: 0 }] })],
    ['submitQuizAnswers, one huge answer', submitQuizAnswers, () => ({ quizId: UUID, moduleId: null, answers: { [UUID]: new Array(Math.floor(MB / 3)).fill(99) } })],
    ['submitQuizAnswers, a huge record', submitQuizAnswers, () => ({ quizId: UUID, moduleId: null, answers: keyed(Math.floor(MB / 11), 1) })],
    ['submitExercise, a huge record', submitExercise, () => ({ exerciseId: UUID, placements: keyed(Math.floor(MB / 11), 'x') })],
    ['saveSelfAssessment, a huge record', saveSelfAssessment, () => ({ sessionId: UUID, answers: keyed(Math.floor(MB / 11), 1) })],
    ['saveSelfAssessment, an oversized answer', saveSelfAssessment, () => ({ sessionId: UUID, answers: { a: 'x'.repeat(MB) } })],
  ] as const)('%s', async (_name, action, input) => {
    const result = await action(input())
    expect(result).toEqual({ error: INVALID })
    expect(issues).toBe(0)
    expect(H.reached).toBe(0)
  })

  it('the instrument works: input within the limits does reach Zod', async () => {
    expect(await saveAiTurns({ sessionId: UUID, turns: [{}] })).toEqual({ error: INVALID })
    expect(issues).toBeGreaterThan(0)
  })

  // Each is larger than anything the pages send, apart from a self-assessment's free text,
  // whose form sets no limit of its own. Reaching the database means validation passed.
  it('saveAiTurns accepts a full batch of the longest turns', async () => {
    const turns = Array.from({ length: 100 }, (_, i) => ({ speaker: 'learner', transcript: 'x'.repeat(8000), turnIndex: i, latencyMs: 1 }))
    expect(await saveAiTurns({ sessionId: UUID, anonId: UUID, turns })).not.toEqual({ error: INVALID })
    expect(H.reached).toBeGreaterThan(0)
  })

  it('submitQuizAnswers accepts a far larger exam than any that exists', async () => {
    const id = (n: number) => `${n}`.padStart(8, '0') + '-1111-4111-8111-111111111111'
    const dm = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`item_${i}_`.padEnd(64, 'a'), `cat_${i}_`.padEnd(64, 'b')]))
    const answers = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [id(i), dm]))
    expect(await submitQuizAnswers({ quizId: UUID, moduleId: null, answers })).not.toEqual({ error: INVALID })
    expect(H.reached).toBeGreaterThan(0)
  })

  it('submitExercise accepts a far larger exercise than any that exists', async () => {
    const id = (n: number) => `${n}`.padStart(8, '0') + '-1111-4111-8111-111111111111'
    const placements = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [id(i), UUID]))
    expect(await submitExercise({ exerciseId: UUID, placements })).not.toEqual({ error: INVALID })
    expect(H.reached).toBeGreaterThan(0)
  })

  it('submitExercise sits exactly at its node limit, and one more is refused unread', async () => {
    const id = (n: number) => `${n}`.padStart(8, '0') + '-1111-4111-8111-111111111111'
    const input = (n: number) => ({ exerciseId: UUID, placements: Object.fromEntries(Array.from({ length: n }, (_, i) => [id(i), UUID])) })
    expect(await submitExercise(input(997))).not.toEqual({ error: INVALID })
    expect(H.reached).toBeGreaterThan(0)
    H.reached = 0
    issues = 0
    expect(await submitExercise(input(998))).toEqual({ error: INVALID })
    expect(issues).toBe(0)
    expect(H.reached).toBe(0)
  })

  it('saveSelfAssessment accepts long free-text answers', async () => {
    const answers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`q${i}`, 'x'.repeat(1500)]))
    expect(await saveSelfAssessment({ sessionId: UUID, answers })).not.toEqual({ error: INVALID })
    expect(H.reached).toBeGreaterThan(0)
  })
})
