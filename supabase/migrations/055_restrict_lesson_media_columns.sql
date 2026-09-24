-- ============================================================================
-- Migration 055 — XPA-8 WC-2C: the six raw lesson media columns stop being
-- readable by the browser roles.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- The last of the three WC-2 steps, and the only one that closes the finding:
--
--   054  (applied 17 Sep 2026)  derived browser-safe fields
--   WC-2B application release   the player reads those fields (merged d52cf67)
--   055  (this file)            withdraw SELECT on the six raw columns from
--                               anon and authenticated
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--   Apply ONLY after the WC-2B application release is live and verified, which
--   it is: production main d52cf67, verified 24 September 2026.
--
-- ── THE FINDING THIS CLOSES ────────────────────────────────────────────────
--
-- RLS decides ROWS, not COLUMNS. `anon` and `authenticated` hold table-wide
-- SELECT on public.lessons, so every visible row arrives with
-- video/pdf/subtitle_object_path and the legacy video/pdf/subtitle_url.
-- Anonymous callers currently receive the storage paths of every published
-- preview lesson — 38 video and 9 PDF paths at the time of writing — although
-- preview has never authorized delivery: /api/media/lesson re-checks the
-- entitlement and signs server-side, and `is_preview` is deliberately not a
-- delivery authority. The disclosure is pure; nothing consumes it.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
--   revoke select on public.lessons from anon, authenticated;
--   grant  select (<every column EXCEPT the six raw ones>) … to anon, authenticated;
--
-- This is the 038 pattern (answer keys), applied to asset locations.
--
-- ── WHAT DOES NOT CHANGE ───────────────────────────────────────────────────
--
--   * the six raw columns themselves — NOT dropped, NOT modified; the service
--     role keeps full access, which is what the media route signs from and
--     what the admin editor reads and writes
--   * the six derived fields from 054 (generated expressions asserted identical)
--   * every row policy on public.lessons: withdrawal (050), preview visibility
--     and entitled access are untouched, and section 4 fingerprints them
--   * which ROWS anon and authenticated may see — section 5 counts them before
--     and after, inside this transaction
--   * INSERT / UPDATE / DELETE privileges: WC-2C changes SELECT only
--   * every lesson, module and course value; publication and preview state
--   * storage buckets, storage policies and stored objects
--   * 046 stays withdrawn; 051 stays reserved; 050, 052, 053 and 054 untouched.
-- ============================================================================

-- REPEATABLE READ: the before/after fingerprints and the anon row counts are
-- separate statements that must read ONE snapshot.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — 054 is live, the raw columns exist, 055 is not applied ══
do $do$
declare
  v_missing text;
  v_n       integer;
begin
  -- 054's derived fields must exist, generated and stored. Without them the
  -- application has nothing to read and this migration would break playback.
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and not a.attisdropped
     and a.attname in ('video_source', 'pdf_source', 'subtitle_source',
                       'video_external_url', 'pdf_external_url', 'subtitle_external_url')
     and a.attgenerated = 's' and a.atttypid = 'text'::regtype;
  if v_n <> 6 then
    raise exception 'WC-2C 055 preflight: expected the 6 generated derived columns from 054, found %', v_n;
  end if;

  -- The six raw columns must still be there: this migration withdraws access,
  -- it does not remove data.
  select string_agg(c, ', ') into v_missing
    from unnest(array['video_object_path', 'pdf_object_path', 'subtitle_object_path',
                      'video_url', 'pdf_url', 'subtitle_url']) as c
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = 'public.lessons'::regclass and a.attname = c and not a.attisdropped
   );
  if v_missing is not null then
    raise exception 'WC-2C 055 preflight: raw column(s) missing from public.lessons: %', v_missing;
  end if;

  if not exists (select 1 from pg_class where oid = 'public.lessons'::regclass and relrowsecurity) then
    raise exception 'WC-2C 055 preflight: row level security is not enabled on public.lessons';
  end if;

  -- Refuse a second apply rather than reporting success for work already done.
  if not has_column_privilege('anon', 'public.lessons', 'video_object_path', 'SELECT')
     and not has_column_privilege('authenticated', 'public.lessons', 'video_object_path', 'SELECT') then
    raise exception 'WC-2C 055 preflight: the raw columns are already withheld from both roles; refusing to re-apply';
  end if;

  -- Both roles must currently hold table-wide SELECT — the state 054 left.
  if not has_table_privilege('anon', 'public.lessons', 'SELECT')
     or not has_table_privilege('authenticated', 'public.lessons', 'SELECT') then
    raise exception 'WC-2C 055 preflight: a browser role does not hold table-level SELECT; the grant state is not what this migration was written against';
  end if;
