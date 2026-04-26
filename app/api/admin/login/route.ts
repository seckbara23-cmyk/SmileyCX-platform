import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { createLogger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'

const log = createLogger('api/admin/login')

// 5 attempts per 15-minute window per IP
const RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 }

export async function POST(request: NextRequest) {
  const origin = new URL(request.url).origin

  // ── Rate limiting ────────────────────────────────────────────────────────────
  const ip = getClientIp(request)
  const rl = rateLimit(`admin-login:${ip}`, RATE_LIMIT)
  if (!rl.success) {
    const retryAfterSec = Math.ceil((rl.resetAt - Date.now()) / 1000)
    return NextResponse.redirect(`${origin}/admin/login?error=too_many_attempts`, {
      status: 303,
      headers: { 'Retry-After': String(retryAfterSec) },
    })
  }

  try {
    const formData      = await request.formData()
    const username      = (formData.get('username') as string | null)?.trim() ?? ''
    const password      = (formData.get('password') as string | null)?.trim() ?? ''
    const adminUsername = process.env.ADMIN_USERNAME
    const adminEmail    = process.env.ADMIN_EMAIL

    if (!adminUsername || !adminEmail) {
      return NextResponse.redirect(`${origin}/admin/login?error=not_configured`, { status: 303 })
    }

    if (!username || !password) {
      return NextResponse.redirect(`${origin}/admin/login?error=invalid`, { status: 303 })
    }

    if (username.toLowerCase() !== adminUsername.trim().toLowerCase()) {
      return NextResponse.redirect(`${origin}/admin/login?error=invalid`, { status: 303 })
    }

    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    )

    const { data, error } = await supabase.auth.signInWithPassword({
      email: adminEmail, password,
    })

    if (error || !data?.user) {
      return NextResponse.redirect(`${origin}/admin/login?error=invalid`, { status: 303 })
    }

    // Verify super_admin role
    const { data: profile } = await createAdminClient()
      .from('profiles')
      .select('platform_role')
      .eq('id', data.user.id)
      .single()

    if (profile?.platform_role !== 'super_admin') {
      return NextResponse.redirect(`${origin}/admin/login?error=forbidden`, { status: 303 })
    }

    // Set a simple HttpOnly cookie the middleware and admin layout read directly.
    // This bypasses @supabase/ssr session cookie issues entirely.
    const response = NextResponse.redirect(`${origin}/admin`, { status: 303 })
    response.cookies.set('scx_admin', data.user.id, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   60 * 60 * 8, // 8 hours
    })
    return response

  } catch (err) {
    log.error({ err }, 'Unhandled exception in admin login')
    return NextResponse.redirect(`${new URL(request.url).origin}/admin/login?error=server`, { status: 303 })
  }
}
