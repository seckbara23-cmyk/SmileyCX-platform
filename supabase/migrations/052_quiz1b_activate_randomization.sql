-- ============================================================================
-- Migration 052 — QUIZ-1B: activate question + option randomisation on the
--                 C1-F1 formative warm-up quiz.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Same discipline and same shape as 045 and 048.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHY A MIGRATION AND NOT A MANUAL UPDATE ────────────────────────────────
--
-- Migration 032 added `randomize_questions` / `randomize_options` DEFAULT
-- FALSE and deliberately enabled them on nothing, leaving activation as a
-- separate, explicit act. This is that act.
--
-- It is expressed as a numbered migration because every production data change
-- in this repository is: 043, 045 and 048 all flip content booleans this way,
-- and 047 established the ordering an activation follows — merge, deploy, THEN
-- apply. An undocumented UPDATE in the SQL editor would leave no ledger entry,
-- no guard, no assertion and no rollback. The blast radius here is one row and
-- two booleans; the reason for the ceremony is reviewability, not risk.
--
-- ── WHY 052, AND NOT 046, 050 OR 051 ───────────────────────────────────────
--
-- Three numbers below 052 are spoken for, and QUIZ-1B may take none of them:
--
--   046  PERMANENTLY WITHDRAWN. Drafted during B-2.3A to split
--        `quiz_attempts` RLS, then security-reviewed and abandoned before
--        application: migration 011 already denies learner
--        INSERT/UPDATE/DELETE on that table, and 046 would have WEAKENED it.
--        The numbering gap is intentional and must stay. Nothing numbered 046
--        may ever be created or applied.
--
--   050  RESERVED — withdrawal-contract RLS phase (`lessons_visible` /
--        `modules_visible`). Reserved by migration 049 and enforced by
--        __tests__/security/xpa-8-f5-publication-governance.test.ts, which
--        asserts no 050 file exists. It redesigns a policy that has already
--        caused one platform-wide 42P17 outage, and must not be borrowed for
--        an unrelated flag flip.
--
--   051  RESERVED — voice competency lexicon hardening, if still required.
--
-- 052 is therefore the first free number. This migration touches no policy,
-- no grant and no function, so it cannot collide with the work 050 is held
-- for; it changes two boolean columns on one row.
--
-- ── WHY THIS CANNOT MOVE THE CORRECT ANSWER ────────────────────────────────
--
-- `quiz_questions.correct_answer` is an INTEGER INDEX into `options`, so
-- shuffling what the learner sees would appear to move the right answer. It
-- does not, because shuffling is PRESENTATIONAL ONLY: the client shuffles
-- {originalIndex, text} pairs and submits the ORIGINAL index, and
-- `submitQuizAnswers` re-reads `correct_answer` server-side and compares
-- against that index. Display order never crosses the server boundary.
--
-- Consequences, all asserted below rather than argued in prose:
--   * `correct_answer` keeps its exact meaning
--   * past attempts are never reinterpreted — they store original indices
--   * server-side grading is untouched
--
-- ── SCOPE ──────────────────────────────────────────────────────────────────
--
-- Capabilities 1 (question order) and 2 (option order) ONLY. Capability 3
-- (subset from a question bank) and capability 4 (random pick among several
-- quizzes) remain unimplemented and are NOT enabled by this migration — there
-- is no bank to draw from, and a subset would need the drawn set persisted per
-- attempt or grading could not be reproduced on appeal.
--
-- ── KNOWN LIMITATION, ACCEPTED ─────────────────────────────────────────────
--
-- `quiz_attempts` has no seed column, and the per-attempt seed is generated
-- client-side and never transmitted. After this migration no attempt records
-- the order its learner actually saw. You can always prove WHAT was answered
-- and that it graded correctly; you cannot reconstruct the screen. Accepted
-- for an unlimited-retry, non-gating formative quiz. Final exams already
-- randomise unconditionally with the same non-persistence (XPA-8 B-2.3A), so
-- this migration neither introduces nor worsens it. Tracked separately.
-- ============================================================================

begin;

do $$
declare
  c_quiz           constant uuid := '70bbc2a8-9c34-4607-88a3-7ce328ea9e7e';
  c_uat_attempt    constant uuid := '650fc334-4577-496f-a9f3-fd464362b93f';

  v_lesson         uuid;
  v_module         uuid;
  v_course         uuid;
  v_rq             boolean;
  v_ro             boolean;
  v_questions      int;
  v_bad_options    int;
  v_attempts       int;
  v_attempts_after int;
  v_other_flagged  int;
  v_published      boolean;
  v_rfe            boolean;
  v_uat_score      int;
  v_uat_max        int;
  v_uat_passed     boolean;
  v_uat_answers    jsonb;
  v_rows           int;
