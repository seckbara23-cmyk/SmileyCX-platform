import { VOICE_CONSENT_VERSION } from '@/lib/voice/consent-version'

/**
 * AI Practice Engine feature flags.
 *
 * AI_VOICE_ENABLED — global kill-switch for the Voice Practice UI. Default OFF.
 * When false, the lesson player performs no AI queries and renders no Voice
 * Practice surface, so behavior is identical to before this feature existed.
 * A `NEXT_PUBLIC_` value is fixed when the deployment is built: changing it
 * takes effect at the next deployment (a redeploy of the same commit is enough).
 */
export const AI_VOICE_ENABLED = process.env.NEXT_PUBLIC_AI_VOICE_ENABLED === 'true'

/**
 * XP-LAUNCH-FINAL-18, XP-VOICE-FIX-01 — the legal condition for opening voice
 * practice to every entitled learner.
 *
 * Until XP-VOICE-FIX-01 this was a constant set to `false`, because the legal
 * texts require two features that did not exist yet: the five-attempt limit
 * per lesson (CGV art. 8) and the explicit consent to the voice processing
 * (privacy policy art. 6). Both now exist and are enforced by the server
 * (`lib/voice/session-policy.ts`, migration 066).
 *
 * What remains is a decision, not code: publishing the legal texts that
 * describe voice practice. The published texts still say it is not open. The
 * owner records that decision by setting `NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION`
 * to the consent version those texts describe. It must equal the version the
 * code asks learners to accept: absent, empty or naming any other version
 * (a stale one included), voice practice stays closed. Moving the consent to a
 * new version therefore closes it again until the texts follow.
 */
export const VOICE_LEGAL_TEXTS_ENV = 'NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION'
export const VOICE_LEGAL_TEXTS_PUBLISHED =
  process.env.NEXT_PUBLIC_VOICE_LEGAL_TEXTS_VERSION === VOICE_CONSENT_VERSION

/**
 * Public opening: both the feature switch and the legal condition. The lesson
 * page and every voice server action consult it (through `lib/voice/access.ts`);
 * a restricted UAT is the only other way in.
 */
export const VOICE_PRACTICE_OPEN = AI_VOICE_ENABLED && VOICE_LEGAL_TEXTS_PUBLISHED

/**
 * XP-F2-04 — restricted UAT. Set at build time on a deployment made for a UAT,
 * it only makes the lesson page ASK the server whether a voice exercise is
 * available. The server answers per account (lib/voice/access.ts): for anyone
 * outside the UAT list the answer is « none », and nothing is shown. It opens
 * nothing by itself.
 */
export const VOICE_UAT_CLIENT_PROBE = process.env.NEXT_PUBLIC_VOICE_UAT === 'true'

/** Whether the lesson page asks the server for a voice exercise at all. */
export const VOICE_LESSON_PROBE = VOICE_PRACTICE_OPEN || VOICE_UAT_CLIENT_PROBE

export const VOICE_CLOSED_MESSAGE = 'L’entraînement vocal n’est pas encore ouvert.'

/**
 * AI_COACH_ENABLED — Phase 2A kill-switch for the deterministic AI Coach
 * (briefing, competency engine, replay, coaching summary). Default OFF.
 * When false, Voice Practice behaves exactly like Phase 1B: no briefing,
 * no engine run, no coach queries. Requires migration 025 to be applied
 * BEFORE enabling. No LLM is involved in Phase 2A either way.
 */
export const AI_COACH_ENABLED = process.env.NEXT_PUBLIC_AI_COACH_ENABLED === 'true'

/**
 * AI_COACH_CLAUDE_ENABLED — Phase 2B kill-switch for the one-shot Claude
 * evaluation. Default OFF. When false, no Claude/Anthropic call is ever made
 * and the coach debrief shows only the deterministic report. Requires the coach
 * flag on, migration 026 applied, and ANTHROPIC_API_KEY set on the server.
 * Instant rollback = set back to false (stored reports remain readable).
 */
export const AI_COACH_CLAUDE_ENABLED =
  process.env.NEXT_PUBLIC_AI_COACH_CLAUDE_ENABLED === 'true'
