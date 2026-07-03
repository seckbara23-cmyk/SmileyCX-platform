# AI Practice Engine — Phase 2
## AI Coach Architecture Blueprint

**Version:** 1.0
**Status:** Architecture blueprint — no production code, no migrations
**Parent:** [AI_PRACTICE_ENGINE.md](./AI_PRACTICE_ENGINE.md) · [AI_PRACTICE_ENGINE_PHASE_1_PLAN.md](./AI_PRACTICE_ENGINE_PHASE_1_PLAN.md)
**Builds on (shipped):** `ai_scenarios` / `ai_sessions` / `ai_turns` / `ai_feedback`, ElevenLabs live voice, deterministic self-assessment, `NEXT_PUBLIC_AI_VOICE_ENABLED`, server-action security model

---

# 0. The one-sentence architecture

**ElevenLabs owns the live conversation; a deterministic Competency Engine measures it; Claude reads the finished transcript exactly once and returns a single structured coaching document; every learner-facing surface (report, replay annotations, improvement plan, history) is a pure read of stored data.**

The learner never chats with Claude. They speak with a customer, then meet their coach.

```
Lesson
  ↓
AI Coach Briefing            (config only — no AI)
  ↓
Voice Conversation           (ElevenLabs — unchanged from Phase 1)
  ↓
Transcript stored            (ai_turns — unchanged)
  ↓
Deterministic Competency     (pure functions — no AI)
Engine
  ↓
Claude AI Coach              (ONE call, idempotent, structured JSON)
  ↓
┌───────────────┬───────────────┬────────────────┬────────────────────┐
│ Coaching      │ Conversation  │ Improvement    │ Competency history │
│ report        │ replay + per- │ plan           │ + dashboards       │
│               │ turn coaching │                │                    │
└───────────────┴───────────────┴────────────────┴────────────────────┘
        all four are reads of the SAME stored evaluation — zero extra AI calls
```

---

# 1. Phase breakdown

| Phase | Name | Contents | AI cost |
|---|---|---|---|
| **2A** | Briefing + Competency Engine | Coach briefing UI (scenario config), deterministic competency signals computed at session completion, storage schema (`ai_scores`, competency catalog, rubrics), flag `NEXT_PUBLIC_AI_COACH_ENABLED` | Zero |
| **2B** | Claude Coach | `evaluateSession` one-shot Claude call, coaching report UI, conversation replay with per-turn annotations | 1 call / session |
| **2C** | Memory + learner dashboard | Improvement plan surface, competency history across sessions, learner competency radar/dashboard | Zero (reads) |
| **2D** | Manager dashboard | Enterprise aggregates, privacy/consent model, team trends | Zero (reads) |

Each phase ships behind flags, is independently rollback-able, and never blocks the Phase 1 flow (voice + self-assessment keep working if every Phase 2 flag is off).

---

# 2. System architecture

```
                       Practice UI (learner)
   ┌────────────┬──────────────┬──────────────┬──────────────┐
   │ Briefing   │ VoiceSession │ ReportView   │ ReplayView   │ …
   └─────┬──────┴──────┬───────┴──────┬───────┴──────┬───────┘
         │ config read │ (Phase 1,    │ read         │ read
         │             │  unchanged)  │              │
         ▼             ▼              ▼              ▼
   ┌─────────────────────────────────────────────────────────┐
   │              Server actions (service-role,              │
   │           in-code ownership, rate-limited)              │
   │  getBriefing · completeAiSession(+engine) ·             │
   │  evaluateSession · getSessionReport ·                   │
   │  getCompetencyHistory · getRecommendations              │
   └───────┬─────────────────┬───────────────────┬───────────┘
           │                 │                   │
           ▼                 ▼                   ▼
   ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐
   │  Supabase    │  │ Competency     │  │ Claude API       │
   │  (source of  │  │ Engine (pure   │  │ (Messages, tool- │
   │   truth)     │  │ TS functions)  │  │  forced JSON,    │
   │              │  │                │  │  called ONCE)    │
   └──────────────┘  └────────────────┘  └──────────────────┘
```

Separation of responsibilities (hard rules):

