// @vitest-environment node
/**
 * XP-LAUNCH-01 — password recovery end to end against the LOCAL Supabase stack.
 *
 * Opt-in: runs only with XPCA_LOCAL_STACK=1 and a loopback
 * NEXT_PUBLIC_SUPABASE_URL (the XP-SEC-03 local UAT writes those into
 * .env.uat.local). Skipped everywhere else, CI included. It refuses any
 * non-loopback URL, so it can never run against a hosted project.
 *
 * REAL: the server action `requestPasswordReset`, the route /auth/recover,
 * GoTrue (token generation, verification, password update, sign-in), the
 * admin client, the DB rate limiter and the audit log of the local stack.
 * MOCKED: next/headers (an in-memory cookie jar stands in for the browser), the
 * mailer (the link is captured instead of sent), captcha, the logger.
 *
 * Synthetic account only; created and deleted by the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const LOOPBACK = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$/.test(URL_)
const ENABLED = process.env.XPCA_LOCAL_STACK === '1' && LOOPBACK && Boolean(ANON) && Boolean(SERVICE)

const sent: { to: string; resetUrl: string }[] = []
const jar = new Map<string, string>()

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'local-stack-harness' }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
  }),
}))
vi.mock('@/lib/security/captcha', () => ({ verifyCaptcha: async () => ({ ok: true }), isCaptchaEnabled: () => false }))
vi.mock('@/lib/email', () => ({
  sendPasswordResetEmail: async (to: string, data: { resetUrl: string }) => { sent.push({ to, resetUrl: data.resetUrl }); return { success: true } },
  sendVerificationEmail: async () => ({ success: true }),
}))
vi.mock('@/lib/logger', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { createLogger: () => l, logger: l }
})

const EMAIL = `xp-launch-01-${Date.now()}@example.test`
const OLD = 'Old-Password-123'
const NEW = 'New-Password-456'
let userId = ''

function jarClient() {
  return createServerClient(URL_, ANON, {
    cookies: {
      get: (name: string) => jar.get(name),
      set: (name: string, value: string, _o: CookieOptions) => { jar.set(name, value) },
      remove: (name: string, _o: CookieOptions) => { jar.delete(name) },
    },
  })
}

describe.skipIf(!ENABLED)('XP-LAUNCH-01 recovery against the local stack', () => {
  const admin = () => createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  beforeAll(async () => {
    const { data, error } = await admin().auth.admin.createUser({ email: EMAIL, password: OLD, email_confirm: true })
    if (error || !data.user) throw new Error(`could not create the synthetic account: ${error?.message}`)
    userId = data.user.id
  })

  afterAll(async () => {
    if (userId) await admin().auth.admin.deleteUser(userId)
  })

  let resetUrl = ''

  it('the request mails a /auth/recover link with a real hashed token, and answers neutrally', async () => {
    const { requestPasswordReset } = await import('@/app/actions/auth')
    const r = await requestPasswordReset({ email: EMAIL })
    expect(r.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(EMAIL)
    const u = new URL(sent[0].resetUrl)
    expect(u.pathname).toBe('/auth/recover')
    expect(u.searchParams.get('type')).toBe('recovery')
    expect(u.searchParams.get('token_hash')?.length).toBeGreaterThan(20)
    resetUrl = sent[0].resetUrl
  })

  it('an unknown address answers exactly the same and sends nothing', async () => {
    const { requestPasswordReset } = await import('@/app/actions/auth')
    const r = await requestPasswordReset({ email: `nobody-${Date.now()}@example.test` })
    expect(r.ok).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('the link opened in a browser with NO prior state establishes a recovery session', async () => {
    jar.clear()
    const { GET } = await import('@/app/auth/recover/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest(resetUrl))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/reset-password')
    expect([...jar.keys()].some(k => k.includes('auth-token'))).toBe(true)
    const { data: { user } } = await jarClient().auth.getUser()
    expect(user?.id).toBe(userId)
  })

  it('the page\'s API call updates the password through that session', async () => {
    const { error } = await jarClient().auth.updateUser({ password: NEW })
    expect(error).toBeNull()
  })

  it('the new password signs in; the old one does not', async () => {
    const plain = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
    const ok = await plain().auth.signInWithPassword({ email: EMAIL, password: NEW })
    expect(ok.error).toBeNull()
    expect(ok.data.user?.id).toBe(userId)
    const bad = await plain().auth.signInWithPassword({ email: EMAIL, password: OLD })
    expect(bad.error).not.toBeNull()
  })

  it('the same link a second time is refused and lands on the invalid card', async () => {
    jar.clear()
    const { GET } = await import('@/app/auth/recover/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest(resetUrl))
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('expired')
    expect([...jar.keys()].some(k => k.includes('auth-token'))).toBe(false)
  })

  it('the audit log of the local stack recorded the request and the link use', async () => {
    const { data } = await admin().from('audit_log')
      .select('event_type, outcome')
      .in('event_type', ['user.password_reset_requested', 'user.password_recovery_opened'])
      .order('created_at', { ascending: true })
    const types = (data ?? []).map(r => `${r.event_type}:${r.outcome}`)
    expect(types).toEqual(expect.arrayContaining([
      'user.password_reset_requested:success',
      'user.password_recovery_opened:success',
      'user.password_recovery_opened:failure',
    ]))
  })
})
