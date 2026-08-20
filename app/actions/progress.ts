'use server'
/**
 * XPA-8 B-2.6 — the client-facing lesson-completion endpoint.
 *
 * Deliberately thin. All of the authority lives in `lib/learn/completion.ts`,
 * which is `server-only` and shared with the voice path, so the two completion
 * writers cannot drift into enforcing different rules. See that file for why
 * the entitlement seam — and not `PLATFORM_MODE`, and not `enrollments` — is
 * what decides.
 *
 * This module exports exactly ONE function. Every export of a `'use server'`
 * file is a callable HTTP endpoint, so a second, laxer variant would be a
 * second, laxer way in.
 */

import { LessonCompleteSchema } from '@/lib/validation/schemas'
import { recordLessonCompletion, type CompletionResult } from '@/lib/learn/completion'

/**
 * Mark a lesson complete for the current caller.
 *
 * `courseId` is the player's claim about which course it is showing; the server
 * resolves the lesson's real course and refuses when they disagree. Both are
 * validated as UUIDs before anything touches the database, so a malformed
 * payload is rejected without a lookup.
 */
export async function completeLesson(
  lessonId: string,
  courseId: string,
): Promise<CompletionResult> {
  const parsed = LessonCompleteSchema.safeParse({ lessonId, courseId })
  if (!parsed.success) return { ok: false, reason: 'invalid_input' }

  return recordLessonCompletion(parsed.data.lessonId, parsed.data.courseId)
}
