-- ============================================================
-- Migration 034: Voice scenario confidentiality boundary (XPA-5A)
--
-- Closes a pre-existing exposure found during XPA-5 verification: the anon key
-- could read EVERY column of a published ai_scenarios row through PostgREST,
-- including `prompt_template` (the 703-character persona/system prompt, which
-- states the evaluation criteria) and `agent_id`.
--
-- ── Why the application layer was not the problem ───────────────────────
-- The server was already correct. fetchVoiceScenario() maps to an explicit
-- allow-list, and agent_id is used only to derive a boolean and to call
-- ElevenLabs server-side. No client-side code queries this table at all.
--
-- The hole was RLS: `USING (is_published = true ...)` is COLUMN-BLIND. It
-- decides which ROWS are visible, never which COLUMNS — so anyone holding the
-- public anon key could bypass the server's projection entirely:
--
--     GET /rest/v1/ai_scenarios?select=prompt_template
--
-- A learner reading the system prompt learns exactly what the coach is told to
-- look for, which makes the exercise gameable and defeats its purpose.
--
-- ── The fix: structural, not cosmetic ───────────────────────────────────
-- 1. Revoke anon/authenticated access to the BASE table. Admin access is
--    untouched — the service-role client bypasses RLS, so every server action
--    and /admin/voice keeps working exactly as before.
-- 2. Add a learner-safe VIEW exposing only render-and-launch fields.
--    A view cannot return a column it does not select, so the boundary is
--    structural: no future query can widen it by accident.
--
-- The agent id deliberately does NOT appear in the view. ElevenLabs needs it
-- server-side only; startVoiceSession resolves it internally and returns just
-- the short-lived signed URL.
--
-- ── Strictly additive ───────────────────────────────────────────────────
-- No table, column, policy, trigger or row is altered or dropped. Existing RLS
-- policies remain in place (they simply no longer have a grant to act on for
-- the public roles). All 11 sessions, 36 turns, feedback and scores untouched.
-- ============================================================

-- ── 1. Learner-safe projection ───────────────────────────────────────────
-- Only what the UI needs to render the activity card and start the exercise.
-- Column names are those verified in production, not guessed.
create or replace view public.public_voice_scenarios as
select
  s.id,
  s.lesson_id,
  s.slug,
  s.title,
  s.persona_name,
  s.language,
  s.situation,          -- learner-facing brief
  s.objectives,         -- learner-facing goals (French)
  s.self_assessment,    -- rubric questions the learner answers about themselves
  -- Pre-conversation briefing. Included deliberately: it is ALREADY shown to
  -- the learner by CoachBriefing.tsx before they start (objective, goals,
  -- duration). These are stated aims, not hidden criteria — withholding them
  -- would break the existing experience this phase must preserve.
  -- `coach_prompt_overrides` is NOT included: that is coach prompt tuning.
  s.briefing,
  s.difficulty,
  s.order_index,
  -- Whether a live voice session is possible, WITHOUT revealing the agent id.
  -- The server still re-derives this (it also needs the API key, which the
  -- database cannot see) — this is for rendering, not authorization.
  (s.provider = 'elevenlabs' and s.agent_id is not null and btrim(s.agent_id) <> '') as voice_configured
from public.ai_scenarios s
where s.is_published = true;

comment on view public.public_voice_scenarios is
  'XPA-5A learner-safe projection of ai_scenarios. Published rows only. Deliberately EXCLUDES prompt_template, agent_id and coach_prompt_overrides. Structural confidentiality: a view cannot return a column it does not select.';

-- ── 2. Close the base table to the public roles ──────────────────────────
-- RLS decides rows; GRANTs decide reachability. Revoking here means the
-- PostgREST endpoint /rest/v1/ai_scenarios returns 42501 for anon regardless
-- of any current or future row policy.
revoke all on public.ai_scenarios from anon;
revoke all on public.ai_scenarios from authenticated;

