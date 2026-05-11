-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — 015: Assign intro video URLs to pilot courses
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE courses
SET intro_video_url = '/videos/Fondamentaux de l''experience client.mp4'
WHERE slug = 'comprendre-client-qualite-experience';

UPDATE courses
SET intro_video_url = '/videos/Creer une experience client memorable.mp4'
WHERE slug = 'excellence-dans-le-service-client';
