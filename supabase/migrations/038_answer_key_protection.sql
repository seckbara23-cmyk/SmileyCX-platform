-- ============================================================================
-- Migration 038 — XPA-6D: answer-key protection for quizzes AND exercises.
--
-- Run as a SINGLE TRANSACTION. Unlike 037, this file wraps ITSELF (see the
-- final section) so atomicity does not depend on the operator's tool — 037's
-- closure recorded that gap and this is the correction.
--
-- ── THE INVARIANT ─────────────────────────────────────────────────────────
--
--   No learner-facing payload may contain an authoritative answer key before
--   scoring. Correct answers belong to trusted server-side scoring paths and
--   to authorized administration. Nothing else.
--
-- ── TWO FINDINGS, ONE DEFECT CLASS, DIFFERENT SEVERITY ────────────────────
--
-- B-4 (quizzes) — recorded in xpa-6a-identity-audit.md, retained for XPA-6D.
--   `quiz_questions_visible` (036) is FOR SELECT USING has_course_access(...).
--   RLS is ROW-level. A learner who satisfies that predicate may select EVERY
--   column, `correct_answer` included. The learner UI hand-picks safe columns,
--   so the key never reached the browser by accident — but that is UI hiding,
--   not protection. Reproduced against production: an entitled learner issuing
--   `select=id,correct_answer` received [0, 1, 1].
--
-- EXERCISES — discovered during XPA-6D's audit, and WORSE.
--   The learner lesson page is a 'use client' component using the BROWSER
--   Supabase client, and it selected `correct_category_id` outright. The key
--   was not merely reachable by a crafted query; it was shipped to every
--   learner on every lesson render. ExerciseBlock then compared placements to
--   it IN THE BROWSER. Scoring was client-side, against a client-held key.
--
--   Latent only because production holds 0 exercises. The structure was live.
--
-- ── WHY COLUMN PRIVILEGES, AND NOT A VIEW OR AN RPC ───────────────────────
--
-- Every legitimate reader of both keys is already the SERVICE ROLE:
--
--   quiz scoring      app/actions/quiz.ts        createAdminClient()
--   quiz admin r/w    app/(admin)/admin/quizzes  createAdminClient()
--   exercise admin    app/(admin)/admin/exercises createAdminClient()
--   exercise scoring  app/actions/exercise.ts    createAdminClient()  (038)
--
-- So no legitimate path reads these columns as `anon` or `authenticated`, and
-- the smallest coherent change is to stop granting them. A learner-safe view
-- would add an object to maintain and leave the base table reachable; an RPC
-- would duplicate a scoring path that already exists. Column privileges close
-- the boundary itself, which is what §3 of the brief requires: `select=*`
-- becomes 42501 rather than a leak.
--
-- RLS still governs WHICH ROWS. Privileges now govern WHICH COLUMNS. Both are
-- required and neither replaces the other.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--
-- Forward-only, per project convention. To reverse manually:
--
--   grant select on public.quiz_questions to anon, authenticated;
--   grant select on public.exercise_items to anon, authenticated;
--
-- That restores the vulnerability and must never be run to "fix" a broken
-- learner page. If a learner surface breaks after this migration, the surface
-- is selecting a key column and the surface is what is wrong.
-- ============================================================================

begin;


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regclass('public.quiz_questions') is null then
    raise exception 'XPA-6D 038 preflight: public.quiz_questions is missing';
  end if;
  if to_regclass('public.exercise_items') is null then
    raise exception 'XPA-6D 038 preflight: public.exercise_items is missing — apply 023 first';
  end if;
  if to_regprocedure('public.has_course_access(uuid)') is null then
    raise exception 'XPA-6D 038 preflight: has_course_access(uuid) is missing — apply 035/036 first';
  end if;
  -- 037 must be in place: this migration assumes the entitlement model decides
  -- row visibility. Protecting columns on top of the WRONG row model would
  -- look like a pass while granting the rows to the wrong people.
  if to_regclass('public.entitlements') is null then
    raise exception 'XPA-6D 038 preflight: public.entitlements is missing — apply 037 first';
  end if;
end $$;


-- ══ 1. QUIZ_QUESTIONS — grant only the learner-safe projection ════════════
--
-- Safe (7): everything needed to RENDER and ANSWER a question.
-- Withheld (3): correct_answer, drag_match_answers, explanation.
--
-- `explanation` is withheld deliberately. It explains WHY an answer is right
-- and therefore reveals it. It is still shown after submission — but from the
-- scoring action's generated payload, never from a table read.

revoke all on public.quiz_questions from anon, authenticated;

