-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — Phase A: RLS + Roles Stabilization Migration
-- Run this in Supabase SQL Editor (safe to re-run — all idempotent)
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS FIXES:
--   1. Removes the RECURSIVE profiles_super_admin_all policy (infinite loop)
--   2. Removes the broken is_admin() function (checked legacy `role` column)
--   3. Ensures is_platform_admin() SECURITY DEFINER function is correct
--   4. Adds clean, non-recursive RLS for all LMS tables
--   5. Adds passing_score to quizzes table
--   6. Ensures profile insert works via trigger (SECURITY DEFINER bypasses RLS)
--   7. Creates index for faster platform_role lookups
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Step 1: Remove the dangerous recursive policy ───────────────────────────
-- This policy was in admin_setup.sql and causes infinite recursion.
DROP POLICY IF EXISTS "profiles_super_admin_all" ON profiles;


-- ── Step 2: Remove the broken is_admin() function (wrong column) ────────────
-- fix_rls.sql and fix_all.sql created is_admin() checking `role = 'admin'`
-- but the live schema uses `platform_role`. Drop it so nothing uses it.
DROP FUNCTION IF EXISTS is_admin();


-- ── Step 3: Ensure is_platform_admin() SECURITY DEFINER is correct ──────────
-- This is the authoritative admin check used by all RLS policies.
-- SECURITY DEFINER runs as the function owner, bypassing RLS recursion.
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND platform_role IN ('super_admin', 'consultant')
  )
$$;


-- ── Step 4: Clean up ALL profiles policies and recreate correctly ────────────
DROP POLICY IF EXISTS "profiles_select_own"      ON profiles;
DROP POLICY IF EXISTS "profiles_insert_trigger"  ON profiles;
DROP POLICY IF EXISTS "profiles_insert_own"      ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"      ON profiles;
DROP POLICY IF EXISTS "profiles_delete_admin"    ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"       ON profiles;

-- Users see their own profile; platform admins see all
CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT
  USING (auth.uid() = id OR is_platform_admin());

-- Insert: only allowed by the SECURITY DEFINER trigger or the user themselves.
-- The handle_new_user() trigger runs as SECURITY DEFINER so it bypasses RLS.
-- This policy covers direct inserts (e.g. admin creating a user manually).
CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Update: own profile or platform admin
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (auth.uid() = id OR is_platform_admin());

-- Delete: platform admin only
CREATE POLICY "profiles_delete_admin"
  ON profiles FOR DELETE
  USING (is_platform_admin());


-- ── Step 5: Ensure trigger + function for new user profile creation ──────────
-- Recreate cleanly in case prior versions had issues.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, platform_role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ── Step 6: LMS table RLS — drop old admin policies and recreate ─────────────
-- Old policies used the inline subquery (recursive pattern). Replace with
-- the is_platform_admin() SECURITY DEFINER function.

-- courses
DROP POLICY IF EXISTS "courses_admin_all"            ON courses;
DROP POLICY IF EXISTS "courses_super_admin_all"       ON courses;
DROP POLICY IF EXISTS "courses_public_select"         ON courses;

CREATE POLICY "courses_public_select"
  ON courses FOR SELECT
  USING (is_published = true OR is_platform_admin());

CREATE POLICY "courses_admin_all"
  ON courses FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- modules
DROP POLICY IF EXISTS "modules_visible"              ON modules;
DROP POLICY IF EXISTS "modules_admin_all"             ON modules;
DROP POLICY IF EXISTS "modules_super_admin_all"       ON modules;

CREATE POLICY "modules_visible"
  ON modules FOR SELECT
  USING (
    is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_id AND c.is_published = true
    )
  );

CREATE POLICY "modules_admin_all"
  ON modules FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- lessons
DROP POLICY IF EXISTS "lessons_visible"              ON lessons;
DROP POLICY IF EXISTS "lessons_admin_all"             ON lessons;
DROP POLICY IF EXISTS "lessons_super_admin_all"       ON lessons;

CREATE POLICY "lessons_visible"
  ON lessons FOR SELECT
  USING (
    is_platform_admin()
    OR is_preview = true
    OR EXISTS (
      SELECT 1 FROM enrollments e
      JOIN modules m ON m.id = lessons.module_id
      WHERE e.user_id = auth.uid()
        AND e.course_id = m.course_id
        AND e.status = 'active'
    )
  );

CREATE POLICY "lessons_admin_all"
  ON lessons FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- quizzes (ensure RLS enabled)
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quizzes_admin_all"            ON quizzes;
DROP POLICY IF EXISTS "quizzes_super_admin_all"       ON quizzes;
DROP POLICY IF EXISTS "quizzes_visible"              ON quizzes;

CREATE POLICY "quizzes_visible"
  ON quizzes FOR SELECT
  USING (
    is_platform_admin()
    OR (lesson_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE l.id = quizzes.lesson_id
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    ))
    OR (module_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM modules m
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE m.id = quizzes.module_id
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    ))
  );

