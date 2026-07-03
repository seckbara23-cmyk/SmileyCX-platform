# AI Practice Engine — Phase 1 Implementation Plan
## Voice Practice MVP

**Version:** 1.0
**Status:** Plan — documentation only, no implementation yet
**Parent:** [AI_PRACTICE_ENGINE.md](./AI_PRACTICE_ENGINE.md)
**Target:** One lesson — **F2-M3-L2**, persona **« Ibrahima »**

---

# 1. Scope

Build the smallest complete slice of the AI Practice Engine:

- **One lesson:** F2-M3-L2 (Formation 2, Module 3, Leçon 2).
- **One scenario:** Ibrahima, client télécom en colère, facturé deux fois (angry telecom customer charged twice).
- **One language:** French — scripts, prompts, UI labels, and feedback.
- **One provider:** ElevenLabs Conversational AI (browser microphone in, French voice out).
- **Evaluation Phase 1a:** deterministic self-assessment only (no Claude in the loop).
- **Evaluation Phase 1b (deferred):** one-time Claude evaluation of stored transcripts.
- Sessions, turns, and self-assessments persisted in Supabase.

The MVP proves the full loop: *scenario → live voice conversation → transcript stored → structured feedback* — on infrastructure every later module reuses.

# 2. Non-goals

Phase 1 deliberately does **not** include:

- Claude in the conversation loop or in evaluation (deferred to 1b).
- More than one scenario, persona, or lesson.
- AI Coach, recommendations, analytics dashboards.
- Trainer-facing scenario editor (scenario is seeded/configured by developers).
- Competency scoring (`ai_scores` stays empty until 1b).
- Avatars or video.
- Any change to payments, auth, middleware, pilot mode, course structure, or existing lesson player behavior.

# 3. User flow (learner)

