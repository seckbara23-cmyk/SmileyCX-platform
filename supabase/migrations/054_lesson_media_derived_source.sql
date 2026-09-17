-- ============================================================================
-- Migration 054 — XPA-8 WC-2A: browser-safe derived media fields on lessons.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- ADDITIVE ONLY. The first of three separately deployed steps:
--
--   054  (this file)  add derived fields; change NO grant, NO row, NO policy
--   app release       the learn player reads the derived fields, not raw paths
--   055  (later)      restrict SELECT on the six raw columns — NOT in this file
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── THE DEFECT THIS PREPARES TO CLOSE ──────────────────────────────────────
--
-- RLS decides ROWS, not COLUMNS. anon and authenticated hold table-wide SELECT
-- on public.lessons, so every visible row exposes video_object_path,
-- pdf_object_path, subtitle_object_path and the legacy video_url / pdf_url /
-- subtitle_url. Anonymous and unentitled callers receive the storage paths of
-- every published preview lesson, although preview never authorizes delivery
-- (/api/media/lesson re-checks the entitlement and signs server-side).
-- docs/xpa-8-wc-2-storage-path-disclosure.md is the design.
--
-- The learn player uses those columns for ONE decision — "do we host this, or
-- does somebody else?" — and never needs the path itself. These fields answer
-- exactly that question, so that 055 can withhold the raw columns without
-- breaking playback.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
--   + lessons.video_source,        lessons.video_external_url
--   + lessons.pdf_source,          lessons.pdf_external_url
--   + lessons.subtitle_source,     lessons.subtitle_external_url
--
-- All six are GENERATED ALWAYS … STORED: derived by the database from the raw
-- columns on every write, impossible for any writer to set or forge, and
-- recomputed automatically when an admin edits a lesson.
--
-- ── THE CONTRACT, per kind k ∈ {video, pdf, subtitle} ──────────────────────
--
--   k_source   'protected' | 'external' | NULL
--   k_external_url   the raw k_url, ONLY when k_source = 'external'; else NULL
--
--   evaluated in this order, first match wins:
--
--   1. k_object_path non-empty                        → 'protected'
--      (the path wins, exactly as resolveAssetSource() decides today; a URL
--       sitting beside a path is never surfaced)
--   2. k_url NULL or empty                            → NULL
--   3. k_url mentions "supabase" anywhere, or a storage/v1 segment in any
--      spelling (/, \, %2f, %252f …), case-insensitive → 'protected'
--      INTERNAL, fail-closed: never external, never surfaced. The media route
--      only delivers object paths, so such a lesson simply has no playable
--      asset — which is already true today (every such URL answers 400).
--   4. k_url is a plain absolute http(s) URL on a public DNS hostname:
--        scheme http or https; hostname of letter/digit/hyphen labels with an
--        alphabetic TLD; NO userinfo (@), NO port, NO IP literal, NO
--        localhost, NO whitespace or control characters, only RFC 3986 URL
--        characters after the host, at most 2048 characters
--                                                     → 'external'
--   5. anything else — relative, protocol-relative, non-http(s), malformed,
--      ambiguous                                      → NULL
--
-- Deliberate, fail-closed divergence from today's resolveAssetSource(), which
-- hands ANY non-empty URL to the browser: rules 3 and 5 withhold a URL-only
-- value that is internal or not a clean external URL. Section 3 proves on the
-- live corpus that no other row diverges.
--
-- ── WHAT DOES NOT CHANGE ───────────────────────────────────────────────────
--
--   * every GRANT and column privilege on public.lessons (section 2 compares
--     the ACLs before and after); anon and authenticated keep reading the raw
--     columns until 055
--   * every existing lesson value — including the legacy URLs, preview flags —
--     every module, course, publication state and policy (fingerprinted)
--   * storage buckets and objects (fingerprinted); entitlements; certificates
--   * any application code: nothing reads these fields until the app release
--   * 046 stays withdrawn; 051 stays reserved; 050, 052 and 053 are untouched.
-- ============================================================================

