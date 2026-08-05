/**
 * Quiz presentation — safe randomization (XPA-4).
 *
 * ── The correctness invariant this module exists to protect ─────────────
 * `quiz_questions.correct_answer` is an INTEGER INDEX into `options`. Shuffling
 * the options a learner sees would therefore appear to move the correct answer.
 *
 * It does not, because shuffling here is PRESENTATIONAL ONLY:
 *
 *     options:  ["Frustrante", "Mémorable", "Correcte", "Autre"]
 *     correct_answer: 1                    ("Mémorable")
 *
 *     displayed (shuffled):  [{i:2,…} {i:0,…} {i:1,…} {i:3,…}]
 *     learner picks slot 2 -> submits originalIndex 1  -> graded correct ✓
 *
 * Every displayed option carries the index it had in the stored array, and the
 * learner's submission is that ORIGINAL index. Display order and grading are
 * fully decoupled, so `correct_answer` keeps its exact meaning, server-side
 * grading is untouched, and past attempts are never reinterpreted.
 *
 * The rule this encodes: **never submit a display position.**
 */

/** One option as rendered, carrying its position in the STORED options array. */
export interface DisplayOption {
  /** Index into the question's stored `options` array. This is what gets submitted. */
  originalIndex: number
  text: string
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * A seed makes a shuffle reproducible for the length of an attempt, so a
 * re-render does not reshuffle the question under the learner's cursor. It is
 * presentation state only — nothing about grading depends on it.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates using the supplied PRNG. Returns a new array; input untouched. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Build the options a learner sees.
 *
 * Always returns every option exactly once, each tagged with its original
 * index. When `randomize` is false the stored order is preserved, so a quiz
 * that has not opted in behaves exactly as before.
 */
export function buildDisplayOptions(
  options: readonly string[],
  randomize: boolean,
  seed: number
): DisplayOption[] {
  const tagged: DisplayOption[] = options.map((text, originalIndex) => ({ originalIndex, text }))
  return randomize ? shuffle(tagged, seededRandom(seed)) : tagged
}

/**
 * Order questions for display.
 *
 * Default is the authoring order (`order_index`), which the caller supplies
 * already sorted. Randomization reorders presentation only — it never adds,
 * removes or duplicates a question, so scoring denominators are unaffected.
 */
export function orderQuestions<T>(questions: readonly T[], randomize: boolean, seed: number): T[] {
  return randomize ? shuffle(questions, seededRandom(seed)) : questions.slice()
}

/**
 * Per-attempt seed.
 *
 * Derived once when an attempt begins and held for its lifetime, so React
 * re-renders do not reshuffle mid-question. Not security-sensitive: it governs
 * presentation only, and knowing it reveals nothing about correct answers.
 */
export function newAttemptSeed(): number {
  return Math.floor(Math.random() * 0xffffffff)
}
