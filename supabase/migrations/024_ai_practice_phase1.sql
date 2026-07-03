-- ============================================================
-- Migration 024: AI Practice Engine — Phase 1 foundation
--
-- Source of truth:
--   docs/architecture/AI_PRACTICE_ENGINE.md
--   docs/architecture/AI_PRACTICE_ENGINE_PHASE_1_PLAN.md
--
-- Additive only. Creates the four Phase 1 tables and does NOT touch any
-- existing table, policy, or data:
--   ai_scenarios  — configuration unit (lesson linkage, persona, French
--                   prompt, self-assessment rubric, publish flag)
--   ai_sessions   — one row per practice attempt (auth user_id OR pilot anon_id)
--   ai_turns      — conversation turns (used once live voice lands / Phase 1b)
--   ai_feedback   — evaluation; Phase 1a = self-assessment (source='self')
--
-- Deferred (NOT created here): ai_personas, ai_rubrics, ai_scores,
-- ai_recommendations.
--
-- Writes to ai_sessions / ai_turns / ai_feedback happen exclusively through
-- validated server actions using the service-role client, which enforce
-- ownership in code. RLS below is defense-in-depth:
--   - anon has NO SELECT on sessions/turns/feedback (no cross-learner reads)
--   - authenticated learners may SELECT only their own rows
--   - scenarios are publicly readable only when is_published = true
--
-- The seed at the bottom inserts ONE scenario (Ibrahima) linked to
-- F2-M3-L2, is_published = false. Guarded + idempotent: it is a no-op if the
-- target lesson is not found.
-- ============================================================

-- ── ai_scenarios ──────────────────────────────────────────────────────────────
create table if not exists public.ai_scenarios (
  id              uuid primary key default gen_random_uuid(),
  lesson_id       uuid not null references public.lessons(id) on delete cascade,
  slug            text not null unique,
  title           text not null,
  persona_name    text not null,
  language        text not null default 'fr',
  situation       text,                                   -- learner-facing French brief
  objectives      jsonb not null default '[]'::jsonb,     -- string[] (French)
  prompt_template text,                                   -- French system prompt (server-only; never sent to browser in 1a)
  provider        text not null default 'elevenlabs',
  agent_id        text,                                   -- ElevenLabs agent id (null until configured; server-only)
  self_assessment jsonb not null default '[]'::jsonb,     -- rubric questions (French)
  is_published    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ai_scenarios_lesson_idx on public.ai_scenarios(lesson_id);
create index if not exists ai_scenarios_published_idx on public.ai_scenarios(lesson_id, is_published);

-- ── ai_sessions ───────────────────────────────────────────────────────────────
create table if not exists public.ai_sessions (
  id               uuid primary key default gen_random_uuid(),
  scenario_id      uuid not null references public.ai_scenarios(id) on delete cascade,
  user_id          uuid references auth.users(id) on delete cascade,   -- nullable (pilot)
  anon_id          uuid,                                               -- nullable (pilot)
  status           text not null default 'active'
                     check (status in ('active', 'completed', 'abandoned')),
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  duration_seconds integer,
  created_at       timestamptz not null default now(),
  -- Exactly one identity: an authenticated user OR a pilot anon id, never both.
  constraint ai_sessions_identity check (
    (user_id is not null and anon_id is null)
    or (user_id is null and anon_id is not null)
  )
);

create index if not exists ai_sessions_user_idx on public.ai_sessions(user_id);
create index if not exists ai_sessions_anon_idx on public.ai_sessions(anon_id);
create index if not exists ai_sessions_scenario_idx on public.ai_sessions(scenario_id);

-- ── ai_turns ──────────────────────────────────────────────────────────────────
create table if not exists public.ai_turns (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_sessions(id) on delete cascade,
  speaker    text not null check (speaker in ('learner', 'agent')),
  transcript text not null,
  turn_index integer not null,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_turns_session_idx on public.ai_turns(session_id, turn_index);

-- ── ai_feedback ───────────────────────────────────────────────────────────────
create table if not exists public.ai_feedback (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.ai_sessions(id) on delete cascade,
  source          text not null default 'self'
                    check (source in ('self', 'claude')),
  answers         jsonb,   -- self-assessment answers (Phase 1a)
  strengths       text,    -- Phase 1b (Claude)
  weaknesses      text,    -- Phase 1b (Claude)
  recommendations text,    -- Phase 1b (Claude)
  created_at      timestamptz not null default now()
);

create index if not exists ai_feedback_session_idx on public.ai_feedback(session_id);
-- One evaluation of each kind per session (self now, claude later — never re-run).
create unique index if not exists ai_feedback_session_source_uidx
  on public.ai_feedback(session_id, source);

-- ── updated_at trigger for ai_scenarios ───────────────────────────────────────
create or replace function public.ai_scenarios_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ai_scenarios_updated_at on public.ai_scenarios;
create trigger ai_scenarios_updated_at
  before update on public.ai_scenarios
  for each row execute procedure public.ai_scenarios_set_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.ai_scenarios enable row level security;
alter table public.ai_sessions  enable row level security;
alter table public.ai_turns     enable row level security;
alter table public.ai_feedback  enable row level security;

-- ai_scenarios: public SELECT only when published; admins full access.
-- (Server code selects only learner-facing columns; agent_id / prompt_template
-- are never requested by the browser.)
drop policy if exists "ai_scenarios_select_published" on public.ai_scenarios;
create policy "ai_scenarios_select_published" on public.ai_scenarios
  for select using (is_published = true or public.is_platform_admin());

drop policy if exists "ai_scenarios_admin" on public.ai_scenarios;
create policy "ai_scenarios_admin" on public.ai_scenarios
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ai_sessions: authenticated learners may read ONLY their own rows.
-- No anon SELECT (pilot learners keep their session id in memory; writes go
-- through validated server actions). No direct INSERT/UPDATE policy — those
-- happen via the service-role client in server actions. Admins may read all.
drop policy if exists "ai_sessions_select_own" on public.ai_sessions;
create policy "ai_sessions_select_own" on public.ai_sessions
  for select using (
    public.is_platform_admin()
    or (user_id is not null and user_id = auth.uid())
  );

-- ai_turns: authenticated learners may read turns of their own sessions only.
drop policy if exists "ai_turns_select_own" on public.ai_turns;
create policy "ai_turns_select_own" on public.ai_turns
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_turns.session_id
        and s.user_id is not null
        and s.user_id = auth.uid()
    )
  );