-- REPEATABLE READ: the before/after fingerprints and the fixture's rollback
-- proofs compare separate statements, which must all read ONE snapshot.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — the world is what this migration was written against ═══
do $do$
declare
  v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from unnest(array[
      'video_url', 'pdf_url', 'subtitle_url',
      'video_object_path', 'pdf_object_path', 'subtitle_object_path'
    ]) as c
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = 'public.lessons'::regclass and a.attname = c
        and not a.attisdropped and a.atttypid = 'text'::regtype
   );
  if v_missing is not null then
    raise exception 'WC-2A 054 preflight: raw text column(s) missing on public.lessons: %', v_missing;
  end if;

  -- Refuse rather than skip: an existing column of the same name with a
  -- different definition must never be mistaken for this one.
  select string_agg(a.attname, ', ') into v_missing
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and not a.attisdropped
     and a.attname in ('video_source', 'pdf_source', 'subtitle_source',
                       'video_external_url', 'pdf_external_url', 'subtitle_external_url');
  if v_missing is not null then
    raise exception 'WC-2A 054 preflight: derived column(s) already exist, refusing to re-apply: %', v_missing;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.lessons'::regclass
                    and conname = 'lessons_object_paths_are_paths') then
    raise exception 'WC-2A 054 preflight: constraint lessons_object_paths_are_paths (041) is missing';
  end if;

  if not exists (select 1 from pg_class where oid = 'public.lessons'::regclass and relrowsecurity) then
    raise exception 'WC-2A 054 preflight: row level security is not enabled on public.lessons';
  end if;
end
$do$;

-- Everything this migration promises not to change, captured before it runs.
-- A temp table, dropped at COMMIT: nothing persists.
create temp table wc2a_054_before on commit drop as
select
  (select coalesce(c.relacl::text, '') from pg_class c
    where c.oid = 'public.lessons'::regclass)                               as table_acl,
  (select string_agg(a.attname || '=' || coalesce(a.attacl::text, ''), ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped) as column_acl,
  (select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
            || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), '')
     from pg_policy p where p.polrelid = 'public.lessons'::regclass)      as lessons_policies,
  (select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.id), ''))
     from public.lessons l)                                                 as lessons_md5,
  (select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), ''))
     from public.modules m)                                                 as modules_md5,
  (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), ''))
     from public.courses c)                                                 as courses_md5,
  (select md5(coalesce(string_agg(b.id || ':' || b.public::text, '|' order by b.id), ''))
     from storage.buckets b)                                                as buckets_md5,
  (select count(*) from public.lessons)                                     as n_lessons,
  (select count(*) from public.lessons where is_preview)                    as n_preview,
  (select count(*) from public.audit_log)                                   as n_audit;


-- ══ 1. THE DERIVED FIELDS ═════════════════════════════════════════════════
--
-- The three kinds carry byte-identical expressions apart from the kind prefix;
-- section 2 proves it from the catalog rather than trusting this text.
--
-- The internal test (rule 3) comes BEFORE the external test (rule 4), so a
-- value that is both — https://x.supabase.co/... is a perfectly valid URL — is
-- always internal.
alter table public.lessons
  add column video_source text generated always as (
    case
      when coalesce(video_object_path, '') <> '' then 'protected'
      when coalesce(video_url, '') = '' then null
      when video_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then 'protected'
      when length(video_url) <= 2048
       and video_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then 'external'
      else null
    end
  ) stored,
  add column video_external_url text generated always as (
    case
      when coalesce(video_object_path, '') <> '' then null
      when coalesce(video_url, '') = '' then null
      when video_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then null
      when length(video_url) <= 2048
       and video_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then video_url
      else null
    end
  ) stored,
  add column pdf_source text generated always as (
    case
      when coalesce(pdf_object_path, '') <> '' then 'protected'
      when coalesce(pdf_url, '') = '' then null
      when pdf_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then 'protected'
      when length(pdf_url) <= 2048
       and pdf_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then 'external'
      else null
    end
  ) stored,
  add column pdf_external_url text generated always as (
    case
      when coalesce(pdf_object_path, '') <> '' then null
      when coalesce(pdf_url, '') = '' then null
      when pdf_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then null
      when length(pdf_url) <= 2048
       and pdf_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then pdf_url
      else null
    end
  ) stored,
  add column subtitle_source text generated always as (
    case
      when coalesce(subtitle_object_path, '') <> '' then 'protected'
      when coalesce(subtitle_url, '') = '' then null
      when subtitle_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then 'protected'
      when length(subtitle_url) <= 2048
       and subtitle_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then 'external'
      else null
    end
  ) stored,
  add column subtitle_external_url text generated always as (
    case
      when coalesce(subtitle_object_path, '') <> '' then null
      when coalesce(subtitle_url, '') = '' then null
      when subtitle_url ~* 'supabase|storage(/|\\|%(25)*2f)+v1' then null
      when length(subtitle_url) <= 2048
       and subtitle_url ~* '^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}([/?#][-a-z0-9._~:/?#@!$&''()*+,;=%]*)?$'
        then subtitle_url
      else null
    end
  ) stored;

