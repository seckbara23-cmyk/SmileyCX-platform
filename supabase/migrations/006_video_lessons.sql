-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — Migration 006: Integrate Real Video Lessons
--
-- What this does:
--   1. Restructures Modules 3 & 4 to match the actual video production order:
--        Old DB: M3=Fondamentaux Service Client, M4=Comprendre Émotions
--        New DB: M3=Comprendre Émotions, M4=Créer Expérience de Qualité
--   2. Adds real video_url paths (served from /public/videos/) to 5 lessons:
--        Module 1 lesson 1, Module 2 lesson 1, Module 3 lesson 1,
--        Module 4 lesson 1, Module 4 lesson 2
--   3. Replaces the old placeholder Module 3 (fondamentaux-service-client)
--      with the video-backed Module 4 content (creer-experience-client-qualite)
--
-- Rollback: see bottom of file.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_course_id  UUID;
  v_mod1_id    UUID;
  v_mod2_id    UUID;
  v_mod3_id    UUID;
  v_mod4_new   UUID;
BEGIN

-- ── Resolve course ID ─────────────────────────────────────────────────────────
SELECT id INTO v_course_id
FROM courses
WHERE slug = 'comprendre-client-qualite-experience';

IF v_course_id IS NULL THEN
  RAISE EXCEPTION 'Flagship course not found — run migration 002 first.';
END IF;

-- ── Module 1: Add video to first lesson ───────────────────────────────────────
SELECT id INTO v_mod1_id
FROM modules WHERE course_id = v_course_id AND slug = 'introduction-experience-client';

IF v_mod1_id IS NOT NULL THEN
  UPDATE lessons
  SET
    video_url        = '/videos/module-1-comprendre-experience-client.mp4',
    title            = 'Comprendre l''Expérience Client',
    duration_minutes = 18,
    is_preview       = true          -- first lesson stays free-preview
  WHERE module_id = v_mod1_id AND slug = 'quest-ce-que-la-cx';
END IF;

-- ── Module 2: Add video to first lesson ───────────────────────────────────────
SELECT id INTO v_mod2_id
FROM modules WHERE course_id = v_course_id AND slug = 'parcours-client-moments-verite';

IF v_mod2_id IS NOT NULL THEN
  UPDATE lessons
  SET
    video_url        = '/videos/module-2-comprendre-parcours-client.mp4',
    title            = 'Comprendre le Parcours Client',
    duration_minutes = 22
  WHERE module_id = v_mod2_id AND slug = 'cartographie-parcours-client';
END IF;

-- ── Module 3 (Émotions): Move from order 4 → 3, add video ────────────────────
--
-- The video production numbers are:
--   Video "Module 3" = Comprendre les Émotions des Clients
--   Video "Module 4" = Créer une Interaction de Qualité (2 lessons)
--
-- The existing DB had:
--   order 3 = fondamentaux-service-client   (no video yet)
--   order 4 = comprendre-emotions-clients    (now gets the Module 3 video)
--
-- Step 1: Temporarily park emotions module at order 99 to avoid unique conflict
UPDATE modules
SET order_index = 99
WHERE course_id = v_course_id AND slug = 'comprendre-emotions-clients';

-- Step 2: Remove the "fondamentaux-service-client" module entirely.
-- Its placeholder lessons had no video and the content is covered by the
-- new Module 4 (creer-experience-client-qualite) below.
-- lesson_progress rows cascade on DELETE (FK: ON DELETE CASCADE).
DELETE FROM modules
WHERE course_id = v_course_id AND slug = 'fondamentaux-service-client';

-- Step 3: Move emotions to order 3 and assign video
SELECT id INTO v_mod3_id
FROM modules WHERE course_id = v_course_id AND slug = 'comprendre-emotions-clients';

UPDATE modules
SET order_index = 3,
    title       = 'Comprendre les Émotions des Clients',
    description = 'Explorez la dimension émotionnelle de l''expérience client et apprenez à créer des connexions authentiques qui transforment les clients en ambassadeurs fidèles.'
WHERE id = v_mod3_id;

-- Add video to first lesson of Module 3 (emotions)
UPDATE lessons
SET
  video_url        = '/videos/module-3-comprendre-emotions-clients.mp4',
  title            = 'Comprendre les Émotions des Clients',
  duration_minutes = 16
WHERE module_id = v_mod3_id AND slug = 'dimension-emotionnelle-cx';

-- ── Module 4 (new): Créer une Expérience Client de Qualité ───────────────────
--
-- This replaces the old fondamentaux-service-client (now deleted above).
-- Contains the two Module 4 video lessons from the Courses folder.
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (
  v_course_id,
  'creer-experience-client-qualite',
  'Créer une Expérience Client de Qualité',
  'Maîtrisez les techniques pour créer des interactions mémorables et gérer toutes les situations clients avec professionnalisme et efficacité.',
  4
)
ON CONFLICT (course_id, slug) DO UPDATE
  SET title = EXCLUDED.title,
      description = EXCLUDED.description,
      order_index = EXCLUDED.order_index