- **ElevenLabs**: STT, TTS, turn-taking, live persona. Nothing else.
- **Competency Engine**: everything computable without an LLM — counters, timing, talk ratio, keyword/pattern signals, replay assembly, history aggregation, analytics.
- **Claude**: reasoning only — judgment, phrasing advice, prioritization, personalization. Never session management, routing, DB access, analytics math, or anything real-time.
- **Supabase**: single source of truth. Every AI output is stored once and re-read forever.

---

# 3. Database evolution (additive only)

No existing table, column, policy, or the Phase 1 flow changes. New objects follow the Phase 1 security pattern exactly (service-role writes via server actions, no anon SELECT, authenticated learners read only their own rows, admins read all).

### New tables

| Table | Purpose | Key fields |
|---|---|---|
| `ai_competencies` | Global competency catalog (admin-managed, shared by ALL modules — voice, future simulators) | `key` (e.g. `empathie`), `label_fr`, `description_fr`, `anchor_notes_fr` (what 3 vs 7 vs 9 looks like), `is_active`, `order_index` |
| `ai_rubrics` | Per-scenario rubric: which competencies a scenario evaluates, with weights + scenario-specific guidance (was deferred in Phase 1) | `scenario_id`, `competency_key`, `weight`, `guidance_fr` |
| `ai_scores` | One row per (session, competency, source) — the atom of coaching memory (was deferred in Phase 1) | `session_id`, `competency_key`, `score` (0–10), `source` (`engine` \| `claude`), `evidence_fr`, `evidence_turn_index` |
| `ai_recommendations` | Personalized next steps produced by the coach (was deferred in Phase 1) | `user_id` / `anon_id`, `session_id`, `type` (`lesson` \| `scenario` \| `goal`), `payload` (jsonb), `status` |

### Additive columns on existing tables

| Table | New columns | Why |
|---|---|---|
| `ai_scenarios` | `briefing` (jsonb: objective_fr, goals_fr[], duration_estimate_min, difficulty 1–5, tips_fr[]), `coach_prompt_overrides` (jsonb, optional per-scenario prompt tuning) | Briefing is pure config; admin-editable, no deploy |
| `ai_sessions` | `engine_signals` (jsonb — deterministic measurements, §6) | Computed at completion; input to Claude; cheap re-reads |
| `ai_feedback` | `report` (jsonb — the full structured coaching document, §8), `model`, `prompt_version`, `input_tokens`, `output_tokens` | The `source='claude'` row grows a body; unique `(session_id, source)` index from Phase 1 **is** the idempotency lock |

Notes:
- `ai_feedback.source` check constraint already allows `'claude'` — no constraint change needed for 2B.
- Competency history needs no new table: it is a SQL aggregation over `ai_scores` × `ai_sessions` ordered by time (a view, e.g. `ai_competency_history`).
- Multi-language future: `label_fr`/`guidance_fr` columns become `labels jsonb` keyed by locale when a second language ships; French-first today.

---

# 4. Component hierarchy

All new components live in `components/ai/` next to the Phase 1 set. `VoicePracticeBlock` remains the orchestrator; its phase state machine grows:

```
VoicePracticeBlock                     (orchestrator — extends Phase 1 phases)
│  intro → voice → analyzing → coached | assessment → summary
│         (Phase 1 'assessment' path kept as the no-coach fallback)
│
├─ CoachBriefing                       2A — objective, goals, duration,
│                                       difficulty, « Commencer » (config only)
├─ VoicePracticeSession                Phase 1 — UNCHANGED
├─ CoachAnalysisPending                2B — « Analyse de votre conversation… »
│                                       (spinner + staged French status lines)
├─ CoachingReport                      2B — overall score, strengths,
│  ├─ CompetencyScoreList              weaknesses, missed opportunities,
│  └─ CoachAdviceCard                  advice (reads stored report)
├─ ConversationReplay                  2B — full transcript, learner turns
│  └─ TurnAnnotation                   annotated with coach comments +
│                                       « Meilleure réponse » suggestions
├─ ImprovementPlan                     2C — focus areas, recommended lessons/
│                                       scenarios, practice goal
├─ CompetencyRadar                     2C — radar of latest scores
├─ CompetencyHistoryChart              2C — evolution across sessions
└─ (SelfAssessmentForm / SessionSummary — Phase 1, kept as fallback
    when the coach flag is off or evaluation fails)
```

