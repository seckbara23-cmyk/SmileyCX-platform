-- ============================================================================
-- Migration 044 — XPA-8 B-2.6: put lesson_progress WRITES behind the same
--                 access seam that already gates the page and the media.
--
-- Run as a SINGLE TRANSACTION. Forward-only: migrations 001 and 037 are applied
-- and ledger-reconciled, so neither is edited. Same discipline as 036.
--
-- ⚠ NOT YET APPLIED TO PRODUCTION. Written and reviewed on `staging`; the
--   operator step is recorded at the bottom of this file.
--
-- ── THE DEFECT (S-1 in the B-2.6 audit) ────────────────────────────────────
--
-- Migration 001 gave lesson_progress one policy:
--
--   CREATE POLICY "progress_own" ON lesson_progress FOR ALL
--     USING      (user_id = auth.uid() OR is_platform_admin())
--     WITH CHECK (user_id = auth.uid() OR is_platform_admin());
--
-- That is an IDENTITY rule and nothing else. It correctly refuses to let one
-- learner write another learner's row — production returns 403 42501 for that,
-- and this migration keeps that behaviour exactly. What it never checked is
-- whether the writer may open the course at all.
--
-- Proved against production with six ID-scoped fixtures on C1-F1:
--
--   fixture                        has_course_access()   lesson_progress write
--   -----------------------------  -------------------   ---------------------
--   A  entitlement + enrollment     true                  201  correct
--   B  entitlement, no enrollment   true                  201  correct
--   C  enrollment only              false                 201  ⚠ WRONG
--   D  expired entitlement          false                 201  ⚠ WRONG
--   E  revoked entitlement          false                 201  ⚠ WRONG
--   F  neither                      false                 201  ⚠ WRONG
--
-- plus: a learner wrote progress for a course they do not hold, and for a
-- course withdrawn from publication. Since no published course has an
-- assessment, 100% self-asserted progress IS the entire certificate
-- requirement — so this is the input B-2.3 would have inherited.
--
-- ── WHY THE APPLICATION FIX IS NOT ENOUGH ──────────────────────────────────
--
-- B-2.6 also moved completion out of the browser and into `completeLesson`, a
-- server action that calls `resolveCourseAccessById()` before writing. That
-- closes the application path. It does NOT close the API path: the learner
-- still holds a JWT, PostgREST is still reachable, and `POST /rest/v1/
-- lesson_progress` still lands. Only a policy can refuse that, which is why
-- this migration exists rather than being replaced by the server action.
--
-- ── WHY READS ARE DELIBERATELY LEFT ALONE ──────────────────────────────────
--
-- The obvious move — bolt `has_course_access()` onto the existing FOR ALL
-- policy — would be wrong, and quietly so. FOR ALL covers SELECT, so a learner
-- whose entitlement expired would stop being able to READ their own transcript.
-- The platform has ratified the opposite, in learner-facing copy:
--
--   "Votre progression, vos résultats et vos certificats sont conservés"
--       — denialMessage('access_ended'), lib/auth/course-access.ts
--
-- and in the entitlement actions, which are documented never to delete
-- enrollments, lesson_progress, quiz attempts or certificates. Access ending
-- must freeze the record, not confiscate it. The certificate page and the admin
-- learner view read these rows too.
--
-- So `progress_own` is SPLIT by command:
--
--   SELECT  identity only          — the record is retained and readable
--   INSERT  identity + access      — new progress requires current access
--   UPDATE  identity + access      — so does amending progress
--   DELETE  identity only          — unchanged; not B-2.6's call to make
--
-- DELETE is called out because leaving it identity-only is a decision, not an
-- oversight. A learner can currently remove their own progress rows. That is
-- pre-existing behaviour, it is not what B-2.6 was asked to fix, and tightening
-- it would change what "your progress is retained" means in a direction nobody
-- has ruled on. It is recorded here so the next reader sees it was considered.
--
-- ── THE LESSON → COURSE HELPER ALREADY EXISTS ──────────────────────────────
--
-- `public.course_of_lesson(uuid)` was created by migration 036 and is live in
-- production. This migration REUSES it and does not redefine it.
--
-- That matters. `create or replace` here would have been silently risky: 036's
-- `lessons_visible` / `quizzes_visible` policies and 038's `exercises_select`
-- all depend on this function, so any drift in a re-declaration would change
-- content visibility as a side effect of a progress migration. The definition
-- drafted for B-2.6 turned out byte-identical to 036's, which is precisely the
-- case where redefining buys nothing and risks something.
--
-- It is already the right shape for this use:
--
--   * SECURITY DEFINER with `set search_path = public` — so a policy calling it
--     steps OUTSIDE RLS for the lookup and cannot re-enter the content policies.
--     That is not a nicety. Migration 036 exists because policies that queried
--     each other produced 42P17 (infinite recursion in policy) and made four
--     content tables unreadable by every caller, admins included.
--   * STABLE, not IMMUTABLE — a lesson can be moved between modules.
--   * already granted to anon and authenticated.
--
-- 038 set the precedent this migration follows exactly:
--
--     has_course_access(public.course_of_lesson(exercises.lesson_id))
--
-- Resolving a lesson's course is not privileged information — the course
-- structure is already public via migration 039 — so the definer rights leak
-- nothing.
-- ============================================================================

