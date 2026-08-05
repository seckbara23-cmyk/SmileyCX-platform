-- ============================================================================
-- Migration 035 — XPA-6A: learner identity, legal acceptance, and the
--                 deny-by-default course-access seam.
--
-- Run as a SINGLE TRANSACTION. The first attempt failed and rolled back
-- atomically, leaving nothing behind — verified against production: none of the
-- eight new profiles columns, neither helper function, and no
-- legal_acceptances table existed afterwards. There is nothing to clean up and
-- nothing to patch by hand.
--
-- ── WHY THE FIRST ATTEMPT FAILED ───────────────────────────────────────────
--
-- Two defects, both mine, both about ORDER rather than intent.
--
-- 1. `current_account_status()` is `language sql`. PostgreSQL fully
--    parse-analyses a SQL-language function body at CREATE time — unlike
--    plpgsql, which only checks syntax. The function read
--    `profiles.account_status`, but the ALTER TABLE that adds that column came
--    LATER in the file, so creation failed with 42703 on the very first
--    statement that mattered.
--
--    Corrected by adding every column BEFORE any function that reads one.
--    Section order is now load-bearing and labelled as such.
--
-- 2. The hardened `profiles_update_own` policy pinned `disabled_at` using an
--    inline `select ... from public.profiles` — a subquery on the very table
--    the policy guards, which raises 42P17 "infinite recursion detected in
--    policy for relation profiles". This would NOT have surfaced until defect 1
--    was fixed, so it would have produced a second failed run.
--
--    Corrected by reading the stored value through a SECURITY DEFINER helper,
--    which is exactly why migration 027 introduced `current_platform_role()`.
--    The pattern was already established here; this migration simply failed to
--    follow it.
--
-- ── VERIFIED AGAINST PRODUCTION BEFORE REWRITING ───────────────────────────
--
--   profiles: avatar_url, company_id, created_at, email, full_name, id,
--             platform_role, role, updated_at        <- the complete live set
--   MISSING : first_name, last_name, display_name, preferred_language,
--             accepted_terms_version, accepted_privacy_version,
--             account_status, disabled_at            <- all added below
--   PRESENT : is_platform_admin(), current_platform_role()
--   PRESENT : enrollments(user_id, course_id, status), lessons(module_id,
--             is_preview), modules(course_id), quizzes(course_id, module_id,
--             lesson_id), quiz_questions(quiz_id), courses(id)
--
-- Every column this migration assumes on public.profiles is now either created
-- by section 1 or listed above as verified pre-existing. There are no others.
--
-- ── WHAT THE MIGRATION DOES ────────────────────────────────────────────────
--
--   1. THE ACCESS SEAM.  public.has_course_access(course_id) becomes the single
--      server-authoritative answer to "may this caller read this course's
--      learning material?". Every content policy is rewritten to call it.
--      XPA-6B extends THAT FUNCTION — no policy is touched again.
--
--   2. LEARNER IDENTITY.  Nullable name/language columns on the EXISTING
--      profiles table (no second profile model), plus account lifecycle state.
--
--   3. LEGAL ACCEPTANCE.  An append-only, versioned record of Terms and Privacy
--      acceptance.
--
-- ── WHY THE ACCESS SEAM IS A CORRECTION, NOT A FEATURE ─────────────────────
--
-- Measured against production with the public anon key — i.e. what any
-- anonymous visitor on the internet actually gets:
--
--     lessons        82 of 82 rows readable anonymously
--     modules        23 of 23 rows readable anonymously
--     quizzes         1 of 1  rows readable anonymously
--     quiz_questions  3 of 3  rows readable anonymously, correct_answer included
--
-- Three independent policy arms caused it, and the third is the decisive one:
--
--   a) `auth.uid() IS NULL AND courses.is_published` — the deliberate pilot arm
--      (migration 008).
--   b) `auth.uid() IS NOT NULL AND courses.is_free`  — migration 005 set
--      is_free = true on EVERY published course, so any authenticated user read
--      everything. With public registration opening in XPA-6A this arm alone
--      would mean "registration grants full course access", contradicting
--      ratified decisions 3 and 5.
--   c) `is_preview = true` — and ALL 82 lessons carried it. This arm is not
--      conditioned on the caller at all, so it would have survived the removal
--      of (a) and (b) and kept the entire catalogue world-readable.
--
-- (c) is why removing the pilot arm alone would have LOOKED like a fix and
-- changed nothing.
--
-- ── EFFECT, STATED PLAINLY ─────────────────────────────────────────────────
--
-- After this migration nobody reads lesson content without an ACTIVE
-- enrollment. There are currently ZERO enrollments and ZERO payments, so course
-- material becomes admin-only until XPA-6B ships the grant path. That is the
-- ratified commercial posture (decisions 3, 5, 6), not an accident.
--
-- Public discovery is untouched: `courses` is not restricted here, so the
-- catalogue, parcours and secteurs pages continue to work.
--
-- ── IDEMPOTENCY ────────────────────────────────────────────────────────────
-- Safe to re-run. Every object uses IF NOT EXISTS / OR REPLACE / DROP-then-
-- CREATE. The one data change (section 3) is guarded so that a re-run cannot
-- undo later editorial work — see the note there, which is the only place in
-- this file where "idempotent" needed more thought than a keyword.
-- ============================================================================