grant select (
  id,
  quiz_id,
  question,
  options,
  order_index,
  question_type,
  question_image_url
) on public.quiz_questions to anon, authenticated;


-- ══ 2. EXERCISE_ITEMS — same treatment ════════════════════════════════════
--
-- Safe (3): id, exercise_id, label, order_index — enough to render the
-- draggable items. Withheld: correct_category_id, the authoritative mapping.

revoke all on public.exercise_items from anon, authenticated;

grant select (
  id,
  exercise_id,
  label,
  order_index
) on public.exercise_items to anon, authenticated;


-- ══ 2b. EXERCISES ARE STILL ON THE SUPERSEDED ACCESS RULE ═════════════════
--
-- Discovered while building the XPA-6D verifier, and proved against production
-- with a disposable learner:
--
--   no entitlement, no enrollment  ->  0 rows
--   ENTITLEMENT only               ->  0 rows   <- the ratified seam grants nothing
--   + ENROLLMENT                   ->  1 row    <- the abolished rule still grants
--
-- `exercises_select` (023) predicates on an ACTIVE row in `enrollments`. XPA-6B
-- ratified Q-L: an enrollment is learning history and authorizes NOTHING. Every
-- other content table moved to `has_course_access()` in 035/036. Exercises were
-- missed, so they kept granting on the rule the platform abolished — and denied
-- the learners the new rule entitles.
--
-- That is an XPA-6B regression living in a subsystem nobody re-checked, and it
-- belongs here because it is the access model for the very rows this migration
-- protects: withholding a column is hollow if the row is exposed to the wrong
-- people. `exercise_categories_select` and `exercise_items_select` gate on
-- `exists (select 1 from exercises ...)`, which is itself RLS-filtered, so
-- correcting the parent corrects all three.
--
-- The `is_free` bypass goes too. `has_course_access()` has no such clause, so
-- keeping it would leave exercises looser than lessons, modules and quizzes.
-- Admins are unaffected: they hold `exercises_admin` FOR ALL, and
-- `has_course_access()` admits `is_platform_admin()` in its own right.

drop policy if exists "exercises_select" on public.exercises;

create policy "exercises_select" on public.exercises
  for select using (
    is_published = true
    and public.has_course_access(public.course_of_lesson(exercises.lesson_id))
  );


-- ══ 3. APPLY-TIME VERIFICATION ════════════════════════════════════════════
--
-- Structural checks alone have passed here before while the system was broken
-- (035). So this section READS as each role and classifies the OUTCOME rather
-- than pattern-matching a SQLSTATE:
--
--   ALLOWED               the statement ran
--   REFUSED_BY_PRIVILEGE  42501 — no grant on that column
--   BROKEN                anything else — never a pass, whichever way
--
-- A withheld column that answers ALLOWED is a leak. A safe column that answers
-- REFUSED_BY_PRIVILEGE is an outage. Both fail this block.

create or replace function public.xpa6d_probe(p_role text, p_sql text)
returns text
language plpgsql
as $$
begin
  execute format('set role %I', p_role);
  execute p_sql;
  reset role;
  return 'ALLOWED';
exception
  when insufficient_privilege then                    -- 42501
    reset role;
    return 'REFUSED_BY_PRIVILEGE';
  when others then
    reset role;
    return 'BROKEN:' || sqlstate || ':' || replace(sqlerrm, E'\n', ' ');
end $$;

do $$
declare
  v    text;
  bad  text;
  r    text;
  col  text;