comment on column public.lessons.video_source is
  'WC-2A (054). Browser-safe: protected (we host it; deliver via /api/media) | external | NULL. '
  'Generated from video_object_path / video_url. Never a path or an internal URL.';
comment on column public.lessons.video_external_url is
  'WC-2A (054). video_url only when video_source = external: a clean http(s) URL on a non-Supabase host. Otherwise NULL.';
comment on column public.lessons.pdf_source is
  'WC-2A (054). Browser-safe: protected | external | NULL. Generated from pdf_object_path / pdf_url.';
comment on column public.lessons.pdf_external_url is
  'WC-2A (054). pdf_url only when pdf_source = external. Otherwise NULL.';
comment on column public.lessons.subtitle_source is
  'WC-2A (054). Browser-safe: protected | external | NULL. Generated from subtitle_object_path / subtitle_url.';
comment on column public.lessons.subtitle_external_url is
  'WC-2A (054). subtitle_url only when subtitle_source = external. Otherwise NULL.';


-- ══ 2. STRUCTURE, GRANTS AND DATA — nothing but the six fields changed ════
do $do$
declare
  b          record;
  v_n        integer;
  v_expr     text;
  v_ref      text;
  v_kind     text;
  v_deps     text;
  v_now      text;
begin
  select * into b from wc2a_054_before;

  -- Six generated, stored, text columns — no more, no fewer.
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and not a.attisdropped
     and a.attname in ('video_source', 'pdf_source', 'subtitle_source',
                       'video_external_url', 'pdf_external_url', 'subtitle_external_url')
     and a.attgenerated = 's' and a.atttypid = 'text'::regtype;
  if v_n <> 6 then
    raise exception 'WC-2A 054: expected 6 generated stored text columns, found %', v_n;
  end if;

  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and not a.attisdropped
     and a.attgenerated <> '';
  if v_n <> 6 then
    raise exception 'WC-2A 054: public.lessons has % generated columns, expected exactly 6', v_n;
  end if;

  -- Each kind reads ONLY its own two raw columns.
  foreach v_kind in array array['video', 'pdf', 'subtitle'] loop
    foreach v_now in array array['_source', '_external_url'] loop
      -- Recorded against the column default (pg_attrdef) on current releases and
      -- against the column itself on older ones; both forms are read, the
      -- generated column's own attribute excluded.
      select string_agg(distinct ref.attname, ',' order by ref.attname) into v_deps
        from pg_attribute gen
        left join pg_attrdef ad on ad.adrelid = gen.attrelid and ad.adnum = gen.attnum
        join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = gen.attrelid
                        and d.refobjsubid > 0 and d.refobjsubid <> gen.attnum
                        and (   (d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid)
                             or (d.classid = 'pg_class'::regclass and d.objid = gen.attrelid
                                 and d.objsubid = gen.attnum))
        join pg_attribute ref on ref.attrelid = d.refobjid and ref.attnum = d.refobjsubid
       where gen.attrelid = 'public.lessons'::regclass and gen.attname = v_kind || v_now;
      if v_deps is distinct from v_kind || '_object_path,' || v_kind || '_url' then
        raise exception 'WC-2A 054: % must depend on exactly its own raw columns, depends on: %',
          v_kind || v_now, coalesce(v_deps, '<none>');
      end if;
    end loop;
  end loop;

  -- The three kinds are the SAME rule: identical catalog expressions once the
  -- kind prefix is normalised.
  foreach v_now in array array['_source', '_external_url'] loop
    select replace(pg_get_expr(d.adbin, d.adrelid), 'video_', 'KIND_') into v_ref
      from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where a.attrelid = 'public.lessons'::regclass and a.attname = 'video' || v_now;
    foreach v_kind in array array['pdf', 'subtitle'] loop
      select replace(pg_get_expr(d.adbin, d.adrelid), v_kind || '_', 'KIND_') into v_expr
        from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where a.attrelid = 'public.lessons'::regclass and a.attname = v_kind || v_now;
      if v_expr is distinct from v_ref then
        raise exception 'WC-2A 054: the % rule differs from the video rule', v_kind || v_now;
      end if;
    end loop;
  end loop;

  -- GRANTS: the table ACL and every pre-existing column ACL are unchanged, and
  -- the new columns carry no column-level grant of their own.
  select coalesce(c.relacl::text, '') into v_now from pg_class c where c.oid = 'public.lessons'::regclass;
  if v_now is distinct from b.table_acl then
    raise exception 'WC-2A 054: the table ACL of public.lessons changed: % -> %', b.table_acl, v_now;
  end if;
  select string_agg(a.attname || '=' || coalesce(a.attacl::text, ''), ',' order by a.attname) into v_now
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('video_source', 'pdf_source', 'subtitle_source',
                           'video_external_url', 'pdf_external_url', 'subtitle_external_url');
  if v_now is distinct from b.column_acl then
    raise exception 'WC-2A 054: a column privilege on public.lessons changed';
  end if;
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.lessons'::regclass and a.attacl is not null
     and a.attname in ('video_source', 'pdf_source', 'subtitle_source',
                       'video_external_url', 'pdf_external_url', 'subtitle_external_url');
  if v_n <> 0 then
    raise exception 'WC-2A 054: % derived column(s) carry their own column-level grant', v_n;
  end if;

  -- Existing readers keep every column they read today (055 is a separate step).
  foreach v_kind in array array['anon', 'authenticated'] loop
    foreach v_now in array array['video_url', 'pdf_url', 'subtitle_url',
                                 'video_object_path', 'pdf_object_path', 'subtitle_object_path'] loop
      if not has_column_privilege(v_kind, 'public.lessons', v_now, 'SELECT') then
        raise exception 'WC-2A 054: % lost SELECT on lessons.% — that is 055, not 054', v_kind, v_now;
      end if;
    end loop;
  end loop;

  select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
           || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), '')
    into v_now from pg_policy p where p.polrelid = 'public.lessons'::regclass;
  if v_now is distinct from b.lessons_policies then
    raise exception 'WC-2A 054: a policy on public.lessons changed';
  end if;

  -- DATA: every pre-existing lesson value, every module, course and bucket.
  select md5(coalesce(string_agg((to_jsonb(l) - array['video_source', 'pdf_source', 'subtitle_source',
            'video_external_url', 'pdf_external_url', 'subtitle_external_url'])::text, '|' order by l.id), ''))
    into v_now from public.lessons l;
  if v_now is distinct from b.lessons_md5 then
    raise exception 'WC-2A 054: existing lesson data changed';
  end if;
  select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), '')) into v_now from public.modules m;
  if v_now is distinct from b.modules_md5 then
    raise exception 'WC-2A 054: module data changed';
  end if;
  select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) into v_now from public.courses c;
  if v_now is distinct from b.courses_md5 then
    raise exception 'WC-2A 054: course data or publication state changed';
  end if;
  select md5(coalesce(string_agg(x.id || ':' || x.public::text, '|' order by x.id), '')) into v_now from storage.buckets x;
  if v_now is distinct from b.buckets_md5 then
    raise exception 'WC-2A 054: storage bucket configuration changed';
  end if;

  raise notice 'WC-2A 054: 6 generated columns, own-kind dependencies, identical rules; grants, policies, lessons, modules, courses and buckets unchanged';