-- ══ 0. PREFLIGHT — fail fast and legibly ══════════════════════════════════
--
-- The first attempt failed with a bare 42703 several sections in. If a
-- dependency is ever missing again, say which one, at the top.
do $$
declare
  missing text := '';
begin
  if to_regclass('public.profiles')       is null then missing := missing || ' profiles';       end if;
  if to_regclass('public.enrollments')    is null then missing := missing || ' enrollments';    end if;
  if to_regclass('public.lessons')        is null then missing := missing || ' lessons';        end if;
  if to_regclass('public.modules')        is null then missing := missing || ' modules';        end if;
  if to_regclass('public.quizzes')        is null then missing := missing || ' quizzes';        end if;
  if to_regclass('public.quiz_questions') is null then missing := missing || ' quiz_questions'; end if;
  if to_regclass('public.courses')        is null then missing := missing || ' courses';        end if;

  if missing <> '' then
    raise exception 'XPA-6A 035 preflight: missing table(s):%', missing;
  end if;

  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'XPA-6A 035 preflight: public.is_platform_admin() is missing (expected from the pre-001 baseline)';
  end if;

  if to_regprocedure('public.current_platform_role()') is null then
    raise exception 'XPA-6A 035 preflight: public.current_platform_role() is missing (expected from migration 027)';
  end if;
end $$;


-- ══ 1. LEARNER PROFILE COLUMNS — FIRST, because functions below read them ══
--
-- ORDER IS LOAD-BEARING. A `language sql` function is parse-analysed when it is
-- created, so every column referenced by section 2 must already exist here.
-- This section moving after section 2 is precisely what broke the first run.
--
-- Additive and nullable on the EXISTING profiles table. The audit found no
-- reason for a second profile model, and a second one would immediately
-- disagree with the first.
--
-- Deliberately absent, per XPA-6A scope: no payment data, no entitlement
-- columns, no B2B membership. Identity stays separate from commerce.
alter table public.profiles
  add column if not exists first_name               text,
  add column if not exists last_name                text,
  add column if not exists display_name             text,
  add column if not exists preferred_language       text        not null default 'fr',
  add column if not exists accepted_terms_version   text,
  add column if not exists accepted_privacy_version text,
  add column if not exists account_status           text        not null default 'active',
  add column if not exists disabled_at              timestamptz;

-- Drop-then-add rather than a pg_constraint existence probe: it is genuinely
-- idempotent, and it is scoped to this table, whereas matching on conname alone
-- can collide with an identically named constraint elsewhere.
alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles
  add constraint profiles_account_status_check
  check (account_status in ('active', 'suspended', 'disabled'));

alter table public.profiles drop constraint if exists profiles_preferred_language_check;
alter table public.profiles
  add constraint profiles_preferred_language_check
  check (preferred_language in ('fr', 'en'));

