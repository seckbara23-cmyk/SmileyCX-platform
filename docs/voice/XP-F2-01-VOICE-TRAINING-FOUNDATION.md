# XP-F2-01/02: the F2 voice-training foundation

One configuration-driven engine for the five voice exercises of training F2. Voice practice stays **closed in production**: `VOICE_PRACTICE_OPEN` is still false, because `VOICE_LEGAL_CONDITIONS_BUILT` is still false. Opening it is a separate, reviewed change.

## Source

« Voice Training Exercises — Training F2 », the document XP CLIENT approved. Taken from it verbatim:
- the five scenarios and their lessons;
- each customer's emotion and situation;
- the French opening lines;
- the objectives and observation criteria;
- the rules every agent follows.

The document is the English version. The French labels of the criteria, and the examples and non-examples each agent prompt must contain, are written here from its rules. They are marked for confirmation before the agents are provisioned.

## The engine

| Part | File | One for the five personas |
|---|---|---|
| personas | `lib/voice/personas.ts` | Amara F2-M2-L4, Fatou F2-M2-L5, Ibrahima F2-M3-L2, Kader F2-M3-L4, Awa F2-M4-L2. Each carries its scenario id (the slug already seeded), lesson, identity, situation, emotion, exact opening line, objective with examples and non-examples, three observation criteria, the criteria that decide the objective, boundaries, two re-prompts, five attempts per lesson, and endings |
| common rules | `lib/voice/agent-rules.ts` | stay in character; react without taking over; never self-resolve, including the disguised closed question; observable behaviour only; at most two re-prompts; a warm closing only when the objective is met; a natural, unresolved ending otherwise; no grade; evidence-based analysis |
| agent configuration | `lib/voice/prompt.ts` | system prompt, first message, language and Analysis-tab evaluation criteria, built from the persona and the rules. The platform sends **no prompt override** at session start: the agent's own configuration is the only prompt that runs |
| feedback | `lib/voice/feedback.ts` | per criterion: réussi, à retravailler or pas assez d'éléments, with a rationale. No score. A rationale with a grade, or quoting words the learner never said, is dropped and the verdict becomes unknown. The objective is met only if every deciding criterion is a success; otherwise the learner is invited to retry |
| provider | `lib/voice/elevenlabs.ts` | signed URL, post-call analysis and conversation deletion, server-side, with timeouts. No response body is ever logged |
| start policy | `lib/voice/session-policy.ts` | consent, stale-session close, one live session, five attempts per lesson in the access period; fails closed |

The server actions (`app/actions/ai-practice.ts`), the session component and the block are shared by all five. Ibrahima keeps the same scenario, agent and flow.

## Security and privacy

- **Closed means closed:** every voice action answers « pas encore ouvert » before doing anything, including on a direct call. Previously, three of them did not check.
- **A signed-in learner with course access:** the pilot's anonymous path is closed for new sessions. Course access is checked on the scenario read and on both session starts.
- **Consent:** explicit, versioned, recorded by the server. Withdrawal and the deletion of one's voice data, here and at the provider, are always available.
- **Ownership:** turns, completion and feedback belong to the session's learner only. A conversation of another agent is refused.
- **Limits:**
  - one live session per learner, enforced by the database;
  - a session left open by a closed tab is closed after 15 minutes;
  - turns only on a live session, deduplicated and rate-limited.
- **Secrets:**
  - the signed URL's token is no longer logged;
  - provider messages reach the browser in development only.
- **No score shown:** the coach summary shows a level word instead of « N/10 ».

## XP-F2-03: the five scenarios, complete

- **Content.** Every persona now carries, besides the source text: its reactions to each register of the learner, example closing lines for both endings, and strict success and failure definitions per criterion. Fatou has the document's four forbidden phrases, their French form and a positive rephrasing for each. Kader has his insistence lines and acceptable alternatives. Awa has her F1 continuity. Amara confirms with « Oui, c’est ça. » when the rephrasing is there.
- **Transcript guards** (`lib/voice/dialogue-guards.ts`). After the provider's analysis, deterministic checks on the transcript can only lower a verdict:
  - a learner who only said « oui » or « d’accord » fails the objective;
  - a forbidden phrase fails Fatou's negative-phrasing criterion, quoting it;
  - no explicit refusal caps Kader's refusal criterion at « unknown »;
  - no time frame caps Awa's commitment criterion at « unknown ».
- **Approval dossier.** `docs/voice/F2-DOSSIER-APPROBATION.md`, in French for Marième, generated from the registry and kept equal to it by a test. It separates the exact source text from every proposal.
- **Provisioning readiness.** `lib/voice/provisioning.ts` builds each agent's exact payload. `lib/voice/agents.manifest.json` is its committed output, with a fingerprint per agent. `scripts/voice/compare-agents.mjs` compares the manifest with live agents, read-only, printing hashes only. Nothing in the repository creates or updates an agent.
- **Ibrahima.** His repository content follows the document. His live agent and his database row are unchanged. The learner already reads the reviewed situation and criteria, not the older database text.
- **Self-assessment is not a voice session.** The one-live-session rule, the stale-session close and the attempt count apply to voice sessions only.
- **Retention.** A tested, unscheduled purge and the design to decide: `docs/voice/XP-F2-03-RETENTION.md`. A learner's erasure no longer loses the provider reference when the provider cannot delete at once.

## Migration 066

**Not applied by this change.** It adds:
- the consent table, with row security, own-row reads and server-only writes;
- `ai_sessions.mode`, 'voice' or 'self'; every existing row becomes 'self';
- `ai_sessions.provider_conversation_id`, `content_purged_at` and `erasure_requested_at`;
- one live **voice** session per learner (XP-F2-03 revision: the first version covered every session, and would have failed on existing data);
- the browser roles lose their write rights on the five learner-owned AI tables, and keep their reads.

It changes no existing row. It must be applied before voice practice is opened.

## Before opening (F2-04)

1. Marième approves the dossier, or corrects it. The corrections go into the registry and the dossier is regenerated.
2. The owner decides the retention period, and the privacy and consent texts announce it.
3. The owner authorizes provisioning: four new agents from the manifest, and the update of Ibrahima's agent. `compare-agents.mjs` then shows every agent matching.
4. Apply 066, publish the scenarios, and open voice practice in a reviewed change with a new version of the texts.
