-- ============================================================================
-- Migration 036 — XPA-6A CORRECTION: break the mutual recursion between the
--                 content policies introduced by migration 035.
--
-- Run as a SINGLE TRANSACTION. Migration 035 is applied and ledger-reconciled,
-- so it is NOT edited — this is a forward fix, the same discipline used for
-- migrations 001-027.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- Migration 035 applied cleanly and every structural check passed. It was still
-- wrong, and production proved it:
--
--   anon SELECT modules         -> 500  42P17
--   anon SELECT lessons         -> 500  42P17
--   anon SELECT quizzes         -> 500  42P17
--   anon SELECT quiz_questions  -> 500  42P17
--
-- 42P17 is `infinite recursion detected in policy for relation`. Not a denial.
-- The four content tables became unreadable by EVERY caller that goes through
-- RLS — anonymous visitors, verified learners, learners holding a legitimately
-- ACTIVE enrollment, and platform admins alike. Only service_role, which
-- bypasses RLS entirely, could still read them.
--
-- Cause: two policies that query each other.
--
--   lessons_visible  ->  exists (select 1 from public.modules ...)   -- fires modules_visible
--   modules_visible  ->  exists (select 1 from public.lessons ...)   -- fires lessons_visible
--
-- The modules arm was added so a module containing a preview lesson still
-- renders its sidebar. Reasonable in isolation; it closed a cycle. The quizzes
-- and quiz_questions policies query modules and lessons too, so they inherited
-- the same failure.
--
-- ── WHY IT WAS NOT CAUGHT ──────────────────────────────────────────────────
--
-- Two failures of verification, both worth naming because the fix is a habit,
-- not a line of SQL.
--
-- 1. Every check in migration 035 was STRUCTURAL — grants, column existence,
--    policy text. None EXERCISED a policy. A policy can be perfectly formed and
--    still be unevaluatable.
--
-- 2. The post-apply probe scored "denied" as `status >= 400`, so a 500 from a
--    recursion error counted as a PASS for "anonymous callers are refused".
--    Refused and broken are not the same result, and a check that cannot tell
--    them apart is not a security check.
--
-- Section 3 below fixes habit 1 by actually reading each table as `anon` and
-- `authenticated` at apply time. Had it existed, migration 035 would have
-- failed loudly instead of succeeding into an outage.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- No content policy may query another RLS-protected table. Every cross-table
-- lookup goes through a SECURITY DEFINER resolver, which runs as the function
-- owner and therefore does not re-enter any policy.
--
-- This is the same pattern migration 027 established with
-- current_platform_role(), and the one 035 used correctly for
-- current_account_status() and current_disabled_at() — it simply was not
-- applied to the cross-table reads.
--
-- Authorization is UNCHANGED. has_course_access() is not touched. The four
-- policies express exactly what they expressed before; only how they reach the
-- course id changes.
-- ============================================================================


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.has_course_access(uuid)') is null then
    raise exception 'XPA-6A 036 preflight: public.has_course_access(uuid) is missing — apply migration 035 first';
  end if;
end $$;


-- ══ 1. SECURITY DEFINER RESOLVERS ═════════════════════════════════════════
--
-- Each answers one question — "which course does this thing belong to?" —
-- reading past RLS so that asking never re-enters a policy.
--
-- STABLE, so the planner may cache the result within a statement rather than
-- re-running it per row. That also repairs a second problem: before migration
-- 035, quiz_questions_visible was expensive enough to hit the statement timeout
-- (57014) on a plain count.

