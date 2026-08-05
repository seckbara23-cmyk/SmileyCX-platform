-- ============================================================================
-- Migration 035 — XPA-6A: learner identity, legal acceptance, and the
--                 deny-by-default course-access seam.
--
-- Three things, in order of consequence:
--
--   1. THE ACCESS SEAM.  public.has_course_access(course_id) becomes the single
--      server-authoritative answer to "may this caller read this course's
--      learning material?". Every content policy is rewritten to call it.
--      XPA-6B extends THIS FUNCTION to consult entitlements — no policy has to
--      be touched again.
--
--   2. LEARNER IDENTITY.  Nullable name/language columns on the existing
--      profiles table (no new profile table — the audit found the existing one
--      sound), plus account lifecycle state.
--
--   3. LEGAL ACCEPTANCE.  An append-only, versioned record of Terms and Privacy
--      acceptance.
--
-- ── WHY THE ACCESS SEAM IS A CORRECTION, NOT A FEATURE ─────────────────────
--
-- Verified against production before writing this migration, using the public
-- anon key — i.e. what any anonymous visitor on the internet actually gets:
--
--     lessons        82 of 82 rows readable anonymously
--     modules        23 of 23 rows readable anonymously
--     quizzes         1 of 1  rows readable anonymously
--     quiz_questions  3 of 3  rows readable anonymously, correct_answer included
--
-- Three independent policy arms caused it, and the third is the one that
-- matters:
--
--   a) `auth.uid() IS NULL AND courses.is_published` — the deliberate pilot arm
--      (migration 008).
--   b) `auth.uid() IS NOT NULL AND courses.is_free`  — migration 005 set
--      is_free = true on every published course, so ANY authenticated user
--      reads everything. With public registration opening in XPA-6A this arm
--      alone would mean "registration grants full course access", which
--      directly contradicts ratified decisions 3 and 5.
--   c) `is_preview = true` — and ALL 82 lessons carry is_preview = true.
--      This arm is not conditioned on the caller at all, so it would survive
--      the removal of (a) and (b) and keep the entire catalogue world-readable.
--
-- (c) is why removing the pilot arm alone would have LOOKED like a fix and
-- changed nothing. The flag is reset below.
--
-- ── EFFECT, STATED PLAINLY ─────────────────────────────────────────────────
--
-- After this migration nobody reads lesson content without an ACTIVE
-- enrollment. There are currently ZERO enrollments and ZERO payments, so in
-- practice course material becomes admin-only until XPA-6B ships the grant
-- path. That is the ratified commercial posture (decisions 3, 5, 6), not an
-- accident — but it IS an outward-facing change and is called out in the
-- XPA-6A report rather than buried here.
--
-- Public discovery is untouched: `courses`, `public_courses`-style catalogue
-- reads, parcours and secteurs all continue to work, because `courses` itself
-- is not restricted here.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- See the ROLLBACK block at the foot of this file.
-- ============================================================================


-- ══ 1. IDENTITY HELPERS ═══════════════════════════════════════════════════

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


-- Current account_status of the caller, read past RLS. Mirrors the
-- current_platform_role() pattern from migration 027 and exists for the same
-- reason: the UPDATE policy below must compare against the STORED value, and
-- reading profiles from inside a profiles policy would recurse.
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
  'XPA-6A. Stored account_status of the calling user, read past RLS. Used to pin the column in profiles_update_own.';


-- ══ 2. THE COURSE-ACCESS SEAM ═════════════════════════════════════════════
--
-- Deny by default. Returns true ONLY for a platform admin, or a verified,
-- active learner holding an ACTIVE enrollment for that exact course.
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
  'XPA-6A course-access seam. The single server-authoritative answer to "may this caller read this course''s learning material?". Admin, or verified+active learner with an ACTIVE enrollment. XPA-6B extends THIS function to consult entitlements; content policies must not be edited again.';

-- RLS policies are evaluated as the CALLING role, so anon and authenticated
-- both need EXECUTE or every policy that calls this raises permission denied.
-- Revoke first: functions are created with EXECUTE granted to PUBLIC.
revoke all on function public.is_email_verified()        from public;
revoke all on function public.current_account_status()   from public;
revoke all on function public.has_course_access(uuid)    from public;

grant execute on function public.is_email_verified()      to anon, authenticated;
grant execute on function public.current_account_status() to anon, authenticated;
grant execute on function public.has_course_access(uuid)  to anon, authenticated;


