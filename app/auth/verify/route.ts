import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { createLogger } from '@/lib/logger'
import { logAuditEvent } from '@/lib/audit/log'
import { sendWelcomeEmail } from '@/lib/email'
import { publicUrl } from '@/lib/brand'

const log = createLogger('auth/verify')

/**
 * Email-verification landing (XPA-6A).
 *
 * The learner arrives here from the link in their verification email. The token
 * is exchanged for a session, which is what sets `email_confirmed_at` on the
 * auth user — verified against this project, including that a replayed token is
 * refused with `otp_expired`.
 *
 * ── WHY A DEDICATED ROUTE AND NOT /auth/callback ──────────────────────────
 * The callback handles PKCE `code` exchange. This handles an OTP `token_hash`.
 * They are different Supabase primitives, and folding them together would mean
 * one branchy handler where a mistake in the recovery path silently changes the
 * verification path.
 *
 * ── REDIRECTS ARE ABSOLUTE, ON THE CANONICAL DOMAIN ───────────────────────
 * Every redirect is built from PUBLIC_SITE_URL rather than from the request
 * origin. A learner who somehow reaches this route on the internal hostname is
 * returned to the commercial site, not kept on the internal one.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type      = searchParams.get('type') ?? 'signup'

  if (!tokenHash || type !== 'signup') {
    log.warn({ type, hasToken: Boolean(tokenHash) }, 'Malformed verification link')
    return NextResponse.redirect(publicUrl('/login?error=verify_invalid'))
  }

  const cookieStore = await cookies()

  // @supabase/ssr@0.3.0 CookieMethods is { get, set, remove }. It has ZERO
  // references to getAll/setAll — supplying that shape is silently ignored and
  // the exchanged session is never persisted (CX-AUTH-0 finding F-2).
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
    type:       'signup',
    token_hash: tokenHash,
  })

  if (error || !data.user) {
    log.warn({ err: error?.message }, 'Email verification failed')
    await logAuditEvent({
      eventType: 'user.email_verified',
      actorType: 'self',
      method:    'email_link',
      outcome:   'failure',
      // The token itself is never logged or audited.
      reason:    error?.message ?? 'verifyOtp returned no user',
    })
    return NextResponse.redirect(publicUrl('/login?error=verify_expired'))
  }

  await logAuditEvent({
    eventType:     'user.email_verified',
    actorType:     'self',
    subjectUserId: data.user.id,
    subjectEmail:  data.user.email ?? null,
    method:        'email_link',
    outcome:       'success',
  })

  // Welcome email is best-effort and must never block activation.
  if (data.user.email) {
    const fullName = (data.user.user_metadata?.full_name as string | undefined) ?? ''
    sendWelcomeEmail(data.user.email, {
      fullName,
      loginUrl: publicUrl('/login'),
    }).catch(err => log.error({ err }, 'Failed to send welcome email'))
  }

  // Verified and signed in. The dashboard is the honest destination: it shows an
  // active account with no courses, which is exactly the true state.
  return NextResponse.redirect(publicUrl('/dashboard?verified=1'))
}
