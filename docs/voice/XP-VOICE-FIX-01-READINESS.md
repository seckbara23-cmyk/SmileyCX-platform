# XP-VOICE-FIX-01: restoring the F2 voice exercises behind a reviewed switch

**Status: voice practice stays closed in production after this change.** Merging it opens nothing: the public switch needs a variable that no environment sets, and a restricted UAT still needs its own variables. No migration, agent, legal text or environment variable is changed by this PR.

## 1. Why the exercises did not display

`lib/ai/flags.ts` held `VOICE_LEGAL_CONDITIONS_BUILT = false`. `VOICE_PRACTICE_OPEN` was `AI_VOICE_ENABLED && false`, so the lesson page never asked for a voice scenario and never rendered `VoicePracticeBlock`, whatever the environment said. The constant was deliberate (XP-LAUNCH-FINAL-18). The legal texts require two features before voice opens: the five-attempt limit per lesson (CGV art. 8) and explicit consent to the voice processing (privacy policy art. 6). Neither existed then.

Both exist now on the voice foundation branch (PR #69):
- consent per version, checked by the server before every start;
- the attempt ledger, and the atomic start in migration 066.

The constant was therefore obsolete as code. It still stood for one real condition: the published legal texts say voice practice is not open yet.

## 2. The switch that replaces it

```
VOICE_PRACTICE_OPEN = NEXT_PUBLIC_AI_VOICE_ENABLED === 'true'
                   && NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION === VOICE_CONSENT_VERSION
```

- `VOICE_CONSENT_VERSION` is the consent version learners accept, today `voix-1.0`. It is defined once, in `lib/voice/consent-version.ts`.
- The owner sets `NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION` when the legal texts that describe voice practice are published. The value is the consent version those texts describe.
- Voice stays closed if the variable is absent or empty, or if it names any other version, a stale one included. When the consent moves to a new version, voice closes again until the texts follow.
- Both variables are fixed when a deployment is built. A change takes effect at the next deployment, and a redeploy of the same commit is enough.
- A restricted UAT does not use this switch. It still goes through `VOICE_UAT_USER_IDS` and `NEXT_PUBLIC_VOICE_UAT` (see `XP-F2-04-UAT-AND-PRIVACY.md`).

## 3. What else changed

| Gap found | Now |
|---|---|
| A learner learned how many attempts were left only after starting, and a learner with none left was asked for the microphone, then refused | The exercise shows « Essais vocaux restants pour cette leçon : N sur 5 » before the start. With none left, it shows the French reason and the start button is disabled. The server still re-checks atomically at the start |
| An account that reaches the course without an inscription, an administrator for instance, saw the exercise, then got « momentanément indisponible » | A distinct refusal, `no_access_period`, with its own French message. The exercise says so before the start |
| Four of the five scenarios have no self-assessment questions, so the form after their conversation was empty | Every reviewed scenario gets questions derived from its observation criteria: one scale question per criterion, then one open question. They replace Ibrahima's older database questions, as the reviewed brief already does. The questions are listed in the approval dossier for Marième |
| The comments said that emptying the UAT list closes it « at once » | Vercel applies environment changes to new deployments only. The comments and `.env.example` now say: at the next deployment |

## 4. When an attempt is consumed

An attempt is consumed when the server holds a signed URL from ElevenLabs and records the session together with its attempt (`voice_start_attempt`, under a per-learner lock). The browser connects after that.

Nothing is consumed by:
- a refusal, whether no consent, no access, a session in progress or no attempt left;
- a denied microphone, because the browser checks it before calling the server;
- a provider error before the signed URL.

A connection that drops after the start counts as an attempt.

## 5. Tests

- `__tests__/learning/xp-voice-fix-01-readiness.test.ts`:
  - the switch matrix: eight combinations, only one opens;
  - the server gate when voice is open publicly;
  - the hard-coded blocker is gone;
  - the derived questions;
  - no secret in client code.
- `__tests__/learning/xp-voice-fix-01-block.test.tsx` renders the exercise in jsdom:
  - the counter, and the disabled start when no attempt remains;
  - the consent step, which needs the box ticked;
  - microphone refused, and the server never called;
  - server refusals shown in French.
- `__tests__/security/xp-f2-voice-session-security.test.ts`, new section XP-VOICE-FIX-01:
  - the counter before the start, then exhausted;
  - no access period;
  - a stale consent version;
  - the provider refusing, failing or returning a malformed URL: no session, no attempt, no body logged;
  - no API key;
  - unpublished scenarios hidden;
  - no course access;
  - derived questions;
  - the counter unreadable.

## 6. Before voice opens to every learner

1. Marième approves the dossier, including the new self-assessment questions.
2. The four new agents are provisioned and Ibrahima's is updated, then the four scenarios are linked and published. These are owner-authorised steps outside this PR.
3. The owner publishes the legal texts (`F2-04-TEXTES-JURIDIQUES-PROPOSES.md`). If they describe `voix-1.1`, a reviewed change activates that version in `lib/voice/consent-version.ts` and `session-policy.ts` first.
4. The owner sets `NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION` and `NEXT_PUBLIC_AI_VOICE_ENABLED=true`, then deploys.

**Rollback:** unset either variable and redeploy.
