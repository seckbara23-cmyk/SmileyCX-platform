import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { createLogger } from '@/lib/logger'
import { sendWelcomeEmail } from '@/lib/email'

const log = createLogger('auth/callback')

/**
 * Auth callback handler — two scenarios:
 *
 * 1. EMAIL CONFIRMATION  → exchanges code for session → sends welcome email → redirects to ?next
 * 2. PASSWORD RECOVERY   → forgot-password sets next=/reset-password&type=recovery
 *    The callback exchanges the recovery code for a session, then redirects the
 *    user to /reset-password where they can set a new password with an active
 *    session (supabase.auth.updateUser works in that state).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code    = searchParams.get('code')
  const type    = searchParams.get('type')          // 'recovery' when from forgot-password
  const rawNext = searchParams.get('next') ?? '/dashboard'
  // Prevent open redirect: only allow relative paths
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard'

  if (code) {
    const cookieStore = await cookies()
    // SECURITY (CX-AUTH-1, repairs CX-AUTH-0 finding F-2):
    // This previously supplied { getAll, setAll }. @supabase/ssr@0.3.0 defines
    // CookieMethods as { get, set, remove } and contains ZERO references to
    // getAll — so the adapter was silently ignored, the exchanged session was
    // never persisted, and password recovery / email confirmation could not
    // complete. tsc does not catch the wrong shape (excess-property checking is
    // weak against the intersection option type), which is why it survived.
    // This now matches lib/supabase/server.ts, which was always correct.
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
      }
    )

    const { data: session, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      log.error({ err: error }, 'exchangeCodeForSession failed')
      const errorType = type === 'recovery' ? 'reset_expired' : 'auth_error'
      return NextResponse.redirect(`${origin}/login?error=${errorType}`)
    }

    // Send welcome email on first email confirmation (not password recovery).
    // Guard: email_confirmed_at must exist and be within the last 60 seconds
    // to avoid re-sending on subsequent logins via magic link.
    if (type !== 'recovery' && session?.user) {
      const user = session.user
      const confirmedAt = user.email_confirmed_at ? new Date(user.email_confirmed_at).getTime() : 0
      const isFirstConfirmation = Date.now() - confirmedAt < 60_000

      if (isFirstConfirmation && user.email) {
        const fullName = (user.user_metadata?.full_name as string | undefined) ?? ''
        sendWelcomeEmail(user.email, {
          fullName,
          loginUrl: `${origin}/login`,
        }).catch(err => log.error({ err }, 'Failed to send welcome email'))
      }
    }

    return NextResponse.redirect(`${origin}${next}`)
  }

  // No code param — bad link
  log.warn('No code param in auth callback request')
  return NextResponse.redirect(`${origin}/login?error=auth_error`)
}
