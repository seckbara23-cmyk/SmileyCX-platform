-- ============================================================================
-- Migration 053 — F-5.2: publication accountability.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Same discipline and same shape as 045, 048, 049 and 052.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT HAPPENED — FOURTH OCCURRENCE ──────────────────────────────────────
--
-- On 2026-09-05 at 15:21:53Z and 15:22:13Z, `mesurer-l-experience-client`
-- (C2-F2) and `developper-une-culture-client` moved to is_published = true.
-- `courses.updated_at` was written on both rows, so the writer set it
-- explicitly — migration 049 deliberately never does.
--
-- `public.audit_log` recorded NOTHING. It holds 7 rows in total and has never
-- held a single `course.published` or `course.unpublished` row.
--
-- The owner has since ruled the change LEGITIMATE: the content owner is
-- actively publishing courses and authoring lessons through the Admin UI. So
-- this migration RESTORES NOTHING. It does not touch publication state, it
-- does not clear anyone's is_preview flags, and it hard-codes no course.
--
-- The defect is that the change could not be attributed at all. Three prior
-- correctives (043, 045, 048) and one restoration (049) all REPAIRED state;
-- none PREVENTED the next write or left a record of it. This one records.
--
-- ── ACCOUNTABILITY, NOT PROHIBITION ────────────────────────────────────────
--
-- Every trigger here is AFTER. An AFTER trigger's return value is discarded,
-- so it is structurally incapable of vetoing or rewriting a row: this file
-- cannot turn into a publication block by accident or by later edit. Publishing
-- stays exactly as available to the owner as it was yesterday.
--
-- AFTER also means only writes that ACTUALLY HAPPENED are recorded. A write
-- refused by RLS, by `courses_code_immutable` (028) or by a constraint never
-- reaches the recorder, and a transaction that later rolls back takes its audit
-- row with it. Refused ATTEMPTS remain the application's job — it already
-- records those with outcome 'failure', which is why the trigger always writes
-- 'success'.
--
-- ── WHY A DATABASE TRIGGER AND NOT MORE APPLICATION CODE ───────────────────
--
-- The application already writes a publication audit row from
-- `lib/admin/publication-audit.ts`. It is bound only to callers who go through
-- that function, and `lib/audit/log.ts` swallows its own insert failures by
-- design. An audit that any other write path can skip is not an audit. A
-- trigger binds every path that reaches the table: Admin UI, app server, the
-- Supabase SQL editor, a script, direct SQL, and any write path added later.
--
-- The two records COEXIST and answer different questions. The application row
-- (`course.published` / `course.unpublished`) names WHO. The trigger row
-- (`course.publication_observed`) proves THAT, on every path. A distinct
-- event_type is used precisely so neither family pollutes the other's counts —
-- `count(*) where event_type = 'course.published'` still means what it meant.
--
-- ── WHY SECURITY DEFINER ───────────────────────────────────────────────────
--
-- `audit_log` has RLS enabled (027) with a SELECT policy for platform admins
-- and NO INSERT policy at all. A trigger running as an ordinary caller would
-- therefore be silently refused — the worst possible failure for a witness.
-- SECURITY DEFINER runs it as the owner. `search_path` pins `public` first and
-- `pg_temp` LAST, and every relation is schema-qualified, so a temp table
-- cannot shadow the audit target.
--
-- ── WHY THERE IS NO EXCEPTION HANDLER AROUND THE INSERT ────────────────────
--
-- Deliberate and load-bearing. A guarded insert is a fail-open witness: it
-- would let the publication commit while the record silently vanished, which
-- is the exact failure mode of `lib/audit/log.ts` that this migration exists to
-- compensate for. If the audit row cannot be written, the publication does not
-- happen. The preflight below refuses to install unless every column the
-- recorder writes is nullable or defaulted, so the foreseeable causes of that
-- failure are eliminated before the trigger ever fires.
--
-- ── WHY 053 ────────────────────────────────────────────────────────────────
--
--   046  PERMANENTLY WITHDRAWN — would have weakened migration 011's
--        quiz_attempts RLS. Nothing numbered 046 may ever be created.
--   050  RESERVED — withdrawal-contract RLS phase (lessons_visible /
--        modules_visible), reserved by 049 and guarded by a test asserting no
--        050 file exists.
--   051  RESERVED — voice competency lexicon hardening.
--   052  USED — QUIZ-1B randomisation activation.
--
-- 053 is the first free number. This migration creates no policy and no grant,
-- so it cannot collide with the work 050 is held for.
--
-- ── WHAT THIS CANNOT DO ────────────────────────────────────────────────────
--
-- A trigger cannot defend itself against the owner of its own table. Anything
-- performed as `postgres` or `supabase_admin` — DISABLE TRIGGER, DROP TRIGGER,
-- CREATE OR REPLACE of the recorder body, a table rewrite, a restore — can
-- evade it. What closes that gap is not more SQL but DETECTION FROM OUTSIDE:
-- `public.publication_governance_installed()` below is readable by the standing
-- verifier `scripts/security/verify-publication-governance.mjs`, which reports
-- a disabled or missing recorder as a FAILURE rather than a pending item.
--
-- For the most realistic non-owner actor — a holder of the service-role key —
-- there is no evasion: `service_role` has bypassrls but does not own the table,
-- so it can neither DISABLE TRIGGER nor SET session_replication_role, and
-- ENABLE ALWAYS closes the replica-mode path even for the owner.
-- ============================================================================