Learner dashboard (2C): a new section on the existing dashboard (additive), composed of `CompetencyRadar`, `CompetencyHistoryChart`, completed-scenario list, and `ImprovementPlan` — all pure reads.

Manager dashboard (2D): new admin-area pages reading aggregate views only (§11, §14).

---

# 5. AI Coach architecture

The coach is a **post-hoc, single-shot, structured evaluator**:

1. `completeAiSession` (existing) finishes → Competency Engine runs synchronously (pure function over the turn list) → `engine_signals` + `ai_scores(source='engine')` stored.
2. UI enters `analyzing` and calls **`evaluateSession(sessionId)`**:
   - **Idempotency gate first**: if `ai_feedback` has a `claude` row for this session → return the stored report immediately. Never evaluate the same transcript twice.
   - Ownership check (user_id / anon_id — existing pattern), rate limit, flag check.
   - Assemble input: transcript (from `ai_turns`), scenario + rubric, learning objectives, engine signals, session metadata.
   - **One Claude Messages call**, tool-forced JSON output (§9).
   - **Deterministic post-validation** before storing (§16 risk control): every quoted turn index must exist; scores clamped 0–10; French-language sanity check; schema validation (Zod).
   - Store: `ai_feedback` (`source='claude'`, `report` jsonb, model, tokens) + `ai_scores(source='claude')` + `ai_recommendations`.
3. Report / replay / plan / history screens are **reads** of what step 2 stored. Revisiting a session re-reads; retrying the scenario creates a *new* session (new evaluation), never a re-evaluation of the old one.

Failure posture: if Claude errors or times out, the session falls back to the Phase 1 self-assessment path with a French notice («&nbsp;Votre coach n'est pas disponible pour le moment — votre conversation est enregistrée, l'analyse pourra être relancée.&nbsp;»). The transcript is durable; evaluation can be triggered again later (still one *successful* evaluation per session).

Reusability: `evaluateSession` takes `(session, scenario, rubric, signals)` — nothing voice-specific. The Interview/Sales/Complaint simulators plug in by supplying their own scenarios + rubrics against the same competency catalog.

---

# 6. Competency Engine design (deterministic)

Pure TypeScript functions — no LLM, no network — run server-side at session completion. Input: ordered `ai_turns` + timestamps + scenario rubric. Output: `engine_signals` jsonb + provisional `ai_scores(source='engine')`.

Signal families (v1):

| Family | Signals | Method |
|---|---|---|
| Conversation shape | turn count, learner/agent talk ratio, avg learner response length, session duration, silence gaps | counters/timing |
| Listening | interruption proxy (learner turn starting < N ms after agent turn), question count, clarification patterns («&nbsp;si je comprends bien&nbsp;», «&nbsp;pouvez-vous préciser&nbsp;») | timing + French pattern lexicon |
| Empathy | acknowledgment markers («&nbsp;je comprends&nbsp;», «&nbsp;je suis désolé&nbsp;», «&nbsp;c'est frustrant&nbsp;»), forbidden phrases («&nbsp;calmez-vous&nbsp;», «&nbsp;ce n'est pas ma faute&nbsp;») | lexicon match |
| Ownership / resolution | solution markers, commitment + delay markers («&nbsp;je vous rappelle avant…&nbsp;», «&nbsp;sous 48 h&nbsp;»), apology on behalf of company | lexicon match |
| Professionalism | greeting/closing present, politeness density («&nbsp;vous&nbsp;» register), profanity check | lexicon match |

Design rules:
- **Lexicons live in the DB** (per-competency `ai_competencies.anchor_notes_fr` + a `signals` config jsonb), admin-tunable, versioned — no hardcoded French in code.
- Engine scores are **provisional and humble**: they seed the radar in 2A (before Claude exists) and become *inputs* to Claude in 2B («&nbsp;the engine noticed X — confirm or correct&nbsp;»). Claude scores supersede engine scores for display when present; both are kept for calibration analytics.
- Engine also does **salient-turn selection**: flags the K most coaching-worthy learner turns (forbidden phrase hits, first response to anger, resolution moment) so Claude annotates the turns that matter instead of everything (§13).
- Deterministic = testable: golden transcript fixtures in unit tests.

---

# 7. Replay engine

