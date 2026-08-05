-- ============================================================
-- Migration 033: Voice Practice productization (XPA-5)
--
-- Source of truth: public/Voice-Training_F2_EN (1).pdf (the five F2 scenarios)
--                  plus the lesson set already authored in C1-F2, where the
--                  content team marked every voice lesson with a 🎤 in its title.
--
-- STRICTLY ADDITIVE + one corrective re-link. Nothing is rebuilt:
--   * ai_scenarios / ai_sessions / ai_turns / ai_feedback  -> reused as-is
--   * competency engine + Claude coach                     -> reused as-is
--   * ElevenLabs integration                               -> untouched
--   * lesson_progress                                      -> reused, not replaced
--
-- ── What this migration does ────────────────────────────────────────────
-- 1. Adds `difficulty` and `order_index` to ai_scenarios (nullable/defaulted).
-- 2. Re-links the existing Ibrahima scenario to the lesson the source document
--    actually specifies. It is currently attached to a C1-F1 lesson, which is a
--    pilot-era misconfiguration.
-- 3. Seeds the four remaining F2 scenarios, UNPUBLISHED and without an agent id,
--    because an ElevenLabs agent must be created per persona first. They stay
--    invisible to learners until an administrator sets the agent and publishes.
--
-- ── What it deliberately does NOT do ────────────────────────────────────
-- * No agent id is invented. agent_id stays NULL for the four new scenarios.
-- * No prompt text is invented: prompt_template is left NULL and authored in
--   the admin UI, per the PDF's prompt-engineering rules.
-- * No session, turn, score or feedback row is modified. The 11 existing pilot
--   sessions reference scenario_id, not lesson_id, so the re-link in (2)
--   preserves every one of them.
-- ============================================================

-- ── 1. Scenario metadata the admin UI needs ──────────────────────────────
alter table public.ai_scenarios
  add column if not exists difficulty text
    check (difficulty is null or difficulty in ('facile', 'intermediaire', 'avance'));

alter table public.ai_scenarios
  add column if not exists order_index integer not null default 0;

comment on column public.ai_scenarios.difficulty is
  'XPA-5. Learner-facing difficulty label. Nullable: existing scenarios keep no label until an administrator sets one.';
comment on column public.ai_scenarios.order_index is
  'XPA-5. Ordering when a lesson carries more than one voice exercise.';

-- ── 2. Re-link Ibrahima to the lesson the source document specifies ──────
-- The F2 document places Ibrahima in Training F2, Module 3, Lesson 2
-- ("Garder son calme et désamorcer la tension" — flagged 🎤 by the content
-- team). It is currently attached to a lesson in C1-F1, which is not where any
-- F2 exercise belongs.
--
-- Matching is by lesson TITLE within the correct course, resolved through the
-- immutable course code, so this does not depend on any hardcoded uuid.
do $$
declare
  target_lesson uuid;
  moved         integer;
begin
  select l.id into target_lesson
  from public.lessons l
  join public.modules m on m.id = l.module_id
  join public.courses c on c.id = m.course_id
  where c.code = 'C1-F2'
    and m.order_index = 3
    and l.title like '%Garder son calme%'
  limit 1;

  if target_lesson is null then
    raise notice 'XPA-5: target lesson for Ibrahima not found — scenario left unchanged';
  else
    update public.ai_scenarios
       set lesson_id  = target_lesson,
           difficulty = coalesce(difficulty, 'intermediaire'),
           updated_at = now()
     where slug = 'ibrahima-double-facturation'
       and lesson_id is distinct from target_lesson;

    get diagnostics moved = row_count;
    raise notice 'XPA-5: Ibrahima re-linked to F2 M3 L2 (rows: %)', moved;
  end if;
end $$;

-- ── 3. Seed the four remaining F2 scenarios ──────────────────────────────
-- UNPUBLISHED and agent-less by design: each persona needs its own ElevenLabs
-- agent, configured per the prompt-engineering rules in the source document
-- (strict example-based criteria, no self-resolution including disguised closed
-- questions, bounded re-prompts, conditional warm closings). Publishing before
-- the agent exists would surface a broken exercise to learners.
--
-- Situation and objectives are transcribed from the source document. Nothing is
-- invented; the bot opening lines and system prompts are authored in the admin
-- UI, where they can be iterated without a deploy.
do $$
declare
  s record;
  target uuid;
  seeded integer := 0;
