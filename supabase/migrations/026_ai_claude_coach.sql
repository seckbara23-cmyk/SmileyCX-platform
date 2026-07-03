-- ============================================================
-- Migration 026: AI Coach — Claude evaluation (Phase 2B)
--
-- Source of truth:
--   docs/architecture/AI_PRACTICE_ENGINE_PHASE_2_COACH.md  (§3, §5, §8, §9)
--
-- Additive only. Adds the columns needed to store ONE Claude evaluation per
-- completed session. No table is created and no data is modified.
--
-- The idempotency lock already exists: migration 024's unique index
-- ai_feedback_session_source_uidx (session_id, source) guarantees at most one
-- row per (session, source). Phase 1a writes source='self'; Phase 2B writes
-- source='claude'. The ai_feedback.source CHECK already allows 'claude', and
-- ai_scores.source already allows 'claude' (migration 025) — no constraint
-- change is required.
--
-- Claude is called AT MOST once per completed session; the stored report is
-- re-read forever. No LLM runs at read time.
-- ============================================================

alter table public.ai_feedback add column if not exists report          jsonb;   -- full structured coaching report (source='claude')
alter table public.ai_feedback add column if not exists model           text;    -- model id that produced the report
alter table public.ai_feedback add column if not exists prompt_version  text;    -- coach prompt version (traceability)
alter table public.ai_feedback add column if not exists input_tokens    integer; -- cost telemetry
alter table public.ai_feedback add column if not exists output_tokens   integer;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- alter table public.ai_feedback drop column if exists report;
-- alter table public.ai_feedback drop column if exists model;
-- alter table public.ai_feedback drop column if exists prompt_version;
-- alter table public.ai_feedback drop column if exists input_tokens;
-- alter table public.ai_feedback drop column if exists output_tokens;
-- delete from public.ai_feedback where source = 'claude';   -- optional: drop stored evaluations
-- delete from public.ai_scores   where source = 'claude';
