-- ============================================================
-- Migration 004: Security & integrity fixes
-- ============================================================

-- ── 1. Enable RLS on companies ──────────────────────────────────────────────
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Platform admin has full access
CREATE POLICY "companies_admin_all"
  ON public.companies FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- Authenticated users can read their own linked company (via profiles.company_id)
CREATE POLICY "companies_read_own"
  ON public.companies FOR SELECT
  USING (
    id IN (
      SELECT company_id FROM public.profiles
      WHERE id = auth.uid() AND company_id IS NOT NULL
    )
  );

-- ── 2. Fix organization_memberships INSERT policy ───────────────────────────
-- OLD: any logged-in user could insert any role for any org
-- NEW: authenticated users may only insert viewer/analyst roles for themselves;
--      org_admin and cx_manager roles require the inserter to already be org_admin
DROP POLICY IF EXISTS "memberships_insert_admin" ON public.organization_memberships;

CREATE POLICY "memberships_insert"
  ON public.organization_memberships FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND user_id = auth.uid()  -- can only add yourself
    AND (
      -- self-service: join as viewer only
      (role = 'viewer')
      -- OR an existing org_admin is promoting/inviting with any role
      OR has_org_role(org_id, 'org_admin')
      OR is_platform_admin()
    )
  );

-- ── 3. Add DELETE policies for kpi_definitions ──────────────────────────────
CREATE POLICY "kpi_def_delete"
  ON public.kpi_definitions FOR DELETE
  USING (has_org_role(org_id, 'cx_manager') OR is_platform_admin());

-- ── 4. Add DELETE and UPDATE policies for kpi_snapshots ─────────────────────
CREATE POLICY "kpi_snap_delete"
  ON public.kpi_snapshots FOR DELETE
  USING (has_org_role(org_id, 'cx_manager') OR is_platform_admin());

CREATE POLICY "kpi_snap_update"
  ON public.kpi_snapshots FOR UPDATE
  USING (has_org_role(org_id, 'cx_manager') OR is_platform_admin())
  WITH CHECK (has_org_role(org_id, 'cx_manager') OR is_platform_admin());

-- ── 5. Add UPDATE and DELETE policies for action_updates ────────────────────
CREATE POLICY "aupdates_update"
  ON public.action_updates FOR UPDATE
  USING (author_id = auth.uid() OR is_platform_admin())
  WITH CHECK (author_id = auth.uid() OR is_platform_admin());

CREATE POLICY "aupdates_delete"
  ON public.action_updates FOR DELETE
  USING (
    author_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.action_plans a
      WHERE a.id = action_updates.action_plan_id
        AND (has_org_role(a.org_id, 'cx_manager') OR is_platform_admin())
    )
  );

-- ── 6. Add CHECK constraint to quizzes (exactly one parent: lesson or module) ─
ALTER TABLE public.quizzes
  ADD CONSTRAINT quizzes_single_parent CHECK (
    (lesson_id IS NOT NULL AND module_id IS NULL)
    OR (lesson_id IS NULL AND module_id IS NOT NULL)
  );
