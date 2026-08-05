-- ============================================================
-- Migration 031: Narrow public projection for discovery (XPA-3)
--
-- Ratified by management decision Q-E. Additive: three views + grants.
-- NO table, column, policy or trigger is changed. The four registry tables
-- (catalogues, course_codes, learning_paths, learning_path_courses) REMAIN
-- ADMINISTRATOR-ONLY. No `USING (true)` policy is added to any of them.
--
-- ── Why views, not RLS ──────────────────────────────────────────────────
-- XPA-2 closed these tables after discovering that a public SELECT policy had
-- exposed the entire unproduced roadmap to anonymous callers. Re-opening them
-- with a filtered policy would work, but it puts the boundary in a place that
-- every future query inherits — one `select *` and the filter is all that
-- stands between a visitor and the backlog.
--
-- A view puts the boundary in the DATABASE and makes it structural: the
-- projection cannot return a column it does not select, or a row it does not
-- join. Application code physically cannot ask these views for roadmap data.
--
-- PostgreSQL 17 creates views with `security_invoker = false` (the default), so
-- these run with the view owner's rights and read past the admin-only RLS on the
-- base tables. That is DELIBERATE and is exactly what makes the projection
-- possible. It is safe because every filter is hardcoded here — the caller
-- supplies nothing that can widen the result set.
--
-- ── What Q-E forbids, and how each is prevented ─────────────────────────
--   total planned courses in a path ...... only published rows are joined
--   unavailable-course counts ............ nothing unavailable is ever returned
--   unproduced codes ..................... inner join on courses requires a row
--   backlog / undecided / retired status . `status` is not selected, anywhere
--   unreleased titles .................... titles come from `courses`, not
--                                          `course_codes.canonical_title`
--   internal roadmap composition ......... paths with zero published courses
--                                          are excluded entirely
--   internal buyer notes ................. `learning_paths.note` is not selected
--
-- ── The subtle one: position gaps ───────────────────────────────────────
-- Raw `position` leaks absence. PM-PRO holds positions 1..7 with only two
-- published; emitting 1 and 4 tells a visitor that items 2 and 3 exist. Public
-- ordering is therefore RE-RANKED with row_number(), so the sequence is always
-- 1..N with no gaps and no inference.
-- ============================================================

-- ── 1. Catalogues that actually have something to show ───────────────────
-- A catalogue with no published course is omitted. Listing an empty tier would
-- disclose that the tier exists and is unbuilt — the same class of roadmap
-- disclosure Q-E forbids. Catalogues appear automatically once content ships.
create or replace view public.public_catalogues as
select
  cat.code,
  cat.title,
  cat.position
from public.catalogues cat
where exists (
  select 1
  from public.courses c
  where c.code is not null
    and c.is_published = true
    and split_part(c.code, '-', 1) = cat.code
);

comment on view public.public_catalogues is
  'XPA-3 public projection. Catalogues having at least one PUBLISHED course. Excludes objective and any empty tier. Never exposes course_codes.';

-- ── 2. Learning paths that have at least one published course ────────────
-- `note` is deliberately absent: it carries internal framing and "Acheteurs
-- types" buyer targeting (Q-E: no internal buyer notes).
create or replace view public.public_learning_paths as
select
  p.code,
  p.kind,          -- 'professional' | 'sector' — drives /parcours vs /secteurs
  p.title,
  p.objective,     -- approved public framing (sector "enjeux", path purpose)
  p.position
from public.learning_paths p
where exists (
  select 1
  from public.learning_path_courses lpc
  join public.courses c
    on c.code = lpc.course_code
   and c.is_published = true
  where lpc.path_code = p.code
);

comment on view public.public_learning_paths is
  'XPA-3 public projection. Paths with >=1 published course. Excludes note (internal buyer targeting) and any empty path.';

-- ── 3. Published course membership, re-ranked ────────────────────────────
-- Returns the RELATIONSHIP only — a course code, its public order and the socle
-- flag. Course content is read from `courses`, which is already anon-readable
-- for published rows. Paths therefore reference courses; they never copy
-- pedagogical content.
create or replace view public.public_path_courses as
select
  lpc.path_code,
  lpc.course_code,
  lpc.is_socle,
  -- Re-ranked, never the stored position: a gap would disclose a hidden course.
  row_number() over (
    partition by lpc.path_code
    order by lpc.position
  ) as position
from public.learning_path_courses lpc
join public.courses c
  on c.code = lpc.course_code
 and c.is_published = true;

comment on view public.public_path_courses is
  'XPA-3 public projection. Published path membership only, ordering re-ranked to 1..N so position gaps cannot reveal unpublished courses. Carries no course content.';

-- ── 4. Grants ────────────────────────────────────────────────────────────
-- Read-only, to the public roles. No INSERT/UPDATE/DELETE is granted; views
-- over multiple base tables are not updatable in any case.
grant select on public.public_catalogues     to anon, authenticated;
grant select on public.public_learning_paths to anon, authenticated;
grant select on public.public_path_courses   to anon, authenticated;

-- Base tables stay closed. Assert it rather than assume it.
revoke all on public.catalogues            from anon;
revoke all on public.course_codes          from anon;
revoke all on public.learning_paths        from anon;
revoke all on public.learning_path_courses from anon;

-- ── 5. Verification ──────────────────────────────────────────────────────
do $$
declare
  n_paths      integer;
  n_leak       integer;
  n_gap        integer;
begin
  -- Every path in the projection must have at least one published course.
  select count(*) into n_paths from public.public_learning_paths;
  raise notice 'public paths with published content: %', n_paths;

  -- No unpublished or unproduced course code may appear.
  select count(*) into n_leak
  from public.public_path_courses ppc
  where not exists (
    select 1 from public.courses c
    where c.code = ppc.course_code and c.is_published = true
  );
  if n_leak > 0 then
    raise exception 'projection leaks % non-published course code(s)', n_leak;
  end if;

  -- Public ordering must be contiguous 1..N for every path.
  select count(*) into n_gap
  from (
    select path_code, count(*) as n, max(position) as maxpos
    from public.public_path_courses group by path_code
  ) t
  where t.n <> t.maxpos;
  if n_gap > 0 then
    raise exception '% path(s) have non-contiguous public ordering', n_gap;
  end if;
end $$;

-- ============================================================
-- ROLLBACK (manual):
--   drop view if exists public.public_path_courses;
--   drop view if exists public.public_learning_paths;
--   drop view if exists public.public_catalogues;
-- No base table, policy or data is affected.
-- ============================================================
