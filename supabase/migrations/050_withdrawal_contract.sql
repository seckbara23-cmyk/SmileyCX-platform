-- ============================================================================
-- Migration 050 — XPA-8 WC-1: the withdrawal contract.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- This is the number migration 049 reserved for exactly this change.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--   Apply WITH SOMEONE WATCHING. These are the two policies migration 035 once
--   made unevaluatable for every caller (42P17), so a failed apply is not a
--   fire-and-forget event.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- Ratified in 035 and 037:  publication controls DISCOVERY, never ACCESS.
--
-- The access half has always held: withdrawing a course never removed a held
-- entitlement. The discovery half did not. `lessons_visible` (036) admits a
-- row on `is_preview = true` ALONE and never consults the owning course, and
-- `modules_visible` admits a module on `module_has_preview_lesson()` alone.
-- So a WITHDRAWN course kept serving its preview lessons and their modules to
-- anonymous and unentitled callers.
--
-- It happened twice, both times through ordinary authoring, and each time a
-- corrective CLEARED THE FLAGS (045, 048, and again inside 049). Clearing flags
-- destroys authoring state and treats one incident, not the cause.
-- docs/xpa-8-withdrawal-contract-gap.md records the debt;
-- docs/xpa-8-withdrawal-contract-proposal.md is the design (Option A).
--
-- ── THE CONTRACT THIS MIGRATION ENFORCES ───────────────────────────────────
--
--   Anonymous / unentitled PREVIEW visibility requires BOTH:
--     the lesson is a preview  AND  its course is published.
--
--   Entitled access is UNCHANGED and remains independent of publication.
--   Platform admins are UNCHANGED (has_course_access admits them).
--   Withdrawal does NOT touch preview flags: republishing restores the
--   teaser exactly as the curator left it.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
--   + public.course_is_published(uuid)     new SECURITY DEFINER helper
--   ~ policy lessons_visible  (USING only) preview arm gains the publication test
--   ~ policy modules_visible  (USING only) preview arm gains the publication test
--
-- ALTER POLICY, not DROP/CREATE: the policy name, command (SELECT) and roles
-- are kept by construction and only the USING expression is replaced. There is
-- no instant, even inside the transaction, where either table has no policy.
--
-- ── WHAT DOES NOT CHANGE ───────────────────────────────────────────────────
--
--   * has_course_access(), entitlements, enrollments — the access authority
--   * course_of_lesson(), course_of_module(), module_has_preview_lesson()
--   * quizzes_visible, quiz_questions_visible, exercises_select — no preview arm
--   * public_course_modules / public_course_lessons (039) — already gated on
--     c.is_published = true, which is the rule the base tables now match
--   * any lesson, module, course, preview flag or publication state (0 rows)
--   * which COLUMNS a visible row exposes. Anonymous object-path disclosure is a
--     separate finding with its own work item and is deliberately NOT here.
--   * 046 stays withdrawn; 051 stays reserved; 052 and 053 are untouched.
--
-- ── RECURSION SAFETY ───────────────────────────────────────────────────────
--
-- 035 produced 42P17 because lessons_visible queried modules and
-- modules_visible queried lessons. 036's rule, kept here: NO content policy may
-- query another RLS-protected table directly. Every cross-table lookup goes
-- through a SECURITY DEFINER function with a pinned search_path, which runs as
-- the function owner and does not re-enter any policy (no table uses FORCE
-- ROW LEVEL SECURITY). course_is_published() reads `courses`, whose own policy
-- (courses_public_select, 001) references no content table — and it would stay
-- safe even if that ever changed, because the definer call never evaluates it.
-- Section 3 does not take this on trust: it READS every content table as anon
-- and as authenticated and aborts on any error.
--
-- ── WHY course_of_lesson IN THE PREVIEW ARM ────────────────────────────────
--
-- The existing 036 helper, as ratified for this change. The ACCESS arm keeps
-- its byte-identical 036 form, has_course_access(course_of_module(module_id)),
-- so the entitled path is not re-expressed at all.
-- ============================================================================