end
$do$;

-- Everything this migration promises not to change, captured before it runs.
-- Dropped at COMMIT: nothing persists.
create temp table wc2c_055_before on commit drop as
select
  (select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
            || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), '')
     from pg_policy p where p.polrelid = 'public.lessons'::regclass)                       as lessons_policies,
  (select coalesce(string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), '|' order by a.attname), '')
     from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.lessons'::regclass and a.attgenerated = 's')               as derived_exprs,
  (select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.id), ''))
     from public.lessons l)                                                                as lessons_md5,
  (select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), ''))
     from public.modules m)                                                                as modules_md5,
  (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), ''))
     from public.courses c)                                                                as courses_md5,
  (select md5(coalesce(string_agg(b.id || ':' || b.public::text, '|' order by b.id), ''))
     from storage.buckets b)                                                               as buckets_md5,
  (select count(*) from public.lessons)                                                    as n_lessons,
  (select count(*) from public.lessons where is_preview)                                   as n_preview,
  (select count(*) from public.audit_log)                                                  as n_audit,
  (select coalesce(string_agg(a.attname, ',' order by a.attname), '') from pg_attribute a
    where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped) as all_columns,
  -- Every privilege except SELECT, for every role that has one. WC-2C changes
  -- SELECT and nothing else, so this string must come out identical.
  (select coalesce(string_agg(r.rolname || ':' || p, '|' order by r.rolname, p), '')
     from pg_roles r
     cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
      and has_table_privilege(r.rolname, 'public.lessons', p))                              as other_privs;

-- How many rows each browser role can see TODAY, read as that role.
create temp table wc2c_055_rows (who text, lessons bigint, modules bigint) on commit drop;
do $do$
declare r text; v_l bigint; v_m bigint;
begin
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set role %I', r);
    select count(*) into v_l from public.lessons;
    select count(*) into v_m from public.modules;
    reset role;
    insert into wc2c_055_rows values (r, v_l, v_m);
  end loop;
exception when others then
  reset role;
  raise;
end
$do$;


-- ══ 1. THE PRIVILEGE CHANGE ═══════════════════════════════════════════════
--
-- Revoke the table-level SELECT, then grant back every column EXCEPT the six
-- locations. Enumerated explicitly, never computed: a column added to this
-- table in future is NOT readable by the browser roles until someone grants it
-- deliberately — fail-closed, and the reason section 2 asserts the list.
--
-- SELECT only. INSERT / UPDATE / DELETE are left exactly as they are: no
-- write policy admits these roles, and widening or narrowing writes is a
-- different question from disclosure.

revoke select on public.lessons from anon, authenticated;

grant select (
  id,
  module_id,
  slug,
  title,
  title_fr,
  content,
  duration_minutes,
  order_index,
  is_preview,
  created_at,
  video_source,
  video_external_url,
  pdf_source,
  pdf_external_url,
  subtitle_source,
  subtitle_external_url
) on public.lessons to anon, authenticated;


-- ══ 2. PRIVILEGES ARE EXACTLY WHAT WAS INTENDED ═══════════════════════════
do $do$
declare
  b        record;
  v_role   text;
  v_col    text;
  v_extra  text;
  v_raw    constant text[] := array['video_object_path', 'pdf_object_path', 'subtitle_object_path',
                                    'video_url', 'pdf_url', 'subtitle_url'];
  v_keep   constant text[] := array['id', 'module_id', 'slug', 'title', 'title_fr', 'content',
                                    'duration_minutes', 'order_index', 'is_preview', 'created_at',
                                    'video_source', 'video_external_url', 'pdf_source',
                                    'pdf_external_url', 'subtitle_source', 'subtitle_external_url'];
