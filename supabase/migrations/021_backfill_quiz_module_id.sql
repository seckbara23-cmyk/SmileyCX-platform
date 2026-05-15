-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 021: Backfill module_id on quizzes created via lesson attachment
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Root cause (fixed in createQuiz server action):
--   When an admin attached a quiz to a lesson, the action set module_id = NULL
--   instead of resolving the lesson's parent module_id.
--   The learner quiz page queries exclusively on module_id, so those quizzes
--   were invisible to learners even though data was correctly inserted.
--
-- Fix:
--   For every quiz that has lesson_id set but module_id NULL, look up the
--   lesson's module_id and copy it onto the quiz row.
--   This is a one-time backfill; the application code was fixed simultaneously.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE quizzes
SET    module_id = lessons.module_id
FROM   lessons
WHERE  quizzes.lesson_id  = lessons.id
  AND  quizzes.module_id  IS NULL;

-- Verify: after this migration, no quiz should have module_id NULL.
-- (Quizzes with both lesson_id AND module_id are fine — the learner page
-- finds them by module_id; lesson_id is kept for optional lesson-scope use.)
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM quizzes
  WHERE module_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE WARNING 'After backfill, % quiz row(s) still have module_id = NULL. '
      'These may have no associated lesson either — investigate manually.',
      orphan_count;
  ELSE
    RAISE NOTICE 'Backfill complete: all quizzes now have module_id set.';
  END IF;
END $$;
