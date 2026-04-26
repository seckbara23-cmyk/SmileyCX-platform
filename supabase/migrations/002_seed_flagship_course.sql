-- ═══════════════════════════════════════════════════════════════════════════
-- SmileyCX — Flagship Course Seed
-- Inserts the main course "Comprendre le Client" with all modules, lessons,
-- and quizzes. Safe to run multiple times (uses ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_course_id UUID;
  v_mod1_id   UUID;
  v_mod2_id   UUID;
  v_mod3_id   UUID;
  v_mod4_id   UUID;
  v_mod5_id   UUID;
  v_quiz_id   UUID;
  v_les_id    UUID;
BEGIN

-- ── Course ───────────────────────────────────────────────────────────────────
INSERT INTO courses (slug, title, description, price, currency, is_published, is_free, level, duration_hours, language)
VALUES (
  'comprendre-client-qualite-experience',
  'Comprendre le Client pour Délivrer une Expérience de Qualité',
  'Une formation complète et pratique pour maîtriser les fondamentaux de l''expérience client. Apprenez à comprendre vos clients, à cartographier leur parcours, et à créer des interactions mémorables qui fidélisent et différencient votre entreprise.',
  45000, 'XOF', true, false, 'beginner', 8, 'fr'
)
ON CONFLICT (slug) DO UPDATE SET is_published = true
RETURNING id INTO v_course_id;

-- ── Module 1 ─────────────────────────────────────────────────────────────────
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (v_course_id, 'introduction-experience-client', 'Introduction à l''Expérience Client (CX)',
  'Posez les bases : qu''est-ce que l''expérience client, pourquoi est-ce un enjeu stratégique, et comment les attentes clients ont-elles évolué ?', 1)
ON CONFLICT (course_id, slug) DO UPDATE SET order_index = 1
RETURNING id INTO v_mod1_id;

-- Lesson 1.1 — preview
INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview)
VALUES (v_mod1_id, 'quest-ce-que-la-cx',
  'Qu''est-ce que l''Expérience Client ? Définitions & Concepts Clés',
  E'## Définition de l''Expérience Client\n\nL''expérience client (CX) désigne la **perception globale** qu''un client développe à travers toutes ses interactions avec une entreprise — avant, pendant et après l''achat.\n\n### Pourquoi c''est important ?\n- 86 % des clients sont prêts à payer plus pour une meilleure expérience\n- Une expérience positive génère de la fidélité et du bouche-à-oreille\n- L''expérience client est devenu le principal différenciateur concurrentiel\n\n### Les 3 dimensions de la CX\n1. **Cognitive** — ce que le client pense de vous\n2. **Émotionnelle** — ce qu''il ressent lors de l''interaction\n3. **Comportementale** — ce qu''il fait ensuite (revient-il ? vous recommande-t-il ?)',
  null, 18, 1, true)
ON CONFLICT (module_id, slug) DO NOTHING;

-- Lesson 1.2
INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview)
VALUES (v_mod1_id, 'pourquoi-cx-compte',
  'Pourquoi la CX est un Avantage Compétitif',
  E'## L''impact business de la CX\n\nDes études montrent que les entreprises leaders en CX surpassent leurs concurrents de **4 à 8 %** en termes de revenus.\n\n### Chiffres clés\n- Acquérir un nouveau client coûte **5 à 7 fois** plus cher que de fidéliser un client existant\n- Une augmentation de 5 % de la fidélisation peut augmenter les profits de **25 à 95 %**\n- Les clients qui vivent une excellente expérience dépensent en moyenne **140 % de plus**',
  null, 15, 2, false)
ON CONFLICT (module_id, slug) DO NOTHING;

-- Lesson 1.3
INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview)
VALUES (v_mod1_id, 'evolution-attentes-clients',
  'L''Évolution des Attentes Clients à l''Ère Digitale',
  E'## Comment les attentes ont évolué\n\nAvec la révolution digitale, les clients sont devenus plus **exigeants, informés et connectés** que jamais.\n\n### Les nouvelles exigences\n- **Instantanéité** : réponse en quelques minutes, pas en 48h\n- **Personnalisation** : être reconnu et traité de façon unique\n- **Cohérence** : même qualité sur tous les canaux\n- **Transparence** : honnêteté sur les prix, délais et problèmes',
  null, 12, 3, false)
ON CONFLICT (module_id, slug) DO NOTHING;

-- Quiz Module 1
INSERT INTO quizzes (module_id, title, passing_score)
VALUES (v_mod1_id, 'Quiz — Module 1 : Introduction à la CX', 70)
ON CONFLICT DO NOTHING
RETURNING id INTO v_quiz_id;

IF v_quiz_id IS NOT NULL THEN
  INSERT INTO quiz_questions (quiz_id, question, options, correct_answer, explanation, order_index) VALUES
    (v_quiz_id, 'Quelle est la définition la plus complète de l''expérience client ?',
      '["La qualité du service après-vente","La perception globale d''un client à travers toutes ses interactions avec l''entreprise","Le niveau de satisfaction mesuré par questionnaire","L''ergonomie d''un site web ou d''une application"]',
      1, 'L''expérience client englobe toutes les interactions, pas seulement le service après-vente ou un point de contact spécifique.', 1),
    (v_quiz_id, 'De combien coûte l''acquisition d''un nouveau client par rapport à la fidélisation ?',
      '["2 fois plus cher","5 à 7 fois plus cher","10 fois plus cher","Le même prix"]',
      1, 'Les études montrent qu''acquérir un nouveau client coûte entre 5 et 7 fois plus cher que de fidéliser un client existant.', 2),
    (v_quiz_id, 'Quelles sont les 3 dimensions de l''expérience client ?',
      '["Visuelle, auditive, olfactive","Avant-vente, vente, après-vente","Cognitive, émotionnelle, comportementale","Produit, prix, promotion"]',
      2, 'Les 3 dimensions sont : cognitive (ce que le client pense), émotionnelle (ce qu''il ressent), comportementale (ce qu''il fait).', 3);
