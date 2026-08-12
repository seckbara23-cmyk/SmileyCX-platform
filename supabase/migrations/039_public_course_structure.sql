-- ============================================================================
-- Migration 039 — UAT-ROUTE-02: public projection of course STRUCTURE.
--
-- Runs as a SINGLE TRANSACTION; this file wraps itself.
--
-- ── THE DEFECT ────────────────────────────────────────────────────────────
--
-- The public course page rendered "0 modules · 0 leçons" and its primary CTA
-- became inert, because `app/(public)/courses/[slug]/page.tsx` loaded modules
-- and lessons with the LEARNER'S session client. XPA-6A/6B/6D correctly hide
-- those tables from anyone without an entitlement, so an anonymous visitor got
-- zero rows — and the page had nothing left to count or to route to.
--
-- The page was reading PROTECTED learner content in order to render PUBLIC
-- catalogue metadata. A course syllabus — how many modules, their titles, how
-- long each lesson runs — is marketing copy. Lesson BODIES are not.
--
-- ── WHY A VIEW, AND NOT A POLICY ──────────────────────────────────────────
--
-- Exactly the reasoning migration 031 recorded for the discovery projection,
-- and it applies unchanged here: re-opening `modules` / `lessons` with a
-- filtered SELECT policy would work, but it puts the boundary somewhere every
-- future query inherits — one `select *` and the filter is all that stands
-- between a visitor and a lesson body.
--
-- A view puts the boundary in the DATABASE and makes it structural: the
-- projection cannot return a column it does not select. `content`, `video_url`,
-- `subtitle_url` and `pdf_url` are physically unreachable through these views,
-- whatever the caller asks for.
--
-- PostgreSQL creates views with `security_invoker = false`, so these read past
-- the entitlement RLS on the base tables. That is DELIBERATE and is what makes
-- the projection possible. It is safe because every filter is hardcoded here —
-- the caller supplies nothing that can widen the result set.
--
-- ── D-GRANT ───────────────────────────────────────────────────────────────
--
-- Supabase applies `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated`, and a VIEW is born holding those grants. Migration 034 shipped
-- an anonymously-WRITABLE view for exactly this reason. So each view below is
-- revoked to nothing first and then granted SELECT only, and §3 asserts it.
--
-- ── WHAT THIS DOES NOT CHANGE ─────────────────────────────────────────────
--
-- No policy, no grant on any base table, no entitlement logic. `has_course_access()`
-- is untouched. A learner still cannot read a lesson body, an answer key, or an
-- exercise key. This migration only stops the marketing page from having to ask.
-- ============================================================================

begin;


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regclass('public.modules') is null or to_regclass('public.lessons') is null then
    raise exception 'UAT-ROUTE-02 039 preflight: modules/lessons are missing';
  end if;
  if to_regclass('public.courses') is null then
    raise exception 'UAT-ROUTE-02 039 preflight: courses is missing';
  end if;
end $$;


-- ══ 1. MODULES OF PUBLISHED COURSES ═══════════════════════════════════════
--
-- Only published courses. Publication controls DISCOVERY (D-ACCESS), which is
-- precisely what this projection serves.

create or replace view public.public_course_modules as
select
  m.id,
  m.course_id,
  m.slug,
  m.title,
  m.order_index
from public.modules m
join public.courses c on c.id = m.course_id
where c.is_published = true;

comment on view public.public_course_modules is
  'UAT-ROUTE-02 public projection. Module structure of PUBLISHED courses for the catalogue page. No lesson content of any kind.';


-- ══ 2. LESSONS OF PUBLISHED COURSES — TITLES AND SHAPE ONLY ═══════════════
--
-- Selected: what a syllabus shows.
-- Absent, and unreachable through this view: content, video_url, subtitle_url,
-- pdf_url. Those stay behind has_course_access() on the base table.

create or replace view public.public_course_lessons as
select
  l.id,
  l.module_id,
  m.course_id,
  l.slug,
  l.title,
  l.duration_minutes,
  l.is_preview,
  l.order_index