-- ── 3. Make the view STRICTLY READ-ONLY ──────────────────────────────────
-- REVOKE FIRST. This is not defensive tidiness — without it the view is
-- writable by anonymous callers.
--
-- Supabase configures `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- anon, authenticated` for the public schema, so EVERY newly created table or
-- view inherits ALL privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER) the moment it is created. A bare `grant select` is
-- therefore ADDITIVE and restricts nothing — the write privileges are already
-- there.
--
-- That matters more for a view than a table. This view is
-- `security_invoker = false` (the default, and required here so the learner
-- projection can read past the base table's RLS). It is also auto-updatable:
-- one FROM entry, no aggregate or DISTINCT. So writes through it execute as
-- the VIEW OWNER and BYPASS the base table's RLS entirely.
--
-- Verified against production before this correction: an anonymous caller
-- could UPDATE and DELETE through the view, and INSERT reached foreign-key
-- validation (23503) rather than being refused on permissions. Read-only was
-- assumed; it was never enforced.
revoke all on public.public_voice_scenarios from public;
revoke all on public.public_voice_scenarios from anon;
revoke all on public.public_voice_scenarios from authenticated;

-- Now grant exactly one privilege, and only to the roles that need it.
grant select on public.public_voice_scenarios to anon, authenticated;

-- ── 4. Verification ──────────────────────────────────────────────────────
do $$
declare
  leaked   text;
  n_pub    integer;
  n_view   integer;
begin
  -- The view must not expose any confidential column, whatever it was called.
  select string_agg(column_name, ', ') into leaked
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'public_voice_scenarios'
    and column_name in ('prompt_template', 'agent_id', 'coach_prompt_overrides');

  if leaked is not null then
    raise exception 'learner-safe view exposes confidential column(s): %', leaked;
  end if;

  -- The view must show exactly the published scenarios — no more, no fewer.
  select count(*) into n_pub  from public.ai_scenarios where is_published;
  select count(*) into n_view from public.public_voice_scenarios;

  if n_pub <> n_view then
    raise exception 'view row count % does not match published scenarios %', n_view, n_pub;
  end if;

  raise notice 'XPA-5A: learner-safe view exposes % published scenario(s), 0 confidential columns', n_view;
end $$;

-- ── 5. Assert the EXACT privilege matrix ─────────────────────────────────
-- The intended matrix, and nothing else:
--   ai_scenarios            anon: none        authenticated: none
--   public_voice_scenarios  anon: SELECT      authenticated: SELECT
--
-- Asserted here rather than trusted, because the failure mode is silent: a
-- default-privilege grant leaves the object looking correct while quietly
-- carrying write access.
do $$
declare
  base_privs text;
  view_privs text;
begin
  select string_agg(distinct privilege_type, ', ' order by privilege_type)
    into base_privs
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'ai_scenarios'
    and grantee in ('anon', 'authenticated');

  if base_privs is not null then
    raise exception 'ai_scenarios still grants [%] to anon/authenticated — expected none', base_privs;
  end if;

  select string_agg(distinct privilege_type, ', ' order by privilege_type)
    into view_privs
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'public_voice_scenarios'
    and grantee in ('anon', 'authenticated');

  if view_privs is distinct from 'SELECT' then
    raise exception 'public_voice_scenarios grants [%] to anon/authenticated — expected SELECT only',
      coalesce(view_privs, 'none');
  end if;

  raise notice 'XPA-5A: privilege matrix verified — base: none, view: SELECT only';
end $$;

-- ============================================================
-- ROLLBACK (manual):
--   drop view if exists public.public_voice_scenarios;
--   grant select on public.ai_scenarios to anon, authenticated;
-- Note the rollback RESTORES BOTH exposures (confidential columns AND the
-- writable-view vector). It exists for completeness only and should not be run.
-- No session, turn, feedback or score row is affected either way.
-- ============================================================
