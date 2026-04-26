-- ============================================================
-- Migration 008: Anonymous access for pilot mode
-- PILOT_MODE: Allows unauthenticated users to read published
-- course content (lessons, modules) without an account.
--
-- This migration is additive — it extends existing policies
-- rather than replacing them, so authenticated and enrolled
-- user access is fully preserved.
--
-- To rollback when pilot ends:
--   Run the ROLLBACK block at the bottom of this file.
-- ============================================================


-- ── 1. lessons: allow anonymous reads for published courses ────────────────
-- Extends the policy from migration 005 to add an anonymous arm.
-- auth.uid() IS NULL identifies the Supabase anonymous / unauthenticated role.

DROP POLICY IF EXISTS "lessons_visible" ON lessons;

CREATE POLICY "lessons_visible" ON lessons FOR SELECT
  USING (
    -- Preview lessons are always public (unchanged)
    is_preview = true

    -- Enrolled users can see any lesson in their active course (unchanged)
    OR EXISTS (
      SELECT 1 FROM enrollments e
      JOIN modules m ON m.id = lessons.module_id
      WHERE e.user_id = auth.uid()
        AND e.course_id = m.course_id
        AND e.status = 'active'
    )

    -- TEMP_FREE_ACCESS: Authenticated users can see all lessons in free courses
    OR (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM modules m
        JOIN courses c ON c.id = m.course_id
        WHERE m.id = lessons.module_id
          AND c.is_free = true
      )
    )

    -- PILOT_MODE: Anonymous users can read lessons in published courses.
    -- Remove this arm (and the modules arm below) to restore auth-gating.
    OR (
      auth.uid() IS NULL
      AND EXISTS (
        SELECT 1 FROM modules m
        JOIN courses c ON c.id = m.course_id
        WHERE m.id = lessons.module_id
          AND c.is_published = true
      )
    )
  );


-- ── 2. modules: allow anonymous reads for published courses ────────────────
-- The lesson player sidebar loads modules directly. Without this, the sidebar
-- returns an empty list for anonymous users even when lessons are visible.

DROP POLICY IF EXISTS "modules_visible" ON modules;

CREATE POLICY "modules_visible" ON modules FOR SELECT
  USING (
    -- Authenticated users always see modules of courses they are enrolled in
    EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.user_id = auth.uid()
        AND e.course_id = modules.course_id
        AND e.status = 'active'
    )

    -- Authenticated users see modules of free courses (TEMP_FREE_ACCESS)
    OR (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = modules.course_id
          AND c.is_free = true
      )
    )

    -- PILOT_MODE: Anonymous users see modules of published courses
    OR (
      auth.uid() IS NULL
      AND EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = modules.course_id
          AND c.is_published = true
      )
    )
  );


-- ── 3. quiz_questions: read-only pilot access ──────────────────────────────
-- If a quiz_questions table exists, allow anonymous reads for published courses.
-- Quiz submissions (quiz_responses / quiz_attempts) remain auth-gated — anon
-- users can see questions but cannot persist answers.
-- Note: skip if the table does not exist in your schema.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'quiz_questions'
  ) THEN
    -- Drop the old policy if it blocks anon reads
    EXECUTE 'DROP POLICY IF EXISTS "quiz_questions_visible" ON quiz_questions';

    EXECUTE $policy$
      CREATE POLICY "quiz_questions_visible" ON quiz_questions FOR SELECT
        USING (
          -- Enrolled users always see questions for their courses
          EXISTS (
            SELECT 1 FROM enrollments e
            JOIN modules m ON m.id = quiz_questions.module_id
            WHERE e.user_id = auth.uid()
              AND e.course_id = m.course_id
              AND e.status = ''active''
          )
          -- PILOT_MODE: Anonymous users see questions for published courses
          OR (
            auth.uid() IS NULL
            AND EXISTS (
              SELECT 1 FROM modules m
              JOIN courses c ON c.id = m.course_id
              WHERE m.id = quiz_questions.module_id
                AND c.is_published = true
            )
          )
        )
    $policy$;
  END IF;
END $$;


-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- Run this block manually to restore pre-pilot RLS (auth-required access).
--
-- DROP POLICY IF EXISTS "lessons_visible" ON lessons;
--
-- CREATE POLICY "lessons_visible" ON lessons FOR SELECT
--   USING (
--     is_preview = true
--     OR EXISTS (
--       SELECT 1 FROM enrollments e
--       JOIN modules m ON m.id = lessons.module_id
--       WHERE e.user_id = auth.uid()
--         AND e.course_id = m.course_id
--         AND e.status = 'active'
--     )
--     OR (
--       auth.uid() IS NOT NULL
--       AND EXISTS (
--         SELECT 1 FROM modules m
--         JOIN courses c ON c.id = m.course_id
--         WHERE m.id = lessons.module_id
--           AND c.is_free = true
--       )
--     )
--   );
--
-- DROP POLICY IF EXISTS "modules_visible" ON modules;
--
-- -- Restore your original modules policy here if one existed,
-- -- or drop the policy entirely if modules were unrestricted before.
