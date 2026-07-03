# AI Practice Engine Architecture
## XP Client Academy

**Version:** 1.0
**Status:** Architecture Proposal — documentation only, no implementation yet
**Author:** XP Client Academy
**Purpose:** Foundation and blueprint for all AI-powered learning experiences.

---

# 1. Vision

The AI Practice Engine is the intelligence layer of XP Client Academy.

Instead of creating isolated AI features (Voicebot, AI Coach, Interview Simulator, etc.), every future AI capability will be built on top of one reusable engine.

The first implementation is **Voice Practice**, but the architecture is intentionally designed to support dozens of future AI modules without redesigning the platform.

---

# 2. Objectives

The AI Practice Engine should:

- Deliver realistic AI conversations
- Evaluate learner performance
- Personalize learning journeys
- Track competencies over time
- Reduce instructor workload
- Keep AI costs predictable
- Reuse the same infrastructure across every training program

---

# 3. Design Principles

## Modular

Every AI capability is an independent module sharing the same core engine.

Examples:

- Voice Practice
- AI Coach
- Interview Simulator
- Sales Simulator
- Complaint Resolution Simulator
- Leadership Coaching
- Certification Assistant

## Deterministic where possible

AI should only be used for reasoning. Everything else remains deterministic, traditional application logic:

- Progress tracking
- Lesson completion
- Scores and score storage
- Certificates
- Analytics

## AI only where it adds value

Claude should **never** be used for:

- Authentication
- Navigation
- CRUD
- Progress calculation
- Completion tracking
- Database queries
- Pricing
- Enrollment
- Permissions

Claude should be used for:

- Conversations
- Coaching
- Feedback
- Explanations
- Scenario adaptation
- Evaluation summaries

## French-first content

All bot scripts, personas, prompts, and learner-facing feedback are authored and delivered **in French**, matching the platform's audience. Prompt templates live alongside scenarios so trainers can review and adjust the French wording without code changes.

---

# 4. High-Level Architecture

```
Browser
    │
    ▼
Practice UI
    │
    ▼
AI Session Manager
    │
    ├───────────────► Scenario Engine
    │
    ├───────────────► Conversation Engine
    │
    ├───────────────► Evaluation Engine
    │
    ├───────────────► AI Coach
    │
    └───────────────► Analytics Engine
                    │
                    ▼
                Supabase
```

---

# 5. Core Components

## 5.1 Practice UI

Responsible for:

- microphone capture
- transcript display
- video / avatars
- learner controls
- session timer
- subtitles
- progress display

No AI logic lives here.

## 5.2 AI Session Manager

Coordinates the complete practice session.

Responsibilities:

- session lifecycle
- loading scenarios
- managing turns
- saving transcripts
- ending sessions
- invoking evaluation

## 5.3 Scenario Engine

Loads the learning scenario.

Example scenario families:

- Customer Complaint
- Luxury Hotel Reception
- Bank Customer
- Insurance Claim
- Technical Support
- Retail Store
- Healthcare Reception
- Government Services

Each scenario contains:

- learning objectives
- persona
- difficulty
- expected competencies
- context
- business rules
- French prompt templates

## 5.4 Conversation Engine

Responsible for:

- Speech-to-Text
- Text-to-Speech
- Conversation state
- Turn management
- Context memory
- Claude integration (customer reasoning)

For Voice Practice, this layer is fulfilled by **ElevenLabs Conversational AI** (see §8).

## 5.5 Evaluation Engine

Evaluates learner performance against the scenario's rubric.

Outputs:

- Overall score
- Competency scores
- Strengths
- Weaknesses
- Recommendations
- Missed opportunities
- Retry advice

Evaluation is introduced in two stages (see §8.4): guided self-assessment first, automated Claude evaluation later.

## 5.6 AI Coach

Uses evaluation results to guide learning. The AI Coach does **not** replace lessons — it complements them.

Responsibilities:

- Explain mistakes and concepts
- Recommend lessons
- Suggest practice sessions
- Generate action plans
- Track improvements
- Answer learner questions
- Celebrate achievements
- Identify recurring weaknesses

## 5.7 Analytics Engine

Produces:

- learning dashboards
- competency evolution
- session history
- engagement metrics
- course completion insights
- AI usage metrics

---

# 6. Competency Framework

Every AI module scores the learner against the same competency model, so results are comparable across Voice Practice, simulators, and coaching.

Example competencies:

- Active Listening
- Empathy
- Positive Language
- Professional Communication
- Problem Solving
- Emotional Intelligence
- Questioning Skills
- Objection Handling
- Conflict Resolution
- Customer Satisfaction
- Product Knowledge
- Service Recovery

Each competency is scored independently.

---

# 7. Data Model (Supabase / PostgreSQL)

Supabase PostgreSQL remains the single source of truth. **No migrations are created at this stage** — this is the target model for when implementation begins.

| Table | Purpose | Key fields |
|---|---|---|
| `ai_sessions` | Every AI practice session | learner_id, scenario_id, started_at, completed_at, duration, final_score |
| `ai_turns` | Every conversation turn | session_id, speaker, transcript, timestamp, latency |
| `ai_feedback` | Final evaluation per session | session_id, strengths, weaknesses, recommendations |
| `ai_scores` | Competency scores per session | session_id, competency, score |
| `ai_personas` | Reusable customer personas (Angry, Confused, VIP, Senior, Technical, Happy…) | name, traits, voice profile, French script fragments |
| `ai_scenarios` | Practice scenarios | difficulty, industry, goals, prompt templates (French), expected competencies |
| `ai_rubrics` | Evaluation criteria; lets trainers customize scoring | scenario_id, competency, criteria |
| `ai_recommendations` | Personalized AI learning recommendations | learner_id, source session, recommended lessons/actions |

