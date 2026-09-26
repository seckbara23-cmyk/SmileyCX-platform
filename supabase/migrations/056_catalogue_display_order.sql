-- ============================================================================
-- Migration 056 — CAT-ARCH-01: the catalogue display-order foundation.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- ADDITIVE AND REVERSIBLE. It changes NO data at all.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT V8 REQUIRES ───────────────────────────────────────────────────────
--
-- The V8 catalogue architecture separates two things this platform currently
-- conflates on the public surface:
--
--   the CODE      C1-F1, C2-F4 …  permanent academic identity (028, immutable)
--   the POSITION  1, 2, 3 …       where a learner sees the formation listed
--
-- `course_codes.position` has existed since 028 and already means display order
-- (the admin catalogue page orders by it). But the PUBLIC read path cannot use
-- it: `getPublishedCoursesByCatalogue()` sorts by `courses.code`, because
-- `course_codes` is deliberately closed to `anon` (D-Q5: the roadmap — every
-- unproduced code and the full path composition — must not be published).
--
-- So today the catalogue can only ever be listed in code order, and V8's
-- required Fondations order (C1-F4 first) is unreachable.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--
--   + view public.public_catalogue_courses   catalogue_code, course_code,
--                                            position — PUBLISHED courses only,
--                                            re-ranked 1..N
--   + constraint course_codes_catalogue_position_unique
--                                            UNIQUE (catalogue_code, position)
--                                            DEFERRABLE INITIALLY DEFERRED
--
-- The view is the 031 pattern exactly: the registry stays closed, and a narrow
-- projection publishes only the relationship between a catalogue and a course
-- that is ALREADY publicly visible. Re-ranking with row_number() is not
-- cosmetic — a stored position of 4 in a catalogue showing three courses would
-- disclose that a fourth exists, which is the roadmap leak D-Q5 forbids.
--
-- The constraint exists so CAT-ARCH-02 can reorder a whole catalogue in one
-- statement. Without DEFERRABLE, swapping two positions inside a transaction
-- trips uniqueness on the intermediate state, and the workaround — parking a
-- row at position 999 first — is exactly the kind of temporary lie that
-- survives a failed migration.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO position is changed. NO code is added, renamed or retired. C1-F4 and
--     C3-F9 are NOT registered; C1-F3 is NOT renamed; the 8th course is NOT
--     assigned a code. All of that is CAT-ARCH-02/03, under owner ruling.
--   * NO course, module, lesson, publication state or preview flag is touched.
--   * NO entitlement, enrollment, progress or certificate is touched.
--   * NO grant on course_codes, catalogues, learning_paths or
--     learning_path_courses changes — they stay admin-only.
--   * NOTHING in WC-2: the six raw lesson media columns stay withheld from the
--     browser roles (055) and section 4 re-asserts it as this migration's own
--     precondition.
--
-- Section 4 proves the visible catalogue order is IDENTICAL before and after,
-- by comparing the code ordering the application uses today with the position
-- ordering it will use tomorrow. With today's data they agree; the migration
-- refuses to commit if they do not.
-- ============================================================================

-- REPEATABLE READ: every assertion below reads ONE snapshot.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — the world is what this migration was written against ═══
do $do$
declare
  v_missing text;
  v_n       integer;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array['public.catalogues', 'public.course_codes', 'public.courses',
                      'public.public_catalogues']) as t
   where to_regclass(t) is null;
  if v_missing is not null then
    raise exception 'CAT-ARCH-01 056 preflight: required object(s) missing: %', v_missing;
  end if;

  -- 028's academic identity must be in place: without courses.code there is
  -- nothing to join a catalogue to.
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.courses'::regclass and a.attname = 'code' and not a.attisdropped
  ) then
    raise exception 'CAT-ARCH-01 056 preflight: public.courses.code (028) is missing';
  end if;

  -- The registry must still be closed to the browser roles. If it were already
  -- open, this migration's whole premise — publish a projection, never the
  -- registry — would be false.
  if has_table_privilege('anon', 'public.course_codes', 'SELECT')
     or has_any_column_privilege('anon', 'public.course_codes', 'SELECT') then
    raise exception 'CAT-ARCH-01 056 preflight: anon already holds SELECT on course_codes; the registry is not closed';
  end if;

  -- Positions must already be unique per catalogue, or the constraint below
  -- would fail with a bare index violation instead of a legible message.
  select count(*) into v_n from (
    select catalogue_code, position from public.course_codes
     group by catalogue_code, position having count(*) > 1
  ) d;
  if v_n <> 0 then
    raise exception 'CAT-ARCH-01 056 preflight: % catalogue/position pair(s) are duplicated; fix the registry before constraining it', v_n;
  end if;

  -- Refuse rather than silently redefine something that is not ours.
  if to_regclass('public.public_catalogue_courses') is not null then
    raise exception 'CAT-ARCH-01 056 preflight: public.public_catalogue_courses already exists; refusing to re-apply';
  end if;
  if exists (select 1 from pg_constraint where conname = 'course_codes_catalogue_position_unique') then
    raise exception 'CAT-ARCH-01 056 preflight: the position constraint already exists; refusing to re-apply';
  end if;
