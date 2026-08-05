-- ============================================================
-- Migration 029: Seed catalogues, course codes and the 15 learning paths
--
-- Every value below is transcribed VERBATIM from the ratified source:
--   public/Architecture_Catalogues_Parcours_XP-Client-Academy_V4.pdf
--     §3–§5  catalogues and formations
--     §6     professional paths (ordered)
--     §7     sector paths (socle commun + complements)
--     §8     formations × paths matrix (cross-check)
--     §10    backlog
--
-- Nothing is inferred. No path is invented. No recommendation is generated
-- (that is XPA-3). Reference data only — idempotent, safe to re-run.
--
-- ── Source contradiction, recorded not resolved ──────────────────────────
-- V4 §9.1 lists "codes existants" as C1-F1..C1-F3 · C2-F1..C2-F5 · C3-F1..C3-F8
-- (16 codes), omitting C2-F6. But §10 defines C2-F6 as codified-and-backlogged,
-- and §9.4 gives the next available C2 code as C2-F7 — which is only consistent
-- if C2-F6 is taken. All 17 codes are therefore seeded, with C2-F6 as 'backlog'
-- exactly as §10 states. Flagged in docs/xpa-2-report.md rather than silently
-- reconciled.
--
-- ── Launch status ───────────────────────────────────────────────────────
-- Every code is seeded 'undecided' EXCEPT C2-F6 ('backlog', stated by §10).
-- The « Lancement Soft » document defining the 7-course launch cohort is not in
-- the repository (decision register D-Q1), and launch status must not be
-- invented. Populating it is a separate, unblocked-later step.
-- ============================================================

-- ── 1. Catalogues (V4 §2, §3–§5) ─────────────────────────────────────────
insert into public.catalogues (code, title, objective, position) values
  ('C1', 'Fondations',
   'Acquérir les bases de l''expérience client et du service client', 1),
  ('C2', 'Intermédiaire',
   'Écouter, mesurer, manager et améliorer en continu', 2),
  ('C3', 'Avancé',
   'Concevoir, transformer et piloter la CX à l''échelle de l''entreprise', 3)
on conflict (code) do update
  set title = excluded.title, objective = excluded.objective,
      position = excluded.position, updated_at = now();

-- ── 2. Course codes (V4 §3, §4, §5, §10) ─────────────────────────────────
insert into public.course_codes (code, catalogue_code, canonical_title, objective, targets, position, status) values
  -- Catalogue 1 — Fondations
  ('C1-F1', 'C1', 'Fondamentaux de l''expérience client',
   'Comprendre les principes fondamentaux de la CX, le parcours client, les moments de vérité, les émotions et les principaux indicateurs.',
   'Tous les profils', 1, 'undecided'),
  ('C1-F2', 'C1', 'Fondamentaux du service client',
   'Développer les bonnes pratiques de communication et de gestion des interactions avec les clients.',
   'Conseillers, commerciaux, accueil, SAV, opérationnels terrain, managers de proximité, entrepreneurs', 2, 'undecided'),
  ('C1-F3', 'C1', 'Fondamentaux du service client digital',
   'Adapter sa communication aux canaux digitaux (email, chat, WhatsApp, réseaux sociaux, messageries).',
   'Conseillers, community managers, support digital, entrepreneurs', 3, 'undecided'),

  -- Catalogue 2 — Intermédiaire
  ('C2-F1', 'C2', 'Manager une équipe orientée client',
   'Développer les compétences du manager pour coacher, accompagner et faire progresser son équipe autour de l''expérience client.',
   'Managers, superviseurs, chefs d''équipe', 1, 'undecided'),
  ('C2-F2', 'C2', 'Mesurer l''expérience client',
   'Comprendre et utiliser les principaux indicateurs CX (CSAT, NPS, CES…), analyser les résultats et piloter les actions d''amélioration.',
   'Managers, qualité, marketing, produit, direction', 2, 'undecided'),
  ('C2-F3', 'C2', 'Piloter la Voix du Client (VoC)',
   'Structurer la collecte des retours clients, analyser les verbatims et transformer les enseignements en plans d''action.',
   'Managers, CX, marketing, produit, qualité', 3, 'undecided'),
  ('C2-F4', 'C2', 'Gérer les réclamations et transformer l''insatisfaction en opportunité',
   'Faire des réclamations une source d''amélioration continue et renforcer la confiance des clients.',
   'Conseillers expérimentés, managers, qualité', 4, 'undecided'),
  ('C2-F5', 'C2', 'Développer une culture client',
   'Mobiliser les équipes autour d''une vision commune de l''expérience client et diffuser les bons comportements dans l''organisation.',
   'Managers, RH, dirigeants, entrepreneurs', 5, 'undecided'),
  ('C2-F6', 'C2', 'Expérience digitale & omnicanale',
   'Offrir une expérience cohérente et sans couture sur l''ensemble des canaux, physiques comme digitaux.',
   'Digital, marketing, CX, direction', 6, 'backlog'),

  -- Catalogue 3 — Avancé
  ('C3-F1', 'C3', 'Customer Journey Mapping',
   'Cartographier le parcours client, identifier les moments de vérité et les irritants.',
   'CX, produit, marketing, qualité', 1, 'undecided'),
  ('C3-F2', 'C3', 'Customer Journey Design & Simplification',
   'Repenser les parcours, supprimer les frictions, simplifier les expériences et tester les produits et services comme un client.',
   'Produit, CX, innovation, opérations, marketing', 2, 'undecided'),
  ('C3-F3', 'C3', 'Service Design',
   'Concevoir des services centrés sur les besoins des clients et alignés avec les capacités de l''entreprise.',
   'Produit, innovation, CX', 3, 'undecided'),
  ('C3-F4', 'C3', 'Personas & segmentation client',
   'Construire des personas pertinents et mieux comprendre les besoins, attentes et comportements des segments de clientèle.',
   'Marketing, produit, CX', 4, 'undecided'),
  ('C3-F5', 'C3', 'Culture client au cœur de la stratégie',
   'Faire de l''expérience client un levier stratégique de transformation de l''entreprise.',
   'Direction, CX, managers seniors', 5, 'undecided'),
  ('C3-F6', 'C3', 'Outils CX & Vision Client 360°',
   'Découvrir les principaux outils permettant de centraliser, analyser et exploiter la connaissance client.',
   'CX, marketing, digital, DSI', 6, 'undecided'),
  ('C3-F7', 'C3', 'L''intelligence artificielle au service de l''expérience client',
   'Utiliser l''IA pour améliorer la connaissance client, personnaliser les interactions et gagner en efficacité opérationnelle.',
   'Tous les métiers impliqués dans la transformation CX', 7, 'undecided'),
  ('C3-F8', 'C3', 'Démontrer le ROI de l''expérience client',
   'Construire un business case, mesurer les bénéfices des initiatives CX et convaincre les décideurs.',
   'Direction, CX, finance, managers', 8, 'undecided')
