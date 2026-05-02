-- ============================================================
-- Migration 010: Fix quiz + quiz_questions RLS for pilot mode
--
-- Root cause (migration 008):
--   The quiz_questions_visible policy incorrectly referenced
--   quiz_questions.module_id, which does not exist.
--   Additionally, migration 001's quiz_questions_visible only
--   joined through lesson_id, so module-level quizzes were
--   never readable by any user.
--
-- Fix:
--   1. quizzes_visible — rebuilt to cover:
--        - enrolled users (module- and lesson-level)
--        - authenticated users in free courses (TEMP_FREE_ACCESS)
--        - anonymous users in published courses (PILOT_MODE)
--
--   2. quiz_questions_visible — rebuilt to cover the same
--      three groups, using the correct join path:
--        quiz_questions.quiz_id → quizzes → modules/lessons → courses
--      Never references quiz_questions.module_id.
-- ============================================================


-- ── 1. quizzes: drop and recreate visibility policy ───────────────────────

DROP POLICY IF EXISTS "quizzes_visible" ON quizzes;

CREATE POLICY "quizzes_visible" ON quizzes FOR SELECT
  USING (
    -- Platform admins see everything
    is_platform_admin()

    -- Enrolled users — module-level quiz
    OR (module_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM modules m
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE m.id = quizzes.module_id
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    ))

    -- Enrolled users — lesson-level quiz
    OR (lesson_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE l.id = quizzes.lesson_id
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    ))

    -- TEMP_FREE_ACCESS: authenticated users in free courses
    OR (
      auth.uid() IS NOT NULL
      AND (
        (module_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM modules m
          JOIN courses c ON c.id = m.course_id
          WHERE m.id = quizzes.module_id
            AND c.is_free = true
        ))
        OR (lesson_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM lessons l
          JOIN modules m ON m.id = l.module_id
          JOIN courses c ON c.id = m.course_id
          WHERE l.id = quizzes.lesson_id
            AND c.is_free = true
        ))
      )
    )

    -- PILOT_MODE: anonymous users in published courses
    OR (
      auth.uid() IS NULL
      AND (
        (module_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM modules m
          JOIN courses c ON c.id = m.course_id
          WHERE m.id = quizzes.module_id
            AND c.is_published = true
        ))
        OR (lesson_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM lessons l
          JOIN modules m ON m.id = l.module_id
          JOIN courses c ON c.id = m.course_id
          WHERE l.id = quizzes.lesson_id
            AND c.is_published = true
        ))
      )
    )
  );


-- ── 2. quiz_questions: drop and recreate visibility policy ────────────────
-- Correct join path: quiz_questions.quiz_id → quizzes → modules/lessons → courses
-- Do NOT reference quiz_questions.module_id (column does not exist).

DROP POLICY IF EXISTS "quiz_questions_visible" ON quiz_questions;

CREATE POLICY "quiz_questions_visible" ON quiz_questions FOR SELECT
  USING (
    -- Platform admins see everything
    is_platform_admin()

    -- Enrolled users — via module-level quiz
    OR EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN modules m ON m.id = qz.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id
        AND qz.module_id IS NOT NULL
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    )

    -- Enrolled users — via lesson-level quiz
    OR EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN lessons l ON l.id = qz.lesson_id
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id
        AND qz.lesson_id IS NOT NULL
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    )

    -- TEMP_FREE_ACCESS: authenticated users in free courses — module-level
    OR (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM quizzes qz
        JOIN modules m ON m.id = qz.module_id
        JOIN courses c ON c.id = m.course_id
        WHERE qz.id = quiz_questions.quiz_id
          AND qz.module_id IS NOT NULL
          AND c.is_free = true
      )
    )

    -- TEMP_FREE_ACCESS: authenticated users in free courses — lesson-level
    OR (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM quizzes qz
        JOIN lessons l ON l.id = qz.lesson_id
        JOIN modules m ON m.id = l.module_id
        JOIN courses c ON c.id = m.course_id
        WHERE qz.id = quiz_questions.quiz_id
          AND qz.lesson_id IS NOT NULL
          AND c.is_free = true
      )
    )

    -- PILOT_MODE: anonymous users in published courses — module-level
    OR (
      auth.uid() IS NULL
      AND EXISTS (
        SELECT 1 FROM quizzes qz
        JOIN modules m ON m.id = qz.module_id
        JOIN courses c ON c.id = m.course_id
        WHERE qz.id = quiz_questions.quiz_id
          AND qz.module_id IS NOT NULL
          AND c.is_published = true
      )
    )

    -- PILOT_MODE: anonymous users in published courses — lesson-level
    OR (
      auth.uid() IS NULL
      AND EXISTS (
        SELECT 1 FROM quizzes qz
        JOIN lessons l ON l.id = qz.lesson_id
        JOIN modules m ON m.id = l.module_id
        JOIN courses c ON c.id = m.course_id
        WHERE qz.id = quiz_questions.quiz_id
          AND qz.lesson_id IS NOT NULL
          AND c.is_published = true
      )
    )
  );


-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- To revert to enrollment-only access (remove pilot/free-course arms):
--
-- DROP POLICY IF EXISTS "quizzes_visible" ON quizzes;
-- CREATE POLICY "quizzes_visible" ON quizzes FOR SELECT
--   USING (
--     is_platform_admin()
--     OR (module_id IS NOT NULL AND EXISTS (
--       SELECT 1 FROM modules m
--       JOIN enrollments e ON e.course_id = m.course_id
--       WHERE m.id = quizzes.module_id
--         AND e.user_id = auth.uid() AND e.status = 'active'
--     ))
--     OR (lesson_id IS NOT NULL AND EXISTS (
--       SELECT 1 FROM lessons l
--       JOIN modules m ON m.id = l.module_id
--       JOIN enrollments e ON e.course_id = m.course_id
--       WHERE l.id = quizzes.lesson_id
--         AND e.user_id = auth.uid() AND e.status = 'active'
--     ))
--   );
--
-- DROP POLICY IF EXISTS "quiz_questions_visible" ON quiz_questions;
-- CREATE POLICY "quiz_questions_visible" ON quiz_questions FOR SELECT
--   USING (
--     is_platform_admin()
--     OR EXISTS (
--       SELECT 1 FROM quizzes qz
--       JOIN modules m ON m.id = qz.module_id
--       JOIN enrollments e ON e.course_id = m.course_id
--       WHERE qz.id = quiz_questions.quiz_id
--         AND qz.module_id IS NOT NULL
--         AND e.user_id = auth.uid() AND e.status = 'active'
--     )
--     OR EXISTS (
--       SELECT 1 FROM quizzes qz
--       JOIN lessons l ON l.id = qz.lesson_id
--       JOIN modules m ON m.id = l.module_id
--       JOIN enrollments e ON e.course_id = m.course_id
--       WHERE qz.id = quiz_questions.quiz_id
--         AND qz.lesson_id IS NOT NULL
--         AND e.user_id = auth.uid() AND e.status = 'active'
--     )
--   );
