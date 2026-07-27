import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Sign out (CX-AUTH-1).
 *
 * Two callers:
 *  1. The owner clicking "Déconnexion".
 *  2. The middleware host boundary, when an authenticated NON-owner reaches the
 *     administration portal. Rather than leaving a valid foreign session on the
 *     admin host, the session is destroyed and the visitor is returned to
 *     /login with "Accès non autorisé".
 *
 * supabase.auth.signOut() revokes the refresh token server-side and clears the
 * auth cookies through the adapter below, so this is a real session teardown —
 * not merely dropping a cookie in one browser.
 *
 * GET is accepted because the middleware redirects here. The handler is
 * idempotent and destroys state only for the caller's own session, so it
 * carries no CSRF consequence: an attacker who forges it can only log a user
 * out, never in.
 */
async function handle(request: NextRequest) {
  const error = new URL(request.url).searchParams.get('error')
  const target = new URL(error ? `/login?error=${encodeURIComponent(error)}` : '/login', request.url)

  const response = NextResponse.redirect(target)
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
        },
        remove(name: string, options: CookieOptions) {
          response.cookies.set(name, '', { ...options, maxAge: 0 })
        },
      },
    }
  )

  await supabase.auth.signOut()

  // Belt and braces: drop the retired admin cookie if any browser still holds
  // one from before CX-AUTH-1. Nothing reads it any more, but leaving stale
  // auth-looking cookies around is a footgun.
  response.cookies.set('scx_admin', '', { path: '/', maxAge: 0 })

  return response
}

export async function GET(request: NextRequest)  { return handle(request) }
export async function POST(request: NextRequest) { return handle(request) }
