-- ═══════════════════════════════════════════════════════════════════════════
-- XP Client Academy — Migration 043: clear C2-F2's blanket preview flags (F-1)
--
-- ── WHAT WAS FOUND ────────────────────────────────────────────────────────
--
-- All 20 lessons of `mesurer-l-experience-client` carried is_preview = true.
-- Every other course carried zero. The audit established:
--
--   • NOT a default        — the column defaults false
--   • NOT an import        — no seed or bulk script in the repo writes it
--   • NOT a migration      — 035 zeroed the old blanket flag and its guard
--                            correctly declined to re-fire afterwards
--   • authored in the ADMIN EDITOR — all 20 created in one 21-minute session,
--     video upload timestamps matching `created_at`, and 19/20 slugs matching
--     the editor's autoSlug(title), the same signature as every other course
--
-- The checkbox is correctly labelled ("Leçon en aperçu libre — visible sans
-- inscription"), defaults unchecked, and the form unmounts between lessons, so
-- there is no state carry-over: each flag was an individual, deliberate tick.
--
-- ── WHY THEY ARE BEING CLEARED ANYWAY ─────────────────────────────────────
--
-- Deliberate is not the same as intended, and intent could not be proven from
-- the data. What could be proven is that the flags bought nothing and risked
-- something:
--
--   • no UX depends on them. The public catalogue lists every lesson of every
--     course from `public_course_lessons` (039) regardless of preview, and the
--     "GRATUIT" badge is driven by `is_preview OR FREE_ACCESS_MODE` — with
--     production in pilot mode, all six courses already render identically.
--     Measured: 0 lock icons anywhere.
--   • they deliver no sample. No lesson on the platform has a `content` body,
--     the media route refuses an unentitled caller (403), and the learn page
--     bounces an anonymous visitor to /login. The badge promises access the
--     platform does not grant.
--   • they arm a real exposure. `lessons.content` IS readable by anon for a
--     preview row — null today only because B-2 has not been done. The moment
--     lesson bodies are written, 20 lessons' full text becomes public with no
--     further change.
--
-- Ruled by the product owner: clear them. One statement, fully reversible.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────────────────
--
-- It does not touch `is_preview` anywhere else, and it does not remove the
-- preview FEATURE. Migration 001's `OR is_preview = true` policy arm stays, so
-- designating a genuine preview lesson remains a normal editorial action —
-- exactly what 035 protected. An unconditional `set is_preview = false` was
-- deliberately NOT used: it would also erase any deliberate preview an
-- administrator sets in future, which is the mistake 035 warned about.
--
-- ── IF A PREVIEW IS EVER SET AGAIN ────────────────────────────────────────
--
-- Note for whoever does it: the base `lessons` table exposes MORE to `anon`
-- than the ratified public projection does — `content`, `title_fr`,
-- `video_url` and the three `*_object_path` columns are all reachable on a
-- preview row, while `public_course_lessons` exposes only id, module_id,
-- course_id, slug, title, duration_minutes, is_preview, order_index.
-- Before using preview for real, restrict those columns for `anon`.
-- `verify-xpa-6a` now asserts this invariant and will fail loudly if a preview
-- row ever exposes a body or an object path.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_course_id  uuid;
  n_before     integer;
  n_cleared    integer;
  n_elsewhere  integer;
begin
  select id into v_course_id
    from public.courses
   where slug = 'mesurer-l-experience-client';

  if v_course_id is null then
    raise exception 'XPA-8 F-1 043: course mesurer-l-experience-client not found; refusing to guess';
  end if;

  select count(*) into n_before
    from public.lessons l
    join public.modules m on m.id = l.module_id
   where m.course_id = v_course_id
     and l.is_preview = true;

  -- Scoped to this course only. Anything flagged elsewhere is somebody's
  -- later editorial decision and is none of this migration's business.
  update public.lessons l
     set is_preview = false
    from public.modules m
   where m.id = l.module_id
     and m.course_id = v_course_id
     and l.is_preview = true;
  get diagnostics n_cleared = row_count;

  select count(*) into n_elsewhere
    from public.lessons l
    join public.modules m on m.id = l.module_id
   where m.course_id <> v_course_id
     and l.is_preview = true;

  raise notice 'XPA-8 F-1 043: cleared % of % preview flag(s) on C2-F2; % preview lesson(s) remain on other courses.',
    n_cleared, n_before, n_elsewhere;

  if n_cleared <> n_before then
    raise exception 'XPA-8 F-1 043: expected to clear % flag(s), cleared %', n_before, n_cleared;
  end if;
end $$;

-- ── Post-condition ─────────────────────────────────────────────────────────
do $$
declare
  n_left integer;
begin
  select count(*) into n_left
    from public.lessons l
    join public.modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
   where c.slug = 'mesurer-l-experience-client'
     and l.is_preview = true;

  if n_left <> 0 then
    raise exception 'XPA-8 F-1 043: % preview flag(s) survived on C2-F2', n_left;
  end if;

  raise notice 'XPA-8 F-1 043: C2-F2 has no preview lessons; the preview feature itself is untouched.';
end $$;