create or replace function public.course_of_module(p_module_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.course_id from public.modules m where m.id = p_module_id
$$;

create or replace function public.course_of_lesson(p_lesson_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.course_id
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where l.id = p_lesson_id
$$;

-- Does this module contain at least one genuine preview lesson?
--
-- THIS is the function whose absence caused the outage: modules_visible asked
-- the question with an inline subquery on public.lessons, which fired
-- lessons_visible, which queried modules, and round it went.
create or replace function public.module_has_preview_lesson(p_module_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.lessons l
    where l.module_id = p_module_id
      and l.is_preview = true
  )
$$;

-- A quiz attaches at course, module or lesson level. coalesce resolves whichever
-- applies; has_course_access(null) is false, so an orphaned quiz is invisible.
create or replace function public.course_of_quiz(p_quiz_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    qz.course_id,
    public.course_of_module(qz.module_id),
    public.course_of_lesson(qz.lesson_id)
  )
  from public.quizzes qz
  where qz.id = p_quiz_id
$$;

comment on function public.course_of_module(uuid)          is 'XPA-6A/036. Resolves module -> course past RLS. Exists so content policies never query another policy-protected table (42P17).';
comment on function public.course_of_lesson(uuid)          is 'XPA-6A/036. Resolves lesson -> course past RLS.';
comment on function public.module_has_preview_lesson(uuid) is 'XPA-6A/036. True when a module contains a preview lesson. Replaces the inline subquery on lessons that closed the lessons<->modules policy cycle.';
comment on function public.course_of_quiz(uuid)            is 'XPA-6A/036. Resolves quiz -> course past RLS, at whichever level the quiz attaches.';

-- Revoke first: functions are created with EXECUTE granted to PUBLIC.
revoke all on function public.course_of_module(uuid)          from public;
revoke all on function public.course_of_lesson(uuid)          from public;
revoke all on function public.module_has_preview_lesson(uuid) from public;
revoke all on function public.course_of_quiz(uuid)            from public;

-- RLS is evaluated as the CALLING role, so both app roles need EXECUTE or every
-- policy below raises permission denied.
grant execute on function public.course_of_module(uuid)          to anon, authenticated;
grant execute on function public.course_of_lesson(uuid)          to anon, authenticated;
grant execute on function public.module_has_preview_lesson(uuid) to anon, authenticated;
grant execute on function public.course_of_quiz(uuid)            to anon, authenticated;


-- ══ 2. CONTENT POLICIES — same meaning, no cross-table queries ════════════

drop policy if exists "lessons_visible" on public.lessons;
create policy "lessons_visible" on public.lessons for select
  using (
    lessons.is_preview = true
    or public.has_course_access(public.course_of_module(lessons.module_id))
  );

drop policy if exists "modules_visible" on public.modules;
create policy "modules_visible" on public.modules for select
  using (
    public.has_course_access(modules.course_id)
    or public.module_has_preview_lesson(modules.id)
  );

drop policy if exists "quizzes_visible" on public.quizzes;
create policy "quizzes_visible" on public.quizzes for select
  using (
    public.has_course_access(public.course_of_quiz(quizzes.id))
  );

drop policy if exists "quiz_questions_visible" on public.quiz_questions;
create policy "quiz_questions_visible" on public.quiz_questions for select
  using (
    public.has_course_access(public.course_of_quiz(quiz_questions.quiz_id))
  );


-- ══ 3. EXERCISE THE POLICIES — the assertion 035 lacked ═══════════════════
--
-- Structural checks passed while the policies were unevaluatable. So actually
-- READ each table as each app role. A recursion, a missing EXECUTE grant or a
-- missing SELECT grant raises here and aborts the migration, instead of
-- shipping into an outage.
--
-- SET ROLE genuinely switches the current role, so RLS applies exactly as it
-- does for a real request. auth.uid() is NULL in this context, which is the
-- anonymous case — the strictest one, and the one that was broken.
do $$
declare
  r text;
  t text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    begin
      execute format('set role %I', r);

      foreach t in array array['lessons', 'modules', 'quizzes', 'quiz_questions'] loop
        execute format('select 1 from public.%I limit 1', t);
      end loop;

      reset role;
    exception when others then
      reset role;
      raise exception 'content policy is not evaluatable as role % on table %: % (%)',
        r, coalesce(t, '?'), sqlerrm, sqlstate;
    end;
  end loop;

  raise notice 'XPA-6A 036: all four content policies evaluate cleanly as anon and authenticated.';
end $$;


-- ══ 4. CONFIRM THE POLICIES STILL DENY ════════════════════════════════════
--
-- Evaluatable is not the same as correct. With auth.uid() NULL and zero preview
-- lessons, an anonymous caller must see NOTHING — otherwise this migration has
-- traded a recursion for an exposure.
do $$
declare
  n_lessons  integer;
  n_modules  integer;
  n_quizzes  integer;
  n_questions integer;
  n_courses  integer;
begin
  set role anon;
  select count(*) into n_lessons   from public.lessons;
  select count(*) into n_modules   from public.modules;
  select count(*) into n_quizzes   from public.quizzes;
  select count(*) into n_questions from public.quiz_questions;
  select count(*) into n_courses   from public.courses;
  reset role;

  if n_lessons <> 0 or n_quizzes <> 0 or n_questions <> 0 then
    raise exception 'anonymous caller can still read protected content: % lesson(s), % quiz(zes), % question(s)',
      n_lessons, n_quizzes, n_questions;
  end if;

  -- modules may legitimately be visible only via module_has_preview_lesson();
  -- with zero preview lessons that must also be zero.
  if n_modules <> 0 then
    raise exception 'anonymous caller can read % module(s) with no preview lesson present', n_modules;
  end if;

  -- Public discovery must NOT have been collateral damage.
  if n_courses = 0 then
    raise exception 'anonymous caller can no longer read the course catalogue — public discovery is broken';
  end if;

  raise notice 'XPA-6A 036: anon sees 0 lessons / 0 modules / 0 quizzes / 0 questions, and % course(s) for discovery.', n_courses;
exception when others then
  reset role;
  raise;
end $$;


-- ══ ROLLBACK ══════════════════════════════════════════════════════════════
-- There is no useful rollback: reverting to the migration 035 policy bodies
-- restores the recursion and makes all four tables unreadable again.
--
-- To reopen anonymous access deliberately (NOT recommended), see the rollback
-- note in migration 035.
-- ══════════════════════════════════════════════════════════════════════════
