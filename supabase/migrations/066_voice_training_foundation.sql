-- ============================================================================
-- Migration 066 — XP-F2-01/02: voice-training foundation.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Voice practice is closed in code
-- (lib/ai/flags.ts: VOICE_PRACTICE_OPEN), and stays closed after this migration.
-- Apply it under its own gate, before any change that opens voice practice:
-- the session policy (lib/voice/session-policy.ts) reads what it adds.
--
-- WHAT IT ADDS
--   1. public.voice_processing_consents: one row per learner and consent
--      version; the learner reads their own rows, only the server writes.
--   2. ai_sessions.mode: 'voice' for a session started with the voice provider,
--      'self' for the self-assessment fallback. Started voice sessions are the
--      attempts counted per lesson.
--   3. ai_sessions.provider_conversation_id: the provider's conversation id,
--      kept so the post-call analysis can be fetched and the conversation
--      deleted on request. Unique.
--   4. At most one live VOICE session per learner, enforced by the database.
--      Self-assessment sessions are not concerned (XP-F2-03 revision): they cost
--      nothing, and an abandoned one must never block a learner.
--   5. ai_sessions.content_purged_at: when the transcript-bearing content of a
--      session was deleted under the retention design (XP-F2-03, a proposal).
--   6. public.voice_provider_erasures (XP-F2-04): the queue of conversations to
--      delete at the voice provider when the session, or the learner's account,
--      that pointed to them is already gone. It holds the provider's conversation
--      id and NOTHING about the learner. Server only: no browser role can read it.
--
-- WHAT IT DOES NOT DO
--   It changes NO existing row of any table: every existing session receives
--   mode 'self' by default, so the voice-only index cannot conflict with them,
--   and no clean-up statement is needed. No publication, no agent id.
-- ============================================================================

begin;

-- ══ 1. Consent ══════════════════════════════════════════════════════════════
create table public.voice_processing_consents (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  consent_version  text        not null check (consent_version ~ '^[a-z0-9.-]{1,40}$'),
  accepted_at      timestamptz not null default now(),
  withdrawn_at     timestamptz,
  primary key (user_id, consent_version),
  constraint voice_consent_withdrawn_after_accepted check (withdrawn_at is null or withdrawn_at >= accepted_at)
);

comment on table public.voice_processing_consents is
  'XP-F2-01. Explicit consent to the voice processing (privacy policy art. 6), per consent version. Server writes only.';

alter table public.voice_processing_consents enable row level security;
-- Supabase's default privileges grant every right on new tables to all four roles:
-- revoke them from each, service_role included, then grant what is needed.
revoke all on public.voice_processing_consents from public, anon, authenticated, service_role;
grant select on public.voice_processing_consents to authenticated;
grant select, insert, update on public.voice_processing_consents to service_role;

create policy "voice_consents_select_own" on public.voice_processing_consents
  for select to authenticated
  using (user_id = auth.uid());

-- ══ 2 and 3. Session mode and provider conversation ═════════════════════════
alter table public.ai_sessions
  add column if not exists mode text not null default 'self'
    check (mode in ('voice', 'self')),
  add column if not exists provider_conversation_id text
    check (provider_conversation_id is null or provider_conversation_id ~ '^[A-Za-z0-9_-]{8,128}$');

-- Sessions already linked to the voice provider are not distinguishable from the
-- self-assessment fallback before this migration; they stay 'self' and do not
-- count as attempts. New voice sessions are written with mode 'voice'.

alter table public.ai_sessions
  add column if not exists content_purged_at timestamptz;

create unique index if not exists ai_sessions_provider_conversation_unique
  on public.ai_sessions (provider_conversation_id)
  where provider_conversation_id is not null;

create index if not exists ai_sessions_user_scenario_mode_started_idx
  on public.ai_sessions (user_id, scenario_id, mode, started_at);

-- ══ 4. One live voice session per learner ═══════════════════════════════════
-- Voice sessions only: every pre-existing row is mode 'self', so this index cannot
-- fail on existing data, and self-assessment is never blocked by it.
create unique index if not exists ai_sessions_one_live_voice_per_user
  on public.ai_sessions (user_id)
  where status = 'active' and user_id is not null and mode = 'voice';

