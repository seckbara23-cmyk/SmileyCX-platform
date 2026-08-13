-- ═══════════════════════════════════════════════════════════════════════════
-- XP Client Academy — Migration 041: protected media storage (XPA-8 W3 / F-2)
--
-- ── THE DEFECT ────────────────────────────────────────────────────────────
--
-- Row-level security protected the lesson ROW while Storage served the FILE to
-- anybody. Measured in production before this migration:
--
--   • a lesson with is_preview = false returns 0 rows to an anonymous caller,
--     and its 15 MB video returned HTTP 200 to that same caller;
--   • `anon` could LIST course-media and enumerate 149 videos, 3 PDFs and
--     24 covers — no URL had to leak first;
--   • an authenticated learner with has_course_access() = false downloaded the
--     same file;
--   • a synthetic certificate written for learner B was downloaded anonymously;
--   • any authenticated learner could INSERT a PDF into ANOTHER learner's
--     certificate folder (proved: bucket went 0 → 1 objects, then cleaned).
--
-- has_course_access() governed the row. Nothing governed the file.
--
-- ── WHY A PUBLIC BUCKET CANNOT BE FIXED WITH POLICIES ─────────────────────
--
-- For a bucket with public = true, `/storage/v1/object/public/<bucket>/<path>`
-- serves the object WITHOUT evaluating storage.objects RLS at all. That is why
-- 018's `cert_owner_select` — which is written correctly — never protected
-- anything: the public route never consulted it. Bucket privacy is not one
-- layer of the model, it is the precondition for the model existing.
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────
--
-- 1. Creates `course-content`, a PRIVATE bucket for learner-protected media.
-- 2. Adds canonical object-path columns (durable identity, not expiring URLs).
-- 3. Makes `certificates` private — it holds 0 objects, so this costs nothing.
-- 4. Removes two storage policies that granted writes to every role.
--
-- It deliberately does NOT move objects and does NOT backfill paths. The new
-- columns stay NULL, application code falls back to the existing public URL,
-- and nothing changes for a learner. Object movement and backfill are 042 plus
-- an operator step, in the sequence documented in docs/xpa-8-w3-*.md.
--
-- `course-media` STAYS PUBLIC. It keeps serving `cover/` — course thumbnails
-- on the anonymous marketing catalogue, which are meant to be public. Only the
-- protected classes (video, pdf, subtitle) leave it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ══ 1. THE PRIVATE BUCKET ═════════════════════════════════════════════════
--
-- No SELECT policy is created for it, and that is the point. A signed URL is
-- minted server-side by the service role, which bypasses RLS; the token is
-- bound to one object path and one expiry. Verified against this project:
-- another object's token returns InvalidSignature, a flipped signature byte
-- returns InvalidJWT, and an `exp` extended without re-signing is refused.
-- With no policy at all there is no accidental grant to widen later.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'course-content',
  'course-content',
  false,                       -- ← the whole point
  524288000,                   -- 500 MB, same ceiling as course-media
  array[
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/pdf',
    'text/vtt', 'text/plain'
  ]
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ══ 2. CANONICAL OBJECT PATHS ═════════════════════════════════════════════
--
-- WHY A NEW COLUMN RATHER THAN REWRITING video_url
--
-- The two columns mean different things and both are needed:
--
--   video_url         an ABSOLUTE URL to something outside our control —
--                     a YouTube embed, a partner's CDN. The learn player
--                     already branches on the file extension to decide
--                     between <video> and an <iframe>, so external URLs are
--                     a supported case, not legacy debt.
--
--   video_object_path an object we hold in `course-content`, addressed by
--                     path. Delivery URLs are derived and expire; the path
--                     is the durable identity.
--
-- Overwriting video_url with a path would have made a column named _url stop
-- holding URLs, and would have destroyed the ability to tell "we host this"
-- from "someone else hosts this". Precedence is decided in one place
-- (lib/media/storage.ts): a path wins when present.

alter table public.lessons
  add column if not exists video_object_path    text,
  add column if not exists pdf_object_path      text,
  add column if not exists subtitle_object_path text;

alter table public.certificates
  add column if not exists pdf_object_path text;

comment on column public.lessons.video_object_path is
  'Object path inside the PRIVATE course-content bucket, e.g. video/1786…-ab12.mp4. '
  'Takes precedence over video_url. Never a URL — delivery URLs are minted per request.';
comment on column public.lessons.pdf_object_path is
  'Object path inside the PRIVATE course-content bucket. Takes precedence over pdf_url.';
comment on column public.lessons.subtitle_object_path is
  'Object path inside the PRIVATE course-content bucket. Takes precedence over subtitle_url.';
