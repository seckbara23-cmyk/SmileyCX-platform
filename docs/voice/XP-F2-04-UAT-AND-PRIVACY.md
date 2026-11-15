# XP-F2-04: voice training, security hardening and restricted UAT readiness

**Status: voice practice is closed in production and stays closed after this change.** Nothing here was applied, provisioned, scheduled or published: migration 066 is unapplied, no ElevenLabs agent was created or changed, no retention schedule exists, and the legal texts are unchanged. A live UAT is **not yet possible**: it needs the owner's steps in section 7.

## 1. What this change closes

| Gap left by F2-03 | Now |
|---|---|
| Deleting an account from the admin page left the learner's conversations at the voice provider, with no reference left to delete them | The provider copies are dealt with before the account goes: deleted, or queued for retry. If neither is possible, the account is not deleted |
| A learner's erasure kept a marked session row when the provider failed | The sessions are always deleted at once. The provider reference moves to a queue that names no learner |
| The retention purge existed only as a function with a hard-wired proposal | A configurable period, a protected route, retries, overdue alerts. Still scheduled by nothing |
| Withdrawal and deletion had server actions but no screen | « Mes données vocales » under the exercise: withdraw the consent, delete the data |
| No way to test with one account without opening voice to everyone | A server-side list of UAT accounts, empty by default |

## 2. Erasure lifecycle

One procedure, `lib/voice/erasure.ts`, serves the learner's own request and the admin account deletion.

1. Read the account's sessions and their provider conversation ids.
2. For each conversation, ask the provider to delete it. « Already gone » counts as deleted.
3. A conversation the provider did not delete (error, time-out, no API key) is written to `voice_provider_erasures`: the conversation id, a reason and dates. **No learner id, no session id, no content.**
4. Only then are the sessions deleted (learner request), or the account (admin), which cascades to them.
5. If a pending reference cannot be queued, **nothing is deleted** and the caller is told. The learner reads « La suppression n'a pas pu être effectuée ». The administrator reads that the account was not deleted and can retry.
6. The queue is retried by the retention run until the provider confirms. Each attempt is counted, and success is dated.

What is recorded: the audit log keeps `voice.data_deleted` or `user.deleted` with counts (sessions, provider copies deleted, provider copies queued) and the failure step. It never holds a transcript or a quote. A provider copy still pending is never reported as deleted: the learner's screen says the provider deletion is still being retried.

Before migration 066 exists in a database, no conversation id was ever stored, so account deletion behaves exactly as before. This is tested, because the admin deletion is live today.

## 3. Retention infrastructure

- **Policy (superseded by XP-F2-READY-01):** 30 days, approved by the owner (decision D1). `VOICE_TRANSCRIPT_RETENTION_DAYS` may only shorten it. See `XP-F2-READY-01-POLICY.md`.
- **Run:** `runVoiceRetention` in `lib/voice/retention.ts`.
  1. With a period: for sessions started before it, delete turns, feedback, scores and recommendations, clear the engine result (it quotes the learner), stamp the session. The session row stays, without words.
  2. Delete the provider conversation of each purged session; a failure is kept and retried.
  3. Always: retry the erasure queue.
- **Route:** `GET /api/voice/retention`, protected by the cron secret, answering counts only. It is **not listed in `vercel.json`**, and a test keeps it unlisted. Scheduling it later is a one-line reviewed change.
- **Alerts:** a provider copy still pending after 3 days is overdue. The run then writes an error log with the code `VOICE_ERASURE_OVERDUE`, a failed audit record, and the route answers 500 so a scheduler's failure alert fires. Database errors raise `VOICE_RETENTION_ERRORS` the same way.
- **Idempotent:** a second run finds nothing to do; a retry never deletes twice or loses a reference.

Limits that code cannot remove, to state in the privacy text:
- **Database backups.** Daily backups roll over about 7 days. A deleted row stays in them until they roll. After any restore, the retention run and every erasure since the backup must be replayed.
- **Provider.** ElevenLabs documents a delete endpoint for a conversation and a per-agent retention period, 2 years by default. It does not document whether a deletion reaches audio, analysis and its own backups at once. So the platform never claims immediate, complete deletion at the provider. Safeguards: set the agents' retention period at provisioning, turn audio saving off if the analysis allows it, and get the four written answers listed in `XP-F2-03-RETENTION.md`.

