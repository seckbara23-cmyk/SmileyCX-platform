// @vitest-environment node
/**
 * CX-AUTH-1 — owner-only administration portal.
 *
 * Proves the boundary the phase requires:
 *   - the public marketing site stays public
 *   - the administration hostname renders nothing without the owner session
 *   - anonymous, wrong-password and non-owner callers are all denied
 *   - a FORGED cookie authorizes nothing (the CX-AUTH-0 F-1/F-3 defects)
 *   - logout destroys the session
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

// The two administrators actually configured for this deployment.
const OWNER_A = 'mariemeify@gmail.com'
const OWNER_B = 'seckbara23@gmail.com'
const ALLOWLIST = `${OWNER_A},${OWNER_B}`

// ─────────────────────── administrator allowlist predicate ──────────────────

describe('CX-AUTH-1 — administrator allowlist', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })
  afterEach(()  => { vi.unstubAllEnvs() })

  const load = () => import('@/lib/auth/owner-email')

  it('authorizes mariemeify@gmail.com', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', ALLOWLIST)
    const { isOwnerEmail } = await load()
    expect(isOwnerEmail(OWNER_A)).toBe(true)
  })

  it('authorizes seckbara23@gmail.com', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', ALLOWLIST)
    const { isOwnerEmail } = await load()
    expect(isOwnerEmail(OWNER_B)).toBe(true)
  })

  it('denies any other authenticated email', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', ALLOWLIST)
    const { isOwnerEmail } = await load()
    for (const other of [
      'someone@else.com',
      'mariemeify@gmail.com.evil.com',   // suffix attack
      'evil.com/mariemeify@gmail.com',
      'mariemelly@gmail.com',            // near-miss on a real address
      'seckbara23@gmail.co',
      'x@y.z',
    ]) {
      expect(isOwnerEmail(other)).toBe(false)
    }
  })

  it('FAILS CLOSED when ADMIN_OWNER_EMAILS is empty', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', '')
    const { isOwnerEmail } = await load()
    expect(isOwnerEmail(OWNER_A)).toBe(false)
    expect(isOwnerEmail(OWNER_B)).toBe(false)
    expect(isOwnerEmail('')).toBe(false)
    expect(isOwnerEmail(null)).toBe(false)
    expect(isOwnerEmail(undefined)).toBe(false)
  })

  it('FAILS CLOSED when ADMIN_OWNER_EMAILS is missing entirely', async () => {
    // Not stubbed at all — the variable is absent from the environment.
    const { isOwnerEmail, ownerEmails } = await load()
    expect(ownerEmails()).toEqual([])
    expect(isOwnerEmail(OWNER_A)).toBe(false)
    expect(isOwnerEmail(OWNER_B)).toBe(false)
  })

  it('FAILS CLOSED on a list of only separators/whitespace', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', ' , ,, ')
    const { isOwnerEmail, ownerEmails } = await load()
    expect(ownerEmails()).toEqual([])
    expect(isOwnerEmail('')).toBe(false)
    expect(isOwnerEmail(OWNER_A)).toBe(false)
  })

  it('trims whitespace and compares case-insensitively', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', `  ${OWNER_A.toUpperCase()} ,   ${OWNER_B}  `)
    const { isOwnerEmail } = await load()
    expect(isOwnerEmail(OWNER_A)).toBe(true)
    expect(isOwnerEmail(`  MarieMeify@GMAIL.com `)).toBe(true)
    expect(isOwnerEmail(OWNER_B.toUpperCase())).toBe(true)
  })

  it('parses a single-entry list (no trailing comma required)', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', OWNER_A)
    const { isOwnerEmail, ownerEmails } = await load()
    expect(ownerEmails()).toEqual([OWNER_A])
    expect(isOwnerEmail(OWNER_A)).toBe(true)
    expect(isOwnerEmail(OWNER_B)).toBe(false)
  })

  it('never treats a null/empty email as authorized', async () => {
    vi.stubEnv('ADMIN_OWNER_EMAILS', ALLOWLIST)
    const { isOwnerEmail } = await load()
    expect(isOwnerEmail(null)).toBe(false)
    expect(isOwnerEmail(undefined)).toBe(false)
    expect(isOwnerEmail('')).toBe(false)
    expect(isOwnerEmail('   ')).toBe(false)
  })
})

// ───────────────────────────── host classification ──────────────────────────

describe('CX-AUTH-1 — host boundary classification', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

  const load = () => import('@/lib/hosts')

  it('classifies the admin hostname as PRIVATE', async () => {
    const { isAdminHost } = await load()
    expect(isAdminHost('smiley-cx-platform.vercel.app')).toBe(true)
  })

  it('classifies the public marketing domain as PUBLIC', async () => {
    const { isAdminHost } = await load()
    expect(isAdminHost('www.xpclient-academy.com')).toBe(false)
    expect(isAdminHost('xpclient-academy.com')).toBe(false)
  })

  it('denies unknown *.vercel.app preview deployments by default', async () => {
    const { isAdminHost } = await load()
    expect(isAdminHost('smiley-cx-platform-git-main-x.vercel.app')).toBe(true)
    expect(isAdminHost('some-random-preview.vercel.app')).toBe(true)
  })

  it('ignores port and case', async () => {
    const { isAdminHost } = await load()
    expect(isAdminHost('SMILEY-CX-PLATFORM.VERCEL.APP:443')).toBe(true)
    expect(isAdminHost('WWW.XPCLIENT-ACADEMY.COM:443')).toBe(false)
  })

  it('is configurable for a future admin.xpclient-academy.com', async () => {
    vi.stubEnv('ADMIN_HOSTS', 'admin.xpclient-academy.com')
    const { isAdminHost } = await load()
    expect(isAdminHost('admin.xpclient-academy.com')).toBe(true)
    expect(isAdminHost('www.xpclient-academy.com')).toBe(false)
  })

  it('prefers x-forwarded-host (set by Vercel) over Host', async () => {
    const { resolveHost } = await load()
    const h = new Headers({ 'x-forwarded-host': 'smiley-cx-platform.vercel.app', host: 'internal' })
    expect(resolveHost(h)).toBe('smiley-cx-platform.vercel.app')
  })

  it('keeps /login reachable on the admin host so the owner can sign in', async () => {
    const { isAdminHostPublicPath } = await load()
    expect(isAdminHostPublicPath('/login')).toBe(true)
    expect(isAdminHostPublicPath('/auth/callback')).toBe(true)
    expect(isAdminHostPublicPath('/api/auth/signout')).toBe(true)
  })

  it('does NOT treat the public marketing surface as reachable on the admin host', async () => {
    const { isAdminHostPublicPath } = await load()
    for (const p of ['/', '/courses', '/courses/x', '/about', '/contact', '/admin']) {
      expect(isAdminHostPublicPath(p)).toBe(false)
    }
  })
})

// ─────────────────────── forged cookie / server-side authz ──────────────────

describe('CX-AUTH-1 — a forged cookie authorizes nothing', () => {
  const uploadRoute = readFileSync(join(ROOT, 'app/api/admin/upload-url/route.ts'), 'utf8')
  const session     = readFileSync(join(ROOT, 'lib/auth/session.ts'), 'utf8')
  const adminLayout = readFileSync(join(ROOT, 'app/(admin)/layout.tsx'), 'utf8')
  const health      = readFileSync(join(ROOT, 'app/api/health/route.ts'), 'utf8')

  it('CX-AUTH-0 F-1 REPAIRED: upload endpoint requires a verified owner session', () => {
    expect(uploadRoute).toMatch(/getOwnerSession\(\)/)
    // The vulnerable pattern was: read scx_admin, 401 only if absent.
    expect(uploadRoute).not.toMatch(/cookies\.get\(['"]scx_admin['"]\)/)
  })

  it('upload rate-limit key is bound to the verified user, not an attacker-chosen value', () => {
    expect(uploadRoute).toMatch(/upload-url:\$\{session\.user\.id\}/)
  })

  it('no server file trusts the retired scx_admin cookie', () => {
    for (const src of [uploadRoute, session, adminLayout, health]) {
      expect(src).not.toMatch(/(cookieStore|cookies\(\))?\s*\.?get\(['"]scx_admin['"]\)/)
    }
  })

  it('the routes that minted the unsigned admin cookie are gone', () => {
    for (const p of [
      'app/api/admin/login/route.ts',
      'app/api/admin/signout/route.ts',
      'app/(admin-auth)/admin/login/page.tsx',
    ]) {
      expect(() => readFileSync(join(ROOT, p), 'utf8')).toThrow()
    }
  })

  it('requirePlatformAdmin authorizes on the owner session, server-side', () => {
    expect(session).toMatch(/getOwnerSession\(\)/)
    expect(session).toMatch(/redirect\(['"]\/login\?error=forbidden['"]\)/)
  })

  it('getOwnerSession uses getUser() (verified) not getSession() (cookie-trusting)', () => {
    const owner = readFileSync(join(ROOT, 'lib/auth/owner.ts'), 'utf8')
    expect(owner).toMatch(/auth\.getUser\(\)/)
    expect(owner).not.toMatch(/auth\.getSession\(\)/)
  })
})

// ──────────────────────────── middleware behaviour ──────────────────────────

describe('CX-AUTH-1 — middleware host enforcement', () => {
  const mw = readFileSync(join(ROOT, 'middleware.ts'), 'utf8')

  it('classifies the host before serving anything', () => {
    expect(mw).toMatch(/isAdminHost\(resolveHost\(request\.headers\)\)/)
  })

  it('redirects anonymous admin-host requests to /login', () => {
    const block = mw.slice(mw.indexOf('isAdminHost(resolveHost'), mw.indexOf('Auth-required routes'))
    expect(block).toMatch(/if \(!user\)/)
    expect(block).toMatch(/\/login/)
  })

  /**
   * XPA-6A — ratified behaviour change, NOT a relaxation.
   *
   * This previously asserted that an authenticated NON-owner on the admin host
   * was SIGNED OUT. That was correct when every account on the platform was an
   * administrator: a non-owner session there could only be an anomaly.
   *
   * With public learner registration open (decisions 1-2, 7-8), that visitor is
   * now almost always an ordinary learner following a stale link, and
   * destroying their commercial session as a penalty for hitting the wrong
   * hostname is hostile. Decision 8 says such learners must be REDIRECTED to
   * the commercial domain.
   *
   * The security property is unchanged and is what this test now pins: a
   * non-owner is still refused the internal host, and — critically — the
   * hostname is not what authorizes anything. Every admin page and action calls
   * requirePlatformAdmin() independently, asserted separately below.
   */
  it('redirects an authenticated NON-owner to the commercial domain', () => {
    expect(mw).toMatch(/isOwnerEmail\(user\.email\)/)
    expect(mw).toMatch(/safeCommercialDeepLink\(/)
    expect(mw).toMatch(/publicUrl\(/)
  })

  it('never preserves an internal deep link when bouncing a learner', () => {
    const fn = mw.slice(mw.indexOf('function safeCommercialDeepLink'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/startsWith\('\/admin'\)/)
    expect(body).toMatch(/startsWith\('\/api'\)/)
    expect(body).toMatch(/publicUrl\('\/'\)/)
  })

  /**
   * CX-AUTH-2A — the host boundary gates access; it must not substitute one
   * page for another. No path is rewritten into /admin.
   */
  it('contains NO rewrite of the path space into /admin', () => {
    expect(mw).not.toMatch(/NextResponse\.rewrite/)
    expect(mw).not.toMatch(/`\/admin\$\{pathname\}`/)
    expect(mw).not.toMatch(/RESERVED_PORTAL_PREFIXES/)
  })

  /**
   * Anchored on the admin-host boundary, not on the first `pathname ===
   * '/login'` in the file — the deep-link helper contains that string too, and
   * anchoring on it silently searched the wrong block.
   */
  const adminHostLoginBlock = () => {
    const start = mw.indexOf('isAdminHostPublicPath(pathname)')
    expect(start).toBeGreaterThan(-1)
    return mw.slice(start, start + 1200)
  }

  it('sends an authenticated owner on /login to the landing page at /', () => {
    expect(adminHostLoginBlock()).toMatch(/redirect\(new URL\('\/', request\.url\)\)/)
  })

  /**
   * XPA-6A: a learner who signs in on the internal host keeps their session but
   * is sent to the commercial dashboard. Their session was never an
   * administration session — signing in there does not make it one.
   */
  it('sends an authenticated NON-owner on /login to the commercial dashboard', () => {
    expect(adminHostLoginBlock()).toMatch(/publicUrl\('\/dashboard'\)/)
  })

  it('the admin nav still points at /admin/* (clean routes do not exist)', () => {
    const layout = readFileSync(join(ROOT, 'app/(admin)/layout.tsx'), 'utf8')
    expect(layout).toMatch(/href: '\/admin\/users'/)
    expect(layout).toMatch(/href: '\/admin\/courses'/)
    expect(layout).toMatch(/href: '\/admin\/modules'/)
  })

  /**
   * CX-AUTH-2B — /login is the ONLY login page. No application code may link
   * to the deleted /admin/login, and the deleted auth system stays deleted.
   */
  it('no active link in app/, components/ or lib/ points to /admin/login', () => {
    let hits = ''
    try {
      hits = execFileSync(
        'git',
        ['grep', '-n', '-e', 'href="/admin/login"', '-e', "href='/admin/login'",
         '-e', 'href={"/admin/login"}', '--', 'app', 'components', 'lib'],
        { cwd: ROOT, encoding: 'utf8' }
      ).trim()
    } catch {
      // git grep exits 1 when nothing matches — that is the passing case.
      hits = ''
    }
    expect(hits).toBe('')
  }, 15_000)

  it('/login is the only login page — /admin/login has no route file', () => {
    for (const p of [
      'app/(admin-auth)/admin/login/page.tsx',
      'app/admin/login/page.tsx',
      'app/api/admin/login/route.ts',
    ]) {
      expect(() => readFileSync(join(ROOT, p), 'utf8')).toThrow()
    }
  })

  it('the legacy redirect does NOT resurrect the deleted auth system', () => {
    expect(mw).toMatch(/pathname === '\/admin\/login'/)
    // No cookie minting, no bespoke credential handling.
    expect(mw).not.toMatch(/scx_admin['"]?\s*,/)
    expect(mw).not.toMatch(/ADMIN_USERNAME|signInWithPassword/)
  })

  it('does not gate the public marketing host behind auth', () => {
    // The public-host path must never require a session for / or /courses.
    const publicGate = /pathname === ['"]\/['"][\s\S]{0,120}redirect[\s\S]{0,60}\/login/
    const adminBlockEnd = mw.indexOf('Auth-required routes')
    expect(publicGate.test(mw.slice(adminBlockEnd))).toBe(false)
  })

  it('keeps /admin gated on the public host too', () => {
    expect(mw).toMatch(/ADMIN_ROUTES\.some[\s\S]{0,200}isOwnerEmail/)
  })
})

// ──────────────────────────── login UI requirements ─────────────────────────

describe('CX-AUTH-1 — login page', () => {
  const form = readFileSync(join(ROOT, 'app/(auth)/login/LoginForm.tsx'), 'utf8')
  const page = readFileSync(join(ROOT, 'app/(auth)/login/page.tsx'), 'utf8')

  it('offers NO public registration link', () => {
    // Strip comments first: the explanatory note above the removed link
    // legitimately contains the word "registration".
    const visible = form.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '')
    expect(visible).not.toMatch(/href=\{?['"`]\/signup/)
    expect(visible).not.toMatch(/S['’]inscrire|Créer un compte|Sign ?up/i)
  })

  it('is French and uses email + password', () => {
    expect(form).toMatch(/Se connecter/)
    expect(form).toMatch(/signInWithPassword/)
  })

  it('shows a generic message for invalid credentials (no user enumeration)', () => {
    expect(form).toMatch(/Email ou mot de passe incorrect/)
  })

  it('renders "Accès non autorisé" for a denied non-owner', () => {
    expect(form).toMatch(/Accès non autorisé/)
  })

  it('offers password recovery (the callback defect is repaired)', () => {
    expect(form).toMatch(/\/forgot-password/)
  })

  it('is host-aware and never statically cached', () => {
    expect(page).toMatch(/isAdminHost\(resolveHost/)
    expect(page).toMatch(/force-dynamic/)
  })
})

// ──────────────────────── recovery flow + logout integrity ──────────────────

describe('CX-AUTH-1 — session lifecycle', () => {
  const callback = readFileSync(join(ROOT, 'app/auth/callback/route.ts'), 'utf8')
  const signout  = readFileSync(join(ROOT, 'app/api/auth/signout/route.ts'), 'utf8')

  it('CX-AUTH-0 F-2 REPAIRED: callback uses the v0.3.0 get/set/remove cookie API', () => {
    expect(callback).toMatch(/get\(name: string\)/)
    expect(callback).toMatch(/set\(name: string/)
    expect(callback).toMatch(/remove\(name: string/)
    // The ignored-by-the-SDK shape must not come back.
    expect(callback).not.toMatch(/getAll\(\)/)
    expect(callback).not.toMatch(/setAll\(/)
  })

  it('logout destroys the session server-side, not just the browser cookie', () => {
    expect(signout).toMatch(/auth\.signOut\(\)/)
  })

  it('logout also clears any stale retired admin cookie', () => {
    expect(signout).toMatch(/scx_admin[\s\S]{0,60}maxAge: 0/)
  })

  it('the admin shell logs out via the real sign-out route', () => {
    const layout = readFileSync(join(ROOT, 'app/(admin)/layout.tsx'), 'utf8')
    expect(layout).toMatch(/\/api\/auth\/signout/)
    expect(layout).toMatch(/Déconnexion/)
  })
})

// ─────────────────────────── provisioning safety ────────────────────────────

describe('CX-AUTH-1 — owner provisioning never handles passwords', () => {
  const script = readFileSync(join(ROOT, 'scripts/auth/provision-owner.mjs'), 'utf8')

  it('never generates, prints or stores a password', () => {
    expect(script).not.toMatch(/password\s*[:=]\s*['"`]/i)
    expect(script).not.toMatch(/randomBytes|generatePassword/i)
  })

  it('sends a recovery email so the owner chooses her own password', () => {
    expect(script).toMatch(/resetPasswordForEmail/)
  })

  it('requires an explicit --confirm before touching production', () => {
    expect(script).toMatch(/--confirm/)
    expect(script).toMatch(/DRY RUN/)
  })
})