-- REPEATABLE READ, so every assertion below reads ONE snapshot. Sections 4 and 5
-- compare counts taken by separate statements; under the default READ COMMITTED
-- an unrelated commit in another session (a login audit row, an admin saving a
-- lesson) could land between two of them and abort a correct migration.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — the world is what this migration was written against ═══
do $do$
declare
  v_missing  text;
  v_qual     text;
  v_body     text;
  v_rls      text;
begin
  select string_agg(p, ', ') into v_missing
    from unnest(array[
      'public.has_course_access(uuid)',
      'public.course_of_lesson(uuid)',
      'public.course_of_module(uuid)',
      'public.module_has_preview_lesson(uuid)'
    ]) as p
   where to_regprocedure(p) is null;
  if v_missing is not null then
    raise exception 'WC-1 050 preflight: required function(s) missing: %', v_missing;
  end if;

  select string_agg(t, ', ') into v_rls
    from unnest(array['courses', 'modules', 'lessons']) as t
   where not exists (
     select 1 from pg_class c
      where c.oid = to_regclass('public.' || t) and c.relrowsecurity
   );
  if v_rls is not null then
    raise exception 'WC-1 050 preflight: row level security is not enabled on: %', v_rls;
  end if;

  -- The two policies must still be the 036 forms. Anything else means they were
  -- changed out of band, and replacing them blind would hide that.
  select pg_get_expr(p.polqual, p.polrelid) into v_qual
    from pg_policy p
   where p.polrelid = 'public.lessons'::regclass and p.polname = 'lessons_visible'
     and p.polcmd = 'r';
  if v_qual is null
     or v_qual !~ 'is_preview = true'
     or v_qual !~ 'has_course_access\((public\.)?course_of_module\(module_id\)\)'
     or v_qual ~* 'course_is_published' then
    raise exception 'WC-1 050 preflight: lessons_visible is not the expected 036 SELECT policy: %', coalesce(v_qual, '<absent>');
  end if;

  select pg_get_expr(p.polqual, p.polrelid) into v_qual
    from pg_policy p
   where p.polrelid = 'public.modules'::regclass and p.polname = 'modules_visible'
     and p.polcmd = 'r';
  if v_qual is null
     or v_qual !~ 'has_course_access\(course_id\)'
     or v_qual !~ 'module_has_preview_lesson\(id\)'
     or v_qual ~* 'course_is_published' then
    raise exception 'WC-1 050 preflight: modules_visible is not the expected 036 SELECT policy: %', coalesce(v_qual, '<absent>');
  end if;

  -- The access authority must not itself depend on publication. If it did, this
  -- migration's promise that entitled learners keep withdrawn courses would be
  -- false before a line of it ran.
  select pg_get_functiondef('public.has_course_access(uuid)'::regprocedure) into v_body;
  if v_body ~* 'is_published' then
    raise exception 'WC-1 050 preflight: has_course_access() references is_published; the access/discovery separation this migration relies on no longer holds';
  end if;

  raise notice 'WC-1 050 preflight: helpers present, RLS enabled, both policies are the 036 forms, access authority is publication-independent';
end
$do$;


-- ══ 1. HELPER — is this course published? ═════════════════════════════════
--
-- coalesce(..., false): a course that cannot be resolved — a null id, an orphan,
-- a course that does not exist — is NOT published. Fail closed. It also makes a
-- withdrawn course and a nonexistent one indistinguishable to the caller, the
-- same disclosure rule UX-1 applies on the learner surface.
--
-- Publication state is not privileged: public_course_lessons (039) already
-- exposes it to anon for published courses, and an unpublished or unknown id
-- answers false either way. The definer rights leak nothing.

create or replace function public.course_is_published(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select c.is_published from public.courses c where c.id = p_course_id),
    false
  )
$fn$;

comment on function public.course_is_published(uuid) is
  'XPA-8 WC-1/050. True only when the course exists and is published. Read past RLS so the content policies never query courses directly (42P17 discipline from 036). Fail-closed: unknown or null id is false.';

revoke all on function public.course_is_published(uuid) from public;
grant execute on function public.course_is_published(uuid) to anon, authenticated;


-- ══ 2. POLICIES — USING only; name, command and roles unchanged ═══════════

alter policy "lessons_visible" on public.lessons
  using (
    (lessons.is_preview = true
     and public.course_is_published(public.course_of_lesson(lessons.id)))
    or public.has_course_access(public.course_of_module(lessons.module_id))
  );

