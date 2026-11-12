# ElevenLabs privacy: what the documentation confirms, and what to ask

Read on 2026-11-12 from the official ElevenLabs documentation. No agent was accessed, created or changed. Nothing here is a guarantee: where the documentation is silent, the platform claims nothing.

| Question | Documented | Status |
|---|---|---|
| 1. Does deleting a conversation remove the audio, the transcript and the analysis? | The API reference says only « Delete a particular conversation », with HTTP 200 on success and 422 on a validation error. It does not name what is removed | **Uncertain: ask** |
| 2. Are backups or secondary copies covered? | Not mentioned on the delete, retention or privacy pages | **Uncertain: ask** |
| 3. How does the agent retention setting interact with deletion? | `platform_settings.privacy.retention_days` controls how long transcripts and audio are kept. The default is 2 years; -1 means unlimited; 0 means « scheduled deletion », with no timing given. A new period can be applied to existing conversations, which « may result in immediate deletion » of older data. Nothing says how it combines with a deletion call | **Partly confirmed** |
| 4. Do Zero Retention Mode or disabled audio saving change the requirements? | Audio saving decides whether call audio is stored. Zero Retention Mode stores no recordings, and « no transcripts or call metadata containing PII »; call data is then delivered only by post-call webhooks. It is per agent unless enforced for the whole workspace. The pages do not say whether the evaluation-criteria analysis, which the feedback reads, is still available in either mode | **Partly confirmed; the effect on the analysis must be asked** |

## Consequences for the platform

- The platform never tells a learner that the provider copy is « deleted » on the strength of a 200 alone. The text says the deletion was **requested**, and the request is retried until the provider accepts it.
- The agents carry `retention_days` = 30 (decision D1), so the provider deletes on its own even if a call failed. Whether to apply it to the existing Ibrahima agent's past conversations is a provisioning decision.
- Zero Retention Mode would replace the analysis read (`GET /v1/convai/conversations/{id}`) with a post-call webhook: a new, authenticated endpoint. It is not built. It is worth it only if the answer to question 4 requires it.

## The questions to send (written answers needed)

1. When `DELETE /v1/convai/conversations/{conversation_id}` returns 200, are the audio recording, the transcript, the post-call analysis (including evaluation-criteria results) and the conversation metadata all deleted? Immediately, or within what delay?
2. After that deletion, or after expiry under `retention_days`, how long can copies remain in backups, logs or replicas, and are they deleted at the end of that period?
3. When an agent has `retention_days` = 30, when exactly does the deletion run, and are conversations deleted by a separate DELETE call before then handled identically?
4. If audio saving is turned off, or Zero Retention Mode is enabled, is the post-call analysis with evaluation-criteria results still produced, and how is it retrieved? Is Zero Retention Mode available on our current plan?
5. In which region are conversations processed and stored for our workspace, and can EU or another residency be selected? (Needed for the legal review of transfers.)