Replay is **assembled entirely from stored data** — zero AI calls at view time:

- Transcript: `ai_turns` ordered by `turn_index` (exists since Phase 1).
- Annotations: the `turn_annotations` array inside the stored `report` jsonb, keyed by `turn_index`, joined client-side.
- Each learner turn renders: the learner's words → coach verdict (`bien` / `à améliorer` / `occasion manquée`) → coach comment (French) → optional «&nbsp;Meilleure réponse&nbsp;» suggestion.
- Agent turns render as context (no annotations).
- Long sessions: only engine-selected salient turns carry annotations; un-annotated turns still display (full conversation always replayable).

Example rendering contract:

> **Vous :** «&nbsp;Calmez-vous.&nbsp;»
> **Coach :** ⚠ Évitez de demander à un client en colère de se calmer — cela amplifie la frustration.
> **Meilleure réponse :** «&nbsp;Je comprends votre frustration, et je vais m'occuper de ce problème tout de suite.&nbsp;»

Replay is the primary learning surface; the report links into it («&nbsp;Voir ce moment dans la conversation&nbsp;»).

---

# 8. Coaching report structure

The single Claude call returns one document, stored verbatim (post-validation) in `ai_feedback.report`:

```jsonc
{
  "version": "coach-report/1",
  "overall_score": 7,                       // 0–10, rubric-weighted
  "summary_fr": "…",                        // 3–4 sentence coach overview
  "strengths": [ { "text_fr": "…", "turn_index": 4 } ],          // max 4
  "weaknesses": [ { "text_fr": "…", "turn_index": 9 } ],         // max 4
  "missed_opportunities": [ { "text_fr": "…", "turn_index": 12 } ], // max 3
  "competency_scores": [
    { "key": "empathie", "score": 8, "evidence_fr": "…", "turn_index": 4 }
  ],
  "turn_annotations": [
    { "turn_index": 9, "verdict": "a_ameliorer",
      "comment_fr": "…", "better_response_fr": "…" }
  ],                                        // learner turns only, ≤ K
  "improvement_plan": {
    "focus_areas_fr": ["…", "…"],           // max 3
    "recommended_lesson_slugs": ["…"],      // validated against catalog
    "recommended_scenario_slugs": ["…"],
    "practice_goal_fr": "…"                 // one concrete next-session goal
  },
  "coach_advice_fr": "…"                    // closing encouragement, warm tone
}
```

Hard caps on array sizes keep output tokens bounded and the UI consistent. `turn_index` references make every claim verifiable against the transcript (and clickable in replay).

---

# 9. Claude prompt strategy

**One call. Messages API. Tool-forced structured output. French.**

- **System prompt (static, cached):** the coach persona — «&nbsp;Tu es un coach expérimenté en relation client en Afrique francophone… bienveillant, précis, exigeant&nbsp;» — plus scoring calibration anchors per competency (what a 3/7/9 looks like), tone rules (never harsh, never generic praise, always cite the conversation), citation rules (only reference turn indexes that exist; never invent quotes), and the output contract.
- **Cached prefix block:** competency catalog + rubric text (changes rarely) → placed early for **prompt caching**; the cache survives across evaluations of the same scenario, cutting input cost sharply at cohort scale.
- **Per-call block:** scenario brief, learning objectives, engine signals summary, session metadata (duration, turn count), then the transcript as numbered turns (`[3] APPRENANT: …` / `[4] IBRAHIMA: …`).
- **Output:** a single tool (`submit_coaching_report`) whose JSON schema mirrors §8; `tool_choice` forced → no free-text drift, no parsing fragility.
- **Model policy:** configurable (env + admin), default **Sonnet-class** for coaching quality; Haiku-class allowed as a cost tier for high-volume enterprise cohorts; the model id + `prompt_version` are stored with every report so calibration changes are traceable.
- **Prompt versioning:** prompts live in versioned server-side templates; scenario-level `coach_prompt_overrides` (jsonb) allow admin tuning without deploys. Bumping `prompt_version` never re-evaluates old sessions (idempotency holds); it only affects new ones.

---

# 10. Server actions

Following the Phase 1 contract (service-role client, in-code ownership via `user_id`/`anon_id`, Zod validation, rate limiting, fail-safe returns):