alter policy "modules_visible" on public.modules
  using (
    public.has_course_access(modules.course_id)
    or (public.module_has_preview_lesson(modules.id)
        and public.course_is_published(modules.course_id))
  );

-- The new expressions must say what this file says, and nothing structural may
-- have moved with them.
do $do$
declare
  v_qual  text;
  v_roles oid[];
begin
  select pg_get_expr(p.polqual, p.polrelid), p.polroles into v_qual, v_roles
    from pg_policy p
   where p.polrelid = 'public.lessons'::regclass and p.polname = 'lessons_visible'
     and p.polcmd = 'r';
  if v_qual is null
     or v_qual !~ 'is_preview = true'
     or v_qual !~ 'course_is_published\((public\.)?course_of_lesson\(id\)\)'
     or v_qual !~ 'has_course_access\((public\.)?course_of_module\(module_id\)\)'
     or v_qual ~* '\m(select|exists)\M' then
    raise exception 'WC-1 050: lessons_visible did not take the intended form: %', coalesce(v_qual, '<absent>');
  end if;
  if v_roles <> array[0::oid] then
    raise exception 'WC-1 050: lessons_visible roles changed: %', v_roles;
  end if;
  -- Exactly ONE publication test, or it has leaked onto the entitled arm and a
  -- learner holding a withdrawn course would lose it. Behavioural checks below
  -- run as anon only, so this is the in-database guard for that arm.
  if (length(v_qual) - length(replace(v_qual, 'course_is_published', ''))) / length('course_is_published') <> 1 then
    raise exception 'WC-1 050: lessons_visible must test publication exactly once (preview arm only): %', v_qual;
  end if;

  select pg_get_expr(p.polqual, p.polrelid), p.polroles into v_qual, v_roles
    from pg_policy p
   where p.polrelid = 'public.modules'::regclass and p.polname = 'modules_visible'
     and p.polcmd = 'r';
  if v_qual is null
     or v_qual !~ 'has_course_access\(course_id\)'
     or v_qual !~ 'module_has_preview_lesson\(id\)'
     or v_qual !~ 'course_is_published\(course_id\)'
     or v_qual ~* '\m(select|exists)\M' then
    raise exception 'WC-1 050: modules_visible did not take the intended form: %', coalesce(v_qual, '<absent>');
  end if;
  if v_roles <> array[0::oid] then
    raise exception 'WC-1 050: modules_visible roles changed: %', v_roles;
  end if;
  if (length(v_qual) - length(replace(v_qual, 'course_is_published', ''))) / length('course_is_published') <> 1 then
    raise exception 'WC-1 050: modules_visible must test publication exactly once (preview arm only): %', v_qual;
  end if;

  -- The recursion guarantee is a property of the HELPER, not of any result: an
  -- invoker-rights version returns the same answers today and re-opens the 42P17
  -- class the moment courses gains a policy that reads content. So assert the
  -- property itself.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.course_is_published(uuid)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
  ) then
    raise exception 'WC-1 050: course_is_published() must be STABLE SECURITY DEFINER with a pinned search_path';
  end if;
  if not has_function_privilege('anon', 'public.course_is_published(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.course_is_published(uuid)', 'execute') then
    raise exception 'WC-1 050: anon and authenticated must both hold EXECUTE on course_is_published()';
  end if;

  raise notice 'WC-1 050: both policies carry the publication test in the preview arm only; roles unchanged; helper is STABLE SECURITY DEFINER with pinned search_path';
end
$do$;


-- ══ 3. EXERCISE — every content table readable as every app role ══════════
--
-- The assertion 035 lacked. SET ROLE applies RLS exactly as a real request
-- does; auth.uid() is NULL here, which is the anonymous case. A recursion, a
-- missing EXECUTE grant or a missing SELECT grant raises and aborts.
do $do$
declare
  r text;
  t text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    begin
      execute format('set role %I', r);
      foreach t in array array[
        'courses', 'modules', 'lessons', 'quizzes', 'quiz_questions', 'exercises',
        'public_course_modules', 'public_course_lessons'
      ] loop
        execute format('select count(*) from public.%I', t);
      end loop;
      reset role;
    exception when others then
      reset role;
      raise exception 'WC-1 050: content is not evaluatable as role % on %: % (%)',
        r, coalesce(t, '?'), sqlerrm, sqlstate;
    end;
  end loop;
  raise notice 'WC-1 050: all content tables and public views evaluate cleanly as anon and authenticated';