-- ══ 3. RESET THE BLANKET PREVIEW FLAG ═════════════════════════════════════
--
-- All 82 lessons carry is_preview = true, which makes "preview" meaningless
-- and the whole catalogue public. Reset it so the flag means what it says; the
-- policy below still honours it, so designating real preview lessons remains a
-- normal editorial action.
--
-- Not data loss: a boolean flag with a one-line rollback (see foot of file).
update public.lessons set is_preview = false where is_preview is distinct from false;


-- ══ 4. CONTENT POLICIES — rewritten onto the seam ═════════════════════════

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
-- needs a learner-safe projection — the XPA-5A pattern. That is XPA-6D scope
-- and is listed as a remaining blocker in the XPA-6A report. This migration
-- reduces the exposed audience from "the entire internet" to "learners an
-- admin explicitly enrolled".
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


-- ══ 5. LEARNER PROFILE COLUMNS ════════════════════════════════════════════
--
-- Additive and nullable on the EXISTING profiles table. The audit found no
-- reason for a second profile model, and a second one would immediately
-- disagree with the first.
--
-- Deliberately absent, per the XPA-6A scope: no payment data, no entitlement
-- columns, no B2B membership. Identity stays separate from commerce.
alter table public.profiles
  add column if not exists first_name               text,
  add column if not exists last_name                text,
  add column if not exists display_name             text,
  add column if not exists preferred_language       text    not null default 'fr',
  add column if not exists accepted_terms_version   text,
  add column if not exists accepted_privacy_version text,
  add column if not exists account_status           text    not null default 'active',
  add column if not exists disabled_at              timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_account_status_check'
  ) then
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('active', 'suspended', 'disabled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_preferred_language_check'
  ) then
    alter table public.profiles
      add constraint profiles_preferred_language_check
      check (preferred_language in ('fr', 'en'));
  end if;
end $$;

comment on column public.profiles.account_status is
  'XPA-6A lifecycle state: active | suspended | disabled. Server-controlled — pinned against self-modification by profiles_update_own.';


-- ══ 6. CLOSE THE SELF-SERVICE ESCALATION THIS WOULD OTHERWISE OPEN ════════
--
-- Migration 027 lets a user UPDATE their own profile row and pins platform_role
-- so they cannot promote themselves. account_status is a NEW privileged column
-- on that same row, so without this a suspended learner could simply set
-- themselves back to 'active' — re-opening F-2 through a different column.
--
-- Migration 027 is NOT modified (ledger rule). Its policy is replaced by a
-- STRICTLY STRONGER one: same USING clause, same platform_role pin, plus pins
-- on account_status, disabled_at and platform_role's sibling `role`.
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
        and disabled_at    is not distinct from (
          select p.disabled_at from public.profiles p where p.id = auth.uid()
        )
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
  n_preview    integer;
  n_anon_grant integer;
begin
  -- 9a. legal_acceptances: authenticated holds SELECT and nothing else.
  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      = 'authenticated'
    and privilege_type <> 'SELECT';
  if bad is not null then
    raise exception 'legal_acceptances: authenticated holds unintended privileges: %', bad;
  end if;

  select count(*) into n_anon_grant
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      = 'authenticated'
    and privilege_type = 'SELECT';
  if n_anon_grant <> 1 then
    raise exception 'legal_acceptances: authenticated is missing SELECT';
  end if;

  -- 9b. anon holds NOTHING on legal_acceptances.
  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name   = 'legal_acceptances'
    and grantee      in ('anon', 'PUBLIC');
  if bad is not null then
    raise exception 'legal_acceptances: anon/PUBLIC still hold: %', bad;
  end if;

  -- 9c. The blanket preview flag is gone. If this ever fails again, the
  --     catalogue is world-readable regardless of every policy above.
  select count(*) into n_preview from public.lessons where is_preview = true;
  if n_preview <> 0 then
    raise exception 'is_preview is still set on % lesson(s) — content remains public', n_preview;
  end if;

  -- 9d. The seam denies an unauthenticated caller. has_course_access() is
  --     evaluated here with auth.uid() = NULL (no request context at apply
  --     time), which is exactly the anonymous case.
  if exists (
    select 1 from public.courses c
    where public.has_course_access(c.id)
      and not public.is_platform_admin()
  ) then
    raise exception 'has_course_access() grants access with no authenticated user';
  end if;

  raise notice 'XPA-6A 035: access seam, identity columns and legal acceptance verified.';
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
-- ══════════════════════════════════════════════════════════════════════════