end
$do$;


-- ══ 3. AGREEMENT WITH TODAY'S ASSET RESOLUTION, ON THE LIVE CORPUS ════════
--
-- The reference is resolveAssetSource() (lib/media/paths.ts), restated in SQL:
--   path non-empty → protected; else URL non-empty → external(URL); else none.
-- Every row must agree with it, EXCEPT a URL-only row the derived rule
-- withholds on purpose (internal or not a clean external URL). Those are
-- counted and reported, never silently absorbed.
do $do$
declare
  v_kind      text;
  v_bad       integer;
  v_rows      integer;
  v_agree     integer;
  v_withheld  integer;
  v_protected integer;
  v_external  integer;
begin
  select count(*) into v_rows from public.lessons;

  foreach v_kind in array array['video', 'pdf', 'subtitle'] loop
    execute format($q$
      select
        count(*) filter (where
          (coalesce(%1$I, '') <> '' and (%3$I is distinct from 'protected' or %4$I is not null))
          or (coalesce(%1$I, '') = '' and coalesce(%2$I, '') = '' and (%3$I is not null or %4$I is not null))
          or (coalesce(%1$I, '') = '' and coalesce(%2$I, '') <> '' and %3$I = 'external'
              and %4$I is distinct from %2$I)
          or (%3$I is not null and %3$I not in ('protected', 'external'))
          or (%3$I is distinct from 'external' and %4$I is not null)),
        count(*) filter (where
          %3$I is not distinct from (case when coalesce(%1$I, '') <> '' then 'protected'
                                          when coalesce(%2$I, '') <> '' then 'external' end)
          and %4$I is not distinct from (case when coalesce(%1$I, '') = '' and coalesce(%2$I, '') <> ''
                                              then %2$I end)),
        count(*) filter (where coalesce(%1$I, '') = '' and coalesce(%2$I, '') <> ''
                           and %3$I is distinct from 'external'),
        count(*) filter (where %3$I = 'protected'),
        count(*) filter (where %3$I = 'external')
      from public.lessons
    $q$, v_kind || '_object_path', v_kind || '_url', v_kind || '_source', v_kind || '_external_url')
    into v_bad, v_agree, v_withheld, v_protected, v_external;

    if v_bad <> 0 then
      raise exception 'WC-2A 054: % % row(s) violate the derived contract', v_bad, v_kind;
    end if;
    if v_agree + v_withheld <> v_rows then
      raise exception 'WC-2A 054: % rows: % agree with resolveAssetSource, % withheld, % unexplained',
        v_kind, v_agree, v_withheld, v_rows - v_agree - v_withheld;
    end if;

    raise notice 'WC-2A 054 corpus %: % rows, % agree with resolveAssetSource, % URL-only withheld (fail-closed); protected %, external %',
      v_kind, v_rows, v_agree, v_withheld, v_protected, v_external;
  end loop;
