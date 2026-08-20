import 'server-only'
/**
 * XPA-8 B-2.3A — the assessment contract.
 *
 * ── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
 *
 * B-2.3's audit found the machinery built and the assessments absent: scoring,
 * five question types, three attachment scopes, randomization flags and an
 * authoring UI, with exactly one 3-question warm-up quiz sitting on top and
 * zero attempts ever recorded. This file adds the missing *contract* — what an
 * assessment is, who may take it, how many times, and what a pass entitles you
 * to — without authoring a single question.
 *
 * ── THE FOUR CONCEPTS, KEPT APART ─────────────────────────────────────────
 *
 *   LESSON COMPLETION   this lesson is done.              Secured by B-2.6.
 *   ASSESSMENT PASSED   this exam was passed.             Here.
 *   COURSE COMPLETED    every required lesson is done.    Derived.
 *   CERTIFICATE ELIGIBLE  completion (+ exam, if required). Here.
 *
 * The audit's finding was that the last three collapse today, because no
 * assessment exists and the certificate gate skipped its quiz checks whenever
 * `PLATFORM_MODE=pilot`. Both halves are fixed: eligibility is computed from an
 * explicit per-course flag, and **`PLATFORM_MODE` is consulted nowhere in this
 * file or in the gate that uses it.** An operating mode is not an academic
 * authority — the same rule B-2.6 established for completion.
 *
 * ── FINAL EXAM VERSUS FORMATIVE QUIZ ──────────────────────────────────────
 *
 * The distinction is STRUCTURAL and server-derived, never client-supplied: a
 * quiz attached to a COURSE (`course_id`) is a final exam; a quiz attached to a
 * module or a lesson is formative. Migration 022's `quizzes_single_parent`
 * CHECK guarantees exactly one parent, so the test is total and unambiguous.
 *
 * That matters for C1-F1's warm-up, "Échauffement — Repérez le niveau". It is
 * lesson-scoped, therefore formative, therefore ungated — it keeps its full
 * pedagogical feedback and gates nothing.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'

const log = createLogger('learn/assessment')

/**
 * Attempts allowed on a final exam.
 *
 * Ratified as 3. Deliberately NOT accompanied by an automatic reset or a
 * fourth-attempt escape hatch: once the budget is spent, remediation is an
 * administrative workflow, which is a separate decision nobody has taken.
 *
 * No schema was added for this. `quiz_attempts` already stores one row per
 * submission with `user_id`, `quiz_id` and `created_at`, so the count is a
 * `count(*)` — the smallest possible change being none at all.
 */
export const FINAL_EXAM_MAX_ATTEMPTS = 3

/** Formative quizzes are unlimited; only exams carry a budget. */
export type AssessmentKind = 'final_exam' | 'formative'

export interface QuizContext {
  quizId:       string
  /** Resolved server-side from the quiz's parent, never from the caller. */
  courseId:     string
  kind:         AssessmentKind
  passingScore: number
}

/**
 * Resolve a quiz to its course and its kind.
 *
 * Uses the service-role client for the lookup and only for the lookup: a
 * learner whose access has lapsed can no longer read `quizzes` through RLS, and
 * we need the course id in order to refuse them for the right reason rather
 * than reporting "quiz not found" for an access failure. The authorization
 * decision belongs to the caller, through the normal seam.
 *
 * Returns null when the quiz does not exist or is orphaned. Throws nothing —
 * a lookup FAILURE is distinguished from a missing row by the `failed` flag, so
 * a broken database cannot masquerade as "no such quiz" (the XPA-8 W3 lesson).
 */
