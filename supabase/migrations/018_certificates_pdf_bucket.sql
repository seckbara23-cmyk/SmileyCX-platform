-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 018: Certificate PDF storage + pdf_url column
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add pdf_url column to certificates (nullable — set after PDF is generated)
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS pdf_url TEXT;

-- 2. Create certificates storage bucket (public so direct download URLs work)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'certificates',
  'certificates',
  true,                        -- public bucket: URL is the access control
  5242880,                     -- 5 MB limit per file
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS: only the owner can upload their certificate
--    (service role bypasses RLS, so the API route upload always works)
CREATE POLICY "cert_owner_select"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "cert_service_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'certificates');

CREATE POLICY "cert_service_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'certificates');
