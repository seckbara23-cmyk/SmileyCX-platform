-- ============================================================
-- Migration 025: AI Coach foundation (Phase 2A)
--
-- Source of truth:
--   docs/architecture/AI_PRACTICE_ENGINE_PHASE_2_COACH.md  (§3 database evolution)
--
-- Additive only. No existing table, column, policy, or data is modified,
-- except additive columns on ai_scenarios / ai_sessions.
--
-- New tables (activating what Phase 1 deferred):
--   ai_competencies    — global competency catalog + deterministic lexicons
--   ai_rubrics         — per-scenario competency weighting/guidance
--   ai_scores          — per-(session, competency, source) scores
--   ai_recommendations — personalized next steps (used from Phase 2B on)
--
-- Additive columns:
--   ai_scenarios.briefing               (jsonb — coach briefing config)
--   ai_scenarios.coach_prompt_overrides (jsonb — Phase 2B prompt tuning)
--   ai_sessions.engine_signals          (jsonb — deterministic engine output)
--
-- NO Claude/LLM anywhere in Phase 2A: scores written here come from the
-- deterministic Competency Engine (source = 'engine').
--
-- RLS mirrors migration 024's pattern:
--   - catalog tables readable when active/published (labels only, no secrets)
--   - scores/recommendations: no anon SELECT; authenticated learners read
--     only their own rows; writes via service-role server actions; admin all.
-- ============================================================

-- ── ai_competencies ───────────────────────────────────────────────────────────
create table if not exists public.ai_competencies (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,
  label_fr        text not null,
  description_fr  text,
  anchor_notes_fr text,                                -- what a 3 / 7 / 9 looks like (Phase 2B calibration)
  signals         jsonb not null default '{}'::jsonb,  -- deterministic lexicons (admin-tunable)
  is_active       boolean not null default true,
  order_index     integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists ai_competencies_updated_at on public.ai_competencies;
create trigger ai_competencies_updated_at
  before update on public.ai_competencies
  for each row execute procedure public.ai_scenarios_set_updated_at();

-- ── ai_rubrics ────────────────────────────────────────────────────────────────
create table if not exists public.ai_rubrics (
  id             uuid primary key default gen_random_uuid(),
  scenario_id    uuid not null references public.ai_scenarios(id) on delete cascade,
  competency_key text not null references public.ai_competencies(key) on delete cascade,
  weight         numeric not null default 1,
  guidance_fr    text,
  created_at     timestamptz not null default now(),
  unique (scenario_id, competency_key)
);

create index if not exists ai_rubrics_scenario_idx on public.ai_rubrics(scenario_id);

-- ── ai_scores ─────────────────────────────────────────────────────────────────
create table if not exists public.ai_scores (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.ai_sessions(id) on delete cascade,
  competency_key      text not null references public.ai_competencies(key) on delete cascade,
  score               integer not null check (score between 0 and 10),
  source              text not null default 'engine' check (source in ('engine', 'claude')),
  evidence_fr         text,
  evidence_turn_index integer,
  created_at          timestamptz not null default now(),
  unique (session_id, competency_key, source)
);

create index if not exists ai_scores_session_idx on public.ai_scores(session_id);
create index if not exists ai_scores_competency_idx on public.ai_scores(competency_key, created_at);

-- ── ai_recommendations ────────────────────────────────────────────────────────
create table if not exists public.ai_recommendations (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references public.ai_sessions(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  anon_id    uuid,
  type       text not null check (type in ('lesson', 'scenario', 'goal')),
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'active' check (status in ('active', 'done', 'dismissed')),
  created_at timestamptz not null default now(),
  constraint ai_recommendations_identity check (
    (user_id is not null and anon_id is null)
    or (user_id is null and anon_id is not null)
  )
);

create index if not exists ai_recommendations_user_idx on public.ai_recommendations(user_id);
create index if not exists ai_recommendations_anon_idx on public.ai_recommendations(anon_id);

-- ── Additive columns on existing tables ───────────────────────────────────────
alter table public.ai_scenarios add column if not exists briefing jsonb;
alter table public.ai_scenarios add column if not exists coach_prompt_overrides jsonb;
alter table public.ai_sessions  add column if not exists engine_signals jsonb;

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.ai_competencies    enable row level security;
alter table public.ai_rubrics         enable row level security;
alter table public.ai_scores          enable row level security;
alter table public.ai_recommendations enable row level security;

-- ai_competencies: labels/lexicons are learner-facing content config — readable
-- when active; writes via admin only.
drop policy if exists "ai_competencies_select_active" on public.ai_competencies;
create policy "ai_competencies_select_active" on public.ai_competencies
  for select using (is_active = true or public.is_platform_admin());

drop policy if exists "ai_competencies_admin" on public.ai_competencies;
create policy "ai_competencies_admin" on public.ai_competencies
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ai_rubrics: readable when the parent scenario is published; admin writes.
drop policy if exists "ai_rubrics_select_published" on public.ai_rubrics;
create policy "ai_rubrics_select_published" on public.ai_rubrics
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.ai_scenarios s
      where s.id = ai_rubrics.scenario_id and s.is_published = true
    )
  );

