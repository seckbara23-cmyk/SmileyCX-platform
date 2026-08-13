// @vitest-environment node
/**
 * XPA-8 W2 — retirement of the legacy `/app/[orgSlug]` surface (blocker B-3).
 *
 * ── WHAT WAS THERE ────────────────────────────────────────────────────────
 *
 * A second, SmileyCX-era organization product: org switcher, per-org dashboard,
 * journeys, touchpoints, action plans, feedback, settings. Reachable by any
 * authenticated user, linked from the admin shell, and never tested against the
 * policies XPA-7 introduced.
 *
 * ── WHY RETIRED RATHER THAN GUARDED ───────────────────────────────────────
 *
 * XPA-7 already answers every organization question authoritatively at
 * `/admin/organizations`. Two answers to "who belongs to this company" is one
 * too many.
 *
 * And the legacy guard was actively wrong after XPA-7: `requireOrgMembership`
 * read `organization_memberships` with NO filter on `status`, so a PENDING
 * invitee or REMOVED ex-employee still satisfied it — RLS lets a learner read
 * their own membership row. It was the only membership check on the platform
 * that ignored the lifecycle.
 *
 * ── THE REDIRECT RULE ─────────────────────────────────────────────────────
 *
 * The slug is never resolved. Looking it up would turn a retired route into an
 * existence oracle — `/app/acme` behaving differently from `/app/invented`
 * tells an unrelated learner which companies exist — and would be an open
 * redirect keyed on attacker-controlled input. The destination depends only on
 * WHO IS ASKING.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel: string) => existsSync(join(ROOT, rel))
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const HANDLER = 'app/app/[[...path]]/page.tsx'

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W2 — the legacy organization product is retired', () => {
  it('B-3: every legacy page is gone', () => {
    for (const p of [
      'app/app/[orgSlug]/dashboard/page.tsx',
      'app/app/[orgSlug]/journeys/page.tsx',
      'app/app/[orgSlug]/actions/page.tsx',
      'app/app/[orgSlug]/feedback/page.tsx',
      'app/app/[orgSlug]/settings/page.tsx',
      'app/app/[orgSlug]/layout.tsx',
      'app/app/orgs/page.tsx',
      'app/app/onboarding/page.tsx',
      'app/app/layout.tsx',
    ]) {
      expect(has(p), `${p} is back`).toBe(false)
    }
  })

  it('B-3: only the retirement handler remains under /app', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
    expect(walk('app/app').sort()).toEqual([HANDLER])
  })

  it('B-3: the legacy shell components are gone', () => {
    for (const c of ['AppShellClient', 'AppSidebar', 'AppTopbar', 'OrgSwitcher']) {
      expect(has(`components/layout/${c}.tsx`), `${c} is back`).toBe(false)
    }
  })

  it('B-3: no page queries the legacy CX-analytics tables any more', () => {
    const src = stripTs(read(HANDLER))
    for (const t of ['journeys', 'touchpoints', 'action_plans', 'feedback_entries',
                     'journey_stages', 'kpi_definitions', 'issues']) {
      expect(src, `the handler still queries ${t}`).not.toContain(t)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NO INBOUND LINKS SURVIVE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W2 inbound navigation', () => {
  const appFiles = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) out.push(p)
      }
    }
    walk(dir)
    return out
  }

  it('nothing links or redirects into /app any more', () => {
    const offenders: string[] = []
    for (const f of [...appFiles('app'), ...appFiles('components'), ...appFiles('lib')]) {
      if (f.startsWith('app/app/')) continue
      const src = stripTs(read(f))
      for (const m of src.matchAll(/(?:href=|redirect\(|push\()\s*['"`](\/app(?:\/[^'"`]*)?)['"`]/g)) {
        offenders.push(`${f} → ${m[1]}`)
      }
    }
    expect(offenders, `inbound links survive:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the admin shell points at the XPA-7 organization surface', () => {
    const src = read('app/(admin)/layout.tsx')
    expect(src).toContain('/admin/organizations')
    expect(src, 'the admin shell still links to the retired product').not.toContain('/app/orgs')
  })

  it('the XPA-7 organization surfaces still exist', () => {
    for (const p of [
      'app/(admin)/admin/organizations/page.tsx',
      'app/(admin)/admin/organizations/[id]/page.tsx',
      'app/(admin)/admin/organizations/CreateOrganizationForm.tsx',
      'app/(admin)/admin/organizations/[id]/AddMemberForm.tsx',
      'app/actions/organizations.ts',
    ]) {
      expect(has(p), `${p} is missing`).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE REDIRECT LEAKS NOTHING
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W2 redirect behaviour', () => {
  const src = () => stripTs(read(HANDLER))

  it('the slug is never resolved — no existence oracle, no open redirect', () => {
    const s = src()
    expect(s, 'the handler reads the path parameter').not.toMatch(/params/)
    // Assert on QUERIES, not on the word: the handler legitimately redirects to
    // `/admin/organizations`, which contains "organizations".
    expect(s, 'the handler looks the organization up').not.toMatch(/\.from\(\s*['"`]organizations/)
    expect(s, 'the handler consults membership').not.toMatch(/\.from\(\s*['"`]organization_memberships/)
    expect(s).not.toContain('slug')
  })

  it('the destination depends only on the caller', () => {
    const s = src()
    expect(s).toMatch(/if \(!user\) redirect\('\/login'\)/)
    expect(s).toMatch(/isOwnerEmail[\s\S]{0,60}redirect\('\/admin\/organizations'\)/)
    expect(s).toMatch(/redirect\('\/dashboard'\)/)
  })

  it('every branch lands outside /app, so no loop is possible', () => {
    const targets = [...src().matchAll(/redirect\('([^']+)'\)/g)].map(m => m[1])
    expect(targets.length).toBeGreaterThanOrEqual(3)
    for (const t of targets) {
      expect(t.startsWith('/app'), `${t} would loop back into the retired surface`).toBe(false)
    }
  })

  it('an unauthenticated caller is sent to login, not to a dashboard', () => {
    const s = src()
    const authAt = s.indexOf('if (!user)')
    // The CALL SITE, not the import at the top of the file.
    const adminAt = s.indexOf('isOwnerEmail(user.email')
    expect(authAt).toBeGreaterThan(-1)
    expect(authAt).toBeLessThan(adminAt)
  })

  it('platform-admin routing uses the owner allowlist, not org membership', () => {
    const s = src()
    expect(s).toContain('isOwnerEmail')
    expect(s, 'the handler grants on organization role').not.toMatch(/has_org_role|is_org_member|org_admin/)
  })

  it('no stale SmileyCX screen renders on the way through', () => {
    const s = read(HANDLER)
    // The handler renders nothing at all — every path redirects.
    expect(s).not.toMatch(/return\s*\(/)
    expect(s).not.toMatch(/<[A-Z][A-Za-z]*/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE LIFECYCLE-IGNORING GUARD IS GONE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W2 removes the membership check that ignored the lifecycle', () => {
  const session = () => read('lib/auth/session.ts')

  it('requireOrgMembership and getUserMemberships are deleted', () => {
    const s = stripTs(session())
    expect(s).not.toContain('export async function requireOrgMembership')
    expect(s).not.toContain('export async function getUserMemberships')
  })

  it('nothing else ever called them', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.includes('__tests__')) {
          const src = stripTs(read(p))
          if (/requireOrgMembership\(|getUserMemberships\(/.test(src)) offenders.push(p)
        }
      }
    }
    for (const d of ['app', 'components', 'lib']) walk(d)
    expect(offenders, `still called from:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the surviving membership helpers filter on ACTIVE', () => {
    const m040 = read('supabase/migrations/040_organizations_xpa7.sql')
    for (const fn of ['is_org_member', 'get_org_role', 'has_org_role']) {
      const body = m040.slice(m040.indexOf(`function public.${fn}`))
      expect(body.slice(0, 700), `${fn} ignores status`).toMatch(/status = 'ACTIVE'/)
    }
  })

  it('the reason is recorded rather than silently deleted', () => {
    expect(session()).toMatch(/no filter on `status`|ignored the lifecycle/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING ELSE MOVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W2 stayed in its lane', () => {
  it('W2 added no migration of its own', () => {
    // This asserted `length === 40` — the count on the day it was written.
    // XPA-8 W3 legitimately adds 041 and 042, so a fixed count would fail
    // forever for a reason that has nothing to do with W2. The invariant is
    // "no migration belongs to W2", and that is what is checked: every
    // migration up to 040 predates W2, and nothing anywhere claims to be one.
    const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
      .filter(f => f.endsWith('.sql')).sort()
    expect(migrations.length).toBeGreaterThanOrEqual(40)
    for (const f of migrations) {
      expect(read(`supabase/migrations/${f}`), `${f} claims to be W2 work`)
        .not.toMatch(/XPA-8 W2|W2:/)
    }
  })

  it('the entitlement seam is untouched', () => {
    const seam = stripTs(read('lib/auth/course-access.ts'))
    expect(seam).toContain('my_course_access')
    expect(seam).not.toMatch(/\/app\b/)
  })

  it('W1 admission is untouched', () => {
    const ac = stripTs(read('lib/access-control.ts'))
    expect(ac).toContain('account_status')
    expect(ac).not.toContain('ALLOWED_PRIVATE_EMAILS')
  })

  it('/app still requires authentication at the middleware boundary', () => {
    expect(read('middleware.ts')).toMatch(/AUTH_REQUIRED = \['\/app'/)
  })
})