begin;

-- ── 0. PREFLIGHT — refuse to install a witness that could fail ─────────────
--
-- Reads the catalog only. Writes nothing, and touches no course.
do $do$
declare
  v_missing text;
  v_notnull text;
  v_rows    bigint;
begin
  if to_regclass('public.courses') is null then
    raise exception 'F-5.2 053: public.courses does not exist';
  end if;
  if to_regclass('public.audit_log') is null then
    raise exception 'F-5.2 053: public.audit_log does not exist — migration 027 has not been applied';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'courses' and column_name = 'is_published'
  ) then
    raise exception 'F-5.2 053: public.courses has no is_published column';
  end if;

  -- Every column the recorder writes must exist.
  select string_agg(c, ', ' order by c) into v_missing
  from unnest(array[
    'event_type', 'actor_type', 'actor_id', 'actor_email',
    'method', 'outcome', 'ip', 'user_agent', 'metadata'
  ]) as c
  where not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'audit_log' and column_name = c
  );
  if v_missing is not null then
    raise exception 'F-5.2 053: public.audit_log is missing column(s): %', v_missing;
  end if;

  -- THE FAIL-CLOSED PRECONDITION. The recorder has no exception handler, so a
  -- NOT NULL column it does not write would block every publication on the
  -- platform the moment this migration commits. Refuse now, loudly, instead.
  select string_agg(column_name, ', ' order by column_name) into v_notnull
  from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'audit_log'
     and is_nullable  = 'NO'
     and column_default is null
     and column_name not in (
       'event_type', 'actor_type', 'outcome', 'metadata'
     );
  if v_notnull is not null then
    raise exception 'F-5.2 053: audit_log column(s) % are NOT NULL without a default and are not written by the recorder; installing would block all publishing', v_notnull;
  end if;

  select count(*) into v_rows from public.audit_log;
  raise notice 'F-5.2 053: preflight ok; audit_log holds % row(s) before install', v_rows;
end
$do$;


-- ── 1. THE RECORDER ────────────────────────────────────────────────────────

create or replace function public.audit_course_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row     jsonb;
  v_prev    boolean;
  v_next    boolean;
  v_claims  jsonb;
  v_actor   uuid;
  v_email   text;
  v_src     text := 'unattributed';
