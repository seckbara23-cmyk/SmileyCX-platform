-- ============================================================================
-- Migration 048 — XPA-8 corrective: clear preview flags on the withdrawn course
--                 "Développer une culture client".
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Same discipline and same shape as 045, which did this for C2-F2.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHY 048 AND NOT 046 ────────────────────────────────────────────────────
--
-- 046 is permanently withdrawn. It was drafted during B-2.3A to split
-- `quiz_attempts` RLS, then security-reviewed and abandoned before application:
-- migration 011 already denies learner INSERT/UPDATE/DELETE on that table, and
-- 046 would have WEAKENED it by letting entitled learners fabricate attempts
-- through PostgREST. The numbering gap is intentional and must stay. Nothing
-- numbered 046 may ever be created or applied.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- On 20 August 2026, between 17:18 and 17:33 UTC, ten lessons were authored
-- across four modules on this course. Every one was created with
-- `is_preview = true`, and nine carry a `video_object_path`.
--
-- The course is `is_published = false` and has been since 19 August. That
-- withdrawal does not contain the exposure, because `lessons_visible`
-- (migration 036) admits a lesson on `is_preview = true` ALONE and never
-- consults the owning course's publication state. So a withdrawn course serves
-- its preview lessons — and their object paths — to anonymous callers.
--
-- Measured immediately before this migration was written:
--
--   preview flags platform-wide           10   (all 10 on this course)
--   anon-visible lessons                  10
--   anon-visible object paths              9
--   XPA-6A                                57/60
--
-- The three XPA-6A failures are one cause:
--
--   anon lessons expose no object path
--   learner lessons expose no body or object path
--   no course is flagged preview WHOLESALE        <- 10 of 10 lessons
--
-- ── SEVERITY: METADATA, NOT CONTENT ────────────────────────────────────────
--
-- The leaked paths were probed as an anonymous caller and are unusable:
-- HTTP 400 on `/storage/v1/object/public/course-content/...` and 400 on the
-- anonymous RLS route. Migration 041 made the bucket private and F-2 signs per
-- request after an authorization check, so no byte of media is reachable. What
-- leaks is lesson titles, ids and object filenames for a course that is
-- supposed to be undiscoverable.
--
-- ── THIS IS THE SECOND OCCURRENCE ──────────────────────────────────────────
--
-- C2-F2 produced exactly this on 17 August and was corrected by migration 045.
-- Clearing flags per incident treats the symptom. The cause is the
-- `lessons_visible` predicate, recorded as architecture debt in
-- docs/xpa-8-withdrawal-contract-gap.md and now scheduled as its own phase.
-- **This migration deliberately does NOT touch that policy.** Restoring the
-- invariant and redesigning the contract are separate changes with separate
-- blast radii.
--
-- ── WHAT IS AND IS NOT TOUCHED ─────────────────────────────────────────────
--
-- Touched:      lessons.is_preview, for lessons of this course only.
-- NOT touched:  publication state (it stays withdrawn), modules, lessons,
--               lesson titles or content, video/pdf object paths and urls,
--               entitlements, enrollments, progress, created_at.
--
-- No authored content is deleted or rewritten. The ten lessons and their media
-- survive intact; only the boolean that made them anonymously visible changes.
--
-- ── IDENTITY ───────────────────────────────────────────────────────────────
--
-- This course has NO `code` — unlike C2-F2, which 045 could key on 'C2-F2'.
-- Its stable key is therefore the slug, and the audited id is asserted as a
-- cross-check so a future slug edit cannot silently retarget this migration.
-- ============================================================================

begin;

do $$
declare
  v_course       uuid;
  v_published    boolean;
  v_before       int;
  v_after        int;
  v_other_before int;
  v_other_after  int;
  v_lessons      int;
  v_modules      int;
  v_media        int;
  c_expected     constant uuid := 'caaeff66-9095-4cf3-9294-e08188522e3a';
