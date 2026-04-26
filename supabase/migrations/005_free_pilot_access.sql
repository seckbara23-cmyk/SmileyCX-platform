-- ============================================================
-- Migration 005: Free pilot access mode
-- TEMP_FREE_ACCESS: This migration makes all published courses
-- freely accessible to authenticated users during the pilot phase.
--
-- To rollback when payments are re-enabled:
--   1. Run the rollback block at the bottom of this file
--   2. Set NEXT_PUBLIC_FREE_ACCESS_MODE=false in .env.local
-- ============================================================

-- ── 1. Update lessons_visible RLS policy ───────────────────────────────────────
-- TEMP_FREE_ACCESS: Add a third condition — any authenticated user can read
-- lessons that belong to a course marked is_free = true.
-- The enrollment-based check is kept so the policy reverts cleanly by
-- simply removing this migration and resetting is_free on courses.

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

    -- TEMP_FREE_ACCESS: Authenticated users can see all lessons in free courses.
    -- Remove this block (and reset courses.is_free) to re-enable payment gating.
    OR (
      auth.uid() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM modules m
        JOIN courses c ON c.id = m.course_id
        WHERE m.id = lessons.module_id
          AND c.is_free = true
      )
    )
  );

-- Keep admin override intact
-- (lessons_admin_all policy is unchanged — not modified here)


-- ── 2. Mark all published courses as free ──────────────────────────────────────
-- TEMP_FREE_ACCESS: Set is_free = true on all published courses so the RLS
-- policy above allows access. Also zero out the price for consistency
-- (price is not shown in the UI when FREE_ACCESS_MODE is active).
-- Rollback: UPDATE courses SET is_free = false, price = <original> WHERE ...

UPDATE courses
SET
  is_free = true,
  price   = 0
WHERE is_published = true;


-- ── 3. Grant INSERT on enrollments for authenticated users ─────────────────────
-- The server action enrollForFree() uses the admin client (service role) so
-- it bypasses RLS — this policy is therefore a safety net for any future
-- direct client-side enrollment, not required for the current pilot flow.
-- It is intentionally restrictive: users can only insert their own records.

DROP POLICY IF EXISTS "enrollments_insert_own" ON enrollments;

CREATE POLICY "enrollments_insert_own" ON enrollments FOR INSERT
  WITH CHECK (user_id = auth.uid());


-- ── ROLLBACK (run manually to re-enable payments) ─────────────────────────────
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
--   );
--
-- DROP POLICY IF EXISTS "enrollments_insert_own" ON enrollments;
--
-- UPDATE courses SET is_free = false, price = <original_price> WHERE is_published = true;