comment on column public.profiles.account_status is
  'XPA-6A lifecycle state: active | suspended | disabled. Server-controlled — pinned against self-modification by profiles_update_own.';


-- ══ 2. IDENTITY HELPERS ═══════════════════════════════════════════════════
--
-- All three are SECURITY DEFINER for the same reason migration 027's
-- current_platform_role() is: they are read from inside RLS policies on the
-- very tables they query, and a plain subquery there recurses (42P17).

-- Email verification is mandatory for learner access (XPA-6A). auth.users is
-- the ONLY authority for it — the app never mirrors email_confirmed_at into a
-- column it could then forget to update.
create or replace function public.is_email_verified()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  )
$$;

comment on function public.is_email_verified() is
  'XPA-6A. True when the caller''s email is confirmed in auth.users. SECURITY DEFINER because auth.users is not readable by app roles.';


-- Stored account_status of the caller, read past RLS.
create or replace function public.current_account_status()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.account_status from public.profiles p where p.id = auth.uid()
$$;

comment on function public.current_account_status() is
  'XPA-6A. Stored account_status of the calling user, read past RLS. Used to pin the column in profiles_update_own without recursing into the policy.';


-- Stored disabled_at of the caller, read past RLS.
--
-- This exists ONLY to avoid recursion. The first version of this migration
-- inlined `(select p.disabled_at from public.profiles p where p.id =
-- auth.uid())` directly into the profiles UPDATE policy, which re-enters the
-- policy being evaluated and raises 42P17.
create or replace function public.current_disabled_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select p.disabled_at from public.profiles p where p.id = auth.uid()
$$;

comment on function public.current_disabled_at() is
  'XPA-6A. Stored disabled_at of the calling user, read past RLS. Exists to keep profiles_update_own free of a self-referential subquery (42P17).';