Session storage (transcripts, feedback, scores) always lands in Supabase regardless of which voice/AI provider handles the live conversation.

---

# 8. Phase 1 — Voice Practice Module

Voice Practice is the first AI module and the proving ground for the whole engine.

## 8.1 Workflow

```
Select scenario
      ↓
Conversation starts
      ↓
Learner speaks (browser microphone)
      ↓
Speech recognition (ElevenLabs)
      ↓
AI generates customer response
      ↓
Voice output (ElevenLabs TTS)
      ↓
Conversation continues (turns saved to Supabase)
      ↓
Evaluation
      ↓
Feedback
      ↓
AI Coach recommendations
```

## 8.2 Technical approach (from the Voicebot spec)

- **ElevenLabs Conversational AI** powers the live voice loop: it handles speech-to-text, conversational turn-taking, and text-to-speech with a natural French voice.
- **Browser microphone** is the only input device required — no app install, works inside the existing learner page.
- **ElevenLabs voice output** plays the customer persona's responses.
- **Supabase session storage**: every session and its turns/transcripts are persisted to the `ai_sessions` / `ai_turns` tables so evaluation and analytics never depend on the voice provider.
- All persona **scripts and prompts are written in French**.

## 8.3 First prototype — F2-M3-L2 « Ibrahima »

The first prototype targets **Formation 2, Module 3, Leçon 2**, with the customer persona **Ibrahima**.

- One scenario, one persona, embedded in the existing lesson flow.
- Ibrahima's script, objection patterns, and tone are defined in French in the scenario's prompt template.
- Success criteria: a learner can hold a complete voice conversation with Ibrahima in the browser and the full transcript is stored in Supabase.

## 8.4 Evaluation phasing

1. **Phase 1a — Self-assessment / pedagogical feedback.** After the conversation, the learner receives a structured self-assessment guide (French): what to check, model answers, reflection questions tied to the lesson's objectives. Deterministic, zero AI cost.
2. **Phase 1b — Claude evaluation.** Once transcripts and rubrics are validated in practice, Claude evaluates the stored transcript **once** against the rubric and writes results to `ai_feedback` / `ai_scores`.

This ordering ships learner value early, validates the data model with real sessions, and delays AI evaluation cost until the rubric is trustworthy.

---

# 9. Claude Usage Strategy

Claude is the reasoning layer only.

**Claude IS NOT called for:** navigation, authentication, progress, lesson completion, analytics, dashboards, database operations, certificate generation.

**Claude IS called for:** conversation generation / customer reasoning (where the voice provider needs it), feedback generation, evaluation summaries, coaching, scenario adaptation.

---

# 10. Cost Optimization

## Token strategy

```
Conversation
      ↓
Store transcript (Supabase)
      ↓
One evaluation request
      ↓
Store results
      ↓
Reuse forever
```

**Never repeatedly evaluate the same transcript.** Evaluation results are written once to `ai_feedback` / `ai_scores` and read from the database thereafter.

Additional levers:

- Self-assessment first (§8.4) — no evaluation tokens during the prototype phase.
- ElevenLabs handles the voice loop, so Claude is not in the per-turn hot path unless a scenario requires deep reasoning.
- Scenario prompt templates are cached and reused across sessions.

---

# 11. Security & Privacy

- Learner conversations remain private.
- Only metadata required for analytics is aggregated.
- Sensitive transcripts may be anonymized.
- Every AI interaction is auditable (session + turn records in Supabase).
- Provider API keys are server-side only, never exposed to the browser.

---

# 12. Future AI Modules

| Phase | Module |
|---|---|
| 1 | ✅ Voice Practice (this document, §8) |
| 2 | AI Coach |
| 3 | Interview Simulator |
| 4 | Sales Simulator |
| 5 | Complaint Resolution Simulator |
| 6 | Leadership Coaching |
| 7 | AI Certification Assistant |
| 8 | Manager / Analytics Dashboard |

Every module plugs into the same Session Manager, Competency Framework, Evaluation Engine, and data model.

---

# 13. Technology Stack

**Frontend:** Next.js, React, TypeScript, Tailwind CSS
**Backend:** Supabase (PostgreSQL, Storage, Realtime)
**AI:** Claude (reasoning & evaluation), ElevenLabs Conversational AI (speech-to-text, text-to-speech, voice loop)
**Deployment:** Vercel

---

# 14. Guiding Principle

The AI Practice Engine is the central intelligence layer of XP Client Academy.

Every future AI capability — Voice Practice, AI Coach, Interview Simulator, Sales Simulator, Complaint Handling, Leadership Coaching, Assessment Automation — must integrate with this engine instead of creating separate AI workflows.

This guarantees:

- one competency framework
- one analytics engine
- one evaluation model
- one learner profile
- reusable AI infrastructure
- predictable AI costs
- scalable enterprise architecture

---

# Roadmap

| Phase | Module | Status |
|---|---|---|
| 1 | Voice Practice (prototype: F2-M3-L2 « Ibrahima », self-assessment feedback) | Planned |
| 1b | Voice Practice — Claude evaluation | Planned |
| 2 | AI Coach | Planned |
| 3 | Interview Simulator | Planned |
| 4 | Sales Simulator | Planned |
| 5 | Complaint Resolution | Planned |
| 6 | Leadership Coach | Planned |
| 7 | Certification Assistant | Planned |
| 8 | AI Analytics Dashboard | Planned |

---

**End of Document**