-- ai_feedback: authenticated learners may read feedback of their own sessions.
drop policy if exists "ai_feedback_select_own" on public.ai_feedback;
create policy "ai_feedback_select_own" on public.ai_feedback
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_feedback.session_id
        and s.user_id is not null
        and s.user_id = auth.uid()
    )
  );

-- ── Seed: one scenario — Ibrahima (F2-M3-L2), is_published = false ────────────
-- Guarded + idempotent. No-op if the target lesson is absent. Publishing is a
-- deliberate later step (flip is_published = true) per the rollout plan.
do $$
declare
  v_lesson_id uuid;
begin
  select l.id
    into v_lesson_id
  from public.lessons l
  join public.modules m on m.id = l.module_id
  join public.courses c on c.id = m.course_id
  where c.slug = 'les-fondamentaux-de-l-experience-client'
    and l.slug = 'comment-le-client-s-exprime'
  limit 1;

  if v_lesson_id is null then
    raise notice 'ai_scenarios seed skipped: target lesson (F2-M3-L2) not found.';
    return;
  end if;

  insert into public.ai_scenarios (
    lesson_id, slug, title, persona_name, language, situation, objectives,
    prompt_template, provider, agent_id, self_assessment, is_published
  ) values (
    v_lesson_id,
    'ibrahima-double-facturation',
    'Client mécontent — Ibrahima',
    'Ibrahima',
    'fr',
    'Ibrahima, client fidèle depuis 5 ans, vous contacte furieux : il a été facturé deux fois ce mois-ci pour son forfait mobile. Il se sent lésé et menace de résilier. Votre objectif : l''écouter, reconnaître l''erreur et proposer une solution concrète.',
    '["Accueillir la colère sans se braquer","Reformuler le problème pour montrer votre compréhension","Présenter des excuses sincères au nom de l''entreprise","Proposer une solution concrète et un délai précis","Rétablir la confiance du client"]'::jsonb,
    -- French system prompt (source of truth for the ElevenLabs agent; server-only, not used in Phase 1a)
    'Tu es Ibrahima, un client sénégalais d''une quarantaine d''années, fidèle depuis 5 ans à un opérateur télécom. Tu appelles le service client, très en colère : tu as été facturé DEUX FOIS ce mois-ci pour ton forfait mobile. Tu te sens lésé et tu menaces de résilier ton contrat. Reste toujours dans ton rôle de client, parle uniquement en français, ne révèle jamais que tu es une intelligence artificielle. Commence par exprimer ta frustration. Si le conseiller t''écoute, reconnaît l''erreur, s''excuse et propose une solution concrète avec un délai, apaise-toi progressivement. S''il est vague, expéditif ou te coupe la parole, reste ferme et mécontent. Ne résous jamais le problème à la place du conseiller.',
    'elevenlabs',
    null,  -- agent_id set later, when the ElevenLabs agent is created
    '[
      {"id":"ecoute","type":"scale","question":"Avez-vous laissé Ibrahima exprimer sa frustration sans l''interrompre ?","guidance":"Un excellent conseiller laisse le client vider son sac avant de répondre, puis montre qu''il a écouté."},
      {"id":"reformulation","type":"scale","question":"Avez-vous reformulé le problème (double facturation) pour montrer votre compréhension ?","guidance":"Reformuler prouve au client qu''il a été entendu et évite les malentendus."},
      {"id":"excuses","type":"scale","question":"Avez-vous présenté des excuses sincères au nom de l''entreprise ?","guidance":"Des excuses sincères désamorcent la colère et rétablissent la relation de confiance."},
      {"id":"solution","type":"scale","question":"Avez-vous proposé une solution concrète avec un délai précis ?","guidance":"Une solution claire (remboursement, correction) assortie d''un délai rassure le client."},
      {"id":"amelioration","type":"text","question":"Qu''auriez-vous pu faire différemment pour mieux gérer cet échange ?","guidance":"Identifier un axe d''amélioration ancre l''apprentissage pour la prochaine fois."}
    ]'::jsonb,
    false
  )
  on conflict (slug) do nothing;

  raise notice 'ai_scenarios seed: Ibrahima scenario ensured (is_published = false).';
end $$;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- Fully removes the Phase 1 AI Practice tables (and their data):
--
-- drop table if exists public.ai_feedback;
-- drop table if exists public.ai_turns;
-- drop table if exists public.ai_sessions;
-- drop table if exists public.ai_scenarios;
-- drop function if exists public.ai_scenarios_set_updated_at();