end
$do$;


-- ══ 4. LEAKAGE INVARIANT — no internal location in any external field ═════
do $do$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.lessons l
   cross join lateral (values
     (l.video_external_url,    l.video_object_path,    l.pdf_object_path,    l.subtitle_object_path),
     (l.pdf_external_url,      l.video_object_path,    l.pdf_object_path,    l.subtitle_object_path),
     (l.subtitle_external_url, l.video_object_path,    l.pdf_object_path,    l.subtitle_object_path)
   ) as x(ext, p1, p2, p3)
   where x.ext is not null
     and (   x.ext ~* 'supabase'
          or x.ext ~* 'storage(/|\\|%(25)*2f)+v1'
          or x.ext !~* '^https?://'
          or x.ext ~ '[[:space:][:cntrl:]]'
          or x.ext in (coalesce(x.p1, ''), coalesce(x.p2, ''), coalesce(x.p3, '')));
  if v_n <> 0 then
    raise exception 'WC-2A 054: % external field value(s) disclose an internal location', v_n;
  end if;

  raise notice 'WC-2A 054: leakage invariant holds — no external field carries a Supabase host, a storage path or an object path';
end
$do$;


-- ══ 5. CLASSIFICATION FIXTURE — adversarial values through the real columns ═
--
-- A transient unpublished course, one module and one lesson per case, all
-- three kinds carrying the same values. Rolled back through a caught sentinel
-- (SQLSTATE XW054), then proven gone. Any real assertion failure raises a
-- different SQLSTATE, is not caught, and aborts the migration.
do $do$
declare
  v_slug     constant text := 'wc2a-054-fixture-' || md5(clock_timestamp()::text || random()::text);
  v_audit    bigint;
  v_lessons  bigint;
  v_course   uuid;
  v_module   uuid;
  v_lesson   uuid;
  v_i        integer := 0;
  r          record;
  g          record;
  v_want_url text;
  v_forged   boolean;