| Action | Phase | Purpose | AI |
|---|---|---|---|
| `fetchVoiceScenario` *(extend)* | 2A | + returns `briefing` config | — |
| `completeAiSession` *(extend)* | 2A | + runs Competency Engine, stores `engine_signals` + engine scores | — |
| `evaluateSession(sessionId)` | 2B | Idempotency gate → assemble inputs → **one Claude call** → validate → store report/scores/recommendations → return report | **1 call** |
| `getSessionReport(sessionId)` | 2B | Read stored report + turns for report/replay screens | — |
| `getCompetencyHistory()` | 2C | Aggregated `ai_scores` over the caller's sessions (view-backed) | — |
| `getRecommendations()` | 2C | Read active `ai_recommendations` for the caller | — |
| `getTeamAnalytics(orgId)` | 2D | Aggregates only; consent-gated transcript access (§14) | — |

Runtime note: `evaluateSession` is the only long call (5–20 s). It must run on the Node runtime with an explicit `maxDuration` (60 s) — a route-level config, not an architecture change. The UI's `analyzing` state covers the wait with staged French status lines.

---

# 11. Analytics

All deterministic SQL — Claude computes none of it:

- **Learner:** latest + historical competency scores (`ai_scores` view), sessions completed, average overall score, streaks, scenario coverage.
- **Cohort/manager (2D):** averages, competency distribution, most-common weaknesses (frequency of low-scoring competencies), improvement slopes over time, scenario completion rates, leaderboard (opt-in display names).
- **Platform/ops:** evaluations/day, token spend (`input_tokens`/`output_tokens` summed), Claude error rate, cache-hit ratio, cost per session, engine-vs-claude score deltas (calibration monitor).

Materialized views (or scheduled aggregate tables) once cohorts grow; plain views are fine for pilot scale.

---

# 12. Performance optimization

- **Everything except `evaluateSession` is a DB read** — report, replay, plan, history render instantly.
- Evaluation runs once, at the moment of highest learner patience (right after the conversation, behind a purposeful «&nbsp;Analyse…&nbsp;» screen). Perceived latency budget: ≤ 20 s; staged status text keeps it premium.
- Replay joins turns + annotations client-side from two indexed queries (`ai_turns(session_id, turn_index)` exists since Phase 1).
- History reads via the `ai_competency_history` view with `(user_id/anon_id, competency_key, created_at)` supporting indexes.
- The Claude SDK loads server-side only; zero client bundle impact (mirrors the ElevenLabs dynamic-import discipline).

# 13. Token optimization

