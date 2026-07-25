import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkSignupDisabled } from '@/lib/security/auth-config'

/**
 * Operator health check (HOTFIX-1, SEC-2 §2 / Step 6).
 *
 * WHY: when the SEC-2 auth-config probe cannot reach Supabase it degrades to
 * 'unknown' and the application boots normally — by ratified policy, so a
 * network fault does not take the platform down. The consequence is that the
 * site can look perfectly healthy while the signup control has NOT actually
 * been verified. That is exactly the state production was in during HOTFIX-1.
 * This endpoint makes that state observable instead of invisible.
 *
 * DISCLOSURE MODEL — deliberately two-tier:
 *   - anonymous: only a coarse status ('ok' | 'degraded'). No codes, no detail,
 *     no configuration values. Enough for an uptime monitor, useless to an
 *     attacker probing for a misconfigured deployment.
 *   - platform admin (scx_admin cookie, role re-verified server-side): the
 *     stable error code and detail needed to diagnose immediately.
 *
 * Never returns the raw Supabase settings payload, keys, or env values.
 */

export const dynamic = 'force-dynamic'
export const runtime  = 'nodejs'

async function isPlatformAdmin(): Promise<boolean> {
  try {
    const adminUserId = (await cookies()).get('scx_admin')?.value
    if (!adminUserId) return false

    const { data } = await createAdminClient()
      .from('profiles')
      .select('platform_role')
      .eq('id', adminUserId)
      .single()

    return (data?.platform_role as string | null)?.trim() === 'super_admin'
  } catch {
    return false
  }
}

export async function GET(_request: NextRequest) {
  const auth = await checkSignupDisabled()

  // 'unknown' is degraded, not healthy: the control has not been verified.
  const status = auth.status === 'secure' ? 'ok' : 'degraded'

  if (!(await isPlatformAdmin())) {
    // Always HTTP 200 so uptime monitors track reachability, not config state.
    return NextResponse.json({ status }, { status: 200 })
  }

  return NextResponse.json(
    {
      status,
      checks: {
        signupDisabled: {
          status: auth.status,        // secure | insecure | unknown
          code:   auth.code ?? null,  // SEC2_SIGNUP_ENABLED | SEC2_SIGNUP_UNVERIFIED
          detail: auth.detail ?? null,
        },
      },
    },
    { status: 200 }
  )
}