begin
  select * into b from wc2c_055_before;

  foreach v_role in array array['anon', 'authenticated'] loop
    -- No table-level SELECT any more: `select *` must fail rather than narrow.
    if has_table_privilege(v_role, 'public.lessons', 'SELECT') then
      raise exception 'WC-2C 055: % still holds table-level SELECT on lessons', v_role;
    end if;
    -- The six locations are gone for this role.
    foreach v_col in array v_raw loop
      if has_column_privilege(v_role, 'public.lessons', v_col, 'SELECT') then
        raise exception 'WC-2C 055: % can still read lessons.%', v_role, v_col;
      end if;
    end loop;
    -- Everything the application needs is still readable.
    foreach v_col in array v_keep loop
      if not has_column_privilege(v_role, 'public.lessons', v_col, 'SELECT') then
        raise exception 'WC-2C 055: % lost SELECT on lessons.%, which the application needs', v_role, v_col;
      end if;
    end loop;
    if not has_any_column_privilege(v_role, 'public.lessons', 'SELECT') then
      raise exception 'WC-2C 055: % can no longer read any column of lessons', v_role;
    end if;
  end loop;

  -- The granted set is EXACTLY the keep list: no column outside it, and no
  -- column of the table left unaccounted for.
  select string_agg(a.attname, ', ' order by a.attname) into v_extra
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', 'public.lessons', a.attname, 'SELECT')
     and not (a.attname = any (v_keep));
  if v_extra is not null then
    raise exception 'WC-2C 055: anon can read column(s) outside the intended set: %', v_extra;
  end if;
  select string_agg(c, ', ') into v_extra
    from unnest(v_keep || v_raw) as c
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = 'public.lessons'::regclass and a.attname = c and not a.attisdropped);
  if v_extra is not null then
    raise exception 'WC-2C 055: the column list does not match the table; unknown column(s): %', v_extra;
  end if;
  if (select count(*) from pg_attribute a
       where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped)
     <> array_length(v_keep, 1) + array_length(v_raw, 1) then
    raise exception 'WC-2C 055: public.lessons has columns this migration did not classify';
  end if;

  -- Trusted roles are untouched.
  foreach v_role in array array['service_role', 'postgres'] loop
    if to_regrole(v_role) is null then continue; end if;
    foreach v_col in array v_raw loop
      if not has_column_privilege(v_role, 'public.lessons', v_col, 'SELECT') then
        raise exception 'WC-2C 055: trusted role % lost SELECT on lessons.% — the media route and admin editor need it', v_role, v_col;
      end if;
    end loop;
  end loop;

  -- Nothing is granted to PUBLIC. A grant to PUBLIC reaches every role that
  -- exists now or later, which is not a set this migration can reason about —
  -- and it is how 018 handed writes to anonymous callers (dropped in 041).
  select string_agg(x.attname || ':' || x.privilege_type, ', ' order by x.attname) into v_extra
    from (
      select a.attname, (aclexplode(a.attacl)).grantee as grantee, (aclexplode(a.attacl)).privilege_type
        from pg_attribute a
       where a.attrelid = 'public.lessons'::regclass and a.attacl is not null
      union all
      select '<table>', (aclexplode(c.relacl)).grantee, (aclexplode(c.relacl)).privilege_type
        from pg_class c where c.oid = 'public.lessons'::regclass and c.relacl is not null
    ) x
   where x.grantee = 0;
  if v_extra is not null then
    raise exception 'WC-2C 055: public.lessons grants privileges to PUBLIC: %', v_extra;
  end if;

  -- SELECT only: no write privilege was added or removed for any role.
  select coalesce(string_agg(r.rolname || ':' || p, '|' order by r.rolname, p), '') into v_extra
    from pg_roles r
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
   where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
     and has_table_privilege(r.rolname, 'public.lessons', p);
  if v_extra is distinct from b.other_privs then
    raise exception 'WC-2C 055: a non-SELECT privilege on public.lessons changed; this migration changes SELECT only';
  end if;

  raise notice 'WC-2C 055: anon and authenticated hold SELECT on 16 columns and on none of the 6 locations; service_role and postgres unchanged; no write privilege moved';
end
$do$;