drop policy if exists "ai_rubrics_admin" on public.ai_rubrics;
create policy "ai_rubrics_admin" on public.ai_rubrics
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ai_scores: authenticated learners read only their own sessions' scores.
-- No anon SELECT (pilot reads go through validated server actions).
drop policy if exists "ai_scores_select_own" on public.ai_scores;
create policy "ai_scores_select_own" on public.ai_scores
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_scores.session_id
        and s.user_id is not null
        and s.user_id = auth.uid()
    )
  );

-- ai_recommendations: same ownership shape.
drop policy if exists "ai_recommendations_select_own" on public.ai_recommendations;
create policy "ai_recommendations_select_own" on public.ai_recommendations
  for select using (
    public.is_platform_admin()
    or (user_id is not null and user_id = auth.uid())
  );

-- ── Seed: competency catalog (French, with deterministic lexicons) ────────────
-- signals shape: { "positive": [{"pattern","hint_fr"?}], "negative": [{"pattern","hint_fr","better_fr"?}] }
-- Patterns are matched accent-insensitively and case-insensitively by the engine.
insert into public.ai_competencies (key, label_fr, description_fr, signals, order_index) values
(
  'ecoute', 'Écoute active',
  'Laisser le client s''exprimer, poser des questions, montrer qu''on a entendu.',
  '{
    "positive": [
      {"pattern": "si je comprends bien", "hint_fr": "Excellente reformulation d''écoute : vous montrez au client qu''il a été entendu."},
      {"pattern": "vous me dites que"},
      {"pattern": "je vous ecoute"},
      {"pattern": "dites-moi"},
      {"pattern": "d''accord"}
    ],
    "negative": []
  }'::jsonb, 1
),
(
  'empathie', 'Empathie',
  'Reconnaître et accueillir l''émotion du client avant de traiter le problème.',
  '{
    "positive": [
      {"pattern": "je comprends", "hint_fr": "Très bien : vous reconnaissez l''émotion du client immédiatement."},
      {"pattern": "je suis desole"},
      {"pattern": "je suis vraiment desole"},
      {"pattern": "c''est frustrant"},
      {"pattern": "je vous comprends"}
    ],
    "negative": [
      {"pattern": "calmez-vous", "hint_fr": "Évitez de demander à un client en colère de se calmer — cela amplifie la frustration.", "better_fr": "Je comprends votre frustration, et je vais m''occuper de votre problème tout de suite."},
      {"pattern": "calmez vous", "hint_fr": "Évitez de demander à un client en colère de se calmer — cela amplifie la frustration.", "better_fr": "Je comprends votre frustration, et je vais m''occuper de votre problème tout de suite."},
      {"pattern": "vous exagerez", "hint_fr": "Ne minimisez jamais le ressenti du client, même si le problème vous semble mineur.", "better_fr": "Je comprends que cette situation soit pénible pour vous."},
      {"pattern": "ce n''est pas grave", "hint_fr": "Pour le client, c''est grave : évitez de minimiser.", "better_fr": "Je comprends que cette double facturation vous inquiète."}
    ]
  }'::jsonb, 2
),
(
  'clarification', 'Clarification',
  'Poser les bonnes questions pour cerner précisément le problème.',
  '{
    "positive": [
      {"pattern": "pouvez-vous preciser", "hint_fr": "Bonne question de clarification : vous cherchez à comprendre précisément."},
      {"pattern": "pouvez-vous me preciser"},
      {"pattern": "depuis quand"},
      {"pattern": "quel montant"},
      {"pattern": "pour bien comprendre"},
      {"pattern": "qu''entendez-vous par"}
    ],
    "negative": []
  }'::jsonb, 3
),
(
  'responsabilisation', 'Prise en charge',
  'Assumer le problème au nom de l''entreprise et s''engager personnellement.',
  '{
    "positive": [
      {"pattern": "je vais verifier", "hint_fr": "Bien : vous prenez le problème en charge personnellement."},
      {"pattern": "je m''en occupe"},
      {"pattern": "je vais m''occuper"},
      {"pattern": "je prends en charge"},
      {"pattern": "nos excuses"},
      {"pattern": "au nom de"},
      {"pattern": "nous allons corriger"}
    ],
    "negative": [
      {"pattern": "ce n''est pas mon service", "hint_fr": "Ne renvoyez jamais le client vers un autre service sans prise en charge.", "better_fr": "Je vais me renseigner et je reviens vers vous avec une réponse."},
      {"pattern": "je ne peux rien faire", "hint_fr": "Même sans solution immédiate, montrez ce que vous POUVEZ faire.", "better_fr": "Voici ce que je peux faire dès maintenant pour vous."},
      {"pattern": "rappelez plus tard", "hint_fr": "C''est à vous de rappeler le client, pas l''inverse.", "better_fr": "Je vous rappelle personnellement avant la fin de la journée."}
    ]
  }'::jsonb, 4
),
(
  'resolution', 'Résolution',
  'Proposer une solution concrète avec un délai précis.',
  '{
    "positive": [
      {"pattern": "remboursement", "hint_fr": "Solution concrète proposée : exactement ce qu''attend le client."},
      {"pattern": "rembourse"},
      {"pattern": "sous 24"},
      {"pattern": "sous 48"},
      {"pattern": "d''ici demain"},
      {"pattern": "avant la fin de"},
      {"pattern": "je vous rappelle"},
      {"pattern": "geste commercial"},
      {"pattern": "corriger la facturation"}
    ],
    "negative": []
  }'::jsonb, 5
),
(
  'professionnalisme', 'Communication professionnelle',
  'Salutations, politesse, registre professionnel du début à la fin.',
  '{
    "positive": [
      {"pattern": "bonjour"},
      {"pattern": "merci"},
      {"pattern": "je vous en prie"},
      {"pattern": "bonne journee"},
      {"pattern": "au revoir"}
    ],
    "negative": []
  }'::jsonb, 6
)
on conflict (key) do nothing;