begin
  -- ── 1. The quiz must exist, or we are guessing ──────────────────────────
  select lesson_id, module_id, course_id, randomize_questions, randomize_options
    into v_lesson, v_module, v_course, v_rq, v_ro
  from public.quizzes
  where id = c_quiz;

  if not found then
    raise exception 'QUIZ-1B 052: quiz % not found — refusing to guess', c_quiz;
  end if;

  -- ── 2. It must be the LESSON-SCOPED FORMATIVE quiz ──────────────────────
  --
  -- `resolveQuizContext` classifies a course-scoped quiz as the final exam.
  -- Randomising an exam is already unconditional in code and is NOT what this
  -- migration approves, so a drifted parent must abort rather than proceed.
  if v_lesson is null then
    raise exception 'QUIZ-1B 052: quiz % has no lesson_id — not the formative quiz this migration approves', c_quiz;
  end if;
  if v_module is not null then
    raise exception 'QUIZ-1B 052: quiz % is module-scoped (module_id %) — out of scope', c_quiz, v_module;
  end if;
  if v_course is not null then
    raise exception 'QUIZ-1B 052: quiz % is course-scoped (a FINAL EXAM, course_id %) — out of scope', c_quiz, v_course;
  end if;

  -- ── 3. Pre-state must be exactly false / false ──────────────────────────
  --
  -- Not merely idempotence. If either flag is already true, someone activated
  -- outside this ledger and the operator must find out why before proceeding.
  if v_rq or v_ro then
    raise exception 'QUIZ-1B 052: quiz % already has randomisation (questions=%, options=%) — expected false/false; refusing to overwrite an unrecorded change',
      c_quiz, v_rq, v_ro;
  end if;

  -- ── 4. Content shape must be what was audited: 3 questions, 4 options ───
  select count(*) into v_questions
  from public.quiz_questions where quiz_id = c_quiz;

  if v_questions <> 3 then
    raise exception 'QUIZ-1B 052: expected 3 questions, found % — content drifted since audit', v_questions;
  end if;

  select count(*) into v_bad_options
  from public.quiz_questions
  where quiz_id = c_quiz and jsonb_array_length(options) <> 4;

  if v_bad_options <> 0 then
    raise exception 'QUIZ-1B 052: % question(s) do not have exactly 4 options — content drifted since audit', v_bad_options;
  end if;

  -- ── 5. Capture everything this migration must NOT change ────────────────
  select count(*) into v_attempts from public.quiz_attempts where quiz_id = c_quiz;

  select score, max_score, passed, answers
    into v_uat_score, v_uat_max, v_uat_passed, v_uat_answers
  from public.quiz_attempts where id = c_uat_attempt;

  if not found then
    raise exception 'QUIZ-1B 052: historical UAT attempt % not found — refusing to act without its baseline', c_uat_attempt;
  end if;

  select count(*) into v_other_flagged
  from public.quizzes
  where id <> c_quiz and (randomize_questions or randomize_options);

  select c.is_published, c.requires_final_exam
    into v_published, v_rfe
  from public.courses c
  join public.modules m on m.course_id = c.id
  join public.lessons l on l.module_id = m.id
  where l.id = v_lesson;

  -- An unparented lesson would make the publication assertions below compare
  -- null to null and silently pass. Refuse rather than assert nothing.
  if not found then
    raise exception 'QUIZ-1B 052: could not resolve the owning course for lesson % — refusing to act blind', v_lesson;
  end if;

  raise notice 'QUIZ-1B 052: target % — lesson-scoped, % question(s), % attempt(s); % other quiz(zes) randomised; course published=%, requires_final_exam=%',
    c_quiz, v_questions, v_attempts, v_other_flagged, v_published, v_rfe;

  -- ── 6. THE CHANGE — guarded on the pre-state, addressed by primary key ──
  update public.quizzes
  set    randomize_questions = true,
         randomize_options   = true
  where  id = c_quiz
    and  randomize_questions = false
    and  randomize_options   = false;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'QUIZ-1B 052: expected to update exactly 1 row, updated %', v_rows;
  end if;

  -- ── 7. Prove the intended quiz, and ONLY it, is activated ───────────────
  select randomize_questions, randomize_options into v_rq, v_ro
  from public.quizzes where id = c_quiz;

  if not (v_rq and v_ro) then
    raise exception 'QUIZ-1B 052: target did not activate (questions=%, options=%)', v_rq, v_ro;
  end if;

  if (select count(*) from public.quizzes
      where id <> c_quiz and (randomize_questions or randomize_options)) <> v_other_flagged then
    raise exception 'QUIZ-1B 052: randomisation leaked to another quiz — the scope escaped';
  end if;

  -- ── 8. Prove nothing else moved ─────────────────────────────────────────
  if (select count(*) from public.quiz_questions where quiz_id = c_quiz) <> v_questions then
    raise exception 'QUIZ-1B 052: question count changed — expected %', v_questions;
  end if;

  if (select count(*) from public.quiz_questions
      where quiz_id = c_quiz and jsonb_array_length(options) <> 4) <> 0 then
    raise exception 'QUIZ-1B 052: option arrays changed shape';
  end if;

  select count(*) into v_attempts_after from public.quiz_attempts where quiz_id = c_quiz;
  if v_attempts_after <> v_attempts then
    raise exception 'QUIZ-1B 052: attempt count changed (% -> %)', v_attempts, v_attempts_after;
  end if;

  if (select score     from public.quiz_attempts where id = c_uat_attempt) is distinct from v_uat_score
  or (select max_score from public.quiz_attempts where id = c_uat_attempt) is distinct from v_uat_max
  or (select passed    from public.quiz_attempts where id = c_uat_attempt) is distinct from v_uat_passed
  or (select answers   from public.quiz_attempts where id = c_uat_attempt) is distinct from v_uat_answers then
    raise exception 'QUIZ-1B 052: the historical UAT attempt % was altered', c_uat_attempt;
  end if;

  if (select c.is_published from public.courses c
      join public.modules m on m.course_id = c.id
      join public.lessons l on l.module_id = m.id
      where l.id = v_lesson) is distinct from v_published then
    raise exception 'QUIZ-1B 052: course publication state changed';
  end if;

  if (select c.requires_final_exam from public.courses c
      join public.modules m on m.course_id = c.id
      join public.lessons l on l.module_id = m.id
      where l.id = v_lesson) is distinct from v_rfe then
    raise exception 'QUIZ-1B 052: requires_final_exam changed';
  end if;

  raise notice 'QUIZ-1B 052: activated randomisation on % (questions+options); % question(s) and % attempt(s) intact; UAT attempt % still %/%, passed=%; no other quiz randomised',
    c_quiz, v_questions, v_attempts, c_uat_attempt, v_uat_score, v_uat_max, v_uat_passed;