1. **Idempotency is the biggest saving:** one successful evaluation per session, stored forever, re-read for every subsequent view. (Phase 1's unique `(session_id, source)` index is the lock.)
2. **Prompt caching:** static system + competency catalog + rubric as a cached prefix; only scenario brief + transcript + signals are fresh tokens.
3. **Transcript budgeting:** cap at ~60 turns / ~8k transcript tokens. Longer sessions: engine keeps all learner turns + salient agent turns, elides low-value agent filler with `[…]` markers. (Pilot sessions are ≤ 5 min — headroom is large.)
4. **Bounded output:** hard array caps in the tool schema (≤ K annotations, ≤ 4 strengths…) bound output tokens.
5. **Salient-turn pre-selection** by the engine focuses annotation tokens where coaching value is highest.
6. **Cost telemetry:** tokens stored per report; daily spend dashboard + alert threshold; global `AI_COACH_ENABLED` kill-switch (server-side) stops new evaluations instantly without touching stored reports.

# 14. Security & privacy

- **Unchanged foundations:** RLS model, middleware, auth, pilot mode, payments — untouched. New tables copy the Phase 1 policy shape (no anon SELECT; owner-only authenticated SELECT; service-role writes through validated actions; admin read).
- **Keys:** `ANTHROPIC_API_KEY` server-only (same discipline as `ELEVENLABS_API_KEY` — never `NEXT_PUBLIC`, verified absent from client bundles).
- **Transcript privacy:** transcripts and reports are the learner's. Manager dashboard (2D) sees **aggregates by default**; individual transcripts/reports require an explicit org-level policy **and** per-learner consent flag, with access audit-logged. Leaderboards are opt-in.
- **PII hygiene:** deterministic scrub of emails/phone numbers from transcripts before the Claude call; system prompt forbids echoing personal data.
- **Abuse control:** `evaluateSession` rate-limited per identity (existing `rateLimitDb`), daily per-identity cap, global kill-switch.
- **Auditability:** every report row stores model, prompt_version, tokens, timestamps — every AI interaction reconstructible.

# 15. Rollout strategy

1. **2A dark:** migration + engine + briefing behind `NEXT_PUBLIC_AI_COACH_ENABLED=false`. Zero visible change; Phase 1 untouched (its acceptance test re-run).
2. **2A pilot:** flag on → learners see briefing + engine-seeded radar; no Claude, zero AI cost; lexicons tuned on real pilot transcripts.
3. **2B staging:** Claude evaluation on the Ibrahima scenario with internal testers; prompt calibration against ~20 real transcripts; French tone review by a human coach.
4. **2B pilot:** enable for the pilot cohort with a daily evaluation budget; watch cost, latency, error rate, and learner feedback (reuse the pilot feedback system).
5. **2C:** dashboard + history once ≥ 2 sessions/learner exist (history needs data).
6. **2D:** enterprise-gated, after consent model review.
7. **Rollback at every step:** flip the flag — stored reports remain readable; only *new* evaluations stop.

# 16. Risk analysis

| Risk | Mitigation |
|---|---|
| Claude invents quotes / wrong turn refs | Tool-forced schema + **deterministic post-validation**: every `turn_index` must exist and belong to the learner where required; invalid reports rejected and retried once, else fall back to self-assessment |
| Serverless timeout on the Claude call | Node runtime + `maxDuration 60`; `analyzing` UI absorbs latency; retry path since transcript is durable |
| Cost overrun (anonymous pilot) | Per-identity rate limits + daily caps + kill-switch + token telemetry/alerts; evaluation triggered by explicit UX moment, not automatically for abandoned sessions |
| STT errors make the coach unfair | Engine passes a transcription-confidence note; system prompt instructs charitable interpretation of garbled turns; coach tone rules forbid penalizing unclear STT |
| Harsh/generic coaching erodes trust | Calibration anchors + tone rules + human review in staging; «&nbsp;coach&nbsp;» framing (observed conversation) rather than «&nbsp;AI score&nbsp;» |
| Pilot anon identity loss (localStorage cleared) breaks history | Known Phase 1 limitation; history is best-effort for anon, first-class for authenticated learners; encourage account creation post-pilot |
| Engine lexicon bias (French variants) | Lexicons DB-managed and tuned on Senegalese-French pilot transcripts; engine scores marked provisional, Claude supersedes |
| `ai_feedback.source` collisions | Unique `(session_id, source)` already enforces one self + one claude row — designed in Phase 1 |
| Scope creep into live Claude chat | Hard rule in this doc + non-goal in every phase plan; coach is post-hoc only |

# 17. Future roadmap

| Phase | Module | Reuses from Phase 2 |
|---|---|---|
| 3 | Interview Simulator | Scenarios + rubrics + coach + replay unchanged; new personas |
| 4 | Sales Simulator | + objection-handling competencies (catalog rows, not code) |
| 5 | Complaint Resolution | Ibrahima family expansion; difficulty ladder via `briefing.difficulty` |
| 6 | Manager/Leadership Coaching | Same engine; manager-role rubrics |
| 7 | Certification Assistant | Competency thresholds over `ai_scores` history → certificate gates |
| 8 | AI Analytics Dashboard | 2D aggregates matured; org benchmarks |
| — | Multi-language | `*_fr` columns → locale-keyed jsonb; prompts per locale |
| — | Multi-provider voice | `ai_scenarios.provider` already exists; coach is provider-agnostic (reads `ai_turns` only) |

---

## Appendix — invariants this blueprint never breaks

1. Claude is called **once** per completed conversation, post-hoc, idempotent.
2. ElevenLabs and Claude never share a responsibility.
3. Anything computable deterministically stays deterministic.
4. All learner-facing coaching surfaces are reads of stored data.
5. Additive-only: Phase 1 behavior with all Phase 2 flags off is byte-identical.
6. French-first; no hardcoded scenarios, personas, competencies, or lexicons.
7. Secrets never reach the browser; transcripts stay private by default.

**End of blueprint**
