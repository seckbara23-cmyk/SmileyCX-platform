/**
 * Structured logger for server-side use only.
 *
 * In production: outputs JSON (consumed by log aggregators like Datadog,
 * Logtail, or Vercel Log Drains).
 * In development: pretty-prints to the terminal via pino-pretty.
 *
 * Usage:
 *   import { logger } from '@/lib/logger'
 *   logger.info({ userId }, 'User enrolled in course')
 *   logger.error({ err, courseId }, 'Enrollment failed')
 *
 * NEVER import this in client components — pino is a server-only module.
 * Add 'server-only' import if you want a compile-time guard.
 */

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    // Redact common sensitive fields so they never appear in logs
    redact: {
      paths: ['password', 'token', 'authorization', 'cookie', '*.password', '*.token'],
      censor: '[REDACTED]',
    },
    base: {
      env: process.env.NODE_ENV,
      app: 'smileycx',
    },
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,env,app' },
      })
    : undefined,
)

/** Child logger pre-tagged with a module name for easier log filtering. */
export function createLogger(module: string) {
  return logger.child({ module })
}