begin
  select id, is_published into v_course, v_published
  from public.courses
  where slug = 'developper-une-culture-client';

  if v_course is null then
    raise exception 'XPA-8 048: no course with slug developper-une-culture-client — refusing to guess';
  end if;

  if v_course <> c_expected then
    raise exception 'XPA-8 048: slug resolves to % but the audited course is % — refusing to act on a different course',
      v_course, c_expected;
  end if;

  -- Withdrawal is a PRECONDITION, not something this migration performs, and
  -- it is what makes clearing previews unambiguously correct: a published
  -- course may legitimately want preview lessons.
  if v_published then
    raise exception 'XPA-8 048: the course is PUBLISHED. This corrective assumes it is withdrawn; refusing to strip previews from a live course';
  end if;

  select count(*) into v_before
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_course and l.is_preview;

  -- Everything OUTSIDE this course must be untouched. Captured before and
  -- re-checked after, rather than inferred from the WHERE clause.
  select count(*) into v_other_before
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id <> v_course and l.is_preview;

  select count(*) into v_lessons
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_course;

  select count(*) into v_modules from public.modules where course_id = v_course;

  select count(*) into v_media
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_course and l.video_object_path is not null;

  raise notice 'XPA-8 048: % modules, % lessons, % preview, % with media; % preview elsewhere',
    v_modules, v_lessons, v_before, v_media, v_other_before;

  -- ── The correction. Guarded on is_preview so a re-run is a no-op. ───────
  update public.lessons l
  set    is_preview = false
  from   public.modules m
  where  m.id = l.module_id
    and  m.course_id = v_course
    and  l.is_preview;

  -- ── Self-verification: fail the transaction, never report a false success ─
  select count(*) into v_after
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_course and l.is_preview;

  if v_after <> 0 then
    raise exception 'XPA-8 048: the course still has % preview lesson(s)', v_after;
  end if;

  select count(*) into v_other_after
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id <> v_course and l.is_preview;

  if v_other_after <> v_other_before then
    raise exception 'XPA-8 048: preview flags outside the target changed (% -> %) — the scope leaked',
      v_other_before, v_other_after;
  end if;

  -- Nothing may have been destroyed: this is an UPDATE of one boolean.
  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_course) <> v_lessons then
    raise exception 'XPA-8 048: lesson count changed — expected %', v_lessons;
  end if;

  if (select count(*) from public.modules where course_id = v_course) <> v_modules then
    raise exception 'XPA-8 048: module count changed — expected %', v_modules;
  end if;

  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_course and l.video_object_path is not null) <> v_media then
    raise exception 'XPA-8 048: authored media references changed — expected %', v_media;
  end if;

  -- And the course must still be withdrawn afterwards.
  if (select is_published from public.courses where id = v_course) then
    raise exception 'XPA-8 048: the course became published during this migration';
  end if;

  raise notice 'XPA-8 048: cleared % preview flag(s); % modules, % lessons, % media refs intact; % preview elsewhere, unchanged',
    v_before, v_modules, v_lessons, v_media, v_other_after;
end $$;

commit;

-- ============================================================================
-- APPLICATION ORDER
--
--   048 is INDEPENDENT of 047. It reads `courses` and `modules` and writes
--   `lessons.is_preview`; 047 adds `courses.requires_final_exam`. Neither reads
--   anything the other writes, so 048 does NOT require 047 and must not wait
--   for it.
--
--   Production ledger at authoring time ends at 045. The intended sequence is:
--
--     044 -> 045 -> 048        (now — restores the XPA-6A invariant)
--             then -> 047      (later, at the B-2.3A database-activation step,
--                               after that release merges and deploys)
--
--   That is deliberately non-monotonic. 047 belongs to the B-2.3A release and
--   is gated on its PR; 048 fixes a live exposure and is gated on nothing.
--   Applying 048 first is correct, and 046 never appears in any sequence.
--
--   1. Run this file in the Supabase SQL editor.
--   2. node scripts/security/verify-xpa-6a.mjs        -> expect 60/60
--   3. Re-run the full production verifier set        -> expect 303/303
--
-- WHAT THIS DOES NOT DO
--
--   * It does not publish the course. It stays withdrawn; publishing it is a
--     separate product decision and the course is not release-ready.
--   * It does not touch the ten authored lessons or their media.
--   * It does not change `lessons_visible`. A withdrawn course can still, in
--     principle, expose preview lessons — that is the cause, not this instance,
--     and it has its own phase. See docs/xpa-8-withdrawal-contract-gap.md.
--
-- ROLLBACK — restores the exposed state exactly. Recorded for completeness;
-- there is no reason to run it, since that state fails XPA-6A.
--
--   begin;
--   update public.lessons l set is_preview = true
--   from public.modules m
--   where m.id = l.module_id
--     and m.course_id = 'caaeff66-9095-4cf3-9294-e08188522e3a';
--   commit;
-- ============================================================================