end
$do$;

-- Everything this migration promises not to change, captured before it runs.
create temp table cat_arch_01_before on commit drop as
select
  (select md5(coalesce(string_agg(to_jsonb(cc)::text, '|' order by cc.code), ''))
     from public.course_codes cc)                                              as course_codes_md5,
  (select md5(coalesce(string_agg(to_jsonb(cat)::text, '|' order by cat.code), ''))
     from public.catalogues cat)                                               as catalogues_md5,
  (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), ''))
     from public.courses c)                                                    as courses_md5,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.code), ''))
     from public.learning_paths p)                                             as paths_md5,
  (select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.path_code, l.course_code), ''))
     from public.learning_path_courses l)                                      as membership_md5,
  (select md5(coalesce(string_agg(to_jsonb(le)::text, '|' order by le.id), ''))
     from public.lessons le)                                                   as lessons_md5,
  -- The catalogue order the application renders TODAY, by code.
  (select coalesce(string_agg(x.code, ',' order by x.catalogue_code, x.code), '')
     from (select split_part(c.code, '-', 1) as catalogue_code, c.code
             from public.courses c
            where c.code is not null and c.is_published = true) x)             as order_by_code,
  (select count(*) from public.courses where code is not null and is_published = true) as n_published_coded;


-- ══ 1. THE PUBLIC PROJECTION ══════════════════════════════════════════════
--
-- Three columns, all of them relationship metadata. No title, no description,
-- no cover, no duration: the course CONTENT is read from `public.courses`,
-- which is already anon-readable for published rows and carries its own RLS.
-- This view answers exactly one question — "which published formations does
-- this catalogue contain, and in what order does the learner see them?"

create view public.public_catalogue_courses as
select
  cc.catalogue_code,
  cc.code as course_code,
  -- Re-ranked, never the stored position. A gap (a registered code whose
  -- course is unproduced or unpublished) would publish the existence of that
  -- code, which is precisely the roadmap disclosure D-Q5 forbids. The tie-break
  -- on code keeps the order deterministic if two positions were ever equal.
  row_number() over (
    partition by cc.catalogue_code
    order by cc.position, cc.code
  ) as position
from public.course_codes cc
join public.courses c
  on c.code = cc.code
 and c.is_published = true;

comment on view public.public_catalogue_courses is
  'CAT-ARCH-01 public projection. Catalogue membership and DISPLAY ORDER of PUBLISHED courses only, re-ranked 1..N so position gaps cannot reveal unproduced or unpublished registry entries. Carries no course content and never exposes course_codes itself.';

-- Read-only, to the public roles — the same grant shape as 031's projections.
grant select on public.public_catalogue_courses to anon, authenticated;

-- The registry stays closed. Asserted rather than assumed, and re-revoked
-- defensively: this migration must never be the thing that opened it.
revoke all on public.catalogues            from anon, authenticated;
revoke all on public.course_codes          from anon, authenticated;


-- ══ 2. UNIQUE DISPLAY POSITIONS, DEFERRABLE ═══════════════════════════════
--
-- DEFERRABLE INITIALLY DEFERRED so CAT-ARCH-02 can write a whole catalogue's
-- new order as one UPDATE and be checked at COMMIT. The pre-existing
-- `course_codes_catalogue_idx` (028) is left in place: it is a plain index used
-- for ordering, and dropping it belongs to no ticket.

alter table public.course_codes
  add constraint course_codes_catalogue_position_unique
  unique (catalogue_code, position) deferrable initially deferred;

comment on constraint course_codes_catalogue_position_unique on public.course_codes is
  'CAT-ARCH-01. Display order is unique within a catalogue. DEFERRABLE INITIALLY DEFERRED so a reorder can be applied atomically without parking rows at fake positions.';


-- ══ 3. STRUCTURE AND PRIVILEGES ═══════════════════════════════════════════
do $do$
declare
  v_cols   text;
  v_n      integer;
  v_role   text;