END IF;

-- ── Module 2 ─────────────────────────────────────────────────────────────────
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (v_course_id, 'parcours-client-moments-verite', 'Parcours Client & Moments de Vérité',
  'Apprenez à visualiser et analyser le parcours client, identifier les points de contact critiques et transformer les moments de vérité en opportunités de différenciation.', 2)
ON CONFLICT (course_id, slug) DO UPDATE SET order_index = 2
RETURNING id INTO v_mod2_id;

INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview) VALUES
  (v_mod2_id, 'cartographie-parcours-client', 'Cartographier le Parcours Client', 'Contenu de leçon — à compléter.', null, 22, 1, false),
  (v_mod2_id, 'points-de-contact-canaux', 'Points de Contact & Canaux d''Interaction', 'Contenu de leçon — à compléter.', null, 18, 2, false),
  (v_mod2_id, 'moments-de-verite', 'Les Moments de Vérité — Le Concept de Jan Carlzon', 'Contenu de leçon — à compléter.', null, 16, 3, false),
  (v_mod2_id, 'points-douleur-opportunites', 'Identifier les Points de Douleur et les Opportunités', 'Contenu de leçon — à compléter.', null, 20, 4, false)
ON CONFLICT (module_id, slug) DO NOTHING;

-- ── Module 3 ─────────────────────────────────────────────────────────────────
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (v_course_id, 'fondamentaux-service-client', 'Les Fondamentaux du Service Client',
  'Maîtrisez les techniques essentielles d''un service client d''excellence : écoute active, empathie, gestion des situations difficiles et communication efficace.', 3)
ON CONFLICT (course_id, slug) DO UPDATE SET order_index = 3
RETURNING id INTO v_mod3_id;

INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview) VALUES
  (v_mod3_id, 'difference-service-experience', 'La Différence entre Service et Expérience', 'Contenu — à compléter.', null, 14, 1, false),
  (v_mod3_id, 'ecoute-active-empathie', 'Écoute Active & Empathie', 'Contenu — à compléter.', null, 20, 2, false),
  (v_mod3_id, 'gestion-clients-difficiles', 'Gérer les Clients Difficiles', 'Contenu — à compléter.', null, 18, 3, false),
  (v_mod3_id, 'communication-efficace', 'Bonnes Pratiques de Communication', 'Contenu — à compléter.', null, 15, 4, false)
ON CONFLICT (module_id, slug) DO NOTHING;

-- ── Module 4 ─────────────────────────────────────────────────────────────────
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (v_course_id, 'comprendre-emotions-clients', 'Comprendre les Émotions des Clients',
  'Explorez la dimension émotionnelle de l''expérience client et apprenez à créer des connexions authentiques qui transforment les clients en ambassadeurs.', 4)
ON CONFLICT (course_id, slug) DO UPDATE SET order_index = 4
RETURNING id INTO v_mod4_id;

INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview) VALUES
  (v_mod4_id, 'dimension-emotionnelle-cx', 'La Dimension Émotionnelle de la CX', 'Contenu — à compléter.', null, 16, 1, false),
  (v_mod4_id, 'cartographie-emotions', 'Cartographie des Émotions Clients', 'Contenu — à compléter.', null, 18, 2, false),
  (v_mod4_id, 'connexions-emotionnelles', 'Créer des Connexions Émotionnelles Durables', 'Contenu — à compléter.', null, 20, 3, false)
ON CONFLICT (module_id, slug) DO NOTHING;

-- ── Module 5 ─────────────────────────────────────────────────────────────────
INSERT INTO modules (course_id, slug, title, description, order_index)
VALUES (v_course_id, 'outils-cx-petites-entreprises', 'Outils CX Essentiels pour les Petites Entreprises',
  'Découvrez les indicateurs clés (NPS, CSAT, CES), des méthodes simples de collecte de feedback et comment construire une culture orientée client dans votre organisation.', 5)
ON CONFLICT (course_id, slug) DO UPDATE SET order_index = 5
RETURNING id INTO v_mod5_id;

INSERT INTO lessons (module_id, slug, title, content, video_url, duration_minutes, order_index, is_preview) VALUES
  (v_mod5_id, 'nps-csat-ces', 'NPS, CSAT et CES — Comprendre les Indicateurs', 'Contenu — à compléter.', null, 20, 1, false),
  (v_mod5_id, 'collecte-feedback', 'Méthodes Simples de Collecte de Feedback', 'Contenu — à compléter.', null, 16, 2, false),
  (v_mod5_id, 'culture-client', 'Construire une Culture Orientée Client', 'Contenu — à compléter.', null, 18, 3, false)
ON CONFLICT (module_id, slug) DO NOTHING;

END $$;

-- Verify
SELECT c.title, m.title AS module, m.order_index,
       COUNT(l.id) AS lesson_count
FROM courses c
JOIN modules m ON m.course_id = c.id
LEFT JOIN lessons l ON l.module_id = m.id
WHERE c.slug = 'comprendre-client-qualite-experience'
GROUP BY c.title, m.title, m.order_index
ORDER BY m.order_index;