1. Learner opens lesson **F2-M3-L2** in the existing lesson player.
2. Below the lesson content, a **« Pratique vocale »** card appears (only on this lesson — see §8).
3. Learner clicks **« Commencer la conversation »** → browser asks for microphone permission.
4. Conversation starts: Ibrahima (ElevenLabs voice, French) opens with his complaint about the double charge.
5. Learner speaks; live transcript renders turn by turn; a session timer runs.
6. Learner ends the session (or reaches the scenario's natural end / max duration).
7. Transcript is saved; the **self-assessment** form appears (French, §14).
8. Learner submits self-assessment → summary screen: transcript replay + their own answers + pedagogical pointers linked back to the lesson.
9. Learner can retry the scenario (new session row; previous sessions kept).

Failure paths: mic denied → French explanatory message with retry; connection drop → partial transcript saved, session marked `abandoned`.

# 4. Admin / preparation flow

No admin UI in Phase 1. Preparation is developer-executed:

1. Write Ibrahima's **French system prompt** (persona, situation, emotional arc, guardrails) and store it in `ai_scenarios.prompt_template`.
2. Create the ElevenLabs agent (dashboard): French voice, prompt, first message, turn-taking settings (§10).
3. Seed one `ai_scenarios` row linking `agent_id` ↔ lesson F2-M3-L2, `is_published = false`.
4. QA on staging → flip `is_published = true` to go live (§17).

The scenario's rubric questions for self-assessment live in `ai_scenarios.self_assessment` (JSONB) so wording can be tuned without a deploy.

# 5. Data model proposal

Minimal subset of the architecture's target model — only what the MVP writes or reads:

- **`ai_scenarios`** — the configuration unit. Holds lesson linkage, ElevenLabs `agent_id`, French prompt template (source of truth for what the agent was configured with), persona summary, self-assessment questions (JSONB), `is_published`.
- **`ai_sessions`** — one row per practice attempt. Belongs to a scenario; identifies the learner (auth `user_id` **or** pilot `anon_id`, §7); tracks `status` (`active` / `completed` / `abandoned`), timestamps, duration.
- **`ai_turns`** — one row per conversation turn. `speaker` (`learner` / `agent`), French `transcript`, ordinal index, timestamps.
- **`ai_feedback`** — one row per completed session. Phase 1a: `source = 'self'`, learner's answers (JSONB). Phase 1b adds `source = 'claude'` rows with strengths/weaknesses/recommendations.

Deferred (created later, not in Phase 1 migrations): `ai_personas`, `ai_rubrics`, `ai_scores`, `ai_recommendations`.

# 6. Supabase table list

| Table | Phase 1 | Notes |
|---|---|---|
| `ai_scenarios` | ✅ create | seeded with 1 row (Ibrahima / F2-M3-L2) |
| `ai_sessions` | ✅ create | `user_id` nullable + `anon_id` nullable (pilot) |
| `ai_turns` | ✅ create | FK → `ai_sessions`, cascade delete |
| `ai_feedback` | ✅ create | `source` column: `'self'` now, `'claude'` in 1b |
| `ai_personas` | ⏸ defer | persona embedded in scenario for MVP |
| `ai_rubrics` | ⏸ defer | self-assessment questions in scenario JSONB |
| `ai_scores` | ⏸ defer | needs Claude evaluation (1b) |
| `ai_recommendations` | ⏸ defer | needs AI Coach (Phase 2) |

One migration file, additive only — no changes to existing tables.

# 7. RLS considerations

Follow the platform's existing pilot patterns (cf. `008_pilot_anon_access.sql`, `010_fix_pilot_quiz_rls.sql`):

- `ai_scenarios`: public **SELECT** where `is_published = true`; writes via service role only.
- `ai_sessions` / `ai_turns` / `ai_feedback`:
  - Authenticated learners: SELECT/INSERT/UPDATE limited to `user_id = auth.uid()`.
  - **Pilot (anonymous):** INSERT allowed with anon key, rows carry a client-generated `anon_id` (UUID persisted in `localStorage`, same pattern as pilot quiz/progress). SELECT for anon restricted to matching `anon_id` passed via RPC or simply not exposed (client keeps its own copy in memory for the summary screen) — decide at implementation; default to **no anon SELECT** to minimize surface.
  - No UPDATE/DELETE for anon beyond closing their own `active` session (via a `SECURITY DEFINER` RPC if needed).
- Abuse control: reuse the existing DB rate-limiting infrastructure before session creation (pilot phase = anonymous = must be throttled).
- Service role key stays server-side only (unchanged rule).

# 8. UI components needed

All new, all under `components/ai/` — the existing lesson player is only touched to conditionally render one block (same integration pattern as `ExerciseBlock`):

| Component | Role |
|---|---|
| `VoicePracticeBlock` | Entry card in the lesson page. Renders **only** when a published scenario exists for the current lesson; otherwise renders nothing (lesson player unchanged for all other lessons). |
| `VoicePracticeSession` | The live session: mic state, connect/disconnect, live French transcript, timer, « Terminer » button, error states. |
| `SelfAssessmentForm` | French rubric questions from the scenario JSONB (scale + free-text), submit → `ai_feedback`. |
| `SessionSummary` | Transcript replay + learner's self-assessment + pedagogical pointers + « Réessayer » CTA. |

Dark-theme styled to match the learner page. Mobile: mic UI works on the existing responsive layout; sidebar behavior untouched.

# 9. API / server actions needed

| Endpoint / action | Purpose |
|---|---|
| `GET /api/ai/voice/signed-url` | Server-side: exchanges `ELEVENLABS_API_KEY` for a short-lived signed WebSocket URL for the scenario's agent. The API key never reaches the browser. Validates that the requested scenario is published; applies rate limiting. |
| `createAiSession` (server action) | Insert `ai_sessions` row (`active`), return session id. |
| `saveAiTurns` (server action) | Append turn batch to `ai_turns` (called on transcript events / periodically / at end). |
| `completeAiSession` (server action) | Mark session `completed` (or `abandoned`), set duration. |
| `saveSelfAssessment` (server action) | Insert `ai_feedback` row with `source='self'`. |

No changes to existing API routes, middleware, or auth.

# 10. ElevenLabs setup checklist

- [ ] Create ElevenLabs account / workspace; enable **Conversational AI**.
- [ ] Pick a French male voice suited to Ibrahima (natural, believable frustration).
- [ ] Create agent **« Ibrahima — client télécom »**:
  - [ ] System prompt in **French**: persona (Ibrahima, ~40 ans, client fidèle), situation (facturé deux fois ce mois-ci), emotional arc (colère → apaisement si bien géré), guardrails (reste dans le rôle, ne révèle pas être une IA, ne résout pas à la place de l'apprenant).
  - [ ] First message in French (opens the complaint).
  - [ ] Language: `fr`; STT language forced to French.
  - [ ] Turn-taking / interruption settings tuned for a realistic argument.
  - [ ] Max conversation duration (e.g. 5 minutes) as a cost guard.
- [ ] Enable transcript events in the client SDK (and evaluate the post-call webhook as a backup transcript source).
- [ ] Restrict the agent to signed-URL access (not public).
- [ ] Record `agent_id` → goes into the `ai_scenarios` seed.
- [ ] Verify pricing/quota; set usage alerts on the ElevenLabs account.

# 11. Environment variables

| Variable | Scope | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | server-only, secret | Signed-URL generation. Never `NEXT_PUBLIC`. |
| `NEXT_PUBLIC_AI_VOICE_ENABLED` | public flag | Global kill-switch for the Voice Practice UI (default `false` until rollout). |

Agent id lives in the `ai_scenarios` row (per-scenario), not in env. `.env.example` gets both entries with comments; Vercel gets the real values.

# 12. Session lifecycle

```
idle → requesting-mic → connecting → active ⇄ (agent speaking / learner speaking)
                                        │
                        ┌───────────────┴────────────────┐
                        ▼                                ▼
                   completed                         abandoned
              (learner ends / scenario end)   (drop, timeout, navigation)
                        │
                        ▼
                self-assessment → summary
```

- `ai_sessions.status` mirrors this: `active` on creation, `completed` or `abandoned` terminal.
- A `beforeunload` / visibility handler attempts to flush pending turns and mark `abandoned`.
- Stale `active` sessions older than the max duration are treated as `abandoned` (cleanup can be lazy — on next read — no cron needed for MVP).
- Retry = new session row; history preserved.

# 13. Transcript persistence

- Primary source: **client SDK transcript events** (learner + agent turns), buffered and sent to `saveAiTurns` in small batches (e.g. every 2 turns or 10 s) and flushed at session end.
- Each turn: `session_id`, `speaker`, `transcript` (French text), `turn_index`, `created_at`.
- Post-call webhook (ElevenLabs → route handler) considered as a **reconciliation** source if client-side saving proves lossy — decision made during implementation, not required for MVP.
- Transcripts are the durable asset: Phase 1b Claude evaluation runs from `ai_turns`, never from the provider. Audio is **not** stored in Phase 1 (privacy + storage cost).

# 14. Self-assessment flow (Phase 1a)

Deterministic, zero AI cost, entirely in French:

1. On completion, learner answers 4–6 rubric questions defined in the scenario JSONB, e.g.:
   - « Avez-vous laissé Ibrahima exprimer sa frustration sans l'interrompre ? » (échelle 1–4)
   - « Avez-vous reformulé le problème (double facturation) pour montrer votre compréhension ? »
   - « Avez-vous proposé une solution concrète et un délai ? »
   - « Qu'auriez-vous pu faire différemment ? » (texte libre)
2. Each question maps to a lesson concept; the summary screen shows model guidance (« Ce qu'un excellent conseiller aurait fait ») next to the learner's own rating.
3. Answers stored in `ai_feedback` (`source='self'`); shown again on retry so learners see their own progression.

This validates the rubric wording with real learners **before** paying for automated evaluation.

# 15. Claude evaluation — deferred plan (Phase 1b)

When 1a is validated:

1. Add `ai_scores` (+ optionally `ai_rubrics`) tables.
2. Server action `evaluateSession(sessionId)`: loads `ai_turns`, builds one French evaluation prompt from the scenario rubric, calls Claude **once**, writes `ai_feedback` (`source='claude'`) + `ai_scores`.
3. Idempotent: if a `claude` feedback row exists for the session, return it — never re-evaluate the same transcript (architecture cost rule).
4. Trigger: learner clicks « Obtenir mon évaluation détaillée » (explicit, visible, rate-limited) — not automatic on every session.
5. UI: evaluation panel added to `SessionSummary`; self-assessment remains (compare self vs. AI view — pedagogically valuable).

Nothing in Phase 1a's schema blocks this: `ai_feedback.source` and the stored transcripts are the extension points.

# 16. Testing checklist

- [ ] Lesson player renders **unchanged** on every lesson without a scenario (no block, no extra requests).
- [ ] Block appears only on F2-M3-L2 and only when `is_published = true` **and** `NEXT_PUBLIC_AI_VOICE_ENABLED=true`.
- [ ] Mic permission granted / denied / revoked mid-session — all handled with French messaging.
- [ ] Full happy path: conversation ≥ 6 turns, French STT accuracy sanity check, session `completed`, all turns in `ai_turns`, self-assessment saved.
- [ ] Abandon paths: tab close, navigation, network drop → partial transcript saved, session `abandoned`.
- [ ] Pilot (anonymous) flow: `anon_id` created, RLS allows insert, no cross-learner reads.
- [ ] Authenticated flow: rows carry `user_id`; learner sees only own history.
- [ ] Rate limiting on session creation and signed-URL endpoint.
- [ ] `ELEVENLABS_API_KEY` absent from all client bundles (grep the build output).
- [ ] Browsers: Chrome, Edge, Firefox, Safari (iOS Safari mic quirks explicitly).
- [ ] Mobile layout: session UI usable at 360 px width.
- [ ] `npm run lint` and `npm run build` clean.
- [ ] Playwright smoke test: block visibility on/off by scenario flag (mic itself mocked or skipped in CI).

# 17. Rollout plan

1. **Dev**: migration + seed (`is_published=false`), flag off. Verify zero visible change in production behavior.
2. **Staging/preview**: flag on, scenario published on preview env only; internal QA with the ElevenLabs agent (real voice loop).
3. **Production, dark**: deploy with `NEXT_PUBLIC_AI_VOICE_ENABLED=false`. Confirm lesson player untouched.
4. **Production, pilot**: flip flag + `is_published=true` for the single scenario. Announce to pilot learners.
5. **Monitor**: session count, completion vs. abandon rate, ElevenLabs usage/cost, error logs.
6. **Rollback**: flip the env flag (instant, no deploy) or unpublish the scenario row.

Pilot mode remains active throughout; nothing in the rollout touches auth, payments, or course structure.

# 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| ElevenLabs cost overrun (anonymous pilot users) | Max session duration on the agent; rate limiting per `anon_id`/IP; usage alerts; global kill-switch flag. |
| French STT misrecognition (accents, Senegalese French) | Force `fr` STT; test with target-audience speakers during staging QA; transcript is advisory in 1a (self-assessment doesn't depend on STT accuracy). |
| Mic permission/browser incompatibility | Explicit French guidance UI; Safari/iOS tested before rollout; block degrades to an informative card if `getUserMedia` unavailable. |
| Transcript loss (client-side saving) | Batched saves during the session, flush on end/unload; post-call webhook as reconciliation fallback if needed. |
| Agent breaks character / inappropriate output | Guardrails in the French system prompt; max duration; staging QA scripts probing edge cases; transcripts auditable. |
| Anonymous data abuse (spam sessions) | Existing DB rate-limiting infra reused; no anon SELECT; sessions capped per anon_id per day. |
| Latency makes conversation unnatural | ElevenLabs Conversational AI is optimized for this; measure round-trip in staging; acceptance gate in §19. |
| Scope creep toward Claude/coach features | Non-goals list (§2) is the contract; 1b has its own plan gate. |

# 19. Acceptance criteria

Phase 1 is **done** when:

1. On F2-M3-L2 (and only there), a learner can complete a full French voice conversation with Ibrahima in the browser using only the microphone.
2. Conversation latency feels conversational (agent responds in ~< 2 s perceived).
3. The complete transcript (all turns, both speakers) exists in `ai_turns` for completed **and** abandoned sessions.
4. The learner receives and submits the French self-assessment; answers persist in `ai_feedback` and reappear in their summary.
5. Every other lesson renders byte-for-byte identically to today; disabling the flag removes all Voice Practice surface instantly.
6. Pilot (anonymous) and authenticated flows both work under RLS with no cross-learner data access.
7. No changes shipped to auth, middleware, payments, pilot mode, or course structure.
8. `npm run lint`, `npm run build`, and the testing checklist (§16) pass.

---

**End of Plan**
