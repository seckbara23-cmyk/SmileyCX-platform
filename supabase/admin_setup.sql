-- ═══════════════════════════════════════════════════════════════════════
-- SmileyCX — One-time platform admin setup
-- Run this in Supabase SQL Editor AFTER creating the admin account.
-- ═══════════════════════════════════════════════════════════════════════

-- STEP 1 ─────────────────────────────────────────────────────────────────
-- Create the admin Supabase Auth user via the Dashboard or CLI:
--
--   supabase auth user create \
--     --email seckbara23@gmail.com \
--     --password "Senegal1980" \
--     --email-confirm
--
-- Or in the Supabase Dashboard → Authentication → Users → Invite user.
-- ────────────────────────────────────────────────────────────────────────


-- STEP 2 ─────────────────────────────────────────────────────────────────
-- Promote the account to super_admin.
-- Replace the email if you used a different one.
-- ────────────────────────────────────────────────────────────────────────

UPDATE profiles
SET    platform_role = 'super_admin'
WHERE  email = 'seckbara23@gmail.com';

-- Verify:
-- SELECT id, email, platform_role FROM profiles WHERE email = 'seckbara23@gmail.com';


-- STEP 3 ─────────────────────────────────────────────────────────────────
-- (Optional) Index for fast platform_role lookups used by the admin layout.
-- ────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS profiles_platform_role_idx ON profiles(platform_role);


-- STEP 4 ─────────────────────────────────────────────────────────────────
-- RLS: allow super_admin to read/write all profiles.
-- The existing schema.sql uses the legacy `role` column — add a policy for
-- platform_role as well so admin API calls work without the service key.
-- ────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "profiles_super_admin_all" ON profiles;

CREATE POLICY "profiles_super_admin_all" ON profiles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE  p.id = auth.uid()
        AND  p.platform_role = 'super_admin'
    )
  );


-- STEP 5 ─────────────────────────────────────────────────────────────────
-- (Optional) Same super_admin policies for courses, modules, lessons.
-- Remove these if you prefer the admin to use the service role key only.
-- ────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "courses_super_admin_all"  ON courses;
DROP POLICY IF EXISTS "modules_super_admin_all"  ON modules;
DROP POLICY IF EXISTS "lessons_super_admin_all"  ON lessons;
DROP POLICY IF EXISTS "quizzes_super_admin_all"  ON quizzes;

CREATE POLICY "courses_super_admin_all" ON courses FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

CREATE POLICY "modules_super_admin_all" ON modules FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

CREATE POLICY "lessons_super_admin_all" ON lessons FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));

CREATE POLICY "quizzes_super_admin_all" ON quizzes FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.platform_role = 'super_admin'));