begin
  -- The WHEN clauses guarantee this function is entered only for a real
  -- transition, so there is no cheap-exit branch to write here.
  if tg_op = 'DELETE' then
    v_row  := to_jsonb(old);
    v_prev := old.is_published;
    v_next := null;                    -- the row is gone, not merely withdrawn
  elsif tg_op = 'INSERT' then
    v_row  := to_jsonb(new);
    v_prev := null;                    -- a birth, not a re-publication; same
    v_next := new.is_published;        -- convention as publication-audit.ts
  else
    v_row  := to_jsonb(new);
    v_prev := old.is_published;
    v_next := new.is_published;
  end if;

  -- Attribution is BEST EFFORT and must never suppress the record. The JWT
  -- claims setting is the only untrusted input here and both the jsonb and the
  -- uuid cast can raise, so PARSING is guarded. The insert below is
  -- deliberately OUTSIDE this block: a guarded insert would be a fail-open
  -- witness, which is the whole defect being corrected.
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_actor  := nullif(v_claims ->> 'sub', '')::uuid;
    v_email  := nullif(v_claims ->> 'email', '');
    if v_actor is not null then
      v_src := 'jwt';
    end if;
  exception
    -- A cancel or a shutdown is not a malformed claim. Re-raise those rather
    -- than mislabelling them as an attribution problem.
    when query_canceled or admin_shutdown then
      raise;
    when others then
      v_src := 'unparseable';
  end;

  insert into public.audit_log (
    event_type, actor_type, actor_id, actor_email,
    method, outcome, ip, user_agent, metadata
  )
  values (
    'course.publication_observed',
    case when v_actor is not null then 'admin' else 'system' end,
    v_actor,
    v_email,
    'db_trigger',
    'success',
    host(inet_client_addr()),
    nullif(current_setting('application_name', true), ''),
    jsonb_build_object(
      'courseId',            v_row ->> 'id',
      'courseCode',          v_row ->> 'code',
      'courseSlug',          v_row ->> 'slug',
      'courseTitle',         v_row ->> 'title',
      'previousIsPublished', v_prev,
      'newIsPublished',      v_next,
      'operation',           tg_op,
      'source',              'db_trigger',
      'triggerName',         tg_name,
      'actorSource',         v_src,
      'sessionUser',         session_user::text,
      'definerUser',         current_user::text,
      'txid',                txid_current()::text,
      'rowUpdatedAt',        v_row ->> 'updated_at'
    )
  );

  -- AFTER ... FOR EACH ROW: the return value is ignored either way.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$fn$;

comment on function public.audit_course_publication() is
  'F-5.2. AFTER INSERT/UPDATE/DELETE recorder on public.courses. Writes exactly one course.publication_observed row to public.audit_log for every publication TRANSITION, on every write path that reaches the table, inside the writer''s own transaction. Records, never refuses, and exempts no role. SECURITY DEFINER because audit_log has RLS with no INSERT policy. Fail-closed by design: no exception handler around the insert. Complements, never replaces, the attributed row written by lib/admin/publication-audit.ts.';

-- CREATE FUNCTION grants EXECUTE TO PUBLIC by default, and EXECUTE is exactly
-- the privilege CREATE TRIGGER consumes. Without this revoke, any role able to
-- create a table with columns named id/title/slug/is_published could attach
-- this SECURITY DEFINER function to it and forge rows into an append-only log.
-- CREATE TRIGGER checks EXECUTE at creation time, not per fire, so revoking
-- here does not stop the triggers created below.
revoke all on function public.audit_course_publication() from public;
revoke all on function public.audit_course_publication() from anon, authenticated;


-- ── 2. THE TRIGGERS ────────────────────────────────────────────────────────
--
-- WHEN clauses rather than `UPDATE OF is_published`, and rather than filtering
-- inside the function. The admin edit form posts is_published on EVERY save, so
-- a column list would fire on every title edit; worse, UPDATE OF fires on the
-- column appearing in the SET list rather than on its value changing, so a
-- BEFORE trigger assigning NEW.is_published as a side effect of another column
-- would commit a change the recorder never saw. 028 already installs
-- `courses_code_immutable` as a BEFORE UPDATE trigger on this exact table, so
-- that class of object is not hypothetical here.
--
-- Three triggers rather than one, because a WHEN clause may reference NEW only
-- on INSERT and OLD only on DELETE.

