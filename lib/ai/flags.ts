/**
 * AI Practice Engine feature flags.
 *
 * AI_VOICE_ENABLED — global kill-switch for the Voice Practice UI. Default OFF.
 * When false, the lesson player performs no AI queries and renders no Voice
 * Practice surface, so behavior is identical to before this feature existed.
 * Flip to true (env) only after the migration is applied and a scenario is
 * published. Instant rollback = set back to false (no deploy needed).
 */
export const AI_VOICE_ENABLED = process.env.NEXT_PUBLIC_AI_VOICE_ENABLED === 'true'