end
$do$;


-- ══ 4. THE INVARIANT ON REAL DATA — read only ═════════════════════════════
--
-- What anon may see is exactly the preview lessons of PUBLISHED courses, and
-- exactly the modules holding one. Computed independently as the owner, then
-- compared with what the policy actually returns. Nothing is written.
do $do$
declare
  v_expect_lessons  integer;
  v_expect_modules  integer;
  v_withdrawn_prev  integer;
  v_seen_lessons    integer;
  v_seen_modules    integer;
  v_seen_withdrawn  integer;
  v_seen_courses    integer;
  v_seen_quiz       integer;
begin
  select count(*) into v_expect_lessons
    from public.lessons l
    join public.modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
   where l.is_preview and c.is_published;

  select count(distinct m.id) into v_expect_modules
    from public.lessons l
    join public.modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
   where l.is_preview and c.is_published;

  select count(*) into v_withdrawn_prev
    from public.lessons l
    join public.modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
   where l.is_preview and not c.is_published;

  set role anon;
  select count(*) into v_seen_lessons from public.lessons;
  select count(*) into v_seen_modules from public.modules;
  select count(*) into v_seen_withdrawn
    from public.lessons l
   where not public.course_is_published(public.course_of_lesson(l.id));
  select count(*) into v_seen_courses from public.courses;
  select count(*) into v_seen_quiz
    from (select id from public.quizzes union all select id from public.quiz_questions) q;
  reset role;

  if v_seen_lessons <> v_expect_lessons then
    raise exception 'WC-1 050: anon sees % lesson(s); preview lessons of published courses number %',
      v_seen_lessons, v_expect_lessons;
  end if;
  if v_seen_modules <> v_expect_modules then
    raise exception 'WC-1 050: anon sees % module(s); modules holding a published preview lesson number %',
      v_seen_modules, v_expect_modules;
  end if;
  if v_seen_withdrawn <> 0 then
    raise exception 'WC-1 050: anon sees % lesson(s) belonging to an unpublished course', v_seen_withdrawn;
  end if;
  if v_seen_courses = 0 then
    raise exception 'WC-1 050: anon can no longer read the course catalogue; public discovery is broken';
  end if;
  if v_seen_quiz <> 0 then
    raise exception 'WC-1 050: anon can read % quiz or question row(s); those policies must be unchanged', v_seen_quiz;
  end if;

  raise notice 'WC-1 050: anon sees % preview lesson(s) in % module(s), % course(s); % preview flag(s) on unpublished courses now hidden and preserved',
    v_seen_lessons, v_seen_modules, v_seen_courses, v_withdrawn_prev;
exception when others then
  reset role;
  raise;
end
$do$;


-- ══ 5. WITHDRAWN-COURSE FIXTURE — proven, then rolled back ════════════════
--
-- A synthetic course with one preview and one non-preview lesson is taken
-- through publish -> withdraw -> republish, reading as anon at each step.
--
-- The whole fixture lives inside a subtransaction that ENDS by raising the
-- sentinel SQLSTATE XW050 and catching it. Catching an exception rolls the
-- subtransaction back, so the fixture course, module, lessons AND the
-- course.publication_observed rows migration 053's recorders write for it are
-- all discarded. Any real assertion failure raises a DIFFERENT SQLSTATE, is not
-- caught, and aborts the migration.
--
-- Entitled-learner and admin behaviour is NOT exercised here, because doing so
-- would mean inserting auth.users rows in production. Those two arms are
-- unchanged 036 text (asserted in section 2), has_course_access() is proven
-- publication-independent (section 0), and both arms are exercised offline
-- against this exact file before review.
do $do$
declare
  v_slug       constant text := 'wc1-050-fixture-' || md5(clock_timestamp()::text || random()::text);
  v_audit_pre  bigint;
  v_witness    integer := 0;
  v_prev_pre   bigint;
  v_course     uuid;
  v_module     uuid;
  v_preview    uuid;
  v_plain      uuid;
  v_n          integer;
  v_flag       boolean;
