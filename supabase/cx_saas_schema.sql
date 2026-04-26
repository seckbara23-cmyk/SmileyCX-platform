-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX CX SaaS — Complete Database Schema
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ══════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS that do NOT reference profiles yet
-- (is_platform_admin is defined AFTER profiles table is created below)
-- ══════════════════════════════════════════════════════════════════════

-- Get the role of the current user in a specific organization
CREATE OR REPLACE FUNCTION get_org_role(p_org_id UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT role FROM organization_memberships
  WHERE org_id = p_org_id AND user_id = auth.uid()
  LIMIT 1
$$;

-- Check if current user is a member of an organization
CREATE OR REPLACE FUNCTION is_org_member(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE org_id = p_org_id AND user_id = auth.uid()
  )
$$;

-- Check if user has at least a given role rank in an org
-- Roles ranked: viewer=1, analyst=2, team_manager=3, cx_manager=4, org_admin=5
CREATE OR REPLACE FUNCTION has_org_role(p_org_id UUID, p_min_role TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE org_id = p_org_id
      AND user_id = auth.uid()
      AND CASE role
            WHEN 'org_admin'    THEN 5
            WHEN 'cx_manager'   THEN 4
            WHEN 'team_manager' THEN 3
            WHEN 'analyst'      THEN 2
            WHEN 'viewer'       THEN 1
            ELSE 0
          END
          >= CASE p_min_role
            WHEN 'org_admin'    THEN 5
            WHEN 'cx_manager'   THEN 4
            WHEN 'team_manager' THEN 3
            WHEN 'analyst'      THEN 2
            WHEN 'viewer'       THEN 1
            ELSE 0
          END
  )
$$;

-- ══════════════════════════════════════════════════════════════════════
-- CORE IDENTITY TABLES
-- ══════════════════════════════════════════════════════════════════════

-- ── Profiles (extends auth.users) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  full_name      TEXT,
  avatar_url     TEXT,
  platform_role  TEXT NOT NULL DEFAULT 'user'
                   CHECK (platform_role IN ('user', 'super_admin', 'consultant')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Organizations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  logo_url     TEXT,
  industry     TEXT,
  country      TEXT,
  plan         TEXT NOT NULL DEFAULT 'trial'
                 CHECK (plan IN ('trial', 'starter', 'growth', 'enterprise')),
  plan_status  TEXT NOT NULL DEFAULT 'active'
                 CHECK (plan_status IN ('active', 'suspended', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- ── Organization Memberships ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('org_admin', 'cx_manager', 'team_manager', 'analyst', 'viewer')),
  invited_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON organization_memberships(org_id);

-- ── is_platform_admin — defined here after profiles table exists ──────
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND platform_role IN ('super_admin', 'consultant')
  )
$$;

-- ── Auto-create profile on signup ─────────────────────────────────────
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ══════════════════════════════════════════════════════════════════════
-- FEEDBACK / VOICE OF CUSTOMER
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feedback_sources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'manual'
               CHECK (type IN ('survey','nps','csat','ces','review','social','support','manual')),
  config     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_sources_org ON feedback_sources(org_id);

CREATE TABLE IF NOT EXISTS feedback_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id           UUID REFERENCES feedback_sources(id) ON DELETE SET NULL,
  touchpoint_id       UUID, -- FK added later after touchpoints table
  journey_stage_id    UUID, -- FK added later after journey_stages table
  score_type          TEXT CHECK (score_type IN ('nps','csat','ces','rating')),
  score               INTEGER,
  content             TEXT,
  respondent_segment  TEXT,
  channel             TEXT NOT NULL DEFAULT 'other'
                        CHECK (channel IN ('email','web','mobile','phone','in-store','social','app','other')),
  sentiment           TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  status              TEXT NOT NULL DEFAULT 'unreviewed'
                        CHECK (status IN ('unreviewed','reviewed','actioned','archived')),
  collected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_feedback_org        ON feedback_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_feedback_collected  ON feedback_entries(org_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status     ON feedback_entries(org_id, status);
CREATE INDEX IF NOT EXISTS idx_feedback_touchpoint ON feedback_entries(touchpoint_id);

CREATE TABLE IF NOT EXISTS feedback_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6c757d',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS feedback_entry_tags (
  feedback_entry_id UUID NOT NULL REFERENCES feedback_entries(id) ON DELETE CASCADE,
  tag_id            UUID NOT NULL REFERENCES feedback_tags(id) ON DELETE CASCADE,
  PRIMARY KEY(feedback_entry_id, tag_id)
);

-- ══════════════════════════════════════════════════════════════════════
-- CX STRUCTURE: JOURNEYS / STAGES / TOUCHPOINTS
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS journeys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  segment     TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','draft','archived')),
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journeys_org ON journeys(org_id);

CREATE TABLE IF NOT EXISTS journey_stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id  UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stages_journey ON journey_stages(journey_id);

CREATE TABLE IF NOT EXISTS touchpoints (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stage_id       UUID REFERENCES journey_stages(id) ON DELETE SET NULL,
  journey_id     UUID REFERENCES journeys(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  channel        TEXT NOT NULL DEFAULT 'other'
                   CHECK (channel IN ('email','web','phone','in-store','social','app','other')),
  owner          TEXT,
  avg_score      DECIMAL(5,2),
  feedback_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','inactive')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_touchpoints_org   ON touchpoints(org_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_stage ON touchpoints(stage_id);

-- Add deferred FKs for feedback_entries
ALTER TABLE feedback_entries
  ADD CONSTRAINT fk_feedback_touchpoint
    FOREIGN KEY (touchpoint_id) REFERENCES touchpoints(id) ON DELETE SET NULL;

ALTER TABLE feedback_entries
  ADD CONSTRAINT fk_feedback_stage
    FOREIGN KEY (journey_stage_id) REFERENCES journey_stages(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════════════════════
-- KPI MEASUREMENT
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kpi_definitions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  metric_type  TEXT NOT NULL DEFAULT 'custom'
                 CHECK (metric_type IN ('nps','csat','ces','custom')),
  target_value DECIMAL(10,2),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kpi_id       UUID NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  value        DECIMAL(10,2) NOT NULL,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_org    ON kpi_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_period ON kpi_snapshots(org_id, period_start DESC);

-- ══════════════════════════════════════════════════════════════════════
-- EXECUTION: ISSUES + ACTION PLANS
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS issues (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  touchpoint_id     UUID REFERENCES touchpoints(id) ON DELETE SET NULL,
  journey_stage_id  UUID REFERENCES journey_stages(id) ON DELETE SET NULL,
  priority          TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('critical','high','medium','low')),
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','resolved','closed')),
  created_by        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_to       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_org      ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_status   ON issues(org_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(org_id, priority);

CREATE TABLE IF NOT EXISTS action_plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id     UUID REFERENCES issues(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  owner_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','in_progress','completed','cancelled')),
  priority     TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('critical','high','medium','low')),
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actions_org     ON action_plans(org_id);
CREATE INDEX IF NOT EXISTS idx_actions_status  ON action_plans(org_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_due     ON action_plans(org_id, due_date);
CREATE INDEX IF NOT EXISTS idx_actions_owner   ON action_plans(owner_id);

CREATE TABLE IF NOT EXISTS action_updates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_plan_id   UUID NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  author_id        UUID REFERENCES profiles(id) ON DELETE SET NULL,
  content          TEXT NOT NULL,
  status_change    TEXT CHECK (status_change IN ('planned','in_progress','completed','cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_updates_plan ON action_updates(action_plan_id);

-- ══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_sources        ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_tags           ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_entry_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE journeys                ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_stages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE touchpoints             ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_definitions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_snapshots           ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_updates          ENABLE ROW LEVEL SECURITY;

-- ── Profiles policies ─────────────────────────────────────────────────
CREATE POLICY "profiles_select_own"    ON profiles FOR SELECT USING (auth.uid() = id OR is_platform_admin());
CREATE POLICY "profiles_insert_trigger" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"    ON profiles FOR UPDATE USING (auth.uid() = id OR is_platform_admin());

-- ── Organizations policies ────────────────────────────────────────────
-- Members can read their orgs; platform admins see all
CREATE POLICY "orgs_member_select" ON organizations FOR SELECT
  USING (is_org_member(id) OR is_platform_admin());
CREATE POLICY "orgs_admin_all" ON organizations FOR ALL
  USING (is_platform_admin());
-- Allow creating orgs (any authenticated user can create one)
CREATE POLICY "orgs_insert_authenticated" ON organizations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
-- Org admins can update their org
CREATE POLICY "orgs_admin_update" ON organizations FOR UPDATE
  USING (has_org_role(id, 'org_admin'));

-- ── Memberships policies ──────────────────────────────────────────────
CREATE POLICY "memberships_select_own" ON organization_memberships FOR SELECT
  USING (user_id = auth.uid() OR is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "memberships_insert_admin" ON organization_memberships FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL); -- controlled via API, not direct insert
CREATE POLICY "memberships_update_admin" ON organization_memberships FOR UPDATE
  USING (has_org_role(org_id, 'org_admin') OR is_platform_admin());
CREATE POLICY "memberships_delete_admin" ON organization_memberships FOR DELETE
  USING (has_org_role(org_id, 'org_admin') OR user_id = auth.uid() OR is_platform_admin());

-- ── Org-scoped table policies (feedback, journeys, issues, actions) ───
-- Pattern: org members can read; cx_manager+ can write; platform_admin can all

-- feedback_sources
CREATE POLICY "fsources_read"  ON feedback_sources FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "fsources_write" ON feedback_sources FOR INSERT WITH CHECK (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "fsources_update" ON feedback_sources FOR UPDATE USING (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "fsources_delete" ON feedback_sources FOR DELETE USING (has_org_role(org_id, 'org_admin'));

-- feedback_entries
CREATE POLICY "fentries_read"   ON feedback_entries FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "fentries_insert" ON feedback_entries FOR INSERT WITH CHECK (has_org_role(org_id, 'analyst'));
CREATE POLICY "fentries_update" ON feedback_entries FOR UPDATE USING (has_org_role(org_id, 'analyst'));
CREATE POLICY "fentries_delete" ON feedback_entries FOR DELETE USING (has_org_role(org_id, 'cx_manager'));

-- feedback_tags
CREATE POLICY "ftags_read"   ON feedback_tags FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "ftags_write"  ON feedback_tags FOR INSERT WITH CHECK (has_org_role(org_id, 'analyst'));
CREATE POLICY "ftags_update" ON feedback_tags FOR UPDATE USING (has_org_role(org_id, 'analyst'));
CREATE POLICY "ftags_delete" ON feedback_tags FOR DELETE USING (has_org_role(org_id, 'cx_manager'));

-- feedback_entry_tags: accessible if user can access the feedback entry
CREATE POLICY "fetags_read"   ON feedback_entry_tags FOR SELECT
  USING (EXISTS (SELECT 1 FROM feedback_entries f WHERE f.id = feedback_entry_id AND is_org_member(f.org_id)));
CREATE POLICY "fetags_write"  ON feedback_entry_tags FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM feedback_entries f WHERE f.id = feedback_entry_id AND has_org_role(f.org_id, 'analyst')));
CREATE POLICY "fetags_delete" ON feedback_entry_tags FOR DELETE
  USING (EXISTS (SELECT 1 FROM feedback_entries f WHERE f.id = feedback_entry_id AND has_org_role(f.org_id, 'analyst')));

-- journeys
CREATE POLICY "journeys_read"   ON journeys FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "journeys_insert" ON journeys FOR INSERT WITH CHECK (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "journeys_update" ON journeys FOR UPDATE USING (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "journeys_delete" ON journeys FOR DELETE USING (has_org_role(org_id, 'org_admin'));

-- journey_stages
CREATE POLICY "stages_read"   ON journey_stages FOR SELECT
  USING (EXISTS (SELECT 1 FROM journeys j WHERE j.id = journey_id AND is_org_member(j.org_id)));
CREATE POLICY "stages_write"  ON journey_stages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM journeys j WHERE j.id = journey_id AND has_org_role(j.org_id, 'cx_manager')));
CREATE POLICY "stages_update" ON journey_stages FOR UPDATE
  USING (EXISTS (SELECT 1 FROM journeys j WHERE j.id = journey_id AND has_org_role(j.org_id, 'cx_manager')));
CREATE POLICY "stages_delete" ON journey_stages FOR DELETE
  USING (EXISTS (SELECT 1 FROM journeys j WHERE j.id = journey_id AND has_org_role(j.org_id, 'org_admin')));

-- touchpoints
CREATE POLICY "touchpoints_read"   ON touchpoints FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "touchpoints_insert" ON touchpoints FOR INSERT WITH CHECK (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "touchpoints_update" ON touchpoints FOR UPDATE USING (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "touchpoints_delete" ON touchpoints FOR DELETE USING (has_org_role(org_id, 'org_admin'));

-- kpi_definitions
CREATE POLICY "kpi_def_read"   ON kpi_definitions FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "kpi_def_write"  ON kpi_definitions FOR INSERT WITH CHECK (has_org_role(org_id, 'cx_manager'));
CREATE POLICY "kpi_def_update" ON kpi_definitions FOR UPDATE USING (has_org_role(org_id, 'cx_manager'));

-- kpi_snapshots
CREATE POLICY "kpi_snap_read"  ON kpi_snapshots FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "kpi_snap_write" ON kpi_snapshots FOR INSERT WITH CHECK (has_org_role(org_id, 'cx_manager'));

-- issues
CREATE POLICY "issues_read"   ON issues FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "issues_insert" ON issues FOR INSERT WITH CHECK (has_org_role(org_id, 'analyst'));
CREATE POLICY "issues_update" ON issues FOR UPDATE USING (has_org_role(org_id, 'analyst'));
CREATE POLICY "issues_delete" ON issues FOR DELETE USING (has_org_role(org_id, 'cx_manager'));

-- action_plans
CREATE POLICY "actions_read"   ON action_plans FOR SELECT USING (is_org_member(org_id) OR is_platform_admin());
CREATE POLICY "actions_insert" ON action_plans FOR INSERT WITH CHECK (has_org_role(org_id, 'analyst'));
CREATE POLICY "actions_update" ON action_plans FOR UPDATE USING (has_org_role(org_id, 'analyst'));
CREATE POLICY "actions_delete" ON action_plans FOR DELETE USING (has_org_role(org_id, 'cx_manager'));

-- action_updates
CREATE POLICY "aupdates_read"   ON action_updates FOR SELECT
  USING (EXISTS (SELECT 1 FROM action_plans a WHERE a.id = action_plan_id AND is_org_member(a.org_id)));
CREATE POLICY "aupdates_insert" ON action_updates FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM action_plans a WHERE a.id = action_plan_id AND has_org_role(a.org_id, 'analyst')) AND author_id = auth.uid());

-- ══════════════════════════════════════════════════════════════════════
-- USEFUL VIEWS
-- ══════════════════════════════════════════════════════════════════════

-- NPS computed per org per month
CREATE OR REPLACE VIEW monthly_nps_view AS
SELECT
  org_id,
  DATE_TRUNC('month', collected_at)::DATE AS month,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE score >= 9)  AS promoters,
  COUNT(*) FILTER (WHERE score <= 6)  AS detractors,
  ROUND(
    (COUNT(*) FILTER (WHERE score >= 9)::decimal
     - COUNT(*) FILTER (WHERE score <= 6)::decimal)
    / NULLIF(COUNT(*), 0) * 100
  ) AS nps
FROM feedback_entries
WHERE score_type = 'nps' AND score IS NOT NULL
GROUP BY org_id, DATE_TRUNC('month', collected_at)::DATE;

-- CSAT average per org per month
CREATE OR REPLACE VIEW monthly_csat_view AS
SELECT
  org_id,
  DATE_TRUNC('month', collected_at)::DATE AS month,
  COUNT(*) AS total,
  ROUND(AVG(score::decimal), 1) AS csat_avg
FROM feedback_entries
WHERE score_type = 'csat' AND score IS NOT NULL
GROUP BY org_id, DATE_TRUNC('month', collected_at)::DATE;

-- Open issues count per org
CREATE OR REPLACE VIEW open_issues_view AS
SELECT org_id, priority, COUNT(*) AS count
FROM issues
WHERE status IN ('open', 'in_progress')
GROUP BY org_id, priority;

-- Overdue actions count per org
CREATE OR REPLACE VIEW overdue_actions_view AS
SELECT org_id, COUNT(*) AS count
FROM action_plans
WHERE status IN ('planned', 'in_progress')
  AND due_date < CURRENT_DATE
GROUP BY org_id;

-- Verify all created successfully
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
