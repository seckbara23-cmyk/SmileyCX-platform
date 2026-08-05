-- ============================================================
-- Migration 030: Backfill course codes onto existing courses
--
-- Assigns the permanent academic identity to the six courses that already
-- exist. Matching is by SLUG, which is the current stable key.
--
-- WHAT THIS DOES NOT DO:
--   * does not rename any slug
--   * does not rename any title
--   * does not change any course id
--   * does not create, delete or unpublish any course
--   * does not invent a mapping for a course that does not exist
--
-- Only `courses.code` is written, and only where it is currently NULL. Once
-- set, migration 028's trigger makes it immutable, so re-running is a no-op.
--
-- ── Mapping provenance ──────────────────────────────────────────────────
-- Five mappings are exact title matches against the V4 catalogue.
-- C1-F3 is a title-differs / objective-matches mapping, RATIFIED by management
-- as decision D-Q2 ("the code becomes the stable technical identity; the
-- displayed title remains editable"). It therefore no longer requires a pause.
-- The existing slug and title are preserved exactly as-is — per D-Q2 the
-- current slug simply becomes the historical one, because the repository has no
-- slug-alias or redirect mechanism (verified: no `redirects` in next.config.mjs,
-- no slug-history table).
--
-- Courses with no produced content (C2-F3, C2-F5, all of C3, C2-F6 backlog)
-- are deliberately left ABSENT rather than stubbed. Their codes exist in
-- course_codes; the missing course is visible as a code with no course row.
-- ============================================================

do $$
declare
  m record;
  n_mapped integer := 0;
begin
  for m in
    select * from (values
      -- code,    slug,                                                                    provenance
      ('C1-F1', 'les-fondamentaux-de-l-experience-client',                                 'exact title match'),
      ('C1-F2', 'les-fondamentaux-du-service-client',                                      'exact title match'),
      ('C1-F3', 'communiquer-avec-les-clients-sur-les-canaux-digitaux',                    'ratified D-Q2 (objective match, title differs)'),
      ('C2-F1', 'manager-une-equipe-orientee-client',                                      'exact title match'),
      ('C2-F2', 'mesurer-l-experience-client',                                             'exact title match'),
      ('C2-F4', 'gerer-les-reclamations-et-transformer-l-insatisfaction-en-opportunite',   'exact title match')
    ) as t(code, slug, provenance)
  loop
    -- Guard: never overwrite an assigned code (the trigger would reject it
    -- anyway; failing here gives a clearer message).
    if exists (select 1 from public.courses c where c.slug = m.slug and c.code is not null and c.code <> m.code) then
      raise exception 'course % already carries code %, refusing to reassign to %',
        m.slug, (select code from public.courses where slug = m.slug), m.code;
    end if;

    update public.courses
       set code = m.code, updated_at = now()
     where slug = m.slug
       and code is null;

    if found then
      n_mapped := n_mapped + 1;
      raise notice 'mapped % -> % (%)', m.slug, m.code, m.provenance;
    else
      -- Either already mapped (idempotent re-run) or the course is absent.
      if not exists (select 1 from public.courses where slug = m.slug) then
        raise notice 'course % not present — code % left unassigned', m.slug, m.code;
      end if;
    end if;
  end loop;

  raise notice 'backfill complete: % course(s) newly mapped', n_mapped;
end $$;

-- ── Verification ─────────────────────────────────────────────────────────
do $$
declare
  n_unmapped integer;
  n_dupes    integer;
begin
  -- Every course that exists today should now carry a code. A course without
  -- one is not an error in itself (new drafts are allowed), but during this
  -- migration it means a mapping was missed.
  select count(*) into n_unmapped from public.courses where code is null;
  if n_unmapped > 0 then
    raise warning '% course(s) still have no code — verify this is intended', n_unmapped;
  end if;

  -- The unique constraint already prevents this; assert for clarity.
  select count(*) into n_dupes from (
    select code from public.courses where code is not null group by code having count(*) > 1
  ) d;
  if n_dupes > 0 then
    raise exception '% code(s) assigned to more than one course', n_dupes;
  end if;
end $$;

-- ============================================================
-- ROLLBACK (manual):
--   -- The immutability trigger blocks clearing a code, so disable it first:
--   alter table public.courses disable trigger courses_code_immutable;
--   update public.courses set code = null
--    where slug in (
--      'les-fondamentaux-de-l-experience-client',
--      'les-fondamentaux-du-service-client',
--      'communiquer-avec-les-clients-sur-les-canaux-digitaux',
--      'manager-une-equipe-orientee-client',
--      'mesurer-l-experience-client',
--      'gerer-les-reclamations-et-transformer-l-insatisfaction-en-opportunite'
--    );
--   alter table public.courses enable trigger courses_code_immutable;
-- No slug, title, id, enrollment, progress or certificate is affected.
-- ============================================================