begin
  select count(*) into v_audit_pre from public.audit_log;
  select count(*) into v_prev_pre  from public.lessons where is_preview;

  begin
    insert into public.courses (slug, title, description, is_published)
    values (v_slug, 'WC-1 050 fixture', 'Transient apply-time fixture; rolled back.', true)
    returning id into v_course;

    insert into public.modules (course_id, slug, title, order_index)
    values (v_course, 'wc1-fixture-module', 'Fixture module', 1)
    returning id into v_module;

    insert into public.lessons (module_id, slug, title, order_index, is_preview)
    values (v_module, 'wc1-fixture-preview', 'Fixture preview lesson', 1, true)
    returning id into v_preview;

    insert into public.lessons (module_id, slug, title, order_index, is_preview)
    values (v_module, 'wc1-fixture-plain', 'Fixture non-preview lesson', 2, false)
    returning id into v_plain;

    -- ── PUBLISHED: the teaser is visible, nothing else is ─────────────────
    set role anon;
    select count(*) into v_n from public.lessons where id = v_preview;
    reset role;
    if v_n <> 1 then
      raise exception 'WC-1 050 fixture: published preview lesson visible to anon % time(s), expected 1', v_n;
    end if;
    set role anon;
    select count(*) into v_n from public.lessons where id = v_plain;
    reset role;
    if v_n <> 0 then
      raise exception 'WC-1 050 fixture: published NON-preview lesson visible to anon % time(s), expected 0', v_n;
    end if;
    set role anon;
    select count(*) into v_n from public.modules where id = v_module;
    reset role;
    if v_n <> 1 then
      raise exception 'WC-1 050 fixture: published preview module visible to anon % time(s), expected 1', v_n;
    end if;

    -- ── WITHDRAWN: zero anonymous rows; the flag is untouched ─────────────
    update public.courses set is_published = false where id = v_course;

    set role anon;
    select count(*) into v_n from public.lessons where module_id = v_module;
    reset role;
    if v_n <> 0 then
      raise exception 'WC-1 050 fixture: withdrawn course still shows % lesson row(s) to anon, expected 0', v_n;
    end if;
    set role anon;
    select count(*) into v_n from public.modules where id = v_module;
    reset role;
    if v_n <> 0 then
      raise exception 'WC-1 050 fixture: withdrawn course still shows % module row(s) to anon, expected 0', v_n;
    end if;
    set role authenticated;
    select count(*) into v_n from public.lessons where module_id = v_module;
    reset role;
    if v_n <> 0 then
      raise exception 'WC-1 050 fixture: withdrawn course shows % lesson row(s) to an unentitled authenticated caller, expected 0', v_n;
    end if;

    select is_preview into v_flag from public.lessons where id = v_preview;
    if v_flag is distinct from true then
      raise exception 'WC-1 050 fixture: withdrawal changed the preview flag to %', v_flag;
    end if;
    if not public.module_has_preview_lesson(v_module) then
      raise exception 'WC-1 050 fixture: module_has_preview_lesson() lost the preview on withdrawal';
    end if;
    if public.course_is_published(v_course) then
      raise exception 'WC-1 050 fixture: course_is_published() still true after withdrawal';
    end if;

    -- ── REPUBLISHED: the teaser returns exactly as the curator left it ────
    update public.courses set is_published = true where id = v_course;

    set role anon;
    select count(*) into v_n from public.lessons where id = v_preview;
    reset role;
    if v_n <> 1 then
      raise exception 'WC-1 050 fixture: republished preview lesson visible to anon % time(s), expected 1', v_n;
    end if;
    set role anon;
    select count(*) into v_n from public.lessons where id = v_plain;
    reset role;
    if v_n <> 0 then
      raise exception 'WC-1 050 fixture: republished NON-preview lesson visible to anon % time(s), expected 0', v_n;
    end if;
    set role anon;
    select count(*) into v_n from public.modules where id = v_module;
    reset role;
    if v_n <> 1 then
      raise exception 'WC-1 050 fixture: republished preview module visible to anon % time(s), expected 1', v_n;
    end if;

    -- IS DISTINCT FROM, not a bare test: a helper that lost its coalesce would
    -- return NULL here, and plpgsql treats a NULL condition as false.
    if public.course_is_published(null) is distinct from false
       or public.course_is_published(gen_random_uuid()) is distinct from false then
      raise exception 'WC-1 050 fixture: course_is_published() is not fail-closed for a null or unknown id';
    end if;

    -- Informational, not a gate: 053's recorders witnessing the fixture shows the
    -- rollback below really discards something. 050 does not depend on 053.
    select count(*) into v_witness from public.audit_log where metadata ->> 'courseSlug' = v_slug;

    raise exception using errcode = 'XW050', message = 'WC-1 050 fixture complete; rolling back';
  exception
    when sqlstate 'XW050' then
      reset role;
  end;

  -- Rolled back means rolled back: no fixture, no witness, no flag drift.
  if exists (select 1 from public.courses where slug = v_slug) then
    raise exception 'WC-1 050 fixture: the fixture course survived the rollback';
  end if;
  select count(*) into v_n from public.audit_log where metadata ->> 'courseSlug' = v_slug;
  if v_n <> 0 then
    raise exception 'WC-1 050 fixture: % audit witness row(s) for the fixture survived the rollback', v_n;
  end if;
  select count(*) into v_n from public.audit_log;
  if v_n <> v_audit_pre then
    raise exception 'WC-1 050 fixture: audit_log changed from % to % row(s) across the rolled-back fixture', v_audit_pre, v_n;
  end if;
  select count(*) into v_n from public.lessons where is_preview;
  if v_n <> v_prev_pre then
    raise exception 'WC-1 050 fixture: preview flag count changed from % to %', v_prev_pre, v_n;
  end if;

  raise notice 'WC-1 050 fixture: published 1/0/1 -> withdrawn 0/0 (flag preserved) -> republished 1/0/1; % witness row(s) discarded with the rollback, audit_log unchanged', v_witness;