begin
  select count(*) into v_audit   from public.audit_log;
  select count(*) into v_lessons from public.lessons;

  begin
    insert into public.courses (slug, title, description, is_published)
    values (v_slug, 'WC-2A 054 fixture', 'Transient apply-time fixture; rolled back.', false)
    returning id into v_course;

    insert into public.modules (course_id, slug, title, order_index)
    values (v_course, 'wc2a-fixture-module', 'Fixture module', 1)
    returning id into v_module;

    for r in
      select * from (values
        -- label                                  object path          raw URL                                                                  source        external?
        ('C01 nothing',                           null::text,          null::text,                                                              null::text,   false),
        ('C02 empty strings',                     '',                  '',                                                                      null,         false),
        ('C03 path only',                         'video/a.mp4',       null,                                                                    'protected',  false),
        ('C04 path wins over external URL',       'video/a.mp4',       'https://www.youtube.com/embed/abc',                                     'protected',  false),
        ('C05 path wins over Supabase URL',       'video/a.mp4',       'https://abc.supabase.co/storage/v1/object/public/course-media/v/a.mp4', 'protected',  false),
        ('C06 whitespace path is a path',         '  ',                'https://www.youtube.com/embed/abc',                                     'protected',  false),
        ('C07 empty path, external URL',          '',                  'https://www.youtube.com/embed/abc?rel=0',                               'external',   true),
        ('C08 vimeo',                             null,                'https://player.vimeo.com/video/123',                                    'external',   true),
        ('C09 upper-case scheme and host',        null,                'HTTPS://CDN.Example.COM/v.mp4',                                         'external',   true),
        ('C10 http, bare host',                   null,                'http://example.com',                                                    'external',   true),
        ('C11 query without path',                null,                'https://example.com?x=1',                                               'external',   true),
        ('C12 percent-encoded path',              null,                'https://example.com/%E2%9C%93.pdf',                                     'external',   true),
        ('C13 punycode host',                     null,                'https://xn--bcher-kva.example/x',                                       'external',   true),
        ('C14 Supabase public storage URL',       null,                'https://abc.supabase.co/storage/v1/object/public/course-media/v/a.mp4', 'protected',  false),
        ('C15 Supabase host, other path',         null,                'https://abc.supabase.co/anything',                                      'protected',  false),
        ('C16 Supabase host upper-case',          null,                'HTTPS://ABC.SUPABASE.CO/X',                                             'protected',  false),
        ('C17 supabase.com marketing (fail-closed)', null,             'https://supabase.com/docs',                                             'protected',  false),
        ('C18 storage/v1 on a custom domain',     null,                'https://cdn.example.com/storage/v1/object/public/x.mp4',                'protected',  false),
        ('C19 storage%2Fv1 encoded',              null,                'https://cdn.example.com/storage%2Fv1/object/x',                         'protected',  false),
        ('C20 storage%252Fv1 double-encoded',     null,                'https://cdn.example.com/Storage%252Fv1/x',                              'protected',  false),
        ('C21 storage backslash v1',              null,                'https://cdn.example.com/storage\v1/x',                                  'protected',  false),
        ('C22 relative storage path',             null,                '/storage/v1/object/public/course-media/v/a.mp4',                        'protected',  false),
        ('C23 userinfo hiding a Supabase host',   null,                'https://evil.example@abc.supabase.co/x',                                'protected',  false),
        ('C24 userinfo on an external host',      null,                'https://user@cdn.example.com/x',                                        null,         false),
        ('C25 relative path',                     null,                '/videos/intro.mp4',                                                     null,         false),
        ('C26 bare object-path lookalike',        null,                'video/x.mp4',                                                           null,         false),
        ('C27 protocol-relative',                 null,                '//cdn.example.com/x.mp4',                                               null,         false),
        ('C28 ftp',                               null,                'ftp://example.com/x.mp4',                                               null,         false),
        ('C29 javascript:',                       null,                'javascript:alert(1)',                                                   null,         false),
        ('C30 data:',                             null,                'data:video/mp4;base64,AAAA',                                            null,         false),
        ('C31 localhost',                         null,                'https://localhost/x',                                                   null,         false),
        ('C32 IPv4 literal',                      null,                'https://127.0.0.1/x',                                                   null,         false),
        ('C33 IPv6 literal',                      null,                'https://[::1]/x',                                                       null,         false),
        ('C34 explicit port',                     null,                'https://example.com:8443/x',                                            null,         false),
        ('C35 leading space',                     null,                ' https://example.com/x',                                                null,         false),
        ('C36 embedded space',                    null,                'https://example.com/x y',                                               null,         false),
        ('C37 trailing newline',                  null,                'https://example.com/x' || chr(10),                                      null,         false),
        ('C38 space in host',                     null,                'https://exa mple.com/x',                                                null,         false),
        ('C39 trailing-dot host',                 null,                'https://example.com./x',                                                null,         false),
        ('C40 single slash after scheme',         null,                'https:/example.com/x',                                                  null,         false),
        ('C41 not a URL',                         null,                'not a url',                                                             null,         false),
        ('C42 markup characters',                 null,                'https://example.com/"><script>',                                        null,         false),
        ('C43 leading-hyphen label',              null,                'https://-bad.example.com/x',                                            null,         false),
        ('C44 over 2048 characters',              null,                'https://example.com/' || repeat('a', 2100),                             null,         false),
        ('C45 backslash authority',               null,                'https://example.com\@evil.example/x',                                   null,         false),
        ('C46 relative path shaped like a host',  null,                '/cdn.example.com/x.mp4',                                                null,         false),
        ('C47 host without a scheme',             null,                'cdn.example.com/x.mp4',                                                 null,         false)
      ) as v(label, obj_path, raw_url, want_source, want_external)
    loop
      v_i := v_i + 1;
      insert into public.lessons (module_id, slug, title, order_index,
                                  video_object_path, pdf_object_path, subtitle_object_path,
                                  video_url, pdf_url, subtitle_url)
      values (v_module, 'wc2a-case-' || v_i, r.label, v_i,
              r.obj_path, r.obj_path, r.obj_path, r.raw_url, r.raw_url, r.raw_url)
      returning id, video_source, pdf_source, subtitle_source,
                video_external_url, pdf_external_url, subtitle_external_url
      into g;

      v_want_url := case when r.want_external then r.raw_url end;
      if g.video_source is distinct from r.want_source
         or g.pdf_source is distinct from r.want_source
         or g.subtitle_source is distinct from r.want_source then
        raise exception 'WC-2A 054 fixture %: source video/pdf/subtitle = %/%/%, expected %',
          r.label, g.video_source, g.pdf_source, g.subtitle_source, coalesce(r.want_source, 'NULL');
      end if;
      if g.video_external_url is distinct from v_want_url
         or g.pdf_external_url is distinct from v_want_url
         or g.subtitle_external_url is distinct from v_want_url then
        raise exception 'WC-2A 054 fixture %: external URL surfaced wrongly (expected external = %)',
          r.label, r.want_external;
      end if;
    end loop;

    -- STORED means re-derived on every write: an admin adding and removing a
    -- path flips the classification with no extra step.
    select id into v_lesson from public.lessons where module_id = v_module and title = 'C08 vimeo';
    update public.lessons set video_object_path = 'video/wc2a.mp4' where id = v_lesson
      returning video_source, video_external_url into g;
    if g.video_source is distinct from 'protected' or g.video_external_url is not null then
      raise exception 'WC-2A 054 fixture: adding a path did not re-derive to protected';
    end if;
    update public.lessons set video_object_path = null where id = v_lesson
      returning video_source, video_external_url into g;
    if g.video_source is distinct from 'external' or g.video_external_url is null then
      raise exception 'WC-2A 054 fixture: removing the path did not re-derive to external';
    end if;

    -- No writer can forge a derived value.
    v_forged := false;
    begin
      insert into public.lessons (module_id, slug, title, order_index, video_source)
      values (v_module, 'wc2a-forged', 'forged', 999, 'external');
      v_forged := true;
    exception when sqlstate '428C9' then
      null;
    end;
    if v_forged then
      raise exception 'WC-2A 054 fixture: a derived column accepted a written value';
    end if;

    raise exception using errcode = 'XW054', message = 'WC-2A 054 fixture complete; rolling back';
  exception
    when sqlstate 'XW054' then
      null;
  end;

  if exists (select 1 from public.courses where slug = v_slug) then
    raise exception 'WC-2A 054 fixture: the fixture course survived the rollback';
  end if;
  if (select count(*) from public.lessons) <> v_lessons then
    raise exception 'WC-2A 054 fixture: lesson count changed across the rolled-back fixture';
  end if;
  if (select count(*) from public.audit_log) <> v_audit then
    raise exception 'WC-2A 054 fixture: audit_log changed across the rolled-back fixture';
  end if;
  if v_i <> 47 then
    raise exception 'WC-2A 054 fixture: ran % case(s), expected 47', v_i;
  end if;

  raise notice 'WC-2A 054 fixture: 47 cases x 3 kinds classified as specified, re-derivation and forgery checks passed; rolled back, no trace';
