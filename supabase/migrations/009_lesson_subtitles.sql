-- Migration 009: Subtitle support for lessons
-- Adds a subtitle_url column (WebVTT file stored in Supabase Storage).
-- The upload API handles the file; this column just stores the public URL.

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS subtitle_url TEXT;