begin;

-- ══ 1. PRECONDITION ═══════════════════════════════════════════════════════
--
-- Fail loudly rather than create a policy that silently authorizes nothing:
-- `has_course_access(null)` returns false, so a missing helper would lock every
-- learner out of recording progress instead of erroring.

do $$
begin
  if to_regprocedure('public.course_of_lesson(uuid)') is null then
    raise exception 'XPA-8 B-2.6: public.course_of_lesson(uuid) is missing — apply migration 036 first';
  end if;
  if to_regprocedure('public.has_course_access(uuid)') is null then
    raise exception 'XPA-8 B-2.6: public.has_course_access(uuid) is missing — apply migration 037 first';
  end if;
end $$;


-- ══ 2. THE POLICY SPLIT ═══════════════════════════════════════════════════
--
-- `progress_own` is replaced by four command-scoped policies. Dropping it is
-- safe to repeat: every statement below is IF EXISTS / CREATE, and the file is
-- idempotent as a whole.

drop policy if exists "progress_own"        on public.lesson_progress;
drop policy if exists "progress_select_own" on public.lesson_progress;
drop policy if exists "progress_insert_own" on public.lesson_progress;
drop policy if exists "progress_update_own" on public.lesson_progress;
drop policy if exists "progress_delete_own" on public.lesson_progress;

-- READ — identity only. An expired learner keeps their transcript.
create policy "progress_select_own"
  on public.lesson_progress for select
  using (user_id = auth.uid() or public.is_platform_admin());

-- CREATE — identity AND current access to the lesson's course.
--
-- `is_platform_admin()` is short-circuited first so administration keeps
-- working, the same arm every other policy in this schema carries.
--
-- Note what is NOT here: no `is_published` test. Publication controls DISCOVERY,
-- never ACCESS (migrations 035, 037) — a learner holding a valid entitlement to
-- a withdrawn course must keep finishing it. The withdrawn-course write the
-- audit flagged stops being possible only because the *entitlement* check
-- stops it, which is the correct reason.
create policy "progress_insert_own"
  on public.lesson_progress for insert
  with check (
    public.is_platform_admin()
    or (
      user_id = auth.uid()
      and public.has_course_access(public.course_of_lesson(lesson_id))
    )
  );

-- AMEND — same rule. USING selects which rows may be targeted, WITH CHECK
-- validates the result; both carry the access test so a row cannot be moved to
-- a lesson the learner has no access to.
create policy "progress_update_own"
  on public.lesson_progress for update
  using (
    public.is_platform_admin()
    or (
      user_id = auth.uid()
      and public.has_course_access(public.course_of_lesson(lesson_id))
    )
  )
  with check (
    public.is_platform_admin()
    or (
      user_id = auth.uid()
      and public.has_course_access(public.course_of_lesson(lesson_id))
    )
  );

