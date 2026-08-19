-- ============================================================================
-- Migration 045 — XPA-8 corrective: restore C2-F2's preview flags to zero.
--
-- Run as a SINGLE TRANSACTION. Forward-only: migration 043 is applied and
-- ledger-reconciled, so it is NOT edited. Same discipline as 036 and 044.
--
-- ⚠ APPLY ORDER. This migration is numbered after 044 but is intended to be
--   applied BEFORE it. The two are independent — 044 rewrites RLS policies on
--   `lesson_progress`, 045 updates `lessons.is_preview` — and neither reads
--   anything the other writes. 044 is gated on the B-2.6 application build
--   reaching production; 045 is not gated on anything and closes a live
--   anonymous exposure, so it goes first. Applying them in either order
--   produces the same end state.
--
-- ── WHAT HAPPENED ──────────────────────────────────────────────────────────
--
-- F-1 established that C2-F2 must not carry blanket preview flags, and
-- migration 043 cleared them — deliberately scoped to C2-F2 and deliberately
-- NOT written as an unconditional platform-wide reset.
--
-- On 17 August 2026 C2-F2 was re-published (18:52 UTC) with 11 of its 21
-- lessons flagged `is_preview = true`. A ruling on 19 August withdrew the
-- course again, restoring `is_published = false`. That closed the catalogue
-- and the detail route but changed the anonymous exposure by exactly nothing:
--
--   anon-visible lessons                  11  ->  11
--   ...of those leaking video_object_path 10  ->  10
--
-- ── WHY WITHDRAWAL WAS NOT ENOUGH ──────────────────────────────────────────
--
-- `lessons_visible` (migration 036) admits a lesson on `is_preview = true`
-- alone. It never consults the owning course's publication state. So a
-- WITHDRAWN course still serves its preview lessons — and their object paths —
-- to anonymous callers.
--
-- That combination had never existed before. Pre-17-August C2-F2 was withdrawn
-- AND carried zero preview flags, so the gap was latent. It is recorded as
-- architecture debt in docs/xpa-8-withdrawal-contract-gap.md.
--
-- This migration does NOT redesign that policy. Restoring the flags to zero is
-- the whole of the corrective action; whether a withdrawn course should be able
-- to have preview lessons at all is a separate decision, deliberately not taken
-- here.
--
-- ── WHAT IS AND IS NOT TOUCHED ─────────────────────────────────────────────
--
-- Touched:      lessons.is_preview, for lessons of C2-F2 only.
-- NOT touched:  publication state (C2-F2 stays withdrawn), lesson content,
--               video/pdf/subtitle paths and urls, modules, the one remaining
--               placeholder lesson, entitlements, enrollments, progress.
--
-- The exposure is metadata, not content: the paths were verified unusable by an
-- anonymous caller (400 on both the public and the RLS storage routes) because
-- migration 041 made `course-content` private. This closes the leak of the
-- path, not of the asset — the asset was never reachable.
--
-- ── THE ELEVEN ROWS, AS AUDITED BEFORE WRITING THIS ────────────────────────
--
-- Every `is_preview = true` lesson on the platform — all 11 — belongs to C2-F2.
-- No other course carries a single preview flag, so scoping by course cannot
-- affect anything else. Verified, and re-asserted below at apply time rather
-- than trusted:
--
--   3cc5f608  Lire les résultats                     (no object path)
--   2f16eeb1  Cas pratique: Construire un tableau…   video/1786986197454-…
--   4b0e80ef  Croiser chiffre et verbatim            video/1786985632523-…
--   20724fb0  Concevoir une bonne enquête            video/1786986649374-…
--   6f8202f5  Choisir le bon moment et canal         video/1786992003342-…
--   3cc456fd  Les nouveaux indicateurs               video/1786986133190-…
--   92b30d03  Cas pratique: Construire un tableau…   video/1786985692166-…
--   0b1e0895  Choisir selon son secteur              video/1786986080047-…
--   4c5772fa  Indicateurs opérationnels              video/1786985956197-…
--   5882f6e1  Indicateurs de fidélité                video/1786986021951-…
--   4bcf8cd8  La clôture                             video/1786986310145-…
--
-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────
--
-- The UPDATE is guarded on `is_preview = true`, so re-running it is a no-op and
-- the assertions still hold. This matters: the corrective data change was
-- applied to production through the service-role REST endpoint at the time of
-- the ruling, and this file is the canonical record. Running it in the SQL
-- editor afterwards changes nothing and reconciles the ledger.
-- ============================================================================

begin;

do $$
declare
  v_course       uuid;
  v_before       int;
  v_after        int;
  v_other_before int;
  v_other_after  int;
  v_lessons      int;
  v_published    boolean;