drop trigger if exists courses_audit_publication_update on public.courses;
create trigger courses_audit_publication_update
  after update on public.courses
  for each row
  when (old.is_published is distinct from new.is_published)
  execute function public.audit_course_publication();

-- A course created already published becomes publicly discoverable at birth.
drop trigger if exists courses_audit_publication_insert on public.courses;
create trigger courses_audit_publication_insert
  after insert on public.courses
  for each row
  when (new.is_published is true)
  execute function public.audit_course_publication();

-- Deleting a PUBLISHED course removes it from the catalogue: a publication
-- change by any reasonable reading, and the one that leaves no row behind to
-- inspect afterwards.
drop trigger if exists courses_audit_publication_delete on public.courses;
create trigger courses_audit_publication_delete
  after delete on public.courses
  for each row
  when (old.is_published is true)
  execute function public.audit_course_publication();

-- ENABLE ALWAYS, not the default ENABLE ORIGIN. A default trigger does not fire
-- when `session_replication_role = 'replica'`, which is a one-line session
-- setting for a superuser and would otherwise be a silent, trivial bypass.
alter table public.courses enable always trigger courses_audit_publication_update;
alter table public.courses enable always trigger courses_audit_publication_insert;
alter table public.courses enable always trigger courses_audit_publication_delete;


-- ── 3. THE OUTSIDE-VISIBLE PROBE ───────────────────────────────────────────
--
-- The one thing a trigger cannot do is prove it still exists. This function is
-- how the standing verifier asks. It is RELATION-scoped, not name-scoped: a
-- rename-and-recreate of `courses` (CREATE TABLE ... LIKE does NOT copy
-- triggers) leaves the names resolvable but the relation empty of them, and
-- this returns false. STABLE and side-effect free.

create or replace function public.publication_governance_installed()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $probe$
  select count(*) = 3
    from pg_trigger
   where tgrelid = 'public.courses'::regclass
     and not tgisinternal
     and tgenabled = 'A'                      -- 'A' = ENABLE ALWAYS
     and tgname in (
       'courses_audit_publication_update',
       'courses_audit_publication_insert',
       'courses_audit_publication_delete'
     );
$probe$;

comment on function public.publication_governance_installed() is
  'F-5.2. True only when all three publication recorders are attached to public.courses AND still ENABLE ALWAYS. Read by scripts/security/verify-publication-governance.mjs so that a disabled or dropped recorder is reported as a FAILURE from outside the database. Relation-scoped so a rename-and-recreate of courses is detected.';

grant execute on function public.publication_governance_installed() to authenticated;


-- ── 4. POSTCONDITIONS — catalog reads only, no row is written ──────────────
do $do$
declare
  v_installed boolean;
  v_secdef    boolean;
  v_cfg       text[];
  v_always    int;
  v_rows      bigint;
begin
  select public.publication_governance_installed() into v_installed;
  if not v_installed then
    raise exception 'F-5.2 053: the three recorders are not all installed and ENABLE ALWAYS on public.courses';
  end if;

  select p.prosecdef, p.proconfig into v_secdef, v_cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'audit_course_publication';

  if not coalesce(v_secdef, false) then
    raise exception 'F-5.2 053: audit_course_publication is not SECURITY DEFINER; it would be refused by audit_log RLS';
  end if;
  if v_cfg is null or not exists (select 1 from unnest(v_cfg) c where c like 'search_path=%') then
    raise exception 'F-5.2 053: audit_course_publication has no pinned search_path';
  end if;

  select count(*) into v_always
    from pg_trigger
   where tgrelid = 'public.courses'::regclass
     and not tgisinternal
     and tgname like 'courses_audit_publication_%'
     and tgenabled <> 'A';
  if v_always <> 0 then
    raise exception 'F-5.2 053: % recorder(s) are not ENABLE ALWAYS', v_always;
  end if;

  -- This migration touches no course, so it must have caused no recorder to
  -- fire. Anything else means it wrote to a table it had no business writing.
  select count(*) into v_rows
    from public.audit_log
   where event_type = 'course.publication_observed'
     and metadata ->> 'txid' = txid_current()::text;
  if v_rows <> 0 then
    raise exception 'F-5.2 053: this migration itself emitted % publication row(s); it must touch no course', v_rows;
  end if;

  raise notice 'F-5.2 053: installed — 3 recorders ENABLE ALWAYS on public.courses, probe true, 0 rows written by this migration';
