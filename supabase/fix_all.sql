-- ═══════════════════════════════════════════════════════════════════
-- SmileyCX — Complete Fix Script
-- Paste this entire file into Supabase SQL Editor and click Run
-- ═══════════════════════════════════════════════════════════════════

-- ── Step 1: Create SECURITY DEFINER helper to avoid RLS recursion ──
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  )
$$;

-- ── Step 2: Drop ALL existing policies on profiles ─────────────────
DROP POLICY IF EXISTS "profiles_select_own"   ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"   ON profiles;
DROP POLICY IF EXISTS "profiles_insert_own"   ON profiles;
DROP POLICY IF EXISTS "profiles_delete_admin" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"    ON profiles;

-- ── Step 3: Recreate profiles policies (no recursion) ─────────────
-- Allow insert only by the trigger (SECURITY DEFINER bypasses RLS)
-- and by the user themselves
CREATE POLICY "profiles_select_own"   ON profiles FOR SELECT USING (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_insert_own"   ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"   ON profiles FOR UPDATE USING (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_delete_admin" ON profiles FOR DELETE USING (is_admin());

-- ── Step 4: Drop and recreate other admin policies ─────────────────
DROP POLICY IF EXISTS "courses_admin_all"     ON courses;
DROP POLICY IF EXISTS "modules_admin_all"     ON modules;
DROP POLICY IF EXISTS "lessons_admin_all"     ON lessons;
DROP POLICY IF EXISTS "enrollments_admin_all" ON enrollments;
DROP POLICY IF EXISTS "payments_admin_all"    ON payments;
DROP POLICY IF EXISTS "certs_admin_all"       ON certificates;

CREATE POLICY "courses_admin_all"     ON courses      FOR ALL USING (is_admin());
CREATE POLICY "modules_admin_all"     ON modules      FOR ALL USING (is_admin());
CREATE POLICY "lessons_admin_all"     ON lessons      FOR ALL USING (is_admin());
CREATE POLICY "enrollments_admin_all" ON enrollments  FOR ALL USING (is_admin());
CREATE POLICY "payments_admin_all"    ON payments     FOR ALL USING (is_admin());
CREATE POLICY "certs_admin_all"       ON certificates FOR ALL USING (is_admin());

-- ── Step 5: Add missing INSERT/UPDATE policies for user flows ──────
DROP POLICY IF EXISTS "enrollments_insert_own" ON enrollments;
CREATE POLICY "enrollments_insert_own" ON enrollments
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "payments_update_own" ON payments;
CREATE POLICY "payments_update_own" ON payments
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "certs_insert_own" ON certificates;
CREATE POLICY "certs_insert_own" ON certificates
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ── Step 6: Recreate the signup trigger (in case it's broken) ─────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'learner')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Step 7: Verify everything looks correct ────────────────────────
SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