begin
  -- ── Identify by the stable business key, never by title ─────────────────
  --
  -- `code` is the platform's stable course identifier (course_codes, the
  -- catalogue, every verifier). A title is editable prose and two courses have
  -- had near-identical ones.
  select id, is_published into v_course, v_published
  from public.courses
  where code = 'C2-F2';

  if v_course is null then
    raise exception 'XPA-8 045: no course with code C2-F2 — refusing to guess';
  end if;

  -- Withdrawal is a precondition, not something this migration performs.
  if v_published then
    raise exception 'XPA-8 045: C2-F2 is PUBLISHED. This corrective assumes the 19 Aug withdrawal is in place; refusing to clear preview flags on a live course';
  end if;

  select count(*) into v_before
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where m.course_id = v_course and l.is_preview;

  -- Everything OUTSIDE C2-F2 must be untouched. Captured before, re-checked
  -- after, rather than asserted by reading the WHERE clause.
  select count(*) into v_other_before
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where m.course_id <> v_course and l.is_preview;

  select count(*) into v_lessons
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where m.course_id = v_course;

  raise notice 'XPA-8 045: C2-F2 % lessons, % preview; % preview elsewhere',
    v_lessons, v_before, v_other_before;

  -- ── The correction ──────────────────────────────────────────────────────
  update public.lessons l
  set    is_preview = false
  from   public.modules m
  where  m.id = l.module_id
    and  m.course_id = v_course
    and  l.is_preview;

  -- ── Self-verification: fail the transaction, never report a false success ─
  select count(*) into v_after
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where m.course_id = v_course and l.is_preview;

  if v_after <> 0 then
    raise exception 'XPA-8 045: C2-F2 still has % preview lesson(s)', v_after;
  end if;

  select count(*) into v_other_after
  from public.lessons l
  join public.modules m on m.id = l.module_id
  where m.course_id <> v_course and l.is_preview;

  if v_other_after <> v_other_before then
    raise exception 'XPA-8 045: preview flags outside C2-F2 changed (% -> %) — the scope leaked',
      v_other_before, v_other_after;
  end if;

  -- Nothing may have been destroyed. The lesson count is the cheapest proof
  -- that this was an UPDATE and not something worse.
  if (select count(*)
      from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_course) <> v_lessons then
    raise exception 'XPA-8 045: C2-F2 lesson count changed — expected %', v_lessons;
  end if;

  -- Media must be intact: this migration touches a boolean, nothing else.
  if (select count(*)
      from public.lessons l join public.modules m on m.id = l.module_id
      where m.course_id = v_course and l.video_object_path is not null) < 10 then
    raise exception 'XPA-8 045: C2-F2 lost video object paths';
  end if;

  -- And the course must still be withdrawn afterwards.
  if (select is_published from public.courses where id = v_course) then
    raise exception 'XPA-8 045: C2-F2 became published during this migration';
  end if;

  raise notice 'XPA-8 045: cleared % preview flag(s) on C2-F2; % lessons intact; % preview elsewhere, unchanged',
    v_before, v_lessons, v_other_after;
end $$;

commit;

-- ============================================================================
-- WHAT THIS DOES NOT DO
--
--   * It does not republish C2-F2.
--   * It does not touch the remaining placeholder lesson ("Lire les résultats"),
--     which still has no instructional modality. B-2.1 is satisfied only
--     because the course is withdrawn; publishing it again requires that lesson
--     to be authored first.
--   * It does not redesign `lessons_visible`. A withdrawn course can still, in
--     principle, expose preview lessons — see
--     docs/xpa-8-withdrawal-contract-gap.md. This migration removes today's
--     instance of that exposure, not its cause.
--
-- ROLLBACK — restores the 17 August state exactly. Recorded for completeness;
-- there is no reason to run it, since that state failed XPA-6A.
--
--   begin;
--   update public.lessons set is_preview = true
--   where id in (
--     '3cc5f608-b2b7-4482-b8bf-faa074dfa139','2f16eeb1-6c59-4f89-85a6-ddcf85e8a0e4',
--     '4b0e80ef-b75c-4f53-8cee-29b7b3da0862','20724fb0-4cba-4406-80d6-f60cba7b5f55',
--     '6f8202f5-36a4-4bbc-93e7-b390306b557c','3cc456fd-0243-48bb-a879-d690aefef61e',
--     '92b30d03-43bc-407c-bad5-7c26b76e7a75','0b1e0895-b052-4232-9e08-d56083e650a3',
--     '4c5772fa-e884-4991-8d08-c90cf2af7f2e','5882f6e1-62ba-4c17-a008-d1ac9c3159a0',
--     '4bcf8cd8-b139-47b7-a5fd-b7a90644b1b2');
--   commit;
-- ============================================================================