-- ══ 3. THE COURSE-ACCESS SEAM ═════════════════════════════════════════════
--
-- Deny by default. True ONLY for a platform admin, or a verified, active
-- learner holding an ACTIVE enrollment for that exact course.
--
-- XPA-6B EXTENDS THIS FUNCTION and nothing else: add an `or exists (... active
-- entitlement ...)` arm here and every content policy inherits it atomically.
--
-- Deliberately NOT here, and each omission is a decision:
--   * no `is_free` arm      — decision 4: account != payment != enrollment != access
--   * no `is_published` arm — publication controls DISCOVERY, never ACCESS
--   * no anonymous arm      — the pilot is over
create or replace function public.has_course_access(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p_course_id is not null
    and (
      public.is_platform_admin()
      or (
        auth.uid() is not null
        and public.is_email_verified()
        and coalesce(public.current_account_status(), 'active') = 'active'
        and exists (
          select 1
          from public.enrollments e
          where e.user_id   = auth.uid()
            and e.course_id = p_course_id
            and e.status    = 'active'
        )
      )
    )
$$;

comment on function public.has_course_access(uuid) is
  'XPA-6A course-access seam. The single server-authoritative answer to "may this caller read this course''s learning material?". Admin, or verified+active learner with an ACTIVE enrollment. XPA-6B extends THIS function; content policies must not be edited again.';

-- RLS policies are evaluated as the CALLING role, so anon and authenticated
-- both need EXECUTE or every policy that calls this raises permission denied.
-- Revoke first: functions are created with EXECUTE granted to PUBLIC.
revoke all on function public.is_email_verified()      from public;
revoke all on function public.current_account_status() from public;
revoke all on function public.current_disabled_at()    from public;
revoke all on function public.has_course_access(uuid)  from public;

grant execute on function public.is_email_verified()      to anon, authenticated;
grant execute on function public.current_account_status() to anon, authenticated;
grant execute on function public.current_disabled_at()    to anon, authenticated;
grant execute on function public.has_course_access(uuid)  to anon, authenticated;


-- ══ 4. RETIRE THE BLANKET PREVIEW FLAG ════════════════════════════════════
--
-- All 82 lessons carry is_preview = true, which makes "preview" meaningless and
-- the whole catalogue public. Reset it so the flag means what it says; the
-- policy below still honours it, so designating real preview lessons remains a
-- normal editorial action.
--
-- ── THE ONE PLACE IDEMPOTENCY NEEDED REAL THOUGHT ────────────────────────
-- An unconditional `set is_preview = false` is re-runnable in the trivial sense
-- and WRONG in the useful sense: re-applying this migration a year from now
-- would silently un-publish whatever preview lessons an administrator had
-- deliberately chosen since. A migration that quietly destroys later editorial
-- work is not idempotent, it is just repeatable.
--
-- So the correction fires only while the BROKEN pattern still holds — every
-- lesson flagged. Once a deliberate subset exists, this is a no-op forever.
do $$
declare
  n_total   integer;
  n_preview integer;
begin
  select count(*) into n_total   from public.lessons;
  select count(*) into n_preview from public.lessons where is_preview = true;

  if n_total > 0 and n_preview = n_total then
    update public.lessons set is_preview = false;
    raise notice 'XPA-6A 035: cleared the blanket is_preview flag on % lesson(s).', n_total;
  else
    raise notice 'XPA-6A 035: is_preview already a deliberate subset (%/%) — left untouched.', n_preview, n_total;
  end if;
end $$;


-- ══ 5. CONTENT POLICIES — rewritten onto the seam ═════════════════════════

-- ── lessons ──────────────────────────────────────────────────────────────
drop policy if exists "lessons_visible" on public.lessons;

create policy "lessons_visible" on public.lessons for select
  using (
    -- A genuine preview lesson stays public. This is the only remaining
    -- caller-independent arm, and it is now editorially controlled rather than
    -- set on every row.
    lessons.is_preview = true
    or exists (
      select 1 from public.modules m
      where m.id = lessons.module_id
        and public.has_course_access(m.course_id)
    )
  );

-- ── modules ──────────────────────────────────────────────────────────────
-- A module is structure, not content, and the lesson player needs the sidebar
-- to render for a preview lesson. Visible when the course is accessible, or
-- when the module actually contains a preview lesson.
drop policy if exists "modules_visible" on public.modules;

create policy "modules_visible" on public.modules for select
  using (
    public.has_course_access(modules.course_id)
    or exists (
      select 1 from public.lessons l
      where l.module_id = modules.id
        and l.is_preview = true
    )
  );

-- ── quizzes ──────────────────────────────────────────────────────────────
-- Three shapes exist: course-level (final exam), module-level, lesson-level.
-- No preview arm: an assessment is never a taster.
drop policy if exists "quizzes_visible" on public.quizzes;

create policy "quizzes_visible" on public.quizzes for select
  using (
    (quizzes.course_id is not null and public.has_course_access(quizzes.course_id))
    or (quizzes.module_id is not null and exists (
      select 1 from public.modules m
      where m.id = quizzes.module_id
        and public.has_course_access(m.course_id)
    ))
    or (quizzes.lesson_id is not null and exists (
      select 1 from public.lessons l
      join public.modules m on m.id = l.module_id
      where l.id = quizzes.lesson_id
        and public.has_course_access(m.course_id)
    ))
  );

-- ── quiz_questions ───────────────────────────────────────────────────────
-- Reachable only through an accessible quiz.
--
-- NOTE, recorded rather than half-fixed: `correct_answer` remains a column on
-- this table, so an ENTITLED learner can still read it via PostgREST. The
-- learner UI never selects it (both quiz players select an explicit safe column
-- list) and scoring is server-side (XPA-4), but column-level confidentiality
-- needs a learner-safe projection — the XPA-5A pattern. That is XPA-6D scope.
-- This migration reduces the exposed audience from "the entire internet" to
-- "learners an admin explicitly enrolled".
drop policy if exists "quiz_questions_visible" on public.quiz_questions;

create policy "quiz_questions_visible" on public.quiz_questions for select
  using (
    exists (
      select 1 from public.quizzes qz
      where qz.id = quiz_questions.quiz_id
        and (
          (qz.course_id is not null and public.has_course_access(qz.course_id))
          or (qz.module_id is not null and exists (
            select 1 from public.modules m
            where m.id = qz.module_id
              and public.has_course_access(m.course_id)
          ))
          or (qz.lesson_id is not null and exists (
            select 1 from public.lessons l
            join public.modules m on m.id = l.module_id
            where l.id = qz.lesson_id
              and public.has_course_access(m.course_id)
          ))
        )
    )
  );


-- ══ 6. CLOSE THE SELF-SERVICE ESCALATION THIS WOULD OTHERWISE OPEN ════════
--
-- Migration 027 lets a user UPDATE their own profile row and pins platform_role
-- so they cannot promote themselves. account_status is a NEW privileged column
-- on that same row, so without this a suspended learner could simply set
-- themselves back to 'active' — re-opening F-2 through a different column.
--
-- Migration 027 is NOT modified (ledger rule). Its policy is replaced by a
-- STRICTLY STRONGER one: same USING clause, same platform_role pin, plus pins
-- on account_status and disabled_at.
--
-- Every pinned value is read through a SECURITY DEFINER helper. Reading them
-- with an inline subquery on public.profiles is what raises 42P17 here.
drop policy if exists "profiles_update_own" on public.profiles;

create policy "profiles_update_own" on public.profiles for update
  using (auth.uid() = id or public.is_platform_admin())
  with check (
    (auth.uid() = id or public.is_platform_admin())
    and (
      public.is_platform_admin()
      or (
        platform_role  is not distinct from public.current_platform_role()
        and account_status is not distinct from coalesce(public.current_account_status(), 'active')
        and disabled_at    is not distinct from public.current_disabled_at()
      )
    )
  );

comment on policy "profiles_update_own" on public.profiles is
  'XPA-6A. Supersedes migration 027 with a strictly stronger WITH CHECK: platform_role stays pinned (F-2) and account_status / disabled_at are pinned too, so a suspended learner cannot reactivate themselves.';


-- ══ 7. VERSIONED LEGAL ACCEPTANCE ═════════════════════════════════════════
--
-- Append-only. One row per (user, document, version) — re-accepting the same
-- version is a no-op, accepting a NEW version adds a row, and the history is
-- never rewritten.
--
-- Deliberately minimal: no device fingerprint, no tracking identifiers. IP and
-- user agent are retained because they are the ordinary, proportionate evidence
-- that an acceptance occurred, and nothing more.
create table if not exists public.legal_acceptances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  document    text        not null check (document in ('terms', 'privacy')),
  version     text        not null check (btrim(version) <> ''),
  accepted_at timestamptz not null default now(),
  ip          text,
  user_agent  text
);

