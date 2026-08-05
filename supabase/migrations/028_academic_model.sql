-- ============================================================
-- Migration 028: Academic model — catalogues, course codes, learning paths
--
-- Source of truth:
--   public/Architecture_Catalogues_Parcours_XP-Client-Academy_V4.pdf
--   docs/xpa-0-audit.md · docs/xpa-decision-register.md
--
-- STRICTLY ADDITIVE. Nothing existing is renamed, dropped, or rebuilt:
--   * new tables only
--   * ONE nullable column added to `courses` (code)
--   * no slug changes, no title changes, no course id changes
--   * no existing RLS policy is altered or dropped
--   * no permission is broadened
--
-- ── The golden rule this schema encodes ──────────────────────────────────
-- Catalogues own pedagogical content. Paths NEVER create or duplicate course
-- content — they reference courses through stable codes, in a recommended
-- order. `learning_path_courses` therefore holds no content columns at all:
-- only a code reference, a position, and whether the entry is part of the
-- sector "socle commun".
--
-- ── Code permanence ──────────────────────────────────────────────────────
-- A course code is a permanent technical identifier. Titles are editable
-- labels. A retired code is NEVER reused, so learner history and statistics
-- stay meaningful. Enforced by triggers below, not by convention.
-- ============================================================

-- ── 1. Catalogues ────────────────────────────────────────────────────────
-- Three fixed pedagogical levels. `code` is the identity (C1/C2/C3).
create table if not exists public.catalogues (
  code        text primary key check (code ~ '^C[0-9]+$'),
  title       text not null,
  objective   text,
  position    integer not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.catalogues is
  'Pedagogical catalogues (C1 Fondations, C2 Intermédiaire, C3 Avancé). Source of truth for course structure. XPA-2.';

-- ── 2. Course codes — the permanent identity registry ────────────────────
-- One row per code defined by the V4 architecture, INDEPENDENT of whether a
-- course has been produced yet. A code with no matching `courses` row is a
-- planned-but-missing course; that is how the admin surface reports gaps
-- without inventing placeholder course content.
create table if not exists public.course_codes (
  code            text primary key check (code ~ '^C[0-9]+-F[0-9]+$'),
  catalogue_code  text not null references public.catalogues(code) on update cascade,
  canonical_title text not null,          -- V4 reference title; display titles live on `courses`
  objective       text,
  targets         text,
  position        integer not null,       -- order within the catalogue
  -- 'undecided' is deliberate: the « Lancement Soft » document that defines the
  -- launch cohort is NOT in the repository (decision register D-Q1), and launch
  -- status must not be invented. Only C2-F6 is seeded as 'backlog', because the
  -- V4 document itself states it (§10).
  status          text not null default 'undecided'
                    check (status in ('undecided','launch','backlog','retired')),
  retired_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists course_codes_catalogue_idx on public.course_codes(catalogue_code, position);
create index if not exists course_codes_status_idx    on public.course_codes(status);

comment on table public.course_codes is
  'Permanent course-code registry from the V4 architecture. A code is never reused, even after retirement. Rows without a matching courses row are planned-but-not-yet-produced. XPA-2.';

-- ── 3. Link existing courses to their code (NULLABLE) ────────────────────
-- Nullable so every existing row stays valid and untouched. The course id
-- remains the database identity; the code is the permanent ACADEMIC identity.
-- Slug remains the URL key and is NOT modified anywhere in this migration.
alter table public.courses
  add column if not exists code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'courses_code_fkey'
  ) then
    alter table public.courses
      add constraint courses_code_fkey
      foreign key (code) references public.course_codes(code) on update cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'courses_code_unique'
  ) then
    -- One course per code. NULLs are not compared, so unmapped courses coexist.
    alter table public.courses add constraint courses_code_unique unique (code);
  end if;
end $$;

comment on column public.courses.code is
  'Permanent academic identity (e.g. C1-F1). Nullable during migration. Immutable once set — see trigger enforce_course_code_immutable. The title is an editable label; the code never changes.';

