# XP-F2-03: transcript retention, a design to decide

**XP-F2-04 update:** the mechanism described here is now `runVoiceRetention`, with a configurable period, a protected unscheduled route, an erasure queue and overdue alerts. See `XP-F2-04-UAT-AND-PRIVACY.md`, sections 2 and 3, which supersede sections 3 and 6 below where they differ.

**Status: proposal. Not approved, not scheduled, not configured anywhere.** This change builds and tests the mechanism only. Nothing calls it. There is no cron, no production setting and no provider retention setting. The period below is a proposal for the owner to decide, with the privacy text that must announce it.

## 1. What is held, and where

| Data | Where | Carries the learner's words | Kept today |
|---|---|---|---|
| Audio of the conversation | ElevenLabs, per conversation | yes, the voice itself | provider default: 2 years |
| Transcript and post-call analysis (criteria results, rationales) | ElevenLabs, per conversation | yes | provider default: 2 years |
| `ai_turns`: the transcript, turn by turn | platform database | yes | no limit |
| `ai_feedback`: self-assessment answers and coaching reports | platform database | yes | no limit |
| `ai_scores` (evidence) and `ai_recommendations` | platform database | may quote | no limit |
| `ai_sessions.engine_signals`: the engine result, with quoted hints | platform database | yes, quotes | no limit |
| `ai_sessions` row: learner, scenario, dates, status, mode, provider conversation id | platform database | no | needed for attempts per lesson and lesson completion |
| `voice_processing_consents` | platform database | no | proof of consent |
| `audit_log`, `voice.*` events | platform database | no, counts and ids only | audit policy |
| Database backups | Supabase daily backups | a copy of all of the above | rolling window, see section 5 |
| Application logs | hosting logs | no: the voice code never logs bodies, transcripts or signed URLs (tested) | hosting policy |

The feedback needs no new storage: it is computed when the learner asks, from the provider's analysis and the stored turns, and is not saved.

## 2. Proposal: 30 days

After 30 days from the start of a session, everything that carries the learner's words is deleted, here and at the provider. The session row stays, without any words, so attempts per lesson and lesson completion still hold.

| | 30 days |
|---|---|
| For | covers reading the feedback and the retries of a normal study rhythm; short against a six-month access; one rule for voice and self-assessment content |
| Against | after 30 days the learner can no longer reread an old feedback (« Le détail de cet entraînement n’est plus conservé. »); a trainer cannot review older sessions; a dispute raised later has no transcript |
| Shorter: 7 days | most feedback is read right after the call; least data held |
| Longer: 90 days, or to the end of the access period | keeps the learner's history; holds voice data much longer |

## 3. The mechanism (built and tested, not scheduled)

`lib/voice/retention.ts`, `runVoiceRetention(db, { retentionDays })`. The period comes from configuration; `PROPOSED_TRANSCRIPT_RETENTION_DAYS = 30` is used nowhere.

1. **Local content.** For every session started before the period, whatever its mode or status (a closed tab can leave one « active »): delete its `ai_turns`, `ai_feedback`, `ai_scores` and `ai_recommendations`, clear `engine_signals`, stamp `content_purged_at`.
2. **Provider copy.** For every purged session that still has a provider conversation id: delete the conversation at ElevenLabs. On success the id is forgotten. On failure, or without an API key, it stays and is retried on the next run: nothing is ever forgotten before it is deleted.
3. **Audit.** One `voice.retention_purged` record per run, with counts only: sessions purged, provider deletions done and pending, erasures completed, errors.

It works in batches, is idempotent, and a second run finds nothing to do. Sessions created before migration 066, including transcripts already stored, are covered: the selection does not depend on the mode.

Scheduling, when decided: a daily route on the hosting platform's cron, protected by a secret, like the existing payment reconciliation route. A database-side job cannot do it, because the provider deletion needs the API key on the server. An alert is due when a run fails, or when provider deletions stay pending for more than a few days.