exception when others then
  reset role;
  raise;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it, and after the branch carrying
--    this file is merged.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once, with
--    someone watching, at a quiet moment with no one authoring content. Expect
--    five NOTICE lines, beginning "WC-1 050". Any ERROR means nothing was
--    applied: the file is one transaction.
--
--    ALTER POLICY takes an ACCESS EXCLUSIVE lock on public.lessons and
--    public.modules until COMMIT, so lesson and module reads WAIT for the whole
--    transaction, fixture included. Offline it completes in well under a
--    second; if the editor shows it still running after a few seconds,
--    cancel it (nothing is applied) rather than let readers queue.
-- 3. Immediately afterwards, as the anonymous key, read /rest/v1/lessons and
--    /rest/v1/modules and confirm HTTP 200 (not 500 / 42P17).
-- 4. Re-run the production verifiers ONLY with separate authorisation, and
--    only after inspecting them: verify-xpa-6a creates and deletes throwaway
--    accounts and mutates entitlement rows by design.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the exact 036 policies. Safe at any time: the 036 forms
-- are the ones production ran on from 036 until this migration, and are proven
-- evaluatable. Rolling back RE-OPENS the withdrawal gap; it does not touch any
-- preview flag or publication state. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- alter policy "lessons_visible" on public.lessons
--   using (
--     lessons.is_preview = true
--     or public.has_course_access(public.course_of_module(lessons.module_id))
--   );
--
-- alter policy "modules_visible" on public.modules
--   using (
--     public.has_course_access(modules.course_id)
--     or public.module_has_preview_lesson(modules.id)
--   );
--
-- -- Only after both policies no longer reference it.
-- drop function if exists public.course_is_published(uuid);
--
-- do $rb$
-- declare r text; t text;
-- begin
--   foreach r in array array['anon', 'authenticated'] loop
--     begin
--       execute format('set role %I', r);
--       foreach t in array array['modules', 'lessons', 'quizzes', 'quiz_questions'] loop
--         execute format('select count(*) from public.%I', t);
--       end loop;
--       reset role;
--     exception when others then
--       reset role;
--       raise exception 'WC-1 050 rollback: not evaluatable as % on %: % (%)', r, t, sqlerrm, sqlstate;
--     end;
--   end loop;
-- end
-- $rb$;
--
-- commit;