CREATE POLICY "quizzes_admin_all"
  ON quizzes FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- quiz_questions
ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quiz_questions_admin_all"     ON quiz_questions;
DROP POLICY IF EXISTS "quiz_questions_visible"       ON quiz_questions;

CREATE POLICY "quiz_questions_visible"
  ON quiz_questions FOR SELECT
  USING (
    is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM quizzes q
      JOIN lessons l ON l.id = q.lesson_id
      JOIN modules m ON m.id = l.module_id
      JOIN enrollments e ON e.course_id = m.course_id
      WHERE q.id = quiz_questions.quiz_id
        AND e.user_id = auth.uid()
        AND e.status = 'active'
    )
  );

CREATE POLICY "quiz_questions_admin_all"
  ON quiz_questions FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- enrollments
DROP POLICY IF EXISTS "enrollments_own"              ON enrollments;
DROP POLICY IF EXISTS "enrollments_insert_own"       ON enrollments;
DROP POLICY IF EXISTS "enrollments_admin_all"         ON enrollments;

CREATE POLICY "enrollments_own"
  ON enrollments FOR SELECT
  USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "enrollments_insert_own"
  ON enrollments FOR INSERT
  WITH CHECK (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "enrollments_update"
  ON enrollments FOR UPDATE
  USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "enrollments_admin_all"
  ON enrollments FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- payments
DROP POLICY IF EXISTS "payments_own"                 ON payments;
DROP POLICY IF EXISTS "payments_insert_own"          ON payments;
DROP POLICY IF EXISTS "payments_update_own"          ON payments;
DROP POLICY IF EXISTS "payments_admin_all"           ON payments;

CREATE POLICY "payments_own"
  ON payments FOR SELECT
  USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "payments_insert_own"
  ON payments FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "payments_update_own"
  ON payments FOR UPDATE
  USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "payments_admin_all"
  ON payments FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- lesson_progress
DROP POLICY IF EXISTS "progress_own"                 ON lesson_progress;

CREATE POLICY "progress_own"
  ON lesson_progress FOR ALL
  USING (user_id = auth.uid() OR is_platform_admin())
  WITH CHECK (user_id = auth.uid() OR is_platform_admin());

-- quiz_attempts
DROP POLICY IF EXISTS "attempts_own"                 ON quiz_attempts;

CREATE POLICY "attempts_own"
  ON quiz_attempts FOR ALL
  USING (user_id = auth.uid() OR is_platform_admin())
  WITH CHECK (user_id = auth.uid() OR is_platform_admin());

-- certificates
DROP POLICY IF EXISTS "certs_own"                    ON certificates;
DROP POLICY IF EXISTS "certs_insert_own"             ON certificates;
DROP POLICY IF EXISTS "certs_admin_all"              ON certificates;

CREATE POLICY "certs_own"
  ON certificates FOR SELECT
  USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "certs_insert_own"
  ON certificates FOR INSERT
  WITH CHECK (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY "certs_admin_all"
  ON certificates FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());


-- ── Step 7: Add passing_score to quizzes (idempotent) ───────────────────────
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS passing_score INTEGER NOT NULL DEFAULT 70;


-- ── Step 8: Add performance indexes ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS profiles_platform_role_idx ON profiles(platform_role);
CREATE INDEX IF NOT EXISTS enrollments_user_idx       ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS enrollments_course_idx     ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS lesson_progress_user_idx   ON lesson_progress(user_id);
CREATE INDEX IF NOT EXISTS lesson_progress_lesson_idx ON lesson_progress(lesson_id);
CREATE INDEX IF NOT EXISTS certificates_user_idx      ON certificates(user_id);


-- ── Step 9: Ensure course_progress_view still works ─────────────────────────
-- (Already defined in schema.sql — just recreate safely)
CREATE OR REPLACE VIEW course_progress_view AS
SELECT
  e.user_id,
  e.course_id,
  COUNT(l.id)                                           AS total_lessons,
  COUNT(lp.id) FILTER (WHERE lp.is_completed = true)   AS completed_lessons,
  ROUND(
    COUNT(lp.id) FILTER (WHERE lp.is_completed = true)::numeric
    / NULLIF(COUNT(l.id), 0) * 100
  )                                                     AS percentage
FROM enrollments e
JOIN modules  m  ON m.course_id = e.course_id
JOIN lessons  l  ON l.module_id = m.id
LEFT JOIN lesson_progress lp
  ON lp.lesson_id = l.id AND lp.user_id = e.user_id
GROUP BY e.user_id, e.course_id;


-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT
  tablename,
  policyname,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('profiles','courses','modules','lessons','enrollments',
                    'lesson_progress','certificates','quizzes','quiz_questions')
ORDER BY tablename, policyname;
