// @vitest-environment node
/**
 * XPA-1 — brand, domain and asset migration.
 *
 * Two things these tests must hold at once:
 *  1. Every USER-FACING URL resolves on the canonical academy domain.
 *  2. The dual-domain architecture is PRESERVED — the Vercel host remains the
 *     admin boundary in lib/hosts.ts and middleware.ts. A naive "replace every
 *     smiley string" sweep would break authentication, so the carve-out is
 *     asserted explicitly rather than left to reviewer memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

// XPA-3 made app/sitemap.ts async and DB-backed. Mock the reader so this
// suite stays a pure unit test — it asserts static routes and the canonical
// domain, not database contents.
vi.mock('@/lib/queries/catalogue', () => ({
  getPublicPaths: async () => [],
  pathHref: (p: { code: string; kind: string }) =>
    `${p.kind === 'sector' ? '/secteurs' : '/parcours'}/${p.code.toLowerCase()}`,
}))

const ROOT = process.cwd()
const CANONICAL = 'https://www.xpclient-academy.com'
const VERCEL_HOST = 'smiley-cx-platform.vercel.app'

// Env stubs must not leak between describe blocks: brand.ts reads env at module
// load, so a stubbed base URL would silently change later assertions.
beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })
afterEach(()  => { vi.unstubAllEnvs() })

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Files where the Vercel hostname is CORRECT — infrastructure, not branding. */
const HOST_CARVE_OUT = ['lib/hosts.ts', 'middleware.ts']

describe('XPA-1 — canonical domain', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })
  afterEach(()  => { vi.unstubAllEnvs() })

  it('defaults to the public academy domain, not the Vercel host', async () => {
    const { PUBLIC_SITE_URL } = await import('@/lib/brand')
    expect(PUBLIC_SITE_URL).toBe(CANONICAL)
    expect(PUBLIC_SITE_URL).not.toContain('vercel.app')
    expect(PUBLIC_SITE_URL).not.toContain('smileycx')
  })

  it('honours NEXT_PUBLIC_SITE_URL when set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://staging.example.com')
    const { PUBLIC_SITE_URL } = await import('@/lib/brand')
    expect(PUBLIC_SITE_URL).toBe('https://staging.example.com')
  })

  it('IGNORES the legacy NEXT_PUBLIC_APP_URL so a stale value cannot poison canonical URLs', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://legacy.smileycx.com')
    const { PUBLIC_SITE_URL } = await import('@/lib/brand')
    expect(PUBLIC_SITE_URL).toBe(CANONICAL)
  })

  it('builds certificate URLs on the public domain', async () => {
    const { certificateVerifyUrl, certificateViewUrl } = await import('@/lib/brand')
    expect(certificateVerifyUrl('abc')).toBe(`${CANONICAL}/verify-certificate/abc`)
    expect(certificateViewUrl('abc')).toBe(`${CANONICAL}/certificates/abc`)
  })

  it('never double-slashes when the base has a trailing slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.xpclient-academy.com/')
    const { publicUrl } = await import('@/lib/brand')
    expect(publicUrl('/courses')).toBe(`${CANONICAL}/courses`)
    expect(publicUrl('courses')).toBe(`${CANONICAL}/courses`)
  })
})

describe('XPA-1 — no user-facing URL points at the deployment host', () => {
  it('the three admin certificate surfaces use the brand constant', () => {
    for (const f of [
      'app/(admin)/admin/certificates/page.tsx',
      'app/(admin)/admin/certificates/[certificateId]/page.tsx',
      'app/(admin)/admin/users/[id]/page.tsx',
    ]) {
      const src = read(f)
      expect(src).toMatch(/PUBLIC_SITE_URL/)
      expect(src).not.toContain(VERCEL_HOST)
    }
  })

  it('no smileycx.com domain remains as a URL default in app code', () => {
    let hits = ''
    try {
      hits = execFileSync(
        'git',
        ['grep', '-n', '-e', 'https://smileycx.com', '-e', 'academy.smileycx.com',
         '--', 'app', 'components', 'lib'],
        { cwd: ROOT, encoding: 'utf8' }
      ).trim()
    } catch { hits = '' }   // git grep exits 1 when nothing matches
    expect(hits).toBe('')
  }, 15_000)

  it('the legacy SmileyCX wordmark is gone from the UI', () => {
    let hits = ''
    try {
      hits = execFileSync(
        'git', ['grep', '-n', '-e', 'Smiley<span', '--', 'app', 'components'],
        { cwd: ROOT, encoding: 'utf8' }
      ).trim()
    } catch { hits = '' }
    expect(hits).toBe('')
  }, 15_000)
})