-- ══ 5. Browser roles on the learner-owned AI tables (XP-F2-03) ═════════════
-- These tables were created under the platform's default privileges, which give
-- anon and authenticated every right on a new table. Row security refuses their
-- writes (each table has a select-own policy only), but TRUNCATE is not governed
-- by row security. Every write is the server's (service role); learners only read
-- their own rows. ai_scenarios was hardened by 034; ai_competencies and ai_rubrics
-- carry admin policies and are left as they are.
revoke all on public.ai_sessions, public.ai_turns, public.ai_feedback, public.ai_scores, public.ai_recommendations
  from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.ai_sessions, public.ai_turns, public.ai_feedback, public.ai_scores, public.ai_recommendations
  from authenticated;

-- ══ 6. Provider erasure queue (XP-F2-04) ════════════════════════════════════
create table public.voice_provider_erasures (
  provider_conversation_id text        primary key check (provider_conversation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  reason                   text        not null check (reason in ('learner_request', 'account_deletion')),
  requested_at             timestamptz not null default now(),
  attempts                 integer     not null default 0 check (attempts >= 0),
  last_attempt_at          timestamptz,
  completed_at             timestamptz
);

comment on table public.voice_provider_erasures is
  'XP-F2-04. Conversations still to delete at the voice provider. No learner identifier. Server only.';

create index voice_provider_erasures_pending_idx
  on public.voice_provider_erasures (requested_at)
  where completed_at is null;

-- Row security with no policy: the browser roles can do nothing, even if a
-- privilege were granted by mistake later. Only the server (service role) works here.
alter table public.voice_provider_erasures enable row level security;
revoke all on public.voice_provider_erasures from public, anon, authenticated, service_role;
grant select, insert, update on public.voice_provider_erasures to service_role;

-- ══ 7. Assertions ═══════════════════════════════════════════════════════════
do $check$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.voice_processing_consents'::regclass) then
    raise exception 'XP-F2-01 066: row level security is off on voice_processing_consents';
  end if;
  if has_table_privilege('anon', 'public.voice_processing_consents', 'SELECT')
     or has_table_privilege('authenticated', 'public.voice_processing_consents', 'INSERT')
     or has_table_privilege('authenticated', 'public.voice_processing_consents', 'UPDATE')
     or has_table_privilege('service_role', 'public.voice_processing_consents', 'DELETE') then
    raise exception 'XP-F2-01 066: unexpected privilege on voice_processing_consents';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.voice_provider_erasures'::regclass)
     or has_table_privilege('anon', 'public.voice_provider_erasures', 'SELECT')
     or has_table_privilege('authenticated', 'public.voice_provider_erasures', 'SELECT')
     or has_table_privilege('service_role', 'public.voice_provider_erasures', 'DELETE')
     or exists (select 1 from pg_policy where polrelid = 'public.voice_provider_erasures'::regclass) then
    raise exception 'XP-F2-04 066: the provider erasure queue is not server-only';
  end if;
  if has_table_privilege('anon', 'public.ai_turns', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_sessions', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.ai_turns', 'INSERT')
     or has_table_privilege('authenticated', 'public.ai_feedback', 'DELETE')
     or not has_table_privilege('authenticated', 'public.ai_sessions', 'SELECT') then
    raise exception 'XP-F2-03 066: browser privileges on the learner-owned AI tables are not as intended';
  end if;
end
$check$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — only while voice practice is still closed in code.
-- ════════════════════════════════════════════════════════════════════════════
-- begin;
-- drop index if exists public.ai_sessions_one_live_voice_per_user;
-- drop index if exists public.ai_sessions_user_scenario_mode_started_idx;
-- drop index if exists public.ai_sessions_provider_conversation_unique;
-- alter table public.ai_sessions drop column if exists content_purged_at;
-- alter table public.ai_sessions drop column if exists provider_conversation_id;
-- alter table public.ai_sessions drop column if exists mode;
-- drop table if exists public.voice_processing_consents;
-- Only when it is empty of pending rows: dropping the queue forgets the provider
-- copies still to delete. Check `select count(*) ... where completed_at is null` first.
-- drop table if exists public.voice_provider_erasures;
-- The privilege revokes of section 5 are deliberately NOT reverted: they remove
-- rights no code uses.
-- commit;
