-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 019: Add status and revocation fields to certificates
-- ═══════════════════════════════════════════════════════════════════════════
-- Safe additions — no existing columns removed or altered.
-- Existing 'valid' default ensures no NULL issues for old rows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS status         TEXT        NOT NULL DEFAULT 'valid'
    CHECK (status IN ('valid', 'revoked', 'pilot', 'duplicate')),
  ADD COLUMN IF NOT EXISTS revoked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

-- Fast lookup for admin status filters
CREATE INDEX IF NOT EXISTS certificates_status_idx ON certificates(status);
CREATE INDEX IF NOT EXISTS certificates_issued_at_idx ON certificates(issued_at DESC);