-- ── Seed: rubric + briefing for the Ibrahima scenario ─────────────────────────
do $$
declare
  v_scenario_id uuid;
begin
  select id into v_scenario_id
  from public.ai_scenarios
  where slug = 'ibrahima-double-facturation'
  limit 1;

  if v_scenario_id is null then
    raise notice 'ai coach seed skipped: Ibrahima scenario not found.';
    return;
  end if;

  insert into public.ai_rubrics (scenario_id, competency_key, weight, guidance_fr) values
    (v_scenario_id, 'ecoute',             1.0, 'Ibrahima doit pouvoir vider son sac avant toute réponse.'),
    (v_scenario_id, 'empathie',           1.5, 'La colère d''Ibrahima doit être accueillie, jamais contestée.'),
    (v_scenario_id, 'clarification',      1.0, 'Faire préciser le montant et la date de la double facturation.'),
    (v_scenario_id, 'responsabilisation', 1.2, 'Assumer l''erreur au nom de l''entreprise, sans se défausser.'),
    (v_scenario_id, 'resolution',         1.5, 'Remboursement ou correction, avec un délai explicite.'),
    (v_scenario_id, 'professionnalisme',  0.8, 'Registre professionnel constant malgré la tension.')
  on conflict (scenario_id, competency_key) do nothing;

  update public.ai_scenarios
  set briefing = '{
    "objective_fr": "Aujourd''hui, vous allez gérer un client en colère : Ibrahima a été facturé deux fois pour son forfait mobile et menace de résilier.",
    "goals_fr": [
      "Écouter d''abord, sans couper la parole",
      "Montrer de l''empathie avant de traiter le problème",
      "Reformuler pour confirmer votre compréhension",
      "Proposer une solution concrète avec un délai précis"
    ],
    "duration_min": 5,
    "difficulty": 2,
    "success_criteria_fr": [
      "Ibrahima s''apaise au fil de la conversation",
      "Le problème de double facturation est reformulé clairement",
      "Une solution et un délai sont annoncés avant la fin"
    ]
  }'::jsonb
  where id = v_scenario_id
    and briefing is null;   -- idempotent: never overwrite admin-edited briefing

  raise notice 'ai coach seed: rubric + briefing ensured for Ibrahima.';
end $$;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- drop table if exists public.ai_recommendations;
-- drop table if exists public.ai_scores;
-- drop table if exists public.ai_rubrics;
-- drop table if exists public.ai_competencies;
-- alter table public.ai_scenarios drop column if exists briefing;
-- alter table public.ai_scenarios drop column if exists coach_prompt_overrides;
-- alter table public.ai_sessions  drop column if exists engine_signals;