begin
  -- Exactly the three intended columns, in order, and nothing else.
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.public_catalogue_courses'::regclass
     and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'catalogue_code,course_code,position' then
    raise exception 'CAT-ARCH-01 056: the projection exposes [%], expected catalogue_code,course_code,position', v_cols;
  end if;

  -- Nothing resembling content, media or a storage location can be present.
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.public_catalogue_courses'::regclass and a.attnum > 0 and not a.attisdropped
     and (a.attname ~* '(url|path|content|video|pdf|subtitle|source|media|price|note|objective|targets|status)');
  if v_n <> 0 then
    raise exception 'CAT-ARCH-01 056: % forbidden column(s) in the public projection', v_n;
  end if;

  -- The constraint is deferrable, and deferred by default.
  if not exists (
    select 1 from pg_constraint
     where conname = 'course_codes_catalogue_position_unique'
       and conrelid = 'public.course_codes'::regclass
       and contype = 'u' and condeferrable and condeferred
  ) then
    raise exception 'CAT-ARCH-01 056: the position constraint is not DEFERRABLE INITIALLY DEFERRED';
  end if;

  -- Browser roles: the projection yes, the registry no.
  foreach v_role in array array['anon', 'authenticated'] loop
    if not has_table_privilege(v_role, 'public.public_catalogue_courses', 'SELECT') then
      raise exception 'CAT-ARCH-01 056: % cannot read the public projection', v_role;
    end if;
    if has_table_privilege(v_role, 'public.course_codes', 'SELECT')
       or has_any_column_privilege(v_role, 'public.course_codes', 'SELECT') then
      raise exception 'CAT-ARCH-01 056: % can read course_codes — the registry must stay closed', v_role;
    end if;
    if has_table_privilege(v_role, 'public.catalogues', 'SELECT')
       or has_any_column_privilege(v_role, 'public.catalogues', 'SELECT') then
      raise exception 'CAT-ARCH-01 056: % can read catalogues — the registry must stay closed', v_role;
    end if;
    -- WC-2C (055) is a precondition of this slice, not a casualty of it.
    if has_column_privilege(v_role, 'public.lessons', 'video_object_path', 'SELECT') then
      raise exception 'CAT-ARCH-01 056: % regained SELECT on a raw lesson media column — WC-2 must stay closed', v_role;
    end if;
  end loop;

  raise notice 'CAT-ARCH-01 056: projection has exactly 3 relationship columns; constraint deferrable; registry and WC-2 still closed to anon and authenticated';
end
$do$;


-- ══ 4. CONTENT OF THE PROJECTION, AND THE ORDER THE LEARNER SEES ══════════
do $do$
declare
  b          record;
  v_n        integer;
  v_expected integer;
  v_after    text;
  r          record;
begin
  select * into b from cat_arch_01_before;

  -- Exactly the published, coded courses — no more, no fewer.
  select count(*) into v_expected from public.public_catalogue_courses;
  if v_expected <> b.n_published_coded then
    raise exception 'CAT-ARCH-01 056: the projection has % row(s), expected % published coded course(s)', v_expected, b.n_published_coded;
  end if;

  -- No unpublished course.
  select count(*) into v_n
    from public.public_catalogue_courses p
    join public.courses c on c.code = p.course_code
   where c.is_published is not true;
  if v_n <> 0 then
    raise exception 'CAT-ARCH-01 056: % unpublished course(s) leaked into the projection', v_n;
  end if;

  -- No registry entry without a course (unproduced code).
  select count(*) into v_n
    from public.public_catalogue_courses p
   where not exists (select 1 from public.courses c where c.code = p.course_code);
  if v_n <> 0 then
    raise exception 'CAT-ARCH-01 056: % unproduced registry code(s) leaked into the projection', v_n;
  end if;

  -- Positions are contiguous 1..N per catalogue, with no gap and no duplicate.
  for r in select catalogue_code,
                  count(*)            as n,
                  min(position)       as lo,
                  max(position)       as hi,
                  count(distinct position) as distinct_n
             from public.public_catalogue_courses
            group by catalogue_code loop
    if r.lo <> 1 or r.hi <> r.n or r.distinct_n <> r.n then
      raise exception 'CAT-ARCH-01 056: catalogue % is not re-ranked 1..% (min %, max %, distinct %)',
        r.catalogue_code, r.n, r.lo, r.hi, r.distinct_n;
    end if;
  end loop;

  -- THE ORDER THE LEARNER SEES DOES NOT CHANGE TODAY.
  -- Left: what the application renders now (by code). Right: what it will
  -- render after the read path switches (by projected position).
  select coalesce(string_agg(x.course_code, ',' order by x.catalogue_code, x.position), '')
    into v_after
    from public.public_catalogue_courses x;
  if v_after is distinct from b.order_by_code then
    raise exception 'CAT-ARCH-01 056: the visible catalogue order would change (was [%], would become [%]). CAT-ARCH-01 must be order-neutral; reordering is CAT-ARCH-02.',
      b.order_by_code, v_after;
  end if;

  raise notice 'CAT-ARCH-01 056: projection = % published coded course(s), contiguous per catalogue, and the visible order is unchanged (%)', v_expected, v_after;