-- ── 4. Learning paths ────────────────────────────────────────────────────
-- Commercial recommendations. Two axes: professional ("qui je suis") and
-- sector ("où je travaille"). They own NO pedagogical content.
create table if not exists public.learning_paths (
  code        text primary key check (code ~ '^(PM|SEC)-[A-Z]+$'),
  kind        text not null check (kind in ('professional','sector')),
  title       text not null,
  objective   text,
  -- Free-text scoping note. Also carries V4 cross-references that are
  -- recommendations rather than course relations (e.g. several sector paths
  -- recommend the PM-OPT path as an entry point for operational staff).
  note        text,
  position    integer not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists learning_paths_kind_idx on public.learning_paths(kind, position);

comment on table public.learning_paths is
  'Professional (PM-) and sector (SEC-) learning paths. Commercial recommendations only — they never store pedagogical content. XPA-2.';

-- ── 5. Path ↔ course junction (ordered N-N) ──────────────────────────────
-- References a COURSE CODE, never a course id and never a title, so a path
-- stays valid whether or not the course has been produced yet.
create table if not exists public.learning_path_courses (
  path_code   text    not null references public.learning_paths(code) on update cascade on delete cascade,
  course_code text    not null references public.course_codes(code)   on update cascade,
  position    integer not null,
  -- Sector paths share a common foundation ("socle commun sectoriel":
  -- C1-F1 + C1-F2). Flagged so the UI can present it distinctly in XPA-3.
  is_socle    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (path_code, course_code),
  constraint learning_path_courses_position_unique unique (path_code, position)
);

create index if not exists lpc_path_idx   on public.learning_path_courses(path_code, position);
create index if not exists lpc_course_idx on public.learning_path_courses(course_code);

comment on table public.learning_path_courses is
  'Ordered N-N between paths and course CODES. Holds no content: selection, order and socle flag only. XPA-2.';

-- ── 6. Immutability enforcement ──────────────────────────────────────────
-- Convention is not enough: a code that can drift is not an identity.

-- 6a. A course code, once assigned, can never be changed or cleared.
create or replace function public.enforce_course_code_immutable()
returns trigger
language plpgsql
as $$
begin
  if OLD.code is not null and NEW.code is distinct from OLD.code then
    raise exception
      'course code is immutable: % cannot become % (course %). Titles are editable labels; codes are permanent identity.',
      OLD.code, coalesce(NEW.code, 'NULL'), OLD.id
      using errcode = '23514';
  end if;
  return NEW;
end $$;

drop trigger if exists courses_code_immutable on public.courses;
create trigger courses_code_immutable
  before update on public.courses
  for each row execute function public.enforce_course_code_immutable();

-- 6b. A registry code is never renamed, and never deleted (retire instead),
--     so it can never be reassigned to a different course.
create or replace function public.enforce_course_code_registry_permanence()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' and NEW.code is distinct from OLD.code then
    raise exception 'course_codes.code is permanent: % cannot be renamed to %', OLD.code, NEW.code
      using errcode = '23514';
  end if;
  if TG_OP = 'DELETE' then
    raise exception
      'course_codes rows are never deleted (code %). Set status = ''retired'' instead — a retired code must never be reused.',
      OLD.code
      using errcode = '23514';
  end if;
  return NEW;
end $$;

drop trigger if exists course_codes_permanent on public.course_codes;
create trigger course_codes_permanent
  before update or delete on public.course_codes
  for each row execute function public.enforce_course_code_registry_permanence();

-- ── 7. Row level security ────────────────────────────────────────────────
-- ADMINISTRATOR-ONLY, deliberately. These tables are closed in XPA-2.
--
-- The obvious choice would be public SELECT, since this is commercial metadata
-- rather than learner data. It was rejected: RLS `USING (true)` makes a table
-- readable through PostgREST by anyone holding the anon key, which is public by
-- design. That would publish the ENTIRE product roadmap — every course code
-- that has no content yet, the backlog entry, and the full path composition —
-- to any anonymous caller.
--
-- That directly contradicts decision D-Q5, which ratified that the V4
-- architecture document must not be publicly served. Serving its contents
-- through an API instead of a PDF is the same disclosure by another route.
--
-- Nothing public consumes these tables in XPA-2: discovery is XPA-3, and the
-- only reader here is the admin catalogue page. When XPA-3 builds public
-- discovery it should add a NARROW read policy — for example, exposing paths
-- and only those course codes that have a published course — rather than
-- opening the registry wholesale.
--
-- No existing policy is modified. Every write policy carries an explicit
-- WITH CHECK (the repository's SQL linter enforces this, and USING alone
-- would constrain row ownership without constraining written values).

alter table public.catalogues            enable row level security;
alter table public.course_codes          enable row level security;
alter table public.learning_paths        enable row level security;
alter table public.learning_path_courses enable row level security;

drop policy if exists "catalogues_public_select" on public.catalogues;
drop policy if exists "catalogues_admin_select" on public.catalogues;
create policy "catalogues_admin_select"
  on public.catalogues for select
  using (public.is_platform_admin());

drop policy if exists "catalogues_admin_all" on public.catalogues;
create policy "catalogues_admin_all"
  on public.catalogues for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists "course_codes_public_select" on public.course_codes;
drop policy if exists "course_codes_admin_select" on public.course_codes;
create policy "course_codes_admin_select"
  on public.course_codes for select
  using (public.is_platform_admin());

drop policy if exists "course_codes_admin_all" on public.course_codes;
create policy "course_codes_admin_all"
  on public.course_codes for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists "learning_paths_public_select" on public.learning_paths;
drop policy if exists "learning_paths_admin_select" on public.learning_paths;
create policy "learning_paths_admin_select"
  on public.learning_paths for select
  using (public.is_platform_admin());

drop policy if exists "learning_paths_admin_all" on public.learning_paths;
create policy "learning_paths_admin_all"
  on public.learning_paths for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists "lpc_public_select" on public.learning_path_courses;
drop policy if exists "lpc_admin_select" on public.learning_path_courses;
create policy "lpc_admin_select"
  on public.learning_path_courses for select
  using (public.is_platform_admin());

drop policy if exists "lpc_admin_all" on public.learning_path_courses;
create policy "lpc_admin_all"
  on public.learning_path_courses for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ============================================================
-- ROLLBACK (manual, for reference — additive so rollback is clean):
--   drop trigger if exists courses_code_immutable on public.courses;
--   drop function if exists public.enforce_course_code_immutable();
--   alter table public.courses drop constraint if exists courses_code_unique;
--   alter table public.courses drop constraint if exists courses_code_fkey;
--   alter table public.courses drop column if exists code;
--   drop trigger if exists course_codes_permanent on public.course_codes;
--   drop function if exists public.enforce_course_code_registry_permanence();
--   drop table if exists public.learning_path_courses;
--   drop table if exists public.learning_paths;
--   drop table if exists public.course_codes;
--   drop table if exists public.catalogues;
-- No existing data is touched by any of the above.
-- ============================================================