## 4. The provider (ElevenLabs), from its documentation

- **Default retention.** « By default, ElevenLabs retains conversation data for 2 years. »
- **Per-agent retention.** `platform_settings.privacy.retention_days`, set in the dashboard or through the API. It applies to transcripts and to audio. The value -1 means unlimited. The value 0 means « scheduled deletion », with no timing documented. A new period can be applied to existing conversations, which « may result in immediate deletion » of older data.
- **Audio saving** can be turned off separately from the transcripts.
- **Zero Retention Mode** is enterprise-only, per agent or for the whole workspace. Call data is then only delivered by post-call webhooks, and debugging support is limited.
- **Deleting one conversation.** `DELETE /v1/convai/conversations/{conversation_id}` returns 200. The reference does not say whether the audio, the transcript and the analysis are all removed, how fast, or what happens to the provider's own backups.

**So provider deletion cannot be guaranteed from the documentation alone.** Questions to send to ElevenLabs before the policy is announced:
1. Does the delete endpoint remove the audio, the transcript and the analysis, at once?
2. How long do deleted conversations survive in the provider's backups?
3. With `retention_days` = 30, when does the deletion run, and does it reach backups?
4. With audio saving off, is the post-call analysis still produced from the transcript?

## 5. Backups

The platform database has daily backups. The documented window on the Pro plan is the last 7 days, rolling. Point-in-time recovery is not enabled. A backup cannot be edited: a purged or erased row stays in the backups for up to about 7 days after its deletion, then disappears as they roll.

- The privacy text must say so: « des copies de sauvegarde peuvent subsister au plus 7 jours ».
- If a backup is ever restored, the purge must be run again at once, and every erasure recorded since the backup (`voice.data_deleted` audit events) must be replayed.
- Enabling point-in-time recovery would lengthen this window. The text would then have to change too.

## 6. Withdrawal and deletion, as built

| Flow | What it does |
|---|---|
| `withdrawVoiceConsent` | stops any new voice session. It deletes nothing: deletion is its own action. To decide: should withdrawal offer, or trigger, the deletion? |
| `deleteMyVoiceData` | deletes each conversation at the provider, then the learner's sessions here (turns, feedback, scores, recommendations by cascade). When the provider cannot delete now, the sessions are still deleted at once, and the conversation id alone goes to a queue that names no learner, retried until the provider confirms (XP-F2-04). |
| Account deletion by an admin | runs the same erasure first (XP-F2-04): provider copies deleted or queued, and the account is not deleted if neither is possible. |
| Attempts after an erasure | deleting the sessions also resets the five attempts per lesson. The action is limited to three per hour. To decide whether that is acceptable. |

## 7. If provider deletion cannot be guaranteed

Defence in depth, in this order:
1. **Set `retention_days` on the five agents to the approved period**, at provisioning time and only after approval. The provider then deletes by itself, even when a delete call failed.
2. **Turn off audio saving** at the provider, if the answer to question 4 allows it. The voice recording is the most sensitive data, and the analysis does not need it.
3. **A shorter period at the provider than here**, for example 7 days there and 30 here. The feedback must then be computed and kept before the provider copy goes: its verdicts and rationales, never the transcript.
4. **Zero Retention Mode** with post-call webhooks, if the plan allows it. This is more work and a higher cost.
5. **Never announce more than is confirmed.** Until ElevenLabs answers, the privacy text states the provider's retention period, not an immediate deletion.

## 8. Before a period is live

1. The owner decides the period and the alternative above.
2. The privacy policy and the consent text announce it. Today the consent says the platform keeps the transcript and the analysis, without a period: a new consent version is needed. The legal pages are approved 1.0, so this needs its own authorization.
3. Migration 066 is applied (it adds `content_purged_at` and the erasure queue).
4. The daily schedule and the alert are added in a reviewed change.
5. ElevenLabs has answered the four questions, and the agents' `retention_days` is set at provisioning.
