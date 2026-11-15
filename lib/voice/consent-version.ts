/**
 * The voice-processing consent version learners accept today.
 *
 * Client-safe on purpose: the public opening switch in `lib/ai/flags.ts`
 * compares the published legal texts' version with it, on the server and in
 * the browser bundle alike. The consent text and the policy around it stay in
 * `lib/voice/session-policy.ts` (server-only), which re-exports this constant.
 */
export const VOICE_CONSENT_VERSION = 'voix-1.0'
