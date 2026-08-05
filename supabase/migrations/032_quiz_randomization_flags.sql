-- ============================================================
-- Migration 032: Explicit per-quiz randomization flags (XPA-4)
--
-- STRICTLY ADDITIVE. Two boolean columns on `quizzes`, both DEFAULT FALSE.
-- No existing row changes behaviour. No question, answer, attempt or score is
-- touched, reinterpreted or migrated.
--
-- ── Why flags rather than a single "random" switch ──────────────────────
-- Randomization is FOUR independent capabilities, and conflating them is how a
-- quiz silently starts grading incorrectly:
--
--   1. question ordering          -> randomize_questions  (implemented here)
--   2. answer/option ordering     -> randomize_options    (implemented here)
--   3. subset from a question bank-> NOT implemented (see below)
--   4. random pick among several
--      quizzes on one lesson      -> NOT implemented (see below)
--
-- Only 1 and 2 are enabled by this migration, because only 1 and 2 can be done
-- today without risking correctness or inventing content.
--
-- ── Why this needs NO change to answer representation ───────────────────
-- `quiz_questions.correct_answer` is an INTEGER INDEX into `options`. Shuffling
-- the displayed options would therefore appear to change the correct answer.
--
-- It does not here, because shuffling is PRESENTATIONAL ONLY. The client
-- shuffles {originalIndex, text} pairs and submits the ORIGINAL index. Display
-- order and grading are fully decoupled, so:
--   * correct_answer keeps its exact current meaning
--   * past attempts remain valid and are never reinterpreted
--   * server-side grading (app/actions/quiz.ts) is unchanged
--
-- A stable answer-identity migration would also work, but it would rewrite
-- every question row and change the meaning of stored data — a far larger
-- blast radius for no additional safety.
--
-- ── Not implemented, and why ────────────────────────────────────────────
-- (3) Question bank / subset: would need a pool size AND the selected subset
--     persisted per attempt, otherwise a reload re-draws and grading cannot be
--     reproduced or appealed. There is also no bank to draw from: the database
--     holds 1 quiz with 3 questions. Deferred until content exists.
-- (4) Random pick among several quizzes on one lesson: today the selector is
--     `.limit(1)` with no ORDER BY, which is UNDEFINED rather than random.
--     XPA-4 makes that deterministic first. An explicit opt-in random mode can
--     follow, and must record which quiz was served.
-- ============================================================

alter table public.quizzes
  add column if not exists randomize_questions boolean not null default false;

alter table public.quizzes
  add column if not exists randomize_options boolean not null default false;

comment on column public.quizzes.randomize_questions is
  'XPA-4. When true the learner sees questions in a shuffled order. Presentational only — order_index remains the authoring order and grading is unaffected.';

comment on column public.quizzes.randomize_options is
  'XPA-4. When true the learner sees answer options in a shuffled order. Presentational only: the client submits the ORIGINAL option index, so correct_answer keeps its exact meaning and past attempts are never reinterpreted.';

-- ── Verification ─────────────────────────────────────────────────────────
do $$
declare
  n_quizzes  integer;
  n_randomiz integer;
begin
  select count(*) into n_quizzes from public.quizzes;
  select count(*) into n_randomiz from public.quizzes
   where randomize_questions or randomize_options;

  -- Defaults must preserve existing behaviour exactly: nothing is randomized
  -- until an administrator opts a specific quiz in.
  if n_randomiz <> 0 then
    raise exception 'migration must not enable randomization on any existing quiz (found %)', n_randomiz;
  end if;

  raise notice 'quizzes: %, randomization enabled on: 0 (defaults preserved)', n_quizzes;
end $$;

-- ============================================================
-- ROLLBACK (manual):
--   alter table public.quizzes drop column if exists randomize_options;
--   alter table public.quizzes drop column if exists randomize_questions;
-- No question, answer, attempt or score is affected.
-- ============================================================
