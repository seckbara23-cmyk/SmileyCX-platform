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

## Migration 066

**Not applied by this change.** It adds:
- the consent table, with row security, own-row reads and server-only writes;
- `ai_sessions.mode`, 'voice' or 'self';
- `ai_sessions.provider_conversation_id`;
- one live session per learner.

It must be applied before voice practice is opened.

## Before opening (F2-03)

1. XP CLIENT confirms the French criteria labels, the examples and non-examples, and the banned-phrase wording for Fatou.
2. Provision the four new agents from `buildAgentConfig()`, and realign Ibrahima's agent and database text with the document.
3. Decide the retention period for transcripts.
4. Apply 066, publish the scenarios, and open voice practice in a reviewed change with a new version of the texts.