end
$do$;

-- Final count check against the pre-migration snapshot.
do $do$
declare
  b record;
begin
  select * into b from wc2a_054_before;
  if (select count(*) from public.lessons) <> b.n_lessons
     or (select count(*) from public.lessons where is_preview) <> b.n_preview
     or (select count(*) from public.audit_log) <> b.n_audit then
    raise exception 'WC-2A 054: lesson, preview or audit counts changed';
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it, and after the branch carrying
--    this file is merged. 054 is safe with the CURRENT application: nothing
--    reads the new fields yet, and no grant changes.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once. The
--    editor does not display RAISE NOTICE output; "Success" means every
--    section passed, because the file is one transaction and any failed
--    assertion raises and rolls everything back.
--
--    Adding STORED generated columns rewrites public.lessons under an ACCESS
--    EXCLUSIVE lock held until COMMIT: lesson reads WAIT for the transaction.
--    At the current size it completes in well under a second; if the editor
--    still shows it running after a few seconds, cancel it (nothing is
--    applied). Run it when no one is authoring content.
-- 3. Afterwards, GET-only: the six fields are listed in the API schema, a
--    service-role read of them agrees with resolveAssetSource() on every row,
--    and an anonymous read of the preview lessons still returns HTTP 200 with
--    the SAME row count. The raw columns remain readable until 055 — expected.
-- 4. Do NOT apply 055 until the compatible application release is deployed
--    and playback is verified in production.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes the six derived fields. Safe ONLY while no deployed
-- application reads them (i.e. before the WC-2B application release). It
-- touches no raw column, grant, policy or row value. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- alter table public.lessons
--   drop column if exists video_source,
--   drop column if exists video_external_url,
--   drop column if exists pdf_source,
--   drop column if exists pdf_external_url,
--   drop column if exists subtitle_source,
--   drop column if exists subtitle_external_url;
--
-- commit;