from public.lessons l
join public.modules m on m.id = l.module_id
join public.courses c on c.id = m.course_id
where c.is_published = true;

comment on view public.public_course_lessons is
  'UAT-ROUTE-02 public projection. Lesson titles, durations and ordering for PUBLISHED courses. Never content, video_url, subtitle_url or pdf_url.';


-- ══ 3. PRIVILEGES — revoke first, then grant SELECT only ══════════════════

revoke all on public.public_course_modules from anon, authenticated, public;
revoke all on public.public_course_lessons from anon, authenticated, public;

grant select on public.public_course_modules to anon, authenticated;
grant select on public.public_course_lessons to anon, authenticated;


-- ══ 4. APPLY-TIME VERIFICATION ════════════════════════════════════════════

-- ── WHY THIS PROBE COUNTS ROWS ────────────────────────────────────────────
--
-- The first version of this block returned 'ALLOWED' whenever the statement
-- executed without error, and asserted that anon reading `lessons.content`
-- must NOT be 'ALLOWED'. It fired, and the finding was false: `lessons` is
-- protected by ROW-level security, not by column privilege, so anon holds
-- SELECT and RLS returns zero rows. `select content from lessons limit 1`
-- succeeds and returns nothing — which the probe scored as a leak.
--
-- Measured against production before this correction:
--
--   anon            lessons.content / video_url / subtitle_url / pdf_url -> 200, 0 rows
--   authenticated,
--   unentitled      same four columns                                    -> 200, 0 rows
--   service_role    same four columns                                    -> 82 rows
--
-- That is the ratified XPA-6A/6B posture, and `verify-xpa-6a.mjs` already
-- asserts it as DENIED_EMPTY. The bug was here.
--
-- It is the fifth variant of the family this programme keeps rediscovering,
-- and the inverted one: XPA-6A scored BROKEN as denied, 037 attempt 1 scored an
-- expected denial as broken, attempt 2 scored a structural refusal as broken,
-- XPA-6D scored an API-layer refusal as broken — and this scored DENIED_EMPTY
-- as ALLOWED. "The statement ran" is not "the caller got data".
--
-- So the probe now classifies the OUTCOME, the same five ways the production
-- verifier does, and each assertion names which outcomes it accepts:
--
--   ALLOWED_WITH_ROWS     rows came back — the only shape that is a leak
--   DENIED_EMPTY          reachable, RLS returned nothing (lessons' posture)
--   REFUSED_BY_PRIVILEGE  42501, no grant (quiz_questions.correct_answer's)
--   NO_SUCH_COLUMN        the projection cannot name it at all
--   BROKEN                anything else — never a pass, whichever way

create or replace function public.uat2_probe(p_role text, p_sql text)
returns text
language plpgsql
as $$
declare
  n bigint;
begin
  execute format('set role %I', p_role);
  execute 'select count(*) from (' || p_sql || ') probe_sub' into n;
  reset role;
  return case when n > 0 then 'ALLOWED_WITH_ROWS' else 'DENIED_EMPTY' end;
exception
  when insufficient_privilege then
    reset role;
    return 'REFUSED_BY_PRIVILEGE';
  when undefined_column then
    reset role;
    return 'NO_SUCH_COLUMN';
  when others then
    reset role;
    return 'BROKEN:' || sqlstate || ':' || replace(sqlerrm, E'\n', ' ');
end $$;

-- Writes cannot be wrapped in `count(*) from (...)`, so they keep an
-- error-shaped probe. For a write, "the statement ran" IS the failure.
create or replace function public.uat2_write_probe(p_role text, p_sql text)
returns text
language plpgsql
as $$
begin
  execute format('set role %I', p_role);
  execute p_sql;
  reset role;
  return 'ALLOWED';
exception
  when insufficient_privilege then reset role; return 'REFUSED_BY_PRIVILEGE';
  when others then reset role; return 'REFUSED:' || sqlstate;
end $$;

do $$
declare
  v text;
  bad text;
  r text;
  col text;
begin
  foreach r in array array['anon', 'authenticated'] loop

    -- 4.1 The projection must WORK. A view nobody can read is not a fix.
    --     Rows are expected here: this is the whole point of the migration.
    v := public.uat2_probe(r, 'select id, course_id, slug, title, order_index
                                 from public.public_course_modules limit 1');
    if v <> 'ALLOWED_WITH_ROWS' then
      raise exception '% cannot read public_course_modules: %', r, v;
    end if;

    v := public.uat2_probe(r, 'select id, module_id, course_id, slug, title,
                                      duration_minutes, is_preview, order_index
                                 from public.public_course_lessons limit 1');
    if v <> 'ALLOWED_WITH_ROWS' then
      raise exception '% cannot read public_course_lessons: %', r, v;
    end if;

    -- 4.2 Protected columns must be STRUCTURALLY absent, not merely ungranted.
    foreach col in array array['content', 'video_url', 'subtitle_url', 'pdf_url'] loop
      v := public.uat2_probe(r, format(
        'select %I from public.public_course_lessons limit 1', col));
      if v <> 'NO_SUCH_COLUMN' then
        raise exception 'public_course_lessons exposes %: expected NO_SUCH_COLUMN, got %', col, v;
      end if;
    end loop;

    -- 4.3 The views must not be writable (D-GRANT / migration 034's defect).
    foreach col in array array[
      'insert into public.public_course_modules (id) values (gen_random_uuid())',
      'update public.public_course_modules set title = ''x''',
      'delete from public.public_course_modules',
      'insert into public.public_course_lessons (id) values (gen_random_uuid())',
      'update public.public_course_lessons set title = ''x''',
      'delete from public.public_course_lessons'
    ] loop
      v := public.uat2_write_probe(r, col);
      if v = 'ALLOWED' then
        raise exception '% may write through a public projection: %', r, col;
      end if;
    end loop;

    -- 4.4 The BASE tables must remain closed to the same role. This projection
    --     must not have widened anything.
    --
    --     `lessons` is protected by RLS, so the correct answer is DENIED_EMPTY:
    --     the role may reach the table and gets nothing. Only rows coming back
    --     is a leak. Demanding a privilege refusal here would fail a correctly
    --     configured database — which is exactly what the first version did.
    v := public.uat2_probe(r, 'select content from public.lessons limit 1');
    if v = 'ALLOWED_WITH_ROWS' then
      raise exception '% can READ lesson bodies directly — the base table was widened', r;
    end if;
    if v not in ('DENIED_EMPTY', 'REFUSED_BY_PRIVILEGE') then
      raise exception '% reading lessons.content returned %', r, v;
    end if;

    --     `quiz_questions.correct_answer` is protected by COLUMN PRIVILEGE
    --     (XPA-6D, migration 038), so the correct answer is a hard 42501.
    --     DENIED_EMPTY here would mean the grant came back.
    v := public.uat2_probe(r, 'select correct_answer from public.quiz_questions limit 1');
    if v <> 'REFUSED_BY_PRIVILEGE' then
      raise exception 'XPA-6D regression: % reading quiz_questions.correct_answer returned %', r, v;
    end if;

  end loop;

  -- 4.5 Exact grant matrix on the new views: SELECT and nothing else.
  select string_agg(grantee || ':' || privilege_type, ', ' order by grantee || ':' || privilege_type)
    into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('public_course_modules', 'public_course_lessons')
    and grantee in ('anon', 'authenticated', 'PUBLIC')
    and privilege_type <> 'SELECT';
  if bad is not null then
    raise exception 'public projections hold non-SELECT privileges: %', bad;
  end if;

  raise notice 'UAT-ROUTE-02 039: public course structure projected; lesson bodies unreachable; base tables and XPA-6D protections unchanged.';
end $$;

drop function if exists public.uat2_probe(text, text);
drop function if exists public.uat2_write_probe(text, text);

commit;
