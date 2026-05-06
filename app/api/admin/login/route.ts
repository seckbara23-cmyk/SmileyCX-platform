import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimitDb, getClientIp } from '@/lib/rate-limit'
import { createLogger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'

const log = createLogger('api/admin/login')

// 5 attempts per 15-minute window (applied per IP and per username independently)
const RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 }

export async function POST(request: NextRequest) {
  const origin = new URL(request.url).origin

  // ── Rate limiting by IP (Supabase-backed — safe on Vercel serverless) ────────
  const ip = getClientIp(request)
  const rlIp = await rateLimitDb(`admin-login:ip:${ip}`, RATE_LIMIT)
  if (!rlIp.success) {
    const retryAfterSec = Math.ceil((rlIp.resetAt - Date.now()) / 1000)
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

    // Also rate-limit by username to prevent distributed IP attacks targeting one account.
    const rlUser = await rateLimitDb(`admin-login:user:${username.toLowerCase()}`, RATE_LIMIT)
    if (!rlUser.success) {
      const retryAfterSec = Math.ceil((rlUser.resetAt - Date.now()) / 1000)
      return NextResponse.redirect(`${origin}/admin/login?error=too_many_attempts`, {
        status: 303,
        headers: { 'Retry-After': String(retryAfterSec) },
      })
    }

    if (username.toLowerCase() !== adminUsername.trim().toLowerCase()) {
      // Return the same generic error regardless of whether username is wrong or
      // password is wrong — never reveal which field failed.
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
      log.warn({ error: error?.message }, 'Admin login: Supabase auth failed')
      return NextResponse.redirect(`${origin}/admin/login?error=invalid`, { status: 303 })
    }

    log.info({ userId: data.user.id }, 'Admin login: auth passed, verifying profile')

    // Profile must already exist with platform_role = 'super_admin'.
    // Auto-creation is intentionally removed — a missing profile means the
    // account was not set up through the proper admin provisioning flow.
    const { data: profile, error: profileErr } = await createAdminClient()
      .from('profiles')
      .select('id, platform_role')
      .eq('id', data.user.id)
      .single()

    if (profileErr || !profile) {
      log.warn({ userId: data.user.id }, 'Admin login: profile not found — access denied')
      return NextResponse.redirect(`${origin}/admin/login?error=forbidden`, { status: 303 })
    }

    const platformRole = (profile.platform_role as string | null)?.trim()
    if (platformRole !== 'super_admin') {
      log.warn({ userId: data.user.id }, 'Admin login: insufficient role — access denied')
      return NextResponse.redirect(`${origin}/admin/login?error=forbidden`, { status: 303 })
    }

    log.info({ userId: data.user.id }, 'Admin login: access granted')

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
