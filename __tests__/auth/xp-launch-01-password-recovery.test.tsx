/**
 * XP-LAUNCH-01 — password recovery works wherever the link is opened.
 *
 * The defect: the reset email carried a PKCE `code` for /auth/callback, which
 * only the browser holding the verifier cookie (the one that submitted
 * "forgot password", on that host) could exchange. Opened on the phone, in
 * another browser, after a mail scanner, or on the public host after a request
 * made on the internal one, the link ended on /login with "link expired".
 *
 * The fix mirrors registration: the platform generates a hashed recovery token
 * with the Admin API, mails it through its own mailer to /auth/recover, which
 * verifies it with `verifyOtp` and sends the learner to /reset-password with a
 * recovery session. Nothing in the browser is needed.
 *
 * Everything here is mocked except the real action, route, page and template.
 * The same flow runs for real against the local Supabase stack in
 * `xp-launch-01-recovery-local-stack.test.ts` (opt-in).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { PUBLIC_SITE_URL } from '@/lib/brand'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ── recorders ────────────────────────────────────────────────────────────────
const generateLink = vi.fn()
const sendPasswordResetEmail = vi.fn(async () => ({ success: true }))
const logAuditEvent = vi.fn(async () => {})
const verifyOtp = vi.fn()
const getSession = vi.fn()
const updateUser = vi.fn()
const push = vi.fn()
const logCalls: unknown[][] = []
const jar = new Map<string, string>()
let search = ''

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'harness' }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
  }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink } } }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
// A stable object, as the real createBrowserClient() of @supabase/ssr caches its
// client: the page keys its effect on it, so a new object per render would re-run
// the session check on every render.
const browserClient = { auth: { getSession, updateUser } }
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => browserClient,
}))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { verifyOtp } }) }))
vi.mock('@/lib/rate-limit', () => ({
  rateLimitDb: vi.fn(async () => ({ success: true, remaining: 4, resetAt: 0 })),
}))
vi.mock('@/lib/security/captcha', () => ({
  verifyCaptcha: async () => ({ ok: true }),
  isCaptchaEnabled: () => false,
}))
vi.mock('@/lib/audit/log', () => ({ logAuditEvent }))
vi.mock('@/lib/email', () => ({
  sendPasswordResetEmail,
  sendVerificationEmail: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/lib/logger', () => {
  const rec = (...args: unknown[]) => { logCalls.push(args) }
  const l = { info: rec, warn: rec, error: rec, debug: rec }
  return { createLogger: () => l, logger: l }
})

const TOKEN = 'pkce+hash/with=chars'   // characters the link must encode
const EMAIL = 'Ada.Lovelace@example.com'

beforeEach(() => {
  vi.clearAllMocks()
  logCalls.length = 0
  jar.clear()
  search = ''
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: TOKEN } }, error: null })
  verifyOtp.mockResolvedValue({ data: { user: { id: 'u-1', email: 'ada@example.com' } }, error: null })
  getSession.mockResolvedValue({ data: { session: null } })
  updateUser.mockResolvedValue({ error: null })
})

// ── 1. the request: the platform mails its own link ─────────────────────────
describe('requestPasswordReset mails a hashed-token link the platform generated', () => {
  async function request(email = EMAIL) {
    const { requestPasswordReset } = await import('@/app/actions/auth')
    return requestPasswordReset({ email })
  }

  it('asks the Admin API for a recovery token and mails /auth/recover with it, URL-encoded', async () => {
    const result = await request()
    expect(result.ok).toBe(true)
    expect(generateLink).toHaveBeenCalledWith({ type: 'recovery', email: 'ada.lovelace@example.com' })
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1)
    const [to, data] = sendPasswordResetEmail.mock.calls[0] as unknown as [string, { resetUrl: string }]
    expect(to).toBe('ada.lovelace@example.com')
    expect(data.resetUrl).toBe(
      `${PUBLIC_SITE_URL}/auth/recover?token_hash=${encodeURIComponent(TOKEN)}&type=recovery`,
    )
    expect(new URL(data.resetUrl).searchParams.get('token_hash')).toBe(TOKEN)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'user.password_reset_requested', outcome: 'success', reason: null,
    }))
  })

  it('an unknown address gets the same answer, no email, and an audited failure', async () => {
    generateLink.mockResolvedValueOnce({ data: null, error: { message: 'User not found' } })
    const known = await request()
    vi.clearAllMocks()
    generateLink.mockResolvedValueOnce({ data: null, error: { message: 'User not found' } })
    const unknown = await request('nobody@example.com')
    expect(unknown).toEqual(known)
    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'user.password_reset_requested', outcome: 'failure', reason: 'User not found',
    }))
  })

  it('a mailer failure is audited and still answers neutrally', async () => {
    sendPasswordResetEmail.mockResolvedValueOnce({ success: false, error: 'simulated' } as never)
    const result = await request()
    expect(result.ok).toBe(true)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', reason: 'simulated' }))
  })

  it('no longer relies on Supabase mailing a PKCE link, and never reads the request origin', () => {
    const action = read('app/actions/auth.ts')
    const recover = action.slice(action.indexOf('export async function requestPasswordReset'))
    expect(recover).not.toMatch(/resetPasswordForEmail\s*\(/)
    expect(recover).toMatch(/generateLink\(\{ type: 'recovery'/)
    expect(recover).toMatch(/publicUrl\(\s*`\/auth\/recover\?token_hash=/)
    expect(recover).not.toMatch(/location\.origin|\borigin\b/)
  })
})

// ── 2. the landing route: verifies the token, sets the recovery session ──────
describe('/auth/recover', () => {
  async function get(query: string) {
    const { GET } = await import('@/app/auth/recover/route')
    const { NextRequest } = await import('next/server')
    const res = await GET(new NextRequest(`https://internal.example.test/auth/recover${query}`))
    return { status: res.status, location: res.headers.get('location') }
  }

  it('verifies a recovery token hash and lands on /reset-password on the public domain', async () => {
    const r = await get(`?token_hash=${encodeURIComponent(TOKEN)}&type=recovery`)
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: TOKEN })
    expect(r.status).toBe(307)
    expect(r.location).toBe(`${PUBLIC_SITE_URL}/reset-password`)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'user.password_recovery_opened', outcome: 'success', subjectUserId: 'u-1',
    }))
  })

  it('a refused (expired or used) token lands on /reset-password?error=expired, audited, token never logged', async () => {
    verifyOtp.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Token has expired or is invalid' } })
    const r = await get(`?token_hash=${encodeURIComponent(TOKEN)}&type=recovery`)
    expect(r.location).toBe(`${PUBLIC_SITE_URL}/reset-password?error=expired`)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }))
    const everything = JSON.stringify([logAuditEvent.mock.calls, logCalls])
    expect(everything).not.toContain(TOKEN)
  })

  it('a malformed link (no token, or another type) is refused before any verification', async () => {
    expect((await get('')).location).toBe(`${PUBLIC_SITE_URL}/reset-password?error=invalid`)
    expect((await get(`?token_hash=${encodeURIComponent(TOKEN)}&type=signup`)).location)
      .toBe(`${PUBLIC_SITE_URL}/reset-password?error=invalid`)
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('redirects are absolute on the public domain, never on the request host', async () => {
    const r = await get(`?token_hash=${encodeURIComponent(TOKEN)}&type=recovery`)
    expect(r.location).not.toContain('internal.example.test')
  })
})

// ── 3. the page: form on a recovery session, invalid card otherwise ──────────
describe('/reset-password page', () => {
  async function page() {
    const mod = await import('@/app/(auth)/reset-password/page')
    return mod.default
  }

  it('shows the invalid card at once when the route refused the link, without a session lookup', async () => {
    search = 'error=expired'
    const Page = await page()
    render(<Page />)
    expect(await screen.findByText('Lien invalide ou expiré')).toBeInTheDocument()
    expect(getSession).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toHaveAttribute('href', '/forgot-password')
    cleanup()
  })

  it('shows the new-password form on a live recovery session', async () => {
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'u-1' } } } })
    const Page = await page()
    render(<Page />)
    expect(await screen.findByLabelText(/Nouveau mot de passe/)).toBeInTheDocument()
    cleanup()
  })

  it('shows the invalid card when there is no session', async () => {
    const Page = await page()
    render(<Page />)
    expect(await screen.findByText('Lien invalide ou expiré')).toBeInTheDocument()
    cleanup()
  })

  it('updates the password through the supported API and confirms', async () => {
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'u-1' } } } })
    const Page = await page()
    render(<Page />)
    const pw = await screen.findByPlaceholderText('Minimum 8 caractères')
    fireEvent.change(pw, { target: { value: 'Correct-Horse-9-Battery' } })
    fireEvent.change(screen.getByPlaceholderText('Répétez votre mot de passe'), { target: { value: 'Correct-Horse-9-Battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour le mot de passe' }))
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'Correct-Horse-9-Battery' }))
    expect(await screen.findByText('Mot de passe mis à jour !')).toBeInTheDocument()
    cleanup()
  })

  it('refuses a short or mismatched password before calling Supabase', async () => {
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'u-1' } } } })
    const Page = await page()
    render(<Page />)
    const pw = await screen.findByPlaceholderText('Minimum 8 caractères')
    fireEvent.change(pw, { target: { value: 'short' } })
    fireEvent.change(screen.getByPlaceholderText('Répétez votre mot de passe'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour le mot de passe' }))
    expect(await screen.findByText('Le mot de passe doit contenir au moins 8 caractères.')).toBeInTheDocument()
    fireEvent.change(pw, { target: { value: 'Correct-Horse-9-Battery' } })
    fireEvent.change(screen.getByPlaceholderText('Répétez votre mot de passe'), { target: { value: 'Different-Horse-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mettre à jour le mot de passe' }))
    expect(await screen.findByText(/ne correspondent pas/)).toBeInTheDocument()
    expect(updateUser).not.toHaveBeenCalled()
    cleanup()
  })
})

// ── 4. the email and the policies around it ──────────────────────────────────
describe('the reset email and the unchanged policies', () => {
  it('the template carries the URL in both forms and reads no request state', async () => {
    const { passwordResetEmailHtml, passwordResetEmailText } = await import('@/lib/email/templates/password-reset')
    const resetUrl = `${PUBLIC_SITE_URL}/auth/recover?token_hash=abc&type=recovery`
    expect(passwordResetEmailHtml({ resetUrl })).toContain('token_hash=abc&amp;type=recovery')
    expect(passwordResetEmailText({ resetUrl })).toContain(resetUrl)
    const src = read('lib/email/templates/password-reset.ts')
    expect(src).not.toMatch(/headers\(|location\.origin|request\.url|\.origin\b/)
  })

  it('/auth and /reset-password stay reachable in private mode; login and registration policies are untouched', () => {
    const mw = read('middleware.ts')
    expect(mw).toMatch(/'\/auth',/)
    expect(mw).toMatch(/'\/reset-password',/)
    expect(mw).toMatch(/const LEARNER_AUTH_PAGES = \['\/login', '\/signup', '\/forgot-password'\]/)
    const action = read('app/actions/auth.ts')
    expect(action).toMatch(/disable_signup/)
    expect(action).toMatch(/export async function registerLearner/)
  })

  it('/auth/callback keeps handling the PKCE links of emails sent before this change', () => {
    const cb = read('app/auth/callback/route.ts')
    expect(cb).toMatch(/exchangeCodeForSession\(code\)/)
    expect(cb).toMatch(/type === 'recovery' \? 'reset_expired'/)
  })
})