## 4. Migration 066, as revised

Unapplied. It changes no existing row.

| Check | Result |
|---|---|
| Existing sessions | every one becomes mode « self »; none is rewritten otherwise |
| One live session rule | voice sessions only; self-assessment is never constrained |
| Consent table | row security; a learner reads only their own rows; only the server writes |
| Erasure queue | row security with no policy; no browser role has any privilege; no learner identifier |
| Learner-owned AI tables | browser roles keep SELECT under row security and lose every write right, TRUNCATE included |
| Assertions | the migration aborts if any of the above is not true after it ran |

Rollback is the commented block at the end of the migration. Its limits: the privilege revokes are deliberately not reverted, and the queue must not be dropped while it holds pending rows, or those provider copies are forgotten. Once voice sessions exist, dropping `mode` and `provider_conversation_id` loses the attempt counts and the provider references: roll back only while voice is closed.

## 5. Consent and legal readiness

The mechanism is built and tested: a versioned consent (`voix-1.0`), an unticked box, a server-side record, refusal of any voice session without it, withdrawal that blocks the next start, and deletion. The proposed wording for the privacy notice, the consent screen, the retention sentence and the deletion instructions is in `F2-04-TEXTES-JURIDIQUES-PROPOSES.md`. **None of it is published.** Publishing needs the owner's approval, a new version of the legal pages, and a new consent version in code.

## 6. Restricted UAT architecture

| Requirement | How it is met |
|---|---|
| Authenticated access | every voice action needs a signed-in account |
| Named testers only | `VOICE_UAT_USER_IDS`, a server-only list of at most 5 account ids. Empty by default. A malformed or oversized list opens nothing |
| Everyone else | gets « pas encore ouvert », exactly as today, for every action |
| Course entitlement | checked on the scenario read and on each session start |
| Five scenarios only | under UAT, a scenario without a reviewed persona is refused |
| Consent and limits | the same consent step, one live voice session, five attempts per lesson |
| No public exposure | the lesson page asks the server for a voice exercise only on a build made with `NEXT_PUBLIC_VOICE_UAT=true`. The server answers « none » to anyone outside the list, so nothing is shown |
| Rollback | empty `VOICE_UAT_USER_IDS`: closed at the next request, no code deployment. The tester can still withdraw and delete |
| Clean termination | a voice session left open is closed after 15 minutes; « Mes données vocales » deletes the tester's sessions, here and at the provider |

`VOICE_PRACTICE_OPEN` is untouched and still false. The UAT list is a second, narrower door; it does not open the first.

### How a tester reaches each exercise

Course « Les fondamentaux du service client » (C1-F2), from « Mes formations »:

| Exercise | Module | Lesson |
|---|---|---|
| Amara | 2 | 4 · Reformuler pour montrer qu'on a compris |
| Fatou | 2 | 5 · Les mots qui apaisent, les mots à bannir |
| Ibrahima | 3 | 2 · Garder son calme et désamorcer la tension |
| Kader | 3 | 4 · Dire non sans braquer le client |
| Awa | 4 | 2 · Bien gérer une réclamation, du début à la fin |

The voice block is at the bottom of each lesson, under the lesson's content. The lessons themselves are ordinary course lessons: they are visible to every learner with access to the course today, with or without the voice block. That was checked against production: the course is published and all five lessons exist and are linked to their scenario.

## 7. What a live UAT still needs

In this order, each under the owner's authorization:

1. Marième's approval of the pedagogical dossier.
2. The retention decision, and the legal texts published in a new version, with a new consent version in code.
3. Migration 066 applied, after a fresh read-only preflight.
4. Four agents created from `lib/voice/agents.manifest.json`, Ibrahima's agent updated, the retention period set on all five. `scripts/voice/compare-agents.mjs` must then show every agent matching.
5. The four agent ids stored and the four scenarios published, by a reviewed migration.
6. This branch merged and deployed with `NEXT_PUBLIC_VOICE_UAT=true`, and `VOICE_UAT_USER_IDS` set to the tester's account id. The tester needs access to C1-F2.
7. A smoke test by the owner with a listed account, and with an unlisted one that must see nothing.

Until step 7 passes, there is no working UAT environment and no test URL to hand out.