-- DELETE — unchanged from migration 001. See the header for why.
create policy "progress_delete_own"
  on public.lesson_progress for delete
  using (user_id = auth.uid() or public.is_platform_admin());


-- ══ 3. SELF-VERIFICATION ══════════════════════════════════════════════════
--
-- Fails the transaction rather than reporting a success that did not happen.

do $$
declare
  n_policies int;
  n_access   int;
begin
  select count(*) into n_policies
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'lesson_progress'
    and policyname in ('progress_select_own', 'progress_insert_own',
                       'progress_update_own', 'progress_delete_own');

  if n_policies <> 4 then
    raise exception 'XPA-8 B-2.6: expected 4 lesson_progress policies, found %', n_policies;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lesson_progress'
      and policyname = 'progress_own'
  ) then
    raise exception 'XPA-8 B-2.6: the old FOR ALL policy progress_own still exists';
  end if;

  -- The write policies must actually reference the access seam. A policy that
  -- merely exists proves nothing.
  select count(*) into n_access
  from pg_policies
  where schemaname = 'public' and tablename = 'lesson_progress'
    and policyname in ('progress_insert_own', 'progress_update_own')
    and coalesce(qual, '') || coalesce(with_check, '') like '%has_course_access%';

  if n_access <> 2 then
    raise exception 'XPA-8 B-2.6: % of 2 write policies reference has_course_access()', n_access;
  end if;

  -- SELECT must NOT reference it — the transcript is retained after access ends.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lesson_progress'
      and policyname = 'progress_select_own'
      and coalesce(qual, '') like '%has_course_access%'
  ) then
    raise exception 'XPA-8 B-2.6: progress_select_own gates READS on access; the record must be retained';
  end if;

  raise notice 'XPA-8 B-2.6: lesson_progress access boundary installed (4 policies, 2 access-gated writes).';
end $$;

commit;

-- ============================================================================
-- OPERATOR STEP — apply AFTER the application change is live, never before.
--
--   Order matters. Once this policy is in place the browser can no longer write
--   `lesson_progress` directly, and the pre-B-2.6 player does exactly that. If
--   the migration lands first, every learner on the currently-deployed build
--   silently stops recording progress.
--
--   The B-2.6 build writes through the service role (`completeLesson`), which
--   bypasses RLS entirely, so applying this afterwards changes nothing for a
--   legitimate learner. It closes only the direct-API path.
--
--   1. Merge staging → main and let the production deployment finish.
--   2. Confirm a completion works on the production site.
--      (Deliberately not named here: XPA-1 holds that no migration may
--      reference a brand, domain or contact constant, and the branding
--      suite enforces it across every tracked migration.)
--   3. Run this file in the Supabase SQL editor (project eqoqcxkdcxeosjqaafhs).
--   4. Re-run:  node scripts/security/verify-xpa-8-b26.mjs
--      Pre-apply it reports the four ⚠ rows as OPEN and exits 1.
--      Post-apply all six fixtures must land on the correct side and it exits 0.
--
-- ROLLBACK (restores migration 001's behaviour exactly, including the hole):
--
--   begin;
--   drop policy if exists "progress_select_own" on public.lesson_progress;
--   drop policy if exists "progress_insert_own" on public.lesson_progress;
--   drop policy if exists "progress_update_own" on public.lesson_progress;
--   drop policy if exists "progress_delete_own" on public.lesson_progress;
--   create policy "progress_own" on public.lesson_progress for all
--     using      (user_id = auth.uid() or public.is_platform_admin())
--     with check (user_id = auth.uid() or public.is_platform_admin());
--   commit;
--
--   `course_of_lesson()` is deliberately NOT dropped by the rollback: it belongs
--   to migration 036 and 038's exercises policy depends on it.
-- ============================================================================
