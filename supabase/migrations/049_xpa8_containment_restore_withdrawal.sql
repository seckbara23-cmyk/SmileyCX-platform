-- ============================================================================
-- Migration 049 — XPA-8 CONTAINMENT: restore the withdrawal state of two
--                 courses and clear the preview flags that survived it.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Same discipline and same shape as 045 and 048.
--
-- NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- -- WHY 049 AND NOT 046 -----------------------------------------------------
--
-- 046 is permanently withdrawn and must never be created or applied. It was
-- drafted during B-2.3A to split `quiz_attempts` RLS, then security-reviewed
-- and abandoned: migration 011 already denies learner INSERT/UPDATE/DELETE on
-- that table, and 046 would have WEAKENED it. The numbering gap is intentional.
--
-- Reserved, and deliberately NOT created here:
--   050  withdrawal-contract RLS phase (lessons_visible / modules_visible)
--   051  voice competency lexicon hardening, if still required
--
-- -- WHAT HAPPENED - THIRD OCCURRENCE ----------------------------------------
--
-- Two courses that had been withdrawn by ruling were re-published on
-- 29 August 2026, 14 seconds apart:
--
--   C2-F2                                       12:37:55.026 UTC
--   slug developper-une-culture-client           12:38:09.091 UTC
--
-- The write mechanism is PROVEN and the actor is UNKNOWN.
--
--   PROVEN:  `courses` carries no updated_at trigger. The only trigger on the
--            table is `courses_code_immutable` (028), which guards `code`.
--            The corrective REST patches behind 045 and 048 changed
--            `is_published` and left `updated_at` untouched, demonstrating that
--            direct database writes do not move it. Both 29-August values carry
--            millisecond precision, the signature of the admin edit action's
--            explicit `updated_at: new Date().toISOString()`. Both rows were
--            therefore written through the admin course edit form.
--
--   UNKNOWN: `audit_log` contained six rows all-time, every one
--            `entitlement.granted`. No publication event type existed, so
--            production does not retain the evidence to attribute this write.
--            That gap is closed in the application layer alongside this
--            migration; it is NOT closed retroactively and this file does not
--            pretend otherwise.
--
-- The edit form renders the publication checkbox `defaultChecked` from the
-- course's current state, so a withdrawn course renders it unticked and an
-- unrelated edit preserves withdrawal. Re-publishing required ticking the box.
-- This is a governance gap, not an application defect.
--
-- -- STATE MEASURED IMMEDIATELY BEFORE THIS MIGRATION WAS WRITTEN ------------
--
--   courses                                    7   (7 published, 0 withdrawn)
--   preview flags platform-wide                3   (all on culture-client)
--   anon-visible lessons                       3
--   anon-visible object paths                  3
--   anon-visible lesson bodies                 0
--   media bytes reachable anonymously          0   (400 on public and RLS route)
--   placeholder lessons in the live catalogue  2
--
-- The two placeholder lessons carry no video, no pdf, no body and no url.
-- Their presence in the published catalogue is the condition B-2B withdrew
-- these courses to prevent.
--
-- -- SEVERITY: METADATA, NOT CONTENT -----------------------------------------
--
-- The three leaked paths were probed anonymously and are unusable: HTTP 400 on
-- the public storage route and 400 on the anonymous RLS route. Migration 041
-- made the bucket private and F-2 signs per request after an authorization
-- check, so no byte of media is reachable. What leaks is lesson titles, ids and
-- object filenames.
--
-- -- WHAT IS AND IS NOT TOUCHED ----------------------------------------------
--
-- Touched:  courses.is_published for exactly two courses;
--           lessons.is_preview for lessons of culture-client only.
--
-- NOT touched:  modules, lessons, lesson titles, lesson content, video and pdf
--               object paths and urls, entitlements, enrollments, progress,
--               quiz attempts, certificates, created_at, and - asserted
--               explicitly below - `courses.updated_at` for every course.
--
-- Nothing is deleted. Both statements are UPDATEs of a single boolean.
--
-- -- updated_at IS DELIBERATELY NOT MOVED ------------------------------------
--
-- `updated_at` is the only forensic signal that distinguishes an application
-- write from a database corrective. 045 and 048 preserved it and this file
-- preserves it too, so the 29-August evidence survives this restoration and a
-- future investigator can still read it. Because no trigger touches the column,
-- omitting it from the SET list is sufficient; the postconditions prove it.
--
-- -- THIS MIGRATION DOES NOT FIX THE CAUSE -----------------------------------
--
-- `lessons_visible` (036) admits a lesson on `is_preview = true` ALONE and
-- never consults the owning course's publication state; `modules_visible` does
-- the same through `module_has_preview_lesson`. That is why withdrawal alone
-- does not contain a preview exposure, and it is why the flags are cleared here
-- as a separate act. Redesigning those policies is migration 050 and its own
-- phase - it changes a policy that has already caused one platform-wide 42P17
-- outage and must not ride along with a data restoration.
-- This migration deliberately does NOT touch lessons_visible, modules_visible
-- or module_has_preview_lesson.
--
-- -- IDENTITY ----------------------------------------------------------------
--
-- C2-F2 has a `code`, the platform's stable course identifier. Culture-client
-- has none, so its stable key is the slug. In BOTH cases the audited uuid is
-- asserted as a cross-check, so neither a slug edit nor a code reassignment can
-- silently retarget this migration at a different course.
--
-- -- IDEMPOTENT --------------------------------------------------------------
--
-- Both UPDATEs are guarded on the value they change, so a re-run is a no-op and
-- every assertion still holds.
-- ============================================================================