create unique index if not exists legal_acceptances_unique_idx
  on public.legal_acceptances (user_id, document, version);
create index if not exists legal_acceptances_user_idx
  on public.legal_acceptances (user_id, accepted_at desc);

comment on table public.legal_acceptances is
  'XPA-6A append-only record of Terms / Privacy acceptance, versioned. Written by the registration server action via service_role; never by the browser.';

alter table public.legal_acceptances enable row level security;

-- Read-only to the subject and to platform admins. No INSERT / UPDATE / DELETE
-- policy exists for app roles at all: writes happen exclusively through
-- service_role, which bypasses RLS. A missing policy is a denial.
drop policy if exists "legal_acceptances_select_own" on public.legal_acceptances;
create policy "legal_acceptances_select_own" on public.legal_acceptances for select
  using (user_id = auth.uid() or public.is_platform_admin());


-- ══ 8. PRIVILEGES — REVOKE FIRST, ALWAYS ══════════════════════════════════
--
-- D-GRANT (XPA-5A): Supabase applies
--   ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated
-- to the public schema, so legal_acceptances was born holding SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER. A bare `grant select` here
-- would be ADDITIVE and would restrict nothing.
--
-- Revoke first. The order is load-bearing.
revoke all on public.legal_acceptances from public;
revoke all on public.legal_acceptances from anon;
revoke all on public.legal_acceptances from authenticated;