export async function resolveQuizContext(
  quizId: string,
): Promise<{ context: QuizContext | null; failed: boolean }> {
  if (!quizId) return { context: null, failed: false }

  const admin = createAdminClient()

  const { data: quiz, error } = await admin
    .from('quizzes')
    .select('id, course_id, module_id, lesson_id, passing_score')
    .eq('id', quizId)
    .maybeSingle()

  if (error) {
    log.error({ err: error.message, quizId }, 'quiz lookup failed')
    return { context: null, failed: true }
  }
  if (!quiz) return { context: null, failed: false }

  // A course-scoped quiz IS the final exam. Structural, not a flag a client can
  // set, and mutually exclusive by migration 022's CHECK constraint.
  const kind: AssessmentKind = quiz.course_id ? 'final_exam' : 'formative'

  // For module/lesson-scoped quizzes the owning course comes from the parent.
  // `course_of_quiz()` (migration 036) already coalesces all three arms and is
  // SECURITY DEFINER, so it resolves past RLS exactly as the policies do.
  let courseId = quiz.course_id as string | null
  if (!courseId) {
    const { data: rpc, error: rpcErr } = await admin
      .rpc('course_of_quiz', { p_quiz_id: quizId })
    if (rpcErr) {
      log.error({ err: rpcErr.message, quizId }, 'course_of_quiz failed')
      return { context: null, failed: true }
    }
    courseId = rpc as string | null
  }

  if (!courseId) return { context: null, failed: false } // orphaned quiz

  return {
    context: {
      quizId,
      courseId,
      kind,
      passingScore: (quiz.passing_score as number | null) ?? 0,
    },
    failed: false,
  }
}

/** How many attempts this learner has already spent on this quiz. */
export async function countAttempts(userId: string, quizId: string): Promise<number | null> {
  const admin = createAdminClient()
  const { count, error } = await admin
    .from('quiz_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('quiz_id', quizId)

  if (error) {
    log.error({ err: error.message, userId, quizId }, 'attempt count failed')
    return null
  }
  return count ?? 0
}

/**
 * Does this course require a final exam for certification?
 *
 * ── WHY THIS TOLERATES A MISSING COLUMN ───────────────────────────────────
 *
 * `courses.requires_final_exam` arrives with migration 047, which is NOT
 * applied in this phase. The application half of B-2.3A therefore has to run
 * against a database that does not yet have the column, exactly as the B-2.6
 * build ran before 044.
 *
 * A missing column reads as `false`, which is not a fudge: `false` is the
 * ratified default and reproduces the pre-B-2.3 certificate contract exactly
 * (lessons only). So during the pre-migration window the gate behaves precisely
 * as it does today, and it starts enforcing exams only once an operator has
 * both applied 047 and deliberately flipped a course's flag.
 *
 * Any OTHER error fails CLOSED — `null` — and the caller must refuse. A
 * database that cannot answer "is an exam required?" must never be read as
 * "no exam required". `42703` is *undefined_column*, and it is the one error
 * that means "not migrated yet" rather than "something is wrong".
 */
export async function courseRequiresFinalExam(courseId: string): Promise<boolean | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('courses')
    .select('requires_final_exam')
    .eq('id', courseId)
    .maybeSingle()

  if (error) {
    if (error.code === '42703') return false // migration 047 not applied yet
    log.error({ err: error.message, code: error.code, courseId },
      'requires_final_exam lookup failed — failing closed')
    return null
  }

  return data?.requires_final_exam === true
}

/** Why a certificate was refused. Drives the honest message and the redirect. */
export type CertificateDenial =
  | 'lessons_incomplete'
  | 'final_exam_missing'
  | 'final_exam_not_passed'
  | 'lookup_failed'

export interface CertificateEligibility {
  eligible: boolean
  reason?:  CertificateDenial
  /** Present when an exam is required and exists — the page redirects to it. */
  examQuizId?: string
  completedLessons?: number
  totalLessons?:     number
}

