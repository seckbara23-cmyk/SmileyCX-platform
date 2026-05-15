-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 022: Final exam support
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds a third quiz attachment type: course-level final exam.
-- Previously quizzes could only be attached to a module or a lesson.
-- Now exactly one of (module_id, lesson_id, course_id) must be non-null.
--
-- Changes:
--   1. Add course_id column to quizzes (nullable FK → courses)
--   2. Drop old quizzes_single_parent CHECK constraint
--   3. Add new quizzes_single_parent constraint using integer cast sum = 1
--   4. Rebuild quizzes_visible RLS to include course-level arm
--   5. Rebuild quiz_questions_visible RLS to include course-level arm
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Add course_id column ───────────────────────────────────────────────

ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES courses(id) ON DELETE CASCADE;


-- ── 2. Drop old single-parent constraint ─────────────────────────────────

ALTER TABLE public.quizzes DROP CONSTRAINT IF EXISTS quizzes_single_parent;


-- ── 3. New constraint: exactly one of three parents must be set ───────────

ALTER TABLE public.quizzes
  ADD CONSTRAINT quizzes_single_parent CHECK (
    (
      (module_id  IS NOT NULL)::int +
      (lesson_id  IS NOT NULL)::int +
      (course_id  IS NOT NULL)::int
    ) = 1
  );


-- ── 4. Rebuild quizzes_visible RLS ───────────────────────────────────────

DROP POLICY IF EXISTS "quizzes_visible" ON quizzes;

CREATE POLICY "quizzes_visible" ON quizzes FOR SELECT
  USING (
    is_platform_admin()

    -- Enrolled users — module-level quiz
    OR (module_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM modules m
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE m.id = quizzes.module_id
        AND e.user_id = auth.uid() AND e.status = 'active'
    ))

    -- Enrolled users — lesson-level quiz
    OR (lesson_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE l.id = quizzes.lesson_id
        AND e.user_id = auth.uid() AND e.status = 'active'
    ))

    -- Enrolled users — course-level final exam
    OR (course_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.course_id = quizzes.course_id
        AND e.user_id = auth.uid() AND e.status = 'active'
    ))

    -- TEMP_FREE_ACCESS: authenticated — module-level
    OR (auth.uid() IS NOT NULL AND module_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM modules m JOIN courses c ON c.id = m.course_id
      WHERE m.id = quizzes.module_id AND c.is_free = true
    ))

    -- TEMP_FREE_ACCESS: authenticated — lesson-level
    OR (auth.uid() IS NOT NULL AND lesson_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM lessons l JOIN modules m ON m.id = l.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE l.id = quizzes.lesson_id AND c.is_free = true
    ))

    -- TEMP_FREE_ACCESS: authenticated — course-level
    OR (auth.uid() IS NOT NULL AND course_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = quizzes.course_id AND c.is_free = true
    ))

    -- PILOT_MODE: anonymous — module-level
    OR (auth.uid() IS NULL AND module_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM modules m JOIN courses c ON c.id = m.course_id
      WHERE m.id = quizzes.module_id AND c.is_published = true
    ))

    -- PILOT_MODE: anonymous — lesson-level
    OR (auth.uid() IS NULL AND lesson_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM lessons l JOIN modules m ON m.id = l.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE l.id = quizzes.lesson_id AND c.is_published = true
    ))

    -- PILOT_MODE: anonymous — course-level
    OR (auth.uid() IS NULL AND course_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = quizzes.course_id AND c.is_published = true
    ))
  );


-- ── 5. Rebuild quiz_questions_visible RLS ─────────────────────────────────

DROP POLICY IF EXISTS "quiz_questions_visible" ON quiz_questions;

CREATE POLICY "quiz_questions_visible" ON quiz_questions FOR SELECT
  USING (
    is_platform_admin()

    -- Enrolled — module-level
    OR EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN modules m ON m.id = qz.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.module_id IS NOT NULL
        AND e.user_id = auth.uid() AND e.status = 'active'
    )

    -- Enrolled — lesson-level
    OR EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN lessons l ON l.id = qz.lesson_id
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.lesson_id IS NOT NULL
        AND e.user_id = auth.uid() AND e.status = 'active'
    )

    -- Enrolled — course-level (final exam)
    OR EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN enrollments e ON e.course_id = qz.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.course_id IS NOT NULL
        AND e.user_id = auth.uid() AND e.status = 'active'
    )

    -- TEMP_FREE_ACCESS — module-level
    OR (auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN modules m ON m.id = qz.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.module_id IS NOT NULL AND c.is_free = true
    ))

    -- TEMP_FREE_ACCESS — lesson-level
    OR (auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN lessons l ON l.id = qz.lesson_id
      JOIN modules m ON m.id = l.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.lesson_id IS NOT NULL AND c.is_free = true
    ))

    -- TEMP_FREE_ACCESS — course-level
    OR (auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN courses c ON c.id = qz.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.course_id IS NOT NULL AND c.is_free = true
    ))

    -- PILOT_MODE — module-level
    OR (auth.uid() IS NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN modules m ON m.id = qz.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.module_id IS NOT NULL AND c.is_published = true
    ))

    -- PILOT_MODE — lesson-level
    OR (auth.uid() IS NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN lessons l ON l.id = qz.lesson_id
      JOIN modules m ON m.id = l.module_id
      JOIN courses c ON c.id = m.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.lesson_id IS NOT NULL AND c.is_published = true
    ))

    -- PILOT_MODE — course-level
    OR (auth.uid() IS NULL AND EXISTS (
      SELECT 1 FROM quizzes qz
      JOIN courses c ON c.id = qz.course_id
      WHERE qz.id = quiz_questions.quiz_id AND qz.course_id IS NOT NULL AND c.is_published = true
    ))
  );
