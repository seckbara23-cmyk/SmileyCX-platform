# XP-F2-READY-01: the approved voice-data policies, as implemented

**Owner decisions, 2026-11-12:**
- **D1:** transcript retention is 30 days.
- **D2:** withdrawing consent stops processing and erases existing voice data, including the provider-held copies.
- **D3:** a voluntary erasure does not reset the five attempts per lesson and access period.

They authorize engineering preparation only. Voice practice stays closed in production. Migration 066 is not applied, no agent exists or was changed, nothing is scheduled, and no legal text is published.

## D1: 30-day retention

| Item | Rule |
|---|---|
| Period | `APPROVED_TRANSCRIPT_RETENTION_DAYS = 30` in `lib/voice/retention.ts`. `VOICE_TRANSCRIPT_RETENTION_DAYS` may only shorten it (1 to 30); a longer or malformed value is a misconfiguration: the run refuses (`VOICE_RETENTION_MISCONFIGURED`, HTTP 500) and purges nothing |
| Start | `ai_sessions.started_at`. A voice session is closed after 15 minutes at most, so start and end are minutes apart |
| Expiry | start + 30 days; deleted by the next run after that |
| Deleted on the platform | `ai_turns`, `ai_feedback`, `ai_scores`, `ai_recommendations` of the session, and `ai_sessions.engine_signals` (it quotes the learner); the session is stamped `content_purged_at` |
| Deleted at the provider | the ElevenLabs conversation, through `DELETE /v1/convai/conversations/{id}`; a failure keeps the id and retries it at every run |
| Second safeguard at the provider | each agent's `platform_settings.privacy.retention_days` = 30, in `lib/voice/agents.manifest.json` (applied only when the agents are provisioned) |
| Kept | the session row without words (attempts and completion depend on it), the consent record, the attempt ledger (D3), the audit log; none holds learner words |
| Status shown | « Le détail de cet entraînement n'est plus conservé » for a purged session; a provider copy still pending is counted as pending, never as deleted |
| Dry run | `runVoiceRetention({ dryRun: true })`, or `GET /api/voice/retention?dryRun=1`: counts what a run would do; no write, no provider call, no alert |
| Schedule | none. The route is behind the cron secret and is not in `vercel.json`; a test keeps it that way |
| Alerts | a provider copy pending more than 3 days: `VOICE_ERASURE_OVERDUE`, failed audit record, HTTP 500; database errors: `VOICE_RETENTION_ERRORS` |

**First run, to know in advance.** On 2026-11-12, all 30 sessions held in production were older than 30 days. They include 230 transcript turns and 11 engine results. Once 066 is applied and a run happens, the policy deletes all of that content at once. That is D1 applied as decided. Run the dry run first and read its counts.

**Backups.** The platform's daily database backups roll over about 7 days. A purged row stays in them until they roll. After any restore, run the retention again at once and replay the erasures recorded since the backup (`voice.data_deleted` audit events). The provider's backups are the provider's: the platform claims nothing about them.

## D2: withdrawal erases

`withdrawVoiceConsent` (app/actions/voice-consent.ts):
1. records the withdrawal; from that moment the server refuses any voice session without a current consent;
2. erases at once, through the shared procedure (lib/voice/erasure.ts): each provider conversation is deleted, or queued without any learner identifier; then the sessions are deleted;
3. answers `erasure: 'complete'` or `'pending_provider'`. If a reference could not even be queued, nothing is deleted and the learner is told to retry. The withdrawal itself stays recorded.

Repeating it is safe: an already-withdrawn consent stays withdrawn, and the erasure finishes what is left. Only the signed-in learner, for their own data, or a platform administrator (`eraseUserVoiceData`, admin user page) can start an erasure. Audit records carry counts and the trigger, never words.

## D3: the attempt ledger

`voice_attempts` (migration 066): one row per started voice attempt, holding the learner, the scenario and the time. No transcript, recording, session link or provider data.

- **Counting:** attempts in the ledger for this learner and scenario since the start of the current access period.
- **Atomic start:** `voice_start_attempt()` takes a per-learner transaction lock, checks the limit and the live session, then writes the session and the attempt together. Executable by the server only.
- **Erasure:** a voluntary or administrator erasure deletes sessions, never ledger rows. Deleting the sessions gives no attempt back.
- **Access period:** a renewal is a new entitlement, so a new period with five new attempts. An expired access has no period, and nothing starts.
- **Account deletion:** the ledger goes with the account (`on delete cascade`).
- **Nature:** the ledger is personal data linked to the learner. It is not anonymous. Its basis and duration are listed for legal review.
- **Self-assessment:** it never touches the ledger.

Tested in-process (concurrent and repeated erasures, renewal, expiry, isolation between learners) and on a disposable local database with 8 real concurrent clients:
- one learner limited to 5 attempts: exactly 5 recorded;
- 8 simultaneous starts: exactly 1 live voice session.