/**
 * Decide whether a learner has EARNED a certificate for a course.
 *
 * Access is deliberately NOT part of this function. Whether the learner may
 * open the course at all is the entitlement seam's question and the caller
 * asks it first; this answers only "did they do the work?". Collapsing the two
 * is what made the gate wrong in both directions before UAT-ACCESS-01.
 *
 * The contract, ratified:
 *
 *   1. every required lesson complete;  AND
 *   2. if `requires_final_exam` is false -> nothing further;
 *      if true -> an attached final exam must EXIST and have a passing attempt.
 *
 * A course flagged as requiring an exam that has none **fails closed**. That is
 * the whole reason the flag defaults to false and is flipped per course only
 * once the exam is authored: a misconfiguration must withhold a certificate,
 * never mint one.
 *
 * Best-passing-result semantics: the test is "does ANY attempt with
 * `passed = true` exist", so a later failed retry can never revoke a pass
 * already earned.
 */
export async function resolveCertificateEligibility(
  userId:   string,
  courseId: string,
): Promise<CertificateEligibility> {
  const admin = createAdminClient()

  // ── 1. Required lessons ─────────────────────────────────────────────────
  const { data: modules, error: modErr } = await admin
    .from('modules')
    .select('id, lessons(id)')
    .eq('course_id', courseId)

  if (modErr) {
    log.error({ err: modErr.message, courseId }, 'module/lesson lookup failed')
    return { eligible: false, reason: 'lookup_failed' }
  }

  const lessonIds = (modules ?? []).flatMap(
    m => ((m.lessons ?? []) as { id: string }[]).map(l => l.id),
  )
  const totalLessons = lessonIds.length

  // A course with no lessons cannot be completed, so it cannot be certified.
  if (totalLessons === 0) {
    return { eligible: false, reason: 'lessons_incomplete', completedLessons: 0, totalLessons: 0 }
  }

  const { count: completed, error: progErr } = await admin
    .from('lesson_progress')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_completed', true)
    .in('lesson_id', lessonIds)

  if (progErr) {
    log.error({ err: progErr.message, userId, courseId }, 'progress count failed')
    return { eligible: false, reason: 'lookup_failed' }
  }

  const completedLessons = completed ?? 0
  if (completedLessons < totalLessons) {
    return { eligible: false, reason: 'lessons_incomplete', completedLessons, totalLessons }
  }

  // ── 2. The exam requirement ─────────────────────────────────────────────
  const requiresExam = await courseRequiresFinalExam(courseId)
  if (requiresExam === null) {
    return { eligible: false, reason: 'lookup_failed', completedLessons, totalLessons }
  }

  if (!requiresExam) {
    // Ratified: no exam gate. This is today's contract, preserved exactly.
    return { eligible: true, completedLessons, totalLessons }
  }

  const { data: exam, error: examErr } = await admin
    .from('quizzes')
    .select('id')
    .eq('course_id', courseId)
    .limit(1)
    .maybeSingle()

  if (examErr) {
    log.error({ err: examErr.message, courseId }, 'final exam lookup failed')
    return { eligible: false, reason: 'lookup_failed', completedLessons, totalLessons }
  }

  // Flag on, no exam attached: FAIL CLOSED. Never silently certify.
  if (!exam) {
    log.error({ courseId },
      'requires_final_exam is true but no course-scoped quiz exists — refusing certificate')
    return { eligible: false, reason: 'final_exam_missing', completedLessons, totalLessons }
  }

  const { data: pass, error: passErr } = await admin
    .from('quiz_attempts')
    .select('id')
    .eq('user_id', userId)
    .eq('quiz_id', exam.id)
    .eq('passed', true)
    .limit(1)
    .maybeSingle()

  if (passErr) {
    log.error({ err: passErr.message, userId, courseId }, 'exam attempt lookup failed')
    return { eligible: false, reason: 'lookup_failed', completedLessons, totalLessons }
  }

  if (!pass) {
    return {
      eligible: false,
      reason: 'final_exam_not_passed',
      examQuizId: exam.id as string,
      completedLessons,
      totalLessons,
    }
  }

  return { eligible: true, examQuizId: exam.id as string, completedLessons, totalLessons }
}