-- ══ 3. EXERCISE IT AS THE ROLES THEMSELVES ════════════════════════════════
--
-- Privilege bits are one thing; what the planner does with a real query is
-- another. Every refusal must be 42501 (insufficient_privilege) — not 42703
-- (column gone, which would mean someone dropped it) and not silence.
do $do$
declare
  v_role  text;
  v_col   text;
  v_state text;
  v_n     bigint;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    -- Each location, selected directly.
    foreach v_col in array array['video_object_path', 'pdf_object_path', 'subtitle_object_path',
                                 'video_url', 'pdf_url', 'subtitle_url'] loop
      begin
        execute format('set role %I', v_role);
        execute format('select %I from public.lessons limit 1', v_col);
        reset role;
        raise exception 'WC-2C 055: % still read lessons.% successfully', v_role, v_col;
      exception
        when insufficient_privilege then
          reset role;
        when others then
          v_state := sqlstate;
          reset role;
          raise exception 'WC-2C 055: % reading lessons.% failed with % instead of 42501', v_role, v_col, v_state;
      end;
    end loop;

    -- A mixed select must fail as a whole, not silently drop the column.
    begin
      execute format('set role %I', v_role);
      execute 'select id, title, video_object_path from public.lessons limit 1';
      reset role;
      raise exception 'WC-2C 055: % read a mixed select containing a location', v_role;
    exception
      when insufficient_privilege then reset role;
      when others then v_state := sqlstate; reset role;
        raise exception 'WC-2C 055: % mixed select failed with % instead of 42501', v_role, v_state;
    end;

    -- select * must fail rather than narrow to the granted columns.
    begin
      execute format('set role %I', v_role);
      execute 'select * from public.lessons limit 1';
      reset role;
      raise exception 'WC-2C 055: % could still select * from lessons', v_role;
    exception
      when insufficient_privilege then reset role;
      when others then v_state := sqlstate; reset role;
        raise exception 'WC-2C 055: % select * failed with % instead of 42501', v_role, v_state;
    end;

    -- The application's own query shape must still work.
    begin
      execute format('set role %I', v_role);
      execute 'select id, slug, title, content, video_source, video_external_url, subtitle_source,
               subtitle_external_url, pdf_source, pdf_external_url, duration_minutes, order_index
               from public.lessons';
      execute 'select count(*) from public.modules m join public.lessons l on l.module_id = m.id';
      reset role;
    exception when others then
      v_state := sqlstate; reset role;
      raise exception 'WC-2C 055: the WC-2B player query is no longer evaluatable as % (%)', v_role, v_state;
    end;

    -- Nothing else in the content graph may have become unevaluatable.
    foreach v_col in array array['modules', 'courses', 'quizzes', 'quiz_questions', 'exercises',
                                 'public_course_modules', 'public_course_lessons'] loop
      begin
        execute format('set role %I', v_role);
        execute format('select count(*) from public.%I', v_col);
        reset role;
      exception when others then
        v_state := sqlstate; reset role;
        raise exception 'WC-2C 055: % can no longer read public.% (%)', v_role, v_col, v_state;
      end;
    end loop;
  end loop;

  -- The trusted path still resolves a location, as the media route does.
  begin
    set role service_role;
    select count(*) into v_n from public.lessons where video_object_path is not null;
    reset role;
  exception when others then
    v_state := sqlstate; reset role;
    raise exception 'WC-2C 055: service_role can no longer resolve object paths (%)', v_state;
  end;
  if v_n < 1 then
    raise exception 'WC-2C 055: service_role sees % lesson(s) with a video path; expected the production corpus', v_n;
  end if;

  raise notice 'WC-2C 055: as anon and as authenticated, all 6 locations, mixed selects and select * are refused with 42501; the player query, every content table and both public views still evaluate; service_role still resolves % video path(s)', v_n;
end
$do$;


-- ══ 4. NOTHING ELSE MOVED ═════════════════════════════════════════════════
do $do$
declare
  b     record;
  v_now text;
