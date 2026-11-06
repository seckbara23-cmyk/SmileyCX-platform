import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { createLogger } from '@/lib/logger'
import { logAuditEvent } from '@/lib/audit/log'
import { publicUrl } from '@/lib/brand'

const log = createLogger('auth/recover')

/**
 * Password-recovery landing (XP-LAUNCH-01).
 *
 * The learner arrives here from the link in the password-reset email the
 * platform sends itself (`requestPasswordReset`). The hashed token is exchanged
 * for a recovery session with `verifyOtp`, which is what lets /reset-password
 * call `updateUser({ password })`.
 *
 * ── WHY A TOKEN HASH, NOT THE PKCE CODE OF /auth/callback ─────────────────
 * The previous flow let Supabase send its own email whose link came back to
 * /auth/callback with a PKCE `code`. A PKCE code can only be exchanged by the
 * browser that holds the matching verifier cookie: the browser, on the host,
 * where "forgot password" was submitted. Recovery links are routinely opened
 * elsewhere (the phone's mail app, another browser, after a mail scanner has
 * followed the link first, or on the public host after a request made on the
 * internal one), and every one of those ended on /login with "link expired".
 * A token hash needs no state in the browser, so the link works wherever it is
 * opened. Registration has worked this way since XPA-6A (`/auth/verify`).
 *
 * ── WHY A DEDICATED ROUTE ─────────────────────────────────────────────────
 * Same reason as /auth/verify: PKCE code exchange, signup OTP and recovery OTP
 * are three Supabase primitives. One handler per primitive keeps a mistake in
 * one path from silently changing another. /auth/callback keeps handling the
 * PKCE links of emails sent before this change.
 *
 * Every redirect is absolute on the canonical public domain.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type      = searchParams.get('type') ?? 'recovery'

  if (!tokenHash || type !== 'recovery') {
    log.warn({ type, hasToken: Boolean(tokenHash) }, 'Malformed recovery link')
    return NextResponse.redirect(publicUrl('/reset-password?error=invalid'))
  }

  const cookieStore = await cookies()

  // @supabase/ssr@0.3.0 CookieMethods is { get, set, remove }; the getAll/setAll
  // shape is silently ignored by this version (CX-AUTH-0 finding F-2).
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])
        },
        remove(name: string, options: CookieOptions) {
          cookieStore.set(name, '', { ...options, maxAge: 0 })
        },
      },
    },
  )

  const { data, error } = await supabase.auth.verifyOtp({
    type:       'recovery',
    token_hash: tokenHash,
  })

  if (error || !data.user) {
    // The token itself is never logged or audited.
    log.warn({ err: error?.message }, 'Recovery link refused')
    await logAuditEvent({
      eventType: 'user.password_recovery_opened',
      actorType: 'self',
      method:    'email_link',
      outcome:   'failure',
      reason:    error?.message ?? 'verifyOtp returned no user',
    })
    return NextResponse.redirect(publicUrl('/reset-password?error=expired'))
  }

  await logAuditEvent({
    eventType:     'user.password_recovery_opened',
    actorType:     'self',
    subjectUserId: data.user.id,
    subjectEmail:  data.user.email ?? null,
    method:        'email_link',
    outcome:       'success',
  })

  // A recovery session is now in the cookies; the page shows the new-password
  // form only when it finds one.
  return NextResponse.redirect(publicUrl('/reset-password'))
}