begin;

do $$
declare
  v_c2f2          uuid;
  v_cult          uuid;
  v_c2f2_pub      boolean;
  v_cult_pub      boolean;
  v_c2f2_upd      timestamptz;
  v_cult_upd      timestamptz;
  v_courses       int;
  v_published     int;
  v_c2f2_mod      int;
  v_c2f2_les      int;
  v_c2f2_vid      int;
  v_c2f2_prev     int;
  v_cult_mod      int;
  v_cult_les      int;
  v_cult_vid      int;
  v_cult_prev     int;
  v_prev_total    int;
  v_prev_other    int;
  v_ent           int;
  v_enr           int;
  v_prog          int;
  v_other_upd     int;
  c_c2f2 constant uuid := '3731d5cc-7245-4fc7-9ddf-a10b9215d6cc';
  c_cult constant uuid := 'caaeff66-9095-4cf3-9294-e08188522e3a';
  c_slug constant text := 'developper-une-culture-client';
begin

  -- == PRECONDITIONS =======================================================
  -- Every one of these is a refusal, not a warning. A corrective that acts on
  -- a shape it did not expect is how the thing it is correcting happened.

  select count(*), count(*) filter (where is_published)
    into v_courses, v_published
  from public.courses;

  if v_courses <> 7 then
    raise exception 'XPA-8 049: expected 7 courses, found % - the catalogue changed shape; refusing to act on an unaudited state',
      v_courses;
  end if;

  -- Target 1: C2-F2, resolved by code, cross-checked by id.
  select id, is_published, updated_at into v_c2f2, v_c2f2_pub, v_c2f2_upd
  from public.courses where code = 'C2-F2';

  if v_c2f2 is null then
    raise exception 'XPA-8 049: no course with code C2-F2 - refusing to guess';
  end if;
  if v_c2f2 <> c_c2f2 then
    raise exception 'XPA-8 049: code C2-F2 resolves to % but the audited course is % - refusing to act on a different course',
      v_c2f2, c_c2f2;
  end if;

  -- Target 2: culture-client, resolved by slug, cross-checked by id.
  select id, is_published, updated_at into v_cult, v_cult_pub, v_cult_upd
  from public.courses where slug = c_slug;

  if v_cult is null then
    raise exception 'XPA-8 049: no course with slug % - refusing to guess', c_slug;
  end if;
  if v_cult <> c_cult then
    raise exception 'XPA-8 049: slug % resolves to % but the audited course is % - refusing to act on a different course',
      c_slug, v_cult, c_cult;
  end if;
  if v_cult = v_c2f2 then
    raise exception 'XPA-8 049: both keys resolved to the same course % - the identity assumptions are wrong', v_cult;
  end if;

  -- Structure baselines. Minimums, not equalities: legitimate authoring may
  -- add lessons, and this corrective must not become the reason a later re-run
  -- fails. Exact preservation is asserted AFTER the writes, against what was
  -- actually measured here.
  select count(*) into v_c2f2_mod from public.modules where course_id = v_c2f2;
  select count(*) into v_cult_mod from public.modules where course_id = v_cult;

  select count(*), count(*) filter (where l.video_object_path is not null),
         count(*) filter (where l.is_preview)
    into v_c2f2_les, v_c2f2_vid, v_c2f2_prev
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_c2f2;

  select count(*), count(*) filter (where l.video_object_path is not null),
         count(*) filter (where l.is_preview)
    into v_cult_les, v_cult_vid, v_cult_prev
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id = v_cult;

  if v_c2f2_mod < 5 or v_c2f2_les < 21 or v_c2f2_vid < 20 then
    raise exception 'XPA-8 049: C2-F2 is smaller than audited (% modules, % lessons, % media; expected at least 5/21/20) - content may already have been lost; refusing to proceed',
      v_c2f2_mod, v_c2f2_les, v_c2f2_vid;
  end if;

  if v_cult_mod < 4 or v_cult_les < 10 or v_cult_vid < 9 then
    raise exception 'XPA-8 049: culture-client is smaller than audited (% modules, % lessons, % media; expected at least 4/10/9) - content may already have been lost; refusing to proceed',
      v_cult_mod, v_cult_les, v_cult_vid;
  end if;

  -- Preview scope. Everything OUTSIDE culture-client must be untouched,
  -- captured before rather than inferred from the WHERE clause.
  select count(*) into v_prev_total from public.lessons where is_preview;

  select count(*) into v_prev_other
  from public.lessons l join public.modules m on m.id = l.module_id
  where m.course_id <> v_cult and l.is_preview;

  -- Learner-record baselines. This migration must not touch one row of any of
  -- them; captured so the postconditions can prove it.
  select count(*) into v_ent  from public.entitlements;
  select count(*) into v_enr  from public.enrollments;
  select count(*) into v_prog from public.lesson_progress;

  raise notice 'XPA-8 049 PRE: % courses (% published); C2-F2 pub=% %/%/% ; culture pub=% %/%/% prev=%; preview total=% (elsewhere=%); ent=% enr=% prog=%',
    v_courses, v_published,
    v_c2f2_pub, v_c2f2_mod, v_c2f2_les, v_c2f2_vid,
    v_cult_pub, v_cult_mod, v_cult_les, v_cult_vid, v_cult_prev,
    v_prev_total, v_prev_other, v_ent, v_enr, v_prog;

  -- == THE CORRECTION ======================================================
  -- Two UPDATEs, each guarded on the value it changes so a re-run is a no-op.
  -- `updated_at` is deliberately absent from both SET lists.

  update public.courses
  set    is_published = false
  where  id in (v_c2f2, v_cult)
    and  is_published;

  update public.lessons l
  set    is_preview = false
  from   public.modules m
  where  m.id = l.module_id
    and  m.course_id = v_cult
    and  l.is_preview;

  -- == POSTCONDITIONS ======================================================
  -- Fail the transaction; never report a false success. A 2xx is not evidence.

  -- 1. Publication state is restored, and only for the two targets.
  if (select is_published from public.courses where id = v_c2f2) then
    raise exception 'XPA-8 049: C2-F2 is still published';
  end if;
  if (select is_published from public.courses where id = v_cult) then
    raise exception 'XPA-8 049: culture-client is still published';
  end if;

  select count(*), count(*) filter (where is_published) into v_courses, v_published
  from public.courses;
  if v_courses <> 7 then
    raise exception 'XPA-8 049: course count changed to % - expected 7', v_courses;
  end if;
  if v_published <> 5 then
    raise exception 'XPA-8 049: expected 5 published courses afterwards, found %', v_published;
  end if;

  -- 2. updated_at was not moved, for the targets or for anyone else. This is
  --    what preserves the 29-August forensic evidence.
  if (select updated_at from public.courses where id = v_c2f2) <> v_c2f2_upd then
    raise exception 'XPA-8 049: C2-F2 updated_at moved from % - the restoration destroyed the evidence it was meant to preserve',
      v_c2f2_upd;
  end if;
  if (select updated_at from public.courses where id = v_cult) <> v_cult_upd then
    raise exception 'XPA-8 049: culture-client updated_at moved from %', v_cult_upd;
  end if;
  select count(*) into v_other_upd
  from public.courses
  where updated_at > greatest(v_c2f2_upd, v_cult_upd);
  if v_other_upd <> 0 then
    raise exception 'XPA-8 049: % course(s) carry an updated_at newer than the audited writes - something else wrote to courses',
      v_other_upd;
  end if;

  -- 3. Preview flags: zero on the target, unchanged everywhere else, and -
  --    because nothing else on the platform carried one - zero platform-wide.
  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_cult and l.is_preview) <> 0 then
    raise exception 'XPA-8 049: culture-client still carries preview flag(s)';
  end if;

  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id <> v_cult and l.is_preview) <> v_prev_other then
    raise exception 'XPA-8 049: preview flags outside culture-client changed (was %) - the scope leaked', v_prev_other;
  end if;

  -- 4. Nothing was destroyed. Exact equality against what was measured above.
  if (select count(*) from public.modules where course_id = v_c2f2) <> v_c2f2_mod then
    raise exception 'XPA-8 049: C2-F2 module count changed - expected %', v_c2f2_mod;
  end if;
  if (select count(*) from public.modules where course_id = v_cult) <> v_cult_mod then
    raise exception 'XPA-8 049: culture-client module count changed - expected %', v_cult_mod;
  end if;

  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_c2f2) <> v_c2f2_les then
    raise exception 'XPA-8 049: C2-F2 lesson count changed - expected %', v_c2f2_les;
  end if;
  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_cult) <> v_cult_les then
    raise exception 'XPA-8 049: culture-client lesson count changed - expected %', v_cult_les;
  end if;

  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_c2f2 and l.video_object_path is not null) <> v_c2f2_vid then
    raise exception 'XPA-8 049: C2-F2 media references changed - expected %', v_c2f2_vid;
  end if;
  if (select count(*) from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_cult and l.video_object_path is not null) <> v_cult_vid then
    raise exception 'XPA-8 049: culture-client media references changed - expected %', v_cult_vid;
  end if;

  -- 5. The academic and entitlement record is untouched. Publication controls
  --    DISCOVERY, never ACCESS - an entitled learner keeps both courses, and
  --    these three counts are the cheapest proof this migration honoured that.
  if (select count(*) from public.entitlements) <> v_ent then
    raise exception 'XPA-8 049: entitlement count changed - expected %', v_ent;
  end if;
  if (select count(*) from public.enrollments) <> v_enr then
    raise exception 'XPA-8 049: enrollment count changed - expected %', v_enr;
  end if;
  if (select count(*) from public.lesson_progress) <> v_prog then
    raise exception 'XPA-8 049: progress count changed - expected %', v_prog;
  end if;

  raise notice 'XPA-8 049 POST: % courses, % published, 2 withdrawn; C2-F2 %/%/% and culture %/%/% intact; preview total now %; updated_at preserved; ent=% enr=% prog=% unchanged',
    v_courses, v_published,
    v_c2f2_mod, v_c2f2_les, v_c2f2_vid,
    v_cult_mod, v_cult_les, v_cult_vid,
    (select count(*) from public.lessons where is_preview),
    v_ent, v_enr, v_prog;