comment on column public.certificates.pdf_object_path is
  'Object path inside the PRIVATE certificates bucket: <user_id>/<certificate_id>.pdf. '
  'Replaces pdf_url, which stored a permanently public URL.';

-- A path column must never be allowed to hold a URL — that is precisely the
-- confusion this migration exists to end. Cheap CHECKs, enforced forever.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lessons_object_paths_are_paths') then
    alter table public.lessons
      add constraint lessons_object_paths_are_paths check (
        (video_object_path    is null or video_object_path    !~ '^[a-z]+://')
        and (pdf_object_path      is null or pdf_object_path      !~ '^[a-z]+://')
        and (subtitle_object_path is null or subtitle_object_path !~ '^[a-z]+://')
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'certificates_object_path_is_path') then
    alter table public.certificates
      add constraint certificates_object_path_is_path check (
        pdf_object_path is null or pdf_object_path !~ '^[a-z]+://'
      );
  end if;
end $$;

-- ══ 3. CERTIFICATES BECOMES PRIVATE ═══════════════════════════════════════
--
-- 018 created it public with the comment "public bucket: URL is the access
-- control". That is the assumption being retired: an unguessable path is not
-- an authorization. The bucket holds 0 objects, so there is nothing to move
-- and nothing to break.

update storage.buckets
   set public = false
 where id = 'certificates';

-- ══ 4. THE STORAGE POLICIES THAT GRANTED WRITES TO EVERYONE ═══════════════
--
-- 018 created these without a TO clause, so they applied to PUBLIC — every
-- role, including anon and authenticated:
--
--   cert_service_insert  FOR INSERT WITH CHECK (bucket_id = 'certificates')
--   cert_service_update  FOR UPDATE USING      (bucket_id = 'certificates')
--
-- Their names say "service", their effect said "anyone". Any signed-in learner
-- could write a PDF into another learner's certificate folder, or overwrite an
-- existing certificate. Proved in production before this migration.
--
-- They are DROPPED rather than rewritten. The service role bypasses RLS
-- entirely, so the certificate-generation route keeps working with no policy
-- at all — the policies were never what made it work. Absent policy = denied,
-- which is the correct default for a bucket only a server should write to.

drop policy if exists "cert_service_insert" on storage.objects;
drop policy if exists "cert_service_update" on storage.objects;

-- `cert_owner_select` is KEPT. With the bucket private it finally does
-- something: it governs `/object/<bucket>/<path>`, so even a caller who learns
-- a path cannot read another learner's certificate through the RLS route.
-- Recreated idempotently in case an environment lacks it.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cert_owner_select'
  ) then
    create policy "cert_owner_select"
      on storage.objects for select
      using (
        bucket_id = 'certificates'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;

-- ══ 5. course-media KEEPS ITS PUBLIC READ, DELIBERATELY ═══════════════════
--
-- 007's "course-media public read" policy stays exactly as it is. After the
-- operator step in 042 this bucket holds ONLY `cover/` — thumbnails rendered
-- by the anonymous marketing catalogue, which must stay publicly cacheable.
-- Narrowing the policy to the cover/ prefix is deliberately NOT done here: it
-- would break the still-present video/ and pdf/ objects during the migration
-- window. It belongs after the cutover, and 042 records it as the final step.

-- ══ 6. VERIFICATION ═══════════════════════════════════════════════════════
do $$
declare
  n_private  integer;
  n_certpub  integer;
  n_badpol   integer;
  n_cols     integer;
begin
  select count(*) into n_private from storage.buckets where id = 'course-content' and public = false;
  if n_private <> 1 then
    raise exception 'XPA-8 W3 041: course-content is missing or still public';
  end if;

  select count(*) into n_certpub from storage.buckets where id = 'certificates' and public = true;
  if n_certpub <> 0 then
    raise exception 'XPA-8 W3 041: certificates bucket is still public';
  end if;

  select count(*) into n_badpol from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('cert_service_insert', 'cert_service_update');
  if n_badpol <> 0 then
    raise exception 'XPA-8 W3 041: the permissive certificate write policies survived';
  end if;

  select count(*) into n_cols from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'lessons' and column_name in
            ('video_object_path', 'pdf_object_path', 'subtitle_object_path'))
       or (table_name = 'certificates' and column_name = 'pdf_object_path'));
  if n_cols <> 4 then
    raise exception 'XPA-8 W3 041: expected 4 object-path columns, found %', n_cols;
  end if;

  raise notice 'XPA-8 W3 041: course-content private, certificates private, 2 permissive policies dropped, 4 path columns added.';
end $$;