end $$;

commit;

-- ============================================================================
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
--
--   This migration MUST NOT be applied before the QUIZ-1B release is merged
--   and its production deployment reports READY.
--
--   The reason is not that the randomisation code is missing — the
--   `orderQuestions` / `buildDisplayOptions` wiring shipped with XPA-4 and is
--   already live; only these flags gate it. Applying early would therefore
--   WORK, and that is the hazard: learners would meet shuffled questions while
--   the pre-submission instruction still told them a passing score was
--   required, which is precisely the contradiction QUIZ-1B exists to remove.
--   Deploying first keeps one coherent change under one UAT.
--
--     1. Merge the QUIZ-1B PR into main; wait for the production deployment
--        to report READY on the merge SHA.
--     2. Run this file in the Supabase SQL editor.
--     3. node scripts/security/verify-quiz-1b.mjs       -> expect all PASS
--     4. Production UAT on C1-F1 -> "Comprendre la CX" ->
--        "Les 3 niveaux d'experience".
--
-- WHAT THIS DOES NOT DO
--
--   * It does not touch any question, option, answer key, attempt or score.
--   * It does not change publication, access, entitlement or enrollment state.
--   * It does not enable randomisation on any other quiz — there is currently
--     exactly one, and the assertions above fail loudly if that changes.
--   * It does not alter final-exam behaviour, which randomises unconditionally
--     and does not consult these flags.
--   * It does not change PLATFORM_MODE. Module-quiz gating and final-exam
--     routing remain dormant under pilot mode; that is a separate ruling.
--
-- ROLLBACK — restores the pre-activation state exactly. Safe at any time:
-- these two booleans are the only state this migration writes, and no attempt
-- is reinterpreted in either direction.
--
--   begin;
--   update public.quizzes
--   set    randomize_questions = false,
--          randomize_options   = false
--   where  id = '70bbc2a8-9c34-4607-88a3-7ce328ea9e7e';
--   do $rb$
--   begin
--     if (select count(*) from public.quizzes
--         where randomize_questions or randomize_options) <> 0 then
--       raise exception 'QUIZ-1B 052 rollback: randomisation still enabled somewhere';
--     end if;
--   end $rb$;
--   commit;
-- ============================================================================