describe('XPA-1 — dual-domain architecture preserved (NO routing regression)', () => {
  it('lib/hosts.ts still treats the Vercel host as the admin boundary', () => {
    const src = read('lib/hosts.ts')
    expect(src).toContain(VERCEL_HOST)
    expect(src).toMatch(/DEFAULT_ADMIN_HOSTS/)
    expect(src).toMatch(/isAdminHost/)
  })

  it('middleware still enforces the host boundary and owner check', () => {
    const src = read('middleware.ts')
    expect(src).toMatch(/isAdminHost\(resolveHost\(request\.headers\)\)/)
    expect(src).toMatch(/isOwnerEmail\(user\.email\)/)
    expect(src).toMatch(/\/api\/auth\/signout\?error=forbidden/)
  })

  it('middleware was NOT modified by the branding sweep', () => {
    // Branding must not have touched auth: no brand import, no canonical URL.
    const src = read('middleware.ts')
    expect(src).not.toMatch(/@\/lib\/brand/)
    expect(src).not.toContain(CANONICAL)
  })

  it('the carve-out files are the ONLY place the Vercel host appears in code', () => {
    let hits: string[] = []
    try {
      hits = execFileSync(
        'git', ['grep', '-l', '-e', VERCEL_HOST, '--', 'app', 'components', 'lib', 'middleware.ts'],
        { cwd: ROOT, encoding: 'utf8' }
      ).split('\n').map(s => s.trim()).filter(Boolean)
    } catch { hits = [] }
    expect(hits.sort()).toEqual(HOST_CARVE_OUT.sort())
  }, 15_000)
})

describe('XPA-1 — metadata', () => {
  const layout = read('app/layout.tsx')

  it('metadataBase resolves against the canonical domain', () => {
    expect(layout).toMatch(/metadataBase: new URL\(PUBLIC_SITE_URL\)/)
    expect(layout).not.toContain('academy.smileycx.com')
  })

  it('declares Open Graph images and a canonical alternate', () => {
    expect(layout).toMatch(/images: \[\{ url: '\/icon\.png'/)
    expect(layout).toMatch(/alternates: \{ canonical: '\/' \}/)
    expect(layout).toMatch(/url:\s+PUBLIC_SITE_URL/)
  })

  it('uses the brand constant rather than repeating the name', () => {
    expect(layout).toMatch(/BRAND_NAME/)
  })
})

describe('XPA-1 — robots, sitemap, manifest', () => {
  it('robots points its sitemap at the public domain and disallows private areas', async () => {
    const { default: robots } = await import('@/app/robots')
    const r = robots()
    expect(r.sitemap).toBe(`${CANONICAL}/sitemap.xml`)
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules
    const disallow = (rule?.disallow ?? []) as string[]
    for (const p of ['/admin', '/api/', '/dashboard', '/learn/']) {
      expect(disallow).toContain(p)
    }
  })

  it('sitemap lists only public pages, all on the canonical domain', async () => {
    const { default: sitemap } = await import('@/app/sitemap')
    // Async since XPA-3: it now enumerates publicly-renderable path pages.
    const entries = await sitemap()
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.url.startsWith(CANONICAL)).toBe(true)
    }
    const urls = entries.map(e => e.url)
    // Private surfaces must never be advertised.
    for (const p of ['/admin', '/dashboard', '/login', '/learn']) {
      expect(urls.some(u => u.includes(p))).toBe(false)
    }
  })

  it('manifest carries the brand name and does not claim maskable on an opaque icon', async () => {
    const { default: manifest } = await import('@/app/manifest')
    const m = manifest()
    expect(m.name).toBe('XP Client Academy')
    for (const icon of m.icons ?? []) {
      expect(icon.purpose).not.toBe('maskable')
    }
  })
})