end $$;

commit;

-- ============================================================================
-- APPLICATION ORDER
--
--   Production ledger before this file: 044 -> 045 -> 047 -> 048.
--   049 is INDEPENDENT of all of them. It reads `courses` and `modules` and
--   writes `courses.is_published` and `lessons.is_preview`; nothing earlier
--   reads what it writes. 046 never appears in any sequence.
--
--   1. Run this file in the Supabase SQL editor.
--   2. node scripts/security/verify-xpa-6a.mjs           -> expect 60/60
--   3. Re-run the full production verifier set           -> expect 303/303
--   4. Revalidate the public catalogue cache and confirm 5 courses are listed.
--
-- WHAT THIS DOES NOT DO
--
--   * It does not delete a course, a module, a lesson, a media reference or a
--     learner record.
--   * It does not touch the two placeholder lessons. They still exist and are
--     still unauthored; withdrawal is what makes that acceptable, and either
--     course may only be published again once they are authored (B-2.1).
--   * It does not change `lessons_visible`, `modules_visible` or
--     `module_has_preview_lesson`. A withdrawn course can still, in principle,
--     expose preview lessons - that is the cause, not this instance, and it is
--     reserved as migration 050.
--   * It does not audit the 29-August writes retroactively. That evidence does
--     not exist and no migration can manufacture it.
--
-- ROLLBACK - restores the 29 August state exactly. Recorded for completeness;
-- there is no reason to run it, since that state fails XPA-6A and B-2B.
--
--   begin;
--   update public.courses set is_published = true
--   where id in ('3731d5cc-7245-4fc7-9ddf-a10b9215d6cc',
--                'caaeff66-9095-4cf3-9294-e08188522e3a');
--   update public.lessons set is_preview = true
--   where id in ('bb9f12ec-c1d5-48c7-9cf7-381b458dae86',
--                '4c85ff72-ed5f-4f20-9611-71d222b129e0',
--                '9a6bb588-7940-42a4-873b-f855b7e90066');
--   commit;
-- ============================================================================