end
$do$;

commit;

-- ============================================================================
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
--
--   ⚠ READ THIS BEFORE APPLYING — it changes a failure mode.
--
--   After this migration, if `public.audit_log` ever becomes unwritable, course
--   PUBLICATION CHANGES WILL FAIL until it is writable again. That is the point
--   of a fail-closed witness, and it is narrowly scoped — only publication
--   transitions, never ordinary course edits, never lessons, never learners.
--   The preflight refuses to install unless every column the recorder writes is
--   nullable or defaulted, which removes the foreseeable causes.
--
--   Any FUTURE migration that adds a column to audit_log must make it nullable
--   or defaulted, or it will block publishing.
--
--   ── RECOVERY ORDER, IF PUBLISHING IS EVER BLOCKED ──────────────────────
--
--   A. REPAIR THE WRITE PATH. Find out why audit_log is unwritable and fix
--      that. This is almost always a schema change that violated the rule
--      above, and it is minutes of work.
--
--   B. If F-5.2 ITSELF is defective and publishing must be restored before
--      the cause is understood, perform the FULL rollback at the foot of this
--      file — all three triggers and both functions, deliberately, as a
--      recorded incident action.
--
--   C. DO NOT disable a single recorder and carry on publishing.
--
--   (C) is called out because it is the tempting one, and it recreates the
--   exact failure F-5.2 exists to close: a publication transition occurring
--   with no database witness. Worse than the original, in fact — the original
--   had no control at all, whereas a half-disabled one still LOOKS like
--   coverage to anyone who does not run the probe. Two of the three recorders
--   would still be attached, so a casual glance at pg_trigger reassures.
--
--   The full rollback removes accountability too, but it removes it HONESTLY:
--   the state is known, `publication_governance_installed()` returns false,
--   and the standing verifier fails loudly until it is restored. An explicit
--   incident with a known state beats a silent partial control every time.
--
--     1. Merge the F-5.2 PR into main; wait for the production deployment to
--        report READY on the merge SHA.
--     2. Run this file in the Supabase SQL editor.
--     3. node scripts/security/verify-publication-governance.mjs   -> expect PASS
--     4. Confirm accountability is live by making one real publication change in
--        the Admin UI and re-running the verifier: a new
--        course.publication_observed row must appear.
--
-- WHAT THIS DOES NOT DO
--
--   * It does not change any course's publication state, and hard-codes none.
--   * It does not clear or alter any lesson's is_preview flag.
--   * It does not touch lessons, modules, quizzes, attempts, entitlements,
--     enrollments, certificates or storage.
--   * It does not create or alter any RLS policy or grant on a table.
--   * It cannot refuse a publication: every trigger is AFTER.
--   * It does not change PLATFORM_MODE, QUIZ-1A/1B, migration 052, final exams
--     or Voice/AI.
--
-- ROLLBACK — removes the accountability and restores the pre-053 behaviour, in
-- which publication changes leave no database record. Reverting re-opens the
-- defect that produced four recurrences, so it is an incident action, not a
-- convenience.
--
-- Run it WHOLE. Dropping only the UPDATE recorder leaves a control that still
-- reports two of three triggers attached while publication transitions go
-- unwitnessed — see RECOVERY ORDER above. All-or-nothing is the point:
-- `publication_governance_installed()` then returns false and the standing
-- verifier fails loudly, so the gap cannot be forgotten.
--
--   begin;
--   drop trigger if exists courses_audit_publication_update on public.courses;
--   drop trigger if exists courses_audit_publication_insert on public.courses;
--   drop trigger if exists courses_audit_publication_delete on public.courses;
--   drop function if exists public.audit_course_publication();
--   drop function if exists public.publication_governance_installed();
--   commit;
--
-- No audit row already written is removed by the rollback, and no course is
-- touched in either direction.
-- ============================================================================