describe('XPA-1 — certificates', () => {
  it('the PDF accepts and renders a verification URL', () => {
    const src = read('lib/pdf/CertificatePDF.tsx')
    expect(src).toMatch(/verifyUrl\?: string/)
    expect(src).toMatch(/Vérifier l&apos;authenticité/)
  })

  it('the PDF route builds that URL on the public academy domain', () => {
    const src = read('app/api/certificates/[id]/pdf/route.ts')
    expect(src).toMatch(/certificateVerifyUrl\(/)
    expect(src).toMatch(/@\/lib\/brand/)
  })

  it('issuer branding is XP Client Academy', () => {
    const src = read('lib/pdf/CertificatePDF.tsx')
    expect(src).toMatch(/author="XP Client Academy"/)
    expect(src).not.toMatch(/Smiley/)
  })
})

describe('XPA-1 — email branding', () => {
  it('sender display name is the full brand', () => {
    const src = read('lib/email/index.ts')
    expect(src).toMatch(/'XP Client Academy <.*>'/)
    expect(src).not.toMatch(/'XP Client <.*>'/)
  })

  it('email logic and delivery architecture are untouched', () => {
    const src = read('lib/email/index.ts')
    expect(src).toMatch(/from:\s+FROM/)          // still a single sender constant
    expect(src).toMatch(/EMAIL_DRY_RUN/)          // dry-run behaviour preserved
    expect(src).toMatch(/RESEND_API_KEY/)         // provider unchanged
  })

  it('server actions fall back to the shared contact constant', () => {
    for (const f of ['app/actions/waitlist.ts', 'app/(public)/contact/actions.ts']) {
      const src = read(f)
      expect(src).toMatch(/@\/lib\/brand/)
      expect(src).not.toMatch(/'bonjour@smileycx\.com'/)
    }
  })
})

describe('XPA-1 — contact address is single-sourced', () => {
  it('all four display surfaces read the constant, none hardcode an address', () => {
    for (const f of [
      'app/(public)/contact/page.tsx',
      'app/(public)/terms/page.tsx',
      'app/(platform)/checkout/confirm/page.tsx',
      'components/layout/Footer.tsx',
    ]) {
      const src = read(f)
      expect(src).toMatch(/CONTACT_EMAIL/)
      expect(src).not.toMatch(/bonjour@smileycx\.com/)
    }
  })

  it('is client-safe — reads only a NEXT_PUBLIC var so client and server agree', () => {
    const src = read('lib/brand.ts')
    expect(src).toMatch(/NEXT_PUBLIC_CONTACT_EMAIL/)
    // A server-only var here would silently diverge in the client Footer.
    expect(src).not.toMatch(/process\.env\.CONTACT_EMAIL/)
  })
})

describe('XPA-1 — public asset guard', () => {
  it('blocks source formats and carries the known .pptx as baseline', () => {
    const src = read('scripts/security/check-public-assets.mjs')
    expect(src).toMatch(/\.pptx/)
    expect(src).toMatch(/process\.exitCode = 1/)
    const baseline = JSON.parse(read('scripts/security/public-assets-baseline.json'))
    expect(baseline.known).toContain('public/images/Certificate of Completion.pptx')
  })

  it('is wired into the aggregate verify script', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['scan:public-assets']).toContain('check-public-assets.mjs')
    expect(pkg.scripts.verify).toContain('scan:public-assets')
  })
})

describe('XPA-1 — no schema, permission or migration changes', () => {
  /**
   * XPA-1 was branding only and introduced no schema work.
   *
   * This originally pinned an absolute migration count (27). That was true when
   * written but inherently brittle: every legitimate later migration breaks it,
   * which is a false alarm rather than a real regression — XPA-2 (028–030) and
   * XPA-3 (031) each tripped it. The durable expression of the same intent is
   * that branding never leaked INTO SQL: no migration may reference brand,
   * domain or contact constants.
   */
  it('branding never leaked into any migration', () => {
    const migrations = execFileSync('git', ['ls-files', '--', 'supabase/migrations'], {
      cwd: ROOT, encoding: 'utf8',
    }).split('\n').filter(Boolean)

    expect(migrations.length).toBeGreaterThanOrEqual(27)

    for (const m of migrations) {
      const sql = read(m)
      for (const forbidden of ['xpclient-academy.com', 'smileycx.com', 'PUBLIC_SITE_URL', 'CONTACT_EMAIL', 'BRAND_NAME']) {
        expect(sql, `${m} references branding`).not.toContain(forbidden)
      }
    }
  }, 20_000)

  it('leaves authorization and the owner allowlist untouched', () => {
    expect(read('lib/auth/owner-email.ts')).toMatch(/ADMIN_OWNER_EMAILS/)
    expect(read('lib/auth/session.ts')).toMatch(/getOwnerSession/)
    // Branding must not have leaked into auth modules.
    expect(read('lib/auth/owner.ts')).not.toMatch(/@\/lib\/brand/)
  })
})