begin
  for s in
    select * from (values
      ('amara-forfait-incompris', 'Amara — le client qui ne comprend pas', 'Amara',
       2, '%Reformuler%',
       'Amara a reçu un SMS annonçant un changement de forfait. Il ne comprend pas ce que cela signifie ni ce qu''il doit faire.',
       '["Reformuler la préoccupation d''Amara avant de répondre","Utiliser un langage simple","Faire en sorte que le client se sente compris"]'::jsonb,
       'facile'),
      ('fatou-mobile-money-bloque', 'Fatou — la cliente frustrée', 'Fatou',
       2, '%mots qui apaisent%',
       'Fatou attend depuis 3 jours le déblocage de son compte Mobile Money. Elle a déjà appelé deux fois sans résultat.',
       '["Éviter les formulations négatives","Reconnaître la frustration avant de proposer une solution","Garder un ton calme et bienveillant"]'::jsonb,
       'intermediaire'),
      ('kader-remboursement-hors-contrat', 'Kader — le client insistant', 'Kader',
       3, '%Dire non%',
       'Kader demande un remboursement qui n''est pas couvert par son contrat. Il insiste et argumente.',
       '["Dire non clairement et fermement, sans agressivité","Expliquer la raison sans blâmer le client","Proposer une alternative si possible"]'::jsonb,
       'avance'),
      ('awa-reclamation-consommation', 'Awa — la boucle F1 vers F2', 'Awa',
       4, '%réclamation%',
       'Awa rappelle au sujet de sa réclamation sur sa consommation. Elle a déjà appelé la semaine dernière et personne ne l''a rappelée.',
       '["Accueillir la cliente sans se justifier","Faire preuve d''une empathie sincère, pas seulement formelle","Prendre un engagement précis"]'::jsonb,
       'avance')
    ) as t(slug, title, persona, module_order, lesson_match, situation, objectives, difficulty)
  loop
    select l.id into target
    from public.lessons l
    join public.modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
    where c.code = 'C1-F2'
      and m.order_index = s.module_order
      and l.title like s.lesson_match
    limit 1;

    if target is null then
      raise notice 'XPA-5: lesson not found for % — skipped', s.slug;
      continue;
    end if;

    insert into public.ai_scenarios
      (lesson_id, slug, title, persona_name, language, situation, objectives,
       provider, agent_id, is_published, difficulty, order_index)
    values
      (target, s.slug, s.title, s.persona, 'fr', s.situation, s.objectives,
       'elevenlabs', null, false, s.difficulty, 0)
    on conflict (slug) do nothing;

    if found then seeded := seeded + 1; end if;
  end loop;

  raise notice 'XPA-5: % scenario(s) seeded (unpublished, awaiting agent id)', seeded;
end $$;

-- ── 4. Verification ──────────────────────────────────────────────────────
do $$
declare
  n_total     integer;
  n_published integer;
  n_no_agent  integer;
begin
  select count(*) into n_total from public.ai_scenarios;
  select count(*) into n_published from public.ai_scenarios where is_published;
  select count(*) into n_no_agent from public.ai_scenarios where is_published and agent_id is null;

  -- A published scenario without an agent would render a broken exercise.
  if n_no_agent > 0 then
    raise exception '% published scenario(s) have no ElevenLabs agent', n_no_agent;
  end if;

  raise notice 'XPA-5: % scenarios total, % published', n_total, n_published;
end $$;

-- ============================================================
-- ROLLBACK (manual):
--   delete from public.ai_scenarios
--    where slug in ('amara-forfait-incompris','fatou-mobile-money-bloque',
--                   'kader-remboursement-hors-contrat','awa-reclamation-consommation')
--      and not exists (select 1 from public.ai_sessions s where s.scenario_id = ai_scenarios.id);
--   alter table public.ai_scenarios drop column if exists order_index;
--   alter table public.ai_scenarios drop column if exists difficulty;
--   -- Ibrahima's lesson_id re-link is intentionally NOT auto-reverted: the
--   -- original placement was the misconfiguration.
-- No session, turn, score or feedback row is affected by any of the above.
-- ============================================================