on conflict (code) do update
  set catalogue_code  = excluded.catalogue_code,
      canonical_title = excluded.canonical_title,
      objective       = excluded.objective,
      targets         = excluded.targets,
      position        = excluded.position,
      updated_at      = now();
      -- status deliberately NOT overwritten: re-running must never clobber a
      -- launch decision recorded later.

-- ── 3. Professional paths — axe « qui je suis » (V4 §6) ──────────────────
insert into public.learning_paths (code, kind, title, objective, note, position) values
  ('PM-CONS', 'professional', 'Parcours Conseiller',
   'Développer les compétences nécessaires pour offrir une expérience client de qualité lors de chaque interaction.', null, 1),
  ('PM-OPT', 'professional', 'Parcours Opérationnel & Terrain',
   'Donner les réflexes essentiels de la relation client aux personnes dont le contact client n''est pas le métier premier : agents de transit, transport, douane, livreurs, techniciens d''intervention, agents de guichet, personnel de terrain.',
   'Cadrage spécifique : ce parcours ne vise pas une carrière CX, mais la maîtrise des moments où l''apprenant parle à un client dans le cadre d''un autre métier. Formats courts, ultra concrets, zéro jargon. C''est le parcours privilégié pour les ventes B2B à l''échelle d''une entreprise entière (tout le personnel opérationnel).', 2),
  ('PM-COM', 'professional', 'Parcours Commercial',
   'Intégrer l''expérience client dans la démarche de vente : fidéliser, développer la relation et faire de chaque interaction commerciale un moment de vérité positif.', null, 3),
  ('PM-MAN', 'professional', 'Parcours Manager',
   'Accompagner les équipes et piloter l''amélioration continue de l''expérience client.', null, 4),
  ('PM-QVC', 'professional', 'Parcours Qualité & VoC',
   'Structurer l''écoute client, mesurer l''expérience et transformer les retours en plans d''action concrets.', null, 5),
  ('PM-RH', 'professional', 'Parcours RH & Culture client',
   'Diffuser la culture client dans l''organisation : recrutement, intégration, formation continue et mobilisation des équipes.', null, 6),
  ('PM-DIG', 'professional', 'Parcours Digital',
   'Maîtriser la relation client sur les canaux digitaux et exploiter les outils numériques au service de l''expérience.', null, 7),
  ('PM-PRO', 'professional', 'Parcours Produit & Marketing',
   'Concevoir des produits, services et parcours centrés sur les besoins réels des clients.', null, 8),
  ('PM-DIR', 'professional', 'Parcours Direction & Entrepreneurs',
   'Faire de l''expérience client un levier de différenciation, de croissance et de transformation.', null, 9)
