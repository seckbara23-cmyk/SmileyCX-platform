-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 017: Fix all course slugs containing whitespace
-- ═══════════════════════════════════════════════════════════════════════════
-- More targeted than 016 — runs only on slugs with actual whitespace and
-- applies a clean multi-step normalization:
--   1. Replace any run of non-alphanumeric chars with a single hyphen
--   2. Lowercase the result
--   3. Trim leading / trailing hyphens
--
-- "service client digital"  →  "service-client-digital"
-- "Les bases d un service"  →  "les-bases-d-un-service"
-- ─────────────────────────────────────────────────────────────────────────

UPDATE courses
SET slug = regexp_replace(
             lower(regexp_replace(slug, '[^a-zA-Z0-9]+', '-', 'g')),
             '^-+|-+$', '', 'g'
           )
WHERE slug ~ '\s';