-- Exactly one privilege, to exactly one role. anon gets nothing: an anonymous
-- caller has no legal acceptances and must not learn that the table exists.
grant select on public.legal_acceptances to authenticated;


-- ══ 9. APPLY-TIME ASSERTIONS ══════════════════════════════════════════════
--
-- The failure mode being guarded against is silent: an object that LOOKS
-- correct while carrying write access. Assert the resulting state rather than
-- trusting the statements above.
do $$
declare
  bad          text;
  n_total      integer;
  n_preview    integer;
  n_select     integer;
  missing_cols text;
begin
  -- 9a. Every column this migration promised on profiles actually exists.
  -- `as t(col)` names the table AND its column explicitly. `as c` alone leaves
  -- the bare reference below resolving through an alias that is both, which is
  -- legal but reads as ambiguous and breaks the moment the query grows.
  select string_agg(t.col, ', ') into missing_cols
  from unnest(array[
    'first_name', 'last_name', 'display_name', 'preferred_language',
    'accepted_terms_version', 'accepted_privacy_version',
    'account_status', 'disabled_at'
  ]) as t(col)
  where not exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'public'
      and ic.table_name   = 'profiles'
      and ic.column_name  = t.col
  );
  if missing_cols is not null then
    raise exception 'profiles is missing expected column(s): %', missing_cols;
  end if;

  -- 9b. legal_acceptances: authenticated holds SELECT and nothing else.
  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      = 'authenticated'
    and privilege_type <> 'SELECT';
  if bad is not null then
    raise exception 'legal_acceptances: authenticated holds unintended privileges: %', bad;
  end if;

  select count(*) into n_select
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      = 'authenticated'
    and privilege_type = 'SELECT';
  if n_select <> 1 then
    raise exception 'legal_acceptances: authenticated is missing SELECT';
  end if;

  -- 9c. anon and PUBLIC hold NOTHING on legal_acceptances.
  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      in ('anon', 'PUBLIC');
  if bad is not null then
    raise exception 'legal_acceptances: anon/PUBLIC still hold: %', bad;
  end if;

  -- 9d. The blanket preview flag is gone.
  --
  -- Asserts the DANGEROUS state is absent, not that zero previews exist. "Zero"
  -- would forbid an administrator from ever designating a preview lesson —
  -- turning a legitimate editorial act into a failed migration on the next run.
  select count(*) into n_total   from public.lessons;
  select count(*) into n_preview from public.lessons where is_preview = true;
  if n_total > 0 and n_preview = n_total then
    raise exception 'every lesson (%) is still flagged is_preview — the catalogue remains world-readable', n_total;
  end if;

  -- 9e. The seam denies an unauthenticated caller. has_course_access() is
  --     evaluated here with auth.uid() = NULL (no request context at apply
  --     time), which is exactly the anonymous case.
  if exists (
    select 1 from public.courses c
    where public.has_course_access(c.id)
      and not coalesce(public.is_platform_admin(), false)
  ) then
    raise exception 'has_course_access() grants access with no authenticated user';
  end if;

  raise notice 'XPA-6A 035: identity columns, access seam and legal acceptance verified.';
end $$;


-- ══ ROLLBACK ══════════════════════════════════════════════════════════════
-- Restoring pilot behaviour (NOT recommended — it re-opens anonymous access to
-- all course material):
--
--   update public.lessons set is_preview = true;   -- restores all 82 rows
--   -- then re-apply the policy bodies from migrations 008 and 010.
--
-- Dropping identity/legal additions only, leaving the access seam in place:
--
--   drop table if exists public.legal_acceptances;
--   alter table public.profiles
--     drop column if exists first_name,
--     drop column if exists last_name,
--     drop column if exists display_name,
--     drop column if exists preferred_language,
--     drop column if exists accepted_terms_version,
--     drop column if exists accepted_privacy_version,
--     drop column if exists account_status,
--     drop column if exists disabled_at;
--   drop function if exists public.current_disabled_at();
--   drop function if exists public.current_account_status();
-- ══════════════════════════════════════════════════════════════════════════