on conflict (code) do update
  set kind = excluded.kind, title = excluded.title, objective = excluded.objective,
      note = excluded.note, position = excluded.position, updated_at = now();

-- ── 4. Sector paths — axe « où je travaille » (V4 §7) ────────────────────
-- Socle commun sectoriel for every sector path: C1-F1 + C1-F2.
insert into public.learning_paths (code, kind, title, objective, note, position) values
  ('SEC-TEL', 'sector', 'Télécoms & Mobile Money',
   'Volumes d''interactions massifs, canaux multiples (boutique, centre d''appels, USSD, applications), litiges de transactions, churn élevé, agents et distributeurs de terrain.',
   'Acheteurs types : Opérateurs télécoms, émetteurs de Mobile Money, réseaux de distribution, centres de contacts.', 1),
  ('SEC-BQA', 'sector', 'Banque & Assurance',
   'Confiance et conformité au cœur de la relation, parcours longs (crédit, sinistre), digitalisation des agences, clientèle multi-segments (particuliers, PME, corporate).',
   'Acheteurs types : Banques, compagnies d''assurance, microfinance, courtiers.', 2),
  ('SEC-LOG', 'sector', 'Logistique, Transport & Douane',
   'Personnel majoritairement opérationnel (transit, douane, transport, entrepôt) en contact client sans fonction relation client dédiée ; enjeux de délais, de litiges et de communication proactive sur l''avancement des dossiers.',
   'Parcours PM-OPT (Opérationnel & Terrain) recommandé comme porte d''entrée pour l''ensemble du personnel. Acheteurs types : Transitaires, transporteurs, commissionnaires en douane, plateformes logistiques, entreprises de livraison. Premier secteur validé par une demande B2B concrète.', 3),
  ('SEC-COM', 'sector', 'Commerce & PME',
   'Relation de proximité, fidélisation locale, concurrence informelle, ressources limitées : besoin de pratiques simples applicables immédiatement, souvent sans service client dédié.',
   'Acheteurs types : Commerces, distributeurs, e-commerçants, PME de services, entrepreneurs.', 4),
  ('SEC-SAN', 'sector', 'Santé',
   'Patients en situation de vulnérabilité, dimension émotionnelle forte, files d''attente et orientation, personnel soignant et administratif en première ligne sans formation relation client.',
   'Parcours PM-OPT (Opérationnel & Terrain) recommandé pour le personnel d''accueil et soignant. Acheteurs types : Cliniques, hôpitaux, laboratoires, pharmacies, structures de santé privées et publiques.', 5),
  ('SEC-ADM', 'sector', 'Administration publique',
   'Usagers captifs mais exigeants, image du service public à transformer, guichets et démarches en cours de digitalisation, agents peu sensibilisés à la notion d''expérience usager.',
   'Parcours PM-OPT (Opérationnel & Terrain) recommandé pour les agents de guichet. Acheteurs types : Administrations, agences publiques, collectivités, services aux usagers.', 6)
on conflict (code) do update
  set kind = excluded.kind, title = excluded.title, objective = excluded.objective,
      note = excluded.note, position = excluded.position, updated_at = now();

