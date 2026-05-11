-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 016: Normalize course slugs (fix slugs containing spaces)
-- ═══════════════════════════════════════════════════════════════════════════
-- Converts any slug that contains spaces or other non-URL-safe characters
-- into a clean kebab-case slug.
--
-- Example: "service client digital" → "service-client-digital"
-- ─────────────────────────────────────────────────────────────────────────

UPDATE courses
SET slug = regexp_replace(
             lower(
               regexp_replace(slug, '[^a-zA-Z0-9]+', '-', 'g')
             ),
             '^-+|-+$', '', 'g'
           )
WHERE slug ~ '[^a-z0-9\-]';
