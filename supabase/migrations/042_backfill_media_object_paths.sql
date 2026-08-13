-- ═══════════════════════════════════════════════════════════════════════════
-- XP Client Academy — Migration 042: backfill media object paths (XPA-8 W3)
--
-- ── RUN THIS ONLY AFTER THE OBJECTS HAVE BEEN COPIED ──────────────────────
--
--   041  →  deploy application code  →  copy objects  →  042  →  delete originals
--                                       (scripts/security/migrate-media-objects.mjs)
--
-- Running it earlier is not dangerous, it is simply refused: every path is
-- checked against storage.objects in the `course-content` bucket before it is
-- written, and a single missing object aborts the whole migration. Storage
-- lives in the same database, so this is a real join, not a hopeful string
-- rewrite.
--
-- ── WHY IT REFUSES RATHER THAN SKIPS ──────────────────────────────────────
--
-- A backfill that silently skips what it cannot parse leaves a subset of
-- lessons pointing at a public URL that is about to be deleted, and the only
-- symptom is a learner seeing a broken player weeks later. Every row that has
-- a Supabase-hosted media URL must end up with a path, or this migration
-- fails and changes nothing.
--
-- Genuinely external URLs (a YouTube embed, a partner CDN) are NOT an error —
-- they are matched explicitly and left alone, because nothing about them is
-- ours to move.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  -- Matches only OUR public object URLs, capturing the object path.
  --   https://<ref>.supabase.co/storage/v1/object/public/course-media/video/x.mp4
  --                                                                  ^^^^^^^^^^^^
  url_re    constant text := '^https?://[^/]+/storage/v1/object/public/course-media/(.+)$';
  r         record;
  obj_path  text;
  n_video   integer := 0;
  n_pdf     integer := 0;
  n_sub     integer := 0;
  n_ext     integer := 0;
  missing   text[]  := '{}';
  unparsed  text[]  := '{}';
begin
  -- ── Pass 1: parse and verify, writing nothing ───────────────────────────
  for r in
    select id, video_url, pdf_url, subtitle_url
      from public.lessons
     where video_url is not null
        or pdf_url is not null
        or subtitle_url is not null
  loop
    foreach obj_path in array array[r.video_url, r.pdf_url, r.subtitle_url]
    loop
      continue when obj_path is null;

      if obj_path !~ url_re then
        -- Not one of ours. Only tolerated if it is plainly an external URL.
        if obj_path ~ '^https?://' then
          n_ext := n_ext + 1;
        else
          unparsed := unparsed || (r.id::text || ' → ' || obj_path);
        end if;
        continue;
      end if;

      -- It is ours: the object must already exist in the PRIVATE bucket.
      if not exists (
        select 1 from storage.objects
         where bucket_id = 'course-content'
           and name = regexp_replace(obj_path, url_re, '\1')
      ) then
        missing := missing || regexp_replace(obj_path, url_re, '\1');
      end if;
    end loop;
  end loop;

  if array_length(unparsed, 1) > 0 then
    raise exception
      'XPA-8 W3 042: % media value(s) are neither a course-media URL nor an external URL. Nothing was changed. First: %',
      array_length(unparsed, 1), unparsed[1];
  end if;

  if array_length(missing, 1) > 0 then
    raise exception
      'XPA-8 W3 042: % object(s) are not yet in the course-content bucket. Run scripts/security/migrate-media-objects.mjs first. Nothing was changed. First: %',
      array_length(missing, 1), missing[1];
  end if;

  -- ── Pass 2: write ───────────────────────────────────────────────────────
  update public.lessons
     set video_object_path = regexp_replace(video_url, url_re, '\1')
   where video_url ~ url_re
     and video_object_path is null;
  get diagnostics n_video = row_count;

  update public.lessons
     set pdf_object_path = regexp_replace(pdf_url, url_re, '\1')
   where pdf_url ~ url_re
     and pdf_object_path is null;
  get diagnostics n_pdf = row_count;

  update public.lessons
     set subtitle_object_path = regexp_replace(subtitle_url, url_re, '\1')
   where subtitle_url ~ url_re
     and subtitle_object_path is null;
  get diagnostics n_sub = row_count;

  raise notice 'XPA-8 W3 042: backfilled % video, % pdf, % subtitle path(s); % external URL(s) left untouched.',
    n_video, n_pdf, n_sub, n_ext;
end $$;

-- ── Post-condition: no Supabase-hosted media may be left without a path ────
do $$
declare
  orphan integer;
begin
  select count(*) into orphan
    from public.lessons
   where (video_url    ~ '/storage/v1/object/public/course-media/' and video_object_path    is null)
      or (pdf_url      ~ '/storage/v1/object/public/course-media/' and pdf_object_path      is null)
      or (subtitle_url ~ '/storage/v1/object/public/course-media/' and subtitle_object_path is null);

  if orphan > 0 then
    raise exception 'XPA-8 W3 042: % lesson(s) still reference a public course-media URL with no object path', orphan;
  end if;

  raise notice 'XPA-8 W3 042: every Supabase-hosted lesson media value now has a canonical object path.';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- REMAINING OPERATOR STEPS (not automated here — they destroy data)
--
--   1. Verify delivery:  node scripts/security/verify-xpa-8-storage.mjs
--   2. Delete the originals from the PUBLIC bucket. Until this happens every
--      historical URL still works and F-2 is NOT closed:
--        node scripts/security/migrate-media-objects.mjs --delete-originals
--   3. Re-run the verifier: the historical-URL checks flip to DENIED.
--   4. Optionally narrow 007's "course-media public read" policy to the
--      cover/ prefix, now that nothing else lives there.
-- ═══════════════════════════════════════════════════════════════════════════
