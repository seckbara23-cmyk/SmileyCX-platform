-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 014: Set intro video URLs for pilot courses
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE courses
SET intro_video_url = '/videos/Fondamentaux de l''experience client.mp4'
WHERE slug = 'excellence-dans-le-service-client';
