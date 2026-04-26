-- ═══════════════════════════════════════════════════════════════════
-- SmileyCX — RLS Infinite Recursion Fix
-- Run this in Supabase SQL Editor AFTER the main schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- 1. Create a SECURITY DEFINER function that checks admin role
--    without triggering RLS (bypasses the recursion)
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  )
$$;

-- 2. Drop all recursive admin policies
DROP POLICY IF EXISTS "profiles_admin_all"    ON profiles;
DROP POLICY IF EXISTS "courses_admin_all"     ON courses;
DROP POLICY IF EXISTS "modules_admin_all"     ON modules;
DROP POLICY IF EXISTS "lessons_admin_all"     ON lessons;
DROP POLICY IF EXISTS "enrollments_admin_all" ON enrollments;
DROP POLICY IF EXISTS "payments_admin_all"    ON payments;
DROP POLICY IF EXISTS "certs_admin_all"       ON certificates;

-- Also drop the broken select/update own policies so we can recreate cleanly
DROP POLICY IF EXISTS "profiles_select_own"  ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"  ON profiles;

-- 3. Recreate profiles policies using is_admin() (no recursion)
CREATE POLICY "profiles_select_own"  ON profiles FOR SELECT USING (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_update_own"  ON profiles FOR UPDATE USING (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_insert_own"  ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_delete_admin" ON profiles FOR DELETE USING (is_admin());

-- 4. Recreate all other admin policies using is_admin()
CREATE POLICY "courses_admin_all"      ON courses     FOR ALL  USING (is_admin());
CREATE POLICY "modules_admin_all"      ON modules     FOR ALL  USING (is_admin());
CREATE POLICY "lessons_admin_all"      ON lessons     FOR ALL  USING (is_admin());
CREATE POLICY "enrollments_admin_all"  ON enrollments FOR ALL  USING (is_admin());
CREATE POLICY "payments_admin_all"     ON payments    FOR ALL  USING (is_admin());
CREATE POLICY "certs_admin_all"        ON certificates FOR ALL USING (is_admin());

-- 5. Allow authenticated users to insert their own enrollments (for checkout flow)
DROP POLICY IF EXISTS "enrollments_insert_own" ON enrollments;
CREATE POLICY "enrollments_insert_own" ON enrollments
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- 6. Allow authenticated users to update payments they own (for status updates)
DROP POLICY IF EXISTS "payments_update_own" ON payments;
CREATE POLICY "payments_update_own" ON payments
  FOR UPDATE USING (user_id = auth.uid());

-- 7. Add INSERT policy for certificates (auto-issued on course completion)
DROP POLICY IF EXISTS "certs_insert_own" ON certificates;
CREATE POLICY "certs_insert_own" ON certificates
  FOR INSERT WITH CHECK (user_id = auth.uid());