begin
  -- ── 3.1 Withheld columns must be unreadable by BOTH app roles ──────────
  foreach r in array array['anon', 'authenticated'] loop

    foreach col in array array['correct_answer', 'drag_match_answers', 'explanation'] loop
      v := public.xpa6d_probe(r, format('select %I from public.quiz_questions limit 1', col));
      if v <> 'REFUSED_BY_PRIVILEGE' then
        raise exception '% may read quiz_questions.%: expected REFUSED_BY_PRIVILEGE, got %', r, col, v;
      end if;
    end loop;

    -- select * must fail too: it expands to every column, key columns included.
    v := public.xpa6d_probe(r, 'select * from public.quiz_questions limit 1');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may SELECT * on quiz_questions: expected REFUSED_BY_PRIVILEGE, got %', r, v;
    end if;

    v := public.xpa6d_probe(r, 'select correct_category_id from public.exercise_items limit 1');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may read exercise_items.correct_category_id: expected REFUSED_BY_PRIVILEGE, got %', r, v;
    end if;

    v := public.xpa6d_probe(r, 'select * from public.exercise_items limit 1');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may SELECT * on exercise_items: expected REFUSED_BY_PRIVILEGE, got %', r, v;
    end if;

    -- ── 3.2 The learner-safe projection must still WORK ──────────────────
    -- A seam that denies everyone is broken, not secure.
    v := public.xpa6d_probe(r,
      'select id, quiz_id, question, options, order_index, question_type, question_image_url
         from public.quiz_questions limit 1');
    if v <> 'ALLOWED' then
      raise exception '% cannot read the learner-safe quiz projection: %', r, v;
    end if;

    v := public.xpa6d_probe(r,
      'select id, exercise_id, label, order_index from public.exercise_items limit 1');
    if v <> 'ALLOWED' then
      raise exception '% cannot read the learner-safe exercise projection: %', r, v;
    end if;

    -- ── 3.3 No writes to either table ────────────────────────────────────
    -- Before 038 `authenticated` held UPDATE here; RLS filtered the rows, so a
    -- PATCH returned 204 with nothing changed and looked like a refusal. The
    -- privilege is now gone, so the refusal is explicit rather than incidental.
    v := public.xpa6d_probe(r, 'update public.quiz_questions set correct_answer = 99');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may UPDATE quiz_questions.correct_answer: got %', r, v;
    end if;

    v := public.xpa6d_probe(r,
      'update public.exercise_items set correct_category_id = gen_random_uuid()');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may UPDATE exercise_items.correct_category_id: got %', r, v;
    end if;

    v := public.xpa6d_probe(r, 'delete from public.quiz_questions');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may DELETE from quiz_questions: got %', r, v;
    end if;

    v := public.xpa6d_probe(r, 'delete from public.exercise_items');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception '% may DELETE from exercise_items: got %', r, v;
    end if;

  end loop;

  -- ── 3.4 Scoring and administration must be UNAFFECTED ──────────────────
  -- Both run as service_role. If this arm fails, the phase has broken the
  -- product rather than protected it.
  v := public.xpa6d_probe('service_role',
    'select correct_answer, drag_match_answers, explanation from public.quiz_questions limit 1');
  if v <> 'ALLOWED' then
    raise exception 'service_role can no longer read the quiz answer key — scoring is broken: %', v;
  end if;

  v := public.xpa6d_probe('service_role',
    'select correct_category_id from public.exercise_items limit 1');
  if v <> 'ALLOWED' then
    raise exception 'service_role can no longer read the exercise answer key — scoring is broken: %', v;
  end if;

  -- ── 3.5 The exact column-privilege matrix ──────────────────────────────
  -- Asserted positively: anything granted to an app role beyond the safe list
  -- is a finding, including a column added by a LATER migration that silently
  -- inherits a table-level grant.
  select string_agg(distinct grantee || '.' || column_name, ', ' order by grantee || '.' || column_name)
    into bad
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'quiz_questions'
    and grantee in ('anon', 'authenticated')
    and column_name not in ('id', 'quiz_id', 'question', 'options',
                            'order_index', 'question_type', 'question_image_url');
  if bad is not null then
    raise exception 'quiz_questions grants columns beyond the learner-safe set: %', bad;
  end if;

  select string_agg(distinct grantee || '.' || column_name, ', ' order by grantee || '.' || column_name)
    into bad
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'exercise_items'
    and grantee in ('anon', 'authenticated')
    and column_name not in ('id', 'exercise_id', 'label', 'order_index');
  if bad is not null then
    raise exception 'exercise_items grants columns beyond the learner-safe set: %', bad;
  end if;

  -- ── 3.6 No table-level privilege may survive ───────────────────────────
  -- A table-level SELECT would silently re-cover every column and make §3.5
  -- pass for the wrong reason.
  select string_agg(grantee || ':' || privilege_type, ', ' order by grantee || ':' || privilege_type)
    into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('quiz_questions', 'exercise_items')
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if bad is not null then
    raise exception 'table-level privileges survive on a protected table: %', bad;
  end if;

  -- ── 3.7 Exercises must be on the ratified seam, not the abolished one ──
  select qual into bad
  from pg_policies
  where schemaname = 'public' and tablename = 'exercises' and policyname = 'exercises_select';

  if bad is null then
    raise exception 'exercises_select is missing — exercises would be unreadable by everyone';
  end if;
  if bad not like '%has_course_access%' then
    raise exception 'exercises_select does not consult has_course_access(): %', bad;
  end if;
  if bad like '%enrollments%' then
    raise exception 'exercises_select still grants on enrollment — Q-L violated: %', bad;
  end if;

  raise notice 'XPA-6D 038: quiz and exercise answer keys are unreadable by anon/authenticated; learner projections, service-role scoring and the exercise access seam verified.';
end $$;

drop function if exists public.xpa6d_probe(text, text);

commit;
