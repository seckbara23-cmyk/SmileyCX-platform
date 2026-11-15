# XP-F2-READY-03: legacy voice sessions and erasure scope

Preparation only. Nothing here was executed against production: no reclassification, no deletion, no provider call, no migration.

## 1. Erasure scope (code fix)

**Defect.** The shared erasure (`lib/voice/erasure.ts`) deleted every session of the learner — voice and self-assessment alike — for a learner's own request, a withdrawal of consent and an administrator's erasure. On a database without migration 066 it deleted every session. Self-assessment answers and coaching results are not voice data: decision D2 covers voice data only.

**Fix.** Two scopes, chosen from the reason:

| Trigger | Scope | Sessions deleted |
|---|---|---|
| learner's request, withdrawal of consent, administrator's voice erasure | `voice` | `mode = 'voice'` only, by id, and the delete repeats the mode condition |
| account deletion (admin only, distinct workflow) | `account` | all of them, by the account's cascade; provider copies are dealt with first |

A voice-scoped erasure also discards any non-voice row it is handed, so a dropped query filter cannot reach self-assessment history. On a database without 066, a voice-scoped erasure deletes nothing: no session can be a voice session there. Regression tests cover each trigger, the dropped-filter case, the pre-066 case, the complete account deletion and the admin-only boundary. With the guards removed, 9 tests fail.

## 2. Legacy voice sessions

Before migration 066 the database did not record a session's mode, nor the provider's conversation id. Migration 066 gives every existing session `mode = 'self'`. Some of them were in fact voice conversations from the earlier pilot: they hold transcript turns, which the self-assessment never writes.

Consequences until they are treated:
- the 30-day voice retention does not reach them (XP-F2-READY-02);
- a learner's voice erasure does not reach them either (section 1);
- the account deletion does.

### Classification criteria (read-only)

A legacy session is proposed for reclassification as voice only when ALL hold:
1. its scenario is the one with a live agent at the time;
2. it holds at least one agent turn and one learner turn;
3. the first turn is the agent's, and turn numbers have no gap;
4. it has no self-assessment feedback;
5. its first agent turn is the persona's documented opening line.

A session meeting 1–4 but not 5 (an earlier agent opening) is **ambiguous**. It is excluded from automatic reclassification and listed for the owner's review.

### Outcome of the review (XP-F2-READY-04)

The sessions excluded on criterion 5 were reviewed. Their first agent turn is a generic assistant greeting, and none of their agent turns mentions the persona's story. They ran on a voice agent not yet configured with the persona.

They are nonetheless voice sessions. Before migration 066, the only code that ever wrote transcript turns was `saveAiTurns`, and its only caller was the live voice-session component. The self-assessment never wrote a turn. Their turns also follow exactly the same pattern as the confirmed sessions: the agent speaks first, then each exchange is saved progressively over the length of the call.

Criterion 5 identifies the persona, not the mode, so it is dropped for the reclassification. A session is reclassified as voice when criteria 1 to 4 hold. After this review, no legacy session with transcript turns remains unresolved.

What the owner confirmed: no known legal dispute or preservation requirement concerns these sessions.

A read-only verifier, generated with the allowlist, checks that every session is still exactly what the inventory saw. It also counts what the 30-day retention would purge after the reclassification, and what stays untouched outside the allowlist. It runs before migration 066 and writes nothing.

### Mechanism (prepared, not executed; kept outside this repository)

A generator turns an exact allowlist of session ids into three SQL files, so they cannot drift apart:
- **dry run:** every check and the update, then rollback, printing the counts;
- **execute:** the same, then commit;
- **rollback:** restores `mode = 'self'` and the original status, for the allowlisted rows only.

The dry run and the execute file check, before writing anything, that migration 066 is applied. They also check that every allowlisted session is still exactly what the inventory saw: scenario, mode, status, turn counts, no purge, no provider id, no self feedback. After the update, they check that only those rows changed. There is no date-based selection. Rows a closed tab left « active » become `abandoned`, so the one-live-voice-session index cannot trip.

These behaviours were proven on a disposable local database:
- the dry run changes nothing;
- execute changes exactly the allowlisted rows;
- a second execute refuses;
- rollback restores everything;
- tampered data makes the dry run refuse;
- rollback refuses once retention has purged the content.

### Effect of the 30-day retention on reclassified sessions

Legacy sessions are months old, so they are past 30 days on the day they are reclassified. The next retention run then deletes their transcript turns, feedback, scores and engine results, and keeps the session rows without words. Their provider copies are not touched by that run: no conversation id is stored for them (section 3).

**Rollback window:** from the reclassification to the next retention run. Do not run the retention until the reclassification has been checked. After a purge, only a database backup (about 7 days) can bring the content back.

## 3. Historical copies at ElevenLabs

No platform data holds their conversation ids. The pilot logged the id only in the browser console, and the server logs of that period no longer exist. The documented list endpoint, `GET /v1/convai/conversations`, filtered by agent and date range, returns each conversation's id, start time, duration and message counts without a transcript. A read-only matcher compares those fields with each legacy session:
- start within ±120 s;
- same learner and agent message counts;
- duration within ±15 s when known.

It reports matched, unmatched or ambiguous. A conversation claimed by two sessions counts for neither.

Limits:
- the provider may have kept the conversations or not; its default retention is 2 years;
- an earlier agent version may no longer be listable under the same agent;
- a session without a duration is matched on start time and counts alone.

Any match must be confirmed before a deletion, which needs its own authorization. An unmatched or ambiguous conversation stays for manual review in the provider dashboard, by agent and date.
