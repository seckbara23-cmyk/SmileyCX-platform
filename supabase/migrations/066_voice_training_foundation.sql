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
--   4. At most one live session per learner, enforced by the database. Sessions
--      left « active » for more than an hour are closed as abandoned first: a
--      closed tab or a crash left them open, and the unique index needs it.
--
-- WHAT IT DOES NOT DO
--   No change to ai_scenarios, ai_turns or ai_feedback rows, no publication, no
--   agent id. Existing sessions keep mode 'self' unless they were voice.
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

create unique index if not exists ai_sessions_provider_conversation_unique
  on public.ai_sessions (provider_conversation_id)
  where provider_conversation_id is not null;

create index if not exists ai_sessions_user_scenario_mode_started_idx
  on public.ai_sessions (user_id, scenario_id, mode, started_at);

-- ══ 4. One live session per learner ═════════════════════════════════════════
update public.ai_sessions
   set status = 'abandoned', completed_at = coalesce(completed_at, now())
 where status = 'active'
   and started_at < now() - interval '1 hour';

create unique index if not exists ai_sessions_one_live_per_user
  on public.ai_sessions (user_id)
  where status = 'active' and user_id is not null;

-- ══ 5. Assertions ═══════════════════════════════════════════════════════════
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
end
$check$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — only while voice practice is still closed in code.
-- ════════════════════════════════════════════════════════════════════════════
-- begin;
-- drop index if exists public.ai_sessions_one_live_per_user;
-- drop index if exists public.ai_sessions_user_scenario_mode_started_idx;
-- drop index if exists public.ai_sessions_provider_conversation_unique;
-- alter table public.ai_sessions drop column if exists provider_conversation_id;
-- alter table public.ai_sessions drop column if exists mode;
-- drop table if exists public.voice_processing_consents;
-- commit;
