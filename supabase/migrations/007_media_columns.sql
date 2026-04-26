-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — Migration 007: Media Columns + Storage
--
-- What this does:
--   1. Adds cover_url to courses (course thumbnail / banner)
--   2. Adds pdf_url to lessons (downloadable PDF resource)
--   3. Creates the `course-media` storage bucket (public)
--   4. Sets storage policies so admins can upload and anyone can read
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Schema changes ────────────────────────────────────────────────────────────
ALTER TABLE courses ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS pdf_url   TEXT;

-- ── Storage bucket ────────────────────────────────────────────────────────────
-- Run in Supabase SQL Editor (requires storage extension to be enabled)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'course-media',
  'course-media',
  true,
  524288000,  -- 500 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public            = true,
      file_size_limit   = 524288000,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── Storage policies ──────────────────────────────────────────────────────────
-- Public read (anyone can view files — URLs are used in lessons)
DROP POLICY IF EXISTS "course-media public read" ON storage.objects;
CREATE POLICY "course-media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'course-media');

-- Upload/delete restricted to service role (admin API handles this)
-- The upload API uses the service role key which bypasses RLS entirely.
-- No additional policies needed for write operations.