RETURNING id INTO v_mod4_new;

-- Module 4 – Lesson 1
INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview)
VALUES (
  v_mod4_new,
  'creer-interaction-qualite',
  'Créer une Interaction de Qualité',
  E'## Créer une Interaction de Qualité\n\nUne interaction de qualité repose sur trois piliers essentiels : la **préparation**, la **présence** et la **personnalisation**.\n\n### Les clés d''une interaction réussie\n- Accueillez chaque client comme s''il était votre seul client\n- Adaptez votre ton et votre langage au profil de votre interlocuteur\n- Anticipez les besoins avant qu''ils ne soient exprimés\n\n### La règle des 7 secondes\nLes premières impressions se forment en 7 secondes. Chaque interaction commence bien avant que le client prenne la parole.',
  '/videos/module-4-lecon-1-creer-interaction-qualite.mp4',
  20,
  1,
  false
)
ON CONFLICT (module_id, slug) DO UPDATE
  SET video_url        = EXCLUDED.video_url,
      title            = EXCLUDED.title,
      duration_minutes = EXCLUDED.duration_minutes;

-- Module 4 – Lesson 2
INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview)
VALUES (
  v_mod4_new,
  'gerer-situations-clients',
  'Gérer les Situations Clients',
  E'## Gérer les Situations Clients\n\nSavoir gérer des situations clients difficiles est une compétence clé qui distingue les équipes ordinaires des équipes d''excellence.\n\n### Les 4 étapes LEAD\n1. **Listen** — Écoutez sans interrompre\n2. **Empathize** — Validez les émotions du client\n3. **Apologize** — Présentez des excuses sincères si nécessaire\n4. **Deliver** — Proposez une solution concrète et tenez votre engagement\n\n### Les erreurs à éviter\n- Être défensif ou justifier l''erreur de l''entreprise\n- Promettre ce qu''on ne peut pas tenir\n- Transférer le client d''un agent à l''autre sans solution',
  '/videos/module-4-lecon-2-gerer-situations-clients.mp4',
  18,
  2,
  false
)
ON CONFLICT (module_id, slug) DO UPDATE
  SET video_url        = EXCLUDED.video_url,
      title            = EXCLUDED.title,
      duration_minutes = EXCLUDED.duration_minutes;

-- ── Module 5: Fix order_index (may have shifted) ──────────────────────────────
UPDATE modules
SET order_index = 5
WHERE course_id = v_course_id AND slug = 'outils-cx-petites-entreprises';

-- ── Update course total duration ──────────────────────────────────────────────
-- Actual timed content: ~94 minutes across 5 video lessons ≈ 2h; keep at 8h
-- to reflect the full course including text lessons and quizzes.
UPDATE courses
SET updated_at = now()
WHERE id = v_course_id;

END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT
  m.order_index,
  m.title        AS module_title,
  m.slug         AS module_slug,
  l.order_index  AS lesson_order,
  l.title        AS lesson_title,
  CASE WHEN l.video_url IS NOT NULL THEN '✓ video' ELSE '— text' END AS video
FROM modules m
JOIN lessons l ON l.module_id = m.id
JOIN courses c ON c.id = m.course_id
WHERE c.slug = 'comprendre-client-qualite-experience'
ORDER BY m.order_index, l.order_index;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (run manually if needed)
-- ═══════════════════════════════════════════════════════════════════════════
/*
DO $$
DECLARE v_course_id UUID;
BEGIN
  SELECT id INTO v_course_id FROM courses WHERE slug = 'comprendre-client-qualite-experience';

  -- Remove the new Module 4
  DELETE FROM modules WHERE course_id = v_course_id AND slug = 'creer-experience-client-qualite';

  -- Restore emotions to order 4
  UPDATE modules SET order_index = 4 WHERE course_id = v_course_id AND slug = 'comprendre-emotions-clients';

  -- Re-insert the old Module 3 (fondamentaux-service-client)
  -- (re-run the relevant section of migration 002)

  -- Clear video_url from lessons
  UPDATE lessons SET video_url = NULL
  WHERE module_id IN (
    SELECT id FROM modules WHERE course_id = v_course_id
      AND slug IN ('introduction-experience-client', 'parcours-client-moments-verite', 'comprendre-emotions-clients')
  ) AND slug IN ('quest-ce-que-la-cx', 'cartographie-parcours-client', 'dimension-emotionnelle-cx');
END $$;
*/
