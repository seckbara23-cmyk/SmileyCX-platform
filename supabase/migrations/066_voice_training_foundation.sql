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
--      'self' for the self-assessment fallback.
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
--   7. public.voice_attempts (XP-F2-READY-01, decision D3): one row per started
--      voice attempt — learner, scenario, time, nothing else. It is the count of
--      the five attempts per lesson and access period, and it survives the
--      learner's voluntary erasure of their voice data, so erasing does not give
--      attempts back. It is personal data linked to the learner, not anonymous;
--      it goes with the account (on delete cascade).
--   8. public.voice_start_attempt(): starts a voice session and records the
--      attempt in one transaction, under a per-learner lock, so two concurrent
--      starts can never exceed the limit or open two live voice sessions.
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
  reason                   text        not null check (reason in ('learner_request', 'consent_withdrawal', 'account_deletion', 'admin_request')),
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

-- ══ 7. Voice attempt ledger (XP-F2-READY-01, D3) ═══════════════════════════
create table public.voice_attempts (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  scenario_id  uuid        not null references public.ai_scenarios(id) on delete cascade,
  started_at   timestamptz not null default now()
);

comment on table public.voice_attempts is
  'XP-F2-READY-01. One row per started voice attempt: learner, scenario, time. No content, no provider data. Kept after a voluntary voice-data erasure (decision D3); deleted with the account. Server only.';

create index voice_attempts_user_scenario_started_idx
  on public.voice_attempts (user_id, scenario_id, started_at);

alter table public.voice_attempts enable row level security;
revoke all on public.voice_attempts from public, anon, authenticated, service_role;
grant select, insert on public.voice_attempts to service_role;

-- ══ 8. Atomic start: one live voice session, five attempts per period ═══════
-- Returns 'started' with the new session id, or 'attempts_exhausted', or
-- 'session_in_progress', and the attempts used in the period after the call.
-- The transaction-scoped advisory lock serialises every start of one learner:
-- the count and the two inserts cannot interleave with another start.
create or replace function public.voice_start_attempt(
  p_user_id     uuid,
  p_scenario_id uuid,
  p_since       timestamptz,
  p_limit       integer
)
returns table (outcome text, session_id uuid, attempts_used integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_used    integer;
  v_session uuid;
begin
  if p_user_id is null or p_scenario_id is null or p_since is null or p_limit is null or p_limit < 1 then
    raise exception 'voice_start_attempt: invalid arguments';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('voice_start_attempt:' || p_user_id::text, 0));

  select count(*) into v_used
    from public.voice_attempts a
   where a.user_id = p_user_id and a.scenario_id = p_scenario_id and a.started_at >= p_since;
  if v_used >= p_limit then
    return query select 'attempts_exhausted'::text, null::uuid, v_used;
    return;
  end if;

  if exists (select 1 from public.ai_sessions s
              where s.user_id = p_user_id and s.status = 'active' and s.mode = 'voice') then
    return query select 'session_in_progress'::text, null::uuid, v_used;
    return;
  end if;

  insert into public.ai_sessions (scenario_id, user_id, anon_id, status, mode)
  values (p_scenario_id, p_user_id, null, 'active', 'voice')
  returning id into v_session;
  insert into public.voice_attempts (user_id, scenario_id) values (p_user_id, p_scenario_id);

  return query select 'started'::text, v_session, v_used + 1;
end
$fn$;

-- New functions are executable by everyone by default: the server only.
revoke all on function public.voice_start_attempt(uuid, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.voice_start_attempt(uuid, uuid, timestamptz, integer) to service_role;

-- ══ 9. Assertions ═══════════════════════════════════════════════════════════
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
  if not (select relrowsecurity from pg_class where oid = 'public.voice_attempts'::regclass)
     or has_table_privilege('anon', 'public.voice_attempts', 'SELECT')
     or has_table_privilege('authenticated', 'public.voice_attempts', 'SELECT')
     or has_table_privilege('service_role', 'public.voice_attempts', 'UPDATE')
     or has_table_privilege('service_role', 'public.voice_attempts', 'DELETE')
     or exists (select 1 from pg_policy where polrelid = 'public.voice_attempts'::regclass) then
    raise exception 'XP-F2-READY-01 066: the attempt ledger is not server-only and append-only';
  end if;
  if has_function_privilege('anon', 'public.voice_start_attempt(uuid, uuid, timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.voice_start_attempt(uuid, uuid, timestamptz, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.voice_start_attempt(uuid, uuid, timestamptz, integer)', 'EXECUTE') then
    raise exception 'XP-F2-READY-01 066: voice_start_attempt must be executable by the server only';
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
-- drop function if exists public.voice_start_attempt(uuid, uuid, timestamptz, integer);
-- Dropping the ledger gives every learner their attempts back (decision D3):
-- only while voice practice has never been open.
-- drop table if exists public.voice_attempts;
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