-- ── 5. Path ↔ course relationships (V4 §6, §7; cross-checked vs §8) ──────
-- C1-F1 is the socle commun of EVERY path and is always at position 1 (V4 §2,
-- §9.3, §11). Sector paths additionally carry C1-F2 as part of the socle.
insert into public.learning_path_courses (path_code, course_code, position, is_socle) values
  -- PM-CONS
  ('PM-CONS', 'C1-F1', 1, true),
  ('PM-CONS', 'C1-F2', 2, false),
  ('PM-CONS', 'C1-F3', 3, false),
  ('PM-CONS', 'C2-F4', 4, false),
  -- PM-OPT
  ('PM-OPT',  'C1-F1', 1, true),
  ('PM-OPT',  'C1-F2', 2, false),
  ('PM-OPT',  'C2-F4', 3, false),
  -- PM-COM
  ('PM-COM',  'C1-F1', 1, true),
  ('PM-COM',  'C1-F2', 2, false),
  ('PM-COM',  'C2-F4', 3, false),
  ('PM-COM',  'C3-F4', 4, false),
  -- PM-MAN
  ('PM-MAN',  'C1-F1', 1, true),
  ('PM-MAN',  'C2-F1', 2, false),
  ('PM-MAN',  'C2-F2', 3, false),
  ('PM-MAN',  'C2-F3', 4, false),
  ('PM-MAN',  'C2-F5', 5, false),
  -- PM-QVC
  ('PM-QVC',  'C1-F1', 1, true),
  ('PM-QVC',  'C2-F2', 2, false),
  ('PM-QVC',  'C2-F3', 3, false),
  ('PM-QVC',  'C2-F4', 4, false),
  ('PM-QVC',  'C3-F1', 5, false),
  -- PM-RH
  ('PM-RH',   'C1-F1', 1, true),
  ('PM-RH',   'C2-F5', 2, false),
  ('PM-RH',   'C2-F1', 3, false),
  ('PM-RH',   'C3-F5', 4, false),
  -- PM-DIG
  ('PM-DIG',  'C1-F1', 1, true),
  ('PM-DIG',  'C1-F3', 2, false),
  ('PM-DIG',  'C3-F6', 3, false),
  ('PM-DIG',  'C3-F7', 4, false),
  -- PM-PRO
  ('PM-PRO',  'C1-F1', 1, true),
  ('PM-PRO',  'C2-F2', 2, false),
  ('PM-PRO',  'C2-F3', 3, false),
  ('PM-PRO',  'C3-F1', 4, false),
  ('PM-PRO',  'C3-F2', 5, false),
  ('PM-PRO',  'C3-F4', 6, false),
  ('PM-PRO',  'C3-F3', 7, false),
  -- PM-DIR
  ('PM-DIR',  'C1-F1', 1, true),
  ('PM-DIR',  'C2-F5', 2, false),
  ('PM-DIR',  'C3-F5', 3, false),
  ('PM-DIR',  'C3-F6', 4, false),
  ('PM-DIR',  'C3-F7', 5, false),
  ('PM-DIR',  'C3-F8', 6, false),

  -- SEC-TEL — socle (C1-F1 + C1-F2) + complements
  ('SEC-TEL', 'C1-F1', 1, true),
  ('SEC-TEL', 'C1-F2', 2, true),
  ('SEC-TEL', 'C1-F3', 3, false),
  ('SEC-TEL', 'C2-F4', 4, false),
  ('SEC-TEL', 'C2-F2', 5, false),
  ('SEC-TEL', 'C2-F1', 6, false),
  -- SEC-BQA
  ('SEC-BQA', 'C1-F1', 1, true),
  ('SEC-BQA', 'C1-F2', 2, true),
  ('SEC-BQA', 'C1-F3', 3, false),
  ('SEC-BQA', 'C2-F4', 4, false),
  ('SEC-BQA', 'C2-F2', 5, false),
  ('SEC-BQA', 'C3-F1', 6, false),
  -- SEC-LOG
  ('SEC-LOG', 'C1-F1', 1, true),
  ('SEC-LOG', 'C1-F2', 2, true),
  ('SEC-LOG', 'C2-F4', 3, false),
  ('SEC-LOG', 'C2-F5', 4, false),
  -- SEC-COM
  ('SEC-COM', 'C1-F1', 1, true),
  ('SEC-COM', 'C1-F2', 2, true),
  ('SEC-COM', 'C1-F3', 3, false),
  ('SEC-COM', 'C2-F4', 4, false),
  ('SEC-COM', 'C2-F5', 5, false),
  -- SEC-SAN
  ('SEC-SAN', 'C1-F1', 1, true),
  ('SEC-SAN', 'C1-F2', 2, true),
  ('SEC-SAN', 'C2-F4', 3, false),
  ('SEC-SAN', 'C2-F5', 4, false),
  -- SEC-ADM
  ('SEC-ADM', 'C1-F1', 1, true),
  ('SEC-ADM', 'C1-F2', 2, true),
  ('SEC-ADM', 'C1-F3', 3, false),
  ('SEC-ADM', 'C2-F5', 4, false)
on conflict (path_code, course_code) do update
  set position = excluded.position, is_socle = excluded.is_socle;

-- ── 6. Integrity assertions (fail loudly if the seed drifts) ─────────────
do $$
declare
  n_paths   integer;
  n_no_f1   integer;
  n_orphan  integer;
begin
  select count(*) into n_paths from public.learning_paths;
  if n_paths <> 15 then
    raise exception 'expected 15 learning paths (9 professional + 6 sector), found %', n_paths;
  end if;

  -- V4 §9.3: C1-F1 is the recommended prerequisite of EVERY path, first position.
  select count(*) into n_no_f1
  from public.learning_paths p
  where not exists (
    select 1 from public.learning_path_courses lpc
    where lpc.path_code = p.code and lpc.course_code = 'C1-F1' and lpc.position = 1
  );
  if n_no_f1 > 0 then
    raise exception '% path(s) do not start with C1-F1 at position 1', n_no_f1;
  end if;

  -- Paths must never reference a code that does not exist in the registry.
  select count(*) into n_orphan
  from public.learning_path_courses lpc
  where not exists (select 1 from public.course_codes cc where cc.code = lpc.course_code);
  if n_orphan > 0 then
    raise exception '% path/course row(s) reference an unknown course code', n_orphan;
  end if;
end $$;