end
$do$;


-- ══ 5. NOTHING WAS WRITTEN ════════════════════════════════════════════════
do $do$
declare
  b     record;
  v_now text;
begin
  select * into b from cat_arch_01_before;

  select md5(coalesce(string_agg(to_jsonb(cc)::text, '|' order by cc.code), '')) into v_now
    from public.course_codes cc;
  if v_now is distinct from b.course_codes_md5 then
    raise exception 'CAT-ARCH-01 056: course_codes changed — this migration must not touch a single position, status or title';
  end if;

  select md5(coalesce(string_agg(to_jsonb(cat)::text, '|' order by cat.code), '')) into v_now
    from public.catalogues cat;
  if v_now is distinct from b.catalogues_md5 then
    raise exception 'CAT-ARCH-01 056: catalogues changed';
  end if;

  select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) into v_now
    from public.courses c;
  if v_now is distinct from b.courses_md5 then
    raise exception 'CAT-ARCH-01 056: course data or publication state changed';
  end if;

  select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.code), '')) into v_now
    from public.learning_paths p;
  if v_now is distinct from b.paths_md5 then
    raise exception 'CAT-ARCH-01 056: learning_paths changed';
  end if;

  select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.path_code, l.course_code), '')) into v_now
    from public.learning_path_courses l;
  if v_now is distinct from b.membership_md5 then
    raise exception 'CAT-ARCH-01 056: path membership changed';
  end if;

  select md5(coalesce(string_agg(to_jsonb(le)::text, '|' order by le.id), '')) into v_now
    from public.lessons le;
  if v_now is distinct from b.lessons_md5 then
    raise exception 'CAT-ARCH-01 056: lesson data changed';
  end if;

  raise notice 'CAT-ARCH-01 056: course_codes, catalogues, courses, learning_paths, membership and lessons are all byte-identical';
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it and after the branch carrying
--    this file is merged. It is safe with the CURRENT application: the view is
--    new and nothing reads it until the CAT-ARCH-01 release is deployed, and
--    the constraint matches the data already in the registry.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once. The
--    editor does not display RAISE NOTICE output; "Success" means every
--    section passed, because the file is one transaction and any failed
--    assertion raises and rolls everything back.
--
--    CREATE VIEW takes no lock on the base tables' data; ADD CONSTRAINT takes a
--    brief ACCESS EXCLUSIVE lock on `course_codes` (17 rows) to build the
--    index. It completes in milliseconds and writes no row.
-- 3. Immediately afterwards, GET-only, as the anonymous key:
--      /rest/v1/public_catalogue_courses?select=*   -> 200, one row per
--                                                      published coded course,
--                                                      positions 1..N per catalogue
--      /rest/v1/course_codes?select=code            -> 401 with code 42501
--    and confirm /courses still lists the formations in the same order.
-- 4. The V8 reorder itself (C1-F4 first, the C2 sequence, registering C1-F4 and
--    C3-F9) is CAT-ARCH-02 and requires the owner rulings R1–R4.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes both objects. Safe ONLY while no deployed application
-- reads the view (i.e. before the CAT-ARCH-01 application release). It touches
-- no row, no grant on any base table, and no position. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- drop view if exists public.public_catalogue_courses;
--
-- alter table public.course_codes
--   drop constraint if exists course_codes_catalogue_position_unique;
--
-- do $rb$
-- begin
--   if to_regclass('public.public_catalogue_courses') is not null then
--     raise exception 'CAT-ARCH-01 056 rollback: the projection survived';
--   end if;
--   if exists (select 1 from pg_constraint where conname = 'course_codes_catalogue_position_unique') then
--     raise exception 'CAT-ARCH-01 056 rollback: the constraint survived';
--   end if;
-- end
-- $rb$;
--
-- commit;
