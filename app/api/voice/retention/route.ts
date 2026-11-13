import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { configuredRetentionDays, runVoiceRetention } from '@/lib/voice/retention'
import { createLogger } from '@/lib/logger'

/**
 * Voice retention and provider-erasure run — XP-F2-04.
 *
 * `GET /api/voice/retention`. NOT SCHEDULED: `vercel.json` lists no cron for
 * it, and a test keeps it that way until the owner authorizes a schedule. It
 * exists so the mechanism can be exercised deliberately, and scheduled later by
 * a one-line reviewed change.
 *
 * Authentication is the cron secret, as for the payment reconciliation: without
 * `CRON_SECRET` it refuses everything (503), and the comparison is constant
 * time over SHA-256 digests.
 *
 * What a run does (lib/voice/retention.ts): it purges the content of sessions
 * older than the approved period (30 days, decision D1; the environment may only
 * shorten it), and retries the provider erasures still pending. `?dryRun=1`
 * counts what a run would do and changes nothing. It answers with COUNTS only:
 * no conversation id, transcript or identity. 500 when the period is
 * misconfigured, or something failed or is overdue, so a scheduler's own
 * failure alert fires.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = createLogger('api/voice/retention')

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest()
}

function authorised(req: Request, secret: string): boolean {
  const given = req.headers.get('authorization') ?? ''
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`))
}

export async function GET(req: Request) {
  const secret = (process.env.CRON_SECRET ?? '').trim()
  if (secret.length < 16) {
    log.error('voice retention refused: CRON_SECRET is not configured')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  if (!authorised(req, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const retentionDays = configuredRetentionDays()
  if (retentionDays === null) {
    log.error({ code: 'VOICE_RETENTION_MISCONFIGURED' }, 'voice retention refused: the period setting is malformed or longer than the policy')
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 })
  }
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

  try {
    const result = await runVoiceRetention(createAdminClient(), {
      retentionDays,
      dryRun,
      apiKey: process.env.ELEVENLABS_API_KEY,
    })
    const healthy = result.errors === 0 && result.overdue === 0
    return NextResponse.json({ ok: healthy, ...result }, { status: healthy ? 200 : 500 })
  } catch (e) {
    log.error({ error: (e as Error).message }, 'voice retention run failed')
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