begin
  select * into b from wc2c_055_before;

  select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
           || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), '')
    into v_now from pg_policy p where p.polrelid = 'public.lessons'::regclass;
  if v_now is distinct from b.lessons_policies then
    raise exception 'WC-2C 055: a row policy on public.lessons changed';
  end if;

  select coalesce(string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), '|' order by a.attname), '')
    into v_now
    from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.lessons'::regclass and a.attgenerated = 's';
  if v_now is distinct from b.derived_exprs then
    raise exception 'WC-2C 055: a derived column from 054 changed';
  end if;

  select coalesce(string_agg(a.attname, ',' order by a.attname), '') into v_now
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_now is distinct from b.all_columns then
    raise exception 'WC-2C 055: the column set of public.lessons changed — no column may be dropped or added here';
  end if;

  select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.id), '')) into v_now from public.lessons l;
  if v_now is distinct from b.lessons_md5 then
    raise exception 'WC-2C 055: lesson data changed';
  end if;
  select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), '')) into v_now from public.modules m;
  if v_now is distinct from b.modules_md5 then
    raise exception 'WC-2C 055: module data changed';
  end if;
  select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) into v_now from public.courses c;
  if v_now is distinct from b.courses_md5 then
    raise exception 'WC-2C 055: course data or publication state changed';
  end if;
  select md5(coalesce(string_agg(x.id || ':' || x.public::text, '|' order by x.id), '')) into v_now from storage.buckets x;
  if v_now is distinct from b.buckets_md5 then
    raise exception 'WC-2C 055: storage bucket configuration changed';
  end if;

  if (select count(*) from public.lessons) <> b.n_lessons
     or (select count(*) from public.lessons where is_preview) <> b.n_preview
     or (select count(*) from public.audit_log) <> b.n_audit then
    raise exception 'WC-2C 055: lesson, preview or audit counts changed';
  end if;

  raise notice 'WC-2C 055: policies, derived columns, column set, lesson/module/course data, buckets and counts all unchanged';
end
$do$;


-- ══ 5. THE SAME ROWS, FEWER COLUMNS ═══════════════════════════════════════
--
-- Withdrawing a column privilege must not change which ROWS a caller sees.
-- Anonymous preview visibility is the whole product surface for a visitor, so
-- it is counted as the role, before and after, inside this transaction.
do $do$
declare
  r       record;
  v_l     bigint;
  v_m     bigint;
begin
  for r in select * from wc2c_055_rows loop
    execute format('set role %I', r.who);
    select count(*) into v_l from public.lessons;
    select count(*) into v_m from public.modules;
    reset role;
    if v_l <> r.lessons or v_m <> r.modules then
      raise exception 'WC-2C 055: % now sees %/% lesson/module rows, was %/%', r.who, v_l, v_m, r.lessons, r.modules;
    end if;
    raise notice 'WC-2C 055: % still sees % lesson row(s) and % module row(s) — unchanged', r.who, v_l, v_m;
  end loop;
exception when others then
  reset role;
  raise;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it, after this branch is merged,
--    and ONLY while the WC-2B application release is live (production main
--    d52cf67 or later). Deploying an older application afterwards would break
--    playback: that build asks for columns this migration withholds.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once. The
--    editor does not display RAISE NOTICE output; "Success" means every
--    section passed, because the file is one transaction and any failed
--    assertion raises and rolls everything back.
--
--    REVOKE/GRANT take a brief ACCESS EXCLUSIVE lock on public.lessons. There
--    is no table rewrite and no data change; it completes in milliseconds.
-- 3. Immediately afterwards, GET-only, as the anonymous key:
--      /rest/v1/lessons?select=id,video_object_path   -> 400 with code 42501
--      /rest/v1/lessons?select=*                      -> 400 with code 42501
--      /rest/v1/lessons?select=id,video_source        -> 200, same row count
--    and confirm the learn player still plays a protected video and PDF.
-- 4. PostgREST enforces privileges per request; no schema reload is required.
--    If the API schema document is cached, `notify pgrst, 'reload schema';`
--    refreshes it — optional, and it changes no privilege.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores table-wide SELECT for the two browser roles, which
-- RE-OPENS the disclosure this migration closes. It touches no row, no policy
-- and no column definition. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- grant select on public.lessons to anon, authenticated;
--
-- do $rb$
-- declare r text;
-- begin
--   foreach r in array array['anon', 'authenticated'] loop
--     if not has_column_privilege(r, 'public.lessons', 'video_object_path', 'SELECT') then
--       raise exception 'WC-2C 055 rollback: % did not regain SELECT', r;
--     end if;
--   end loop;
-- end
-- $rb$;
--
-- commit;
