// @vitest-environment node
/**
 * XPA-8 W1 — operating-mode authority (B-1).
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `PLATFORM_MODE=private` locked the whole site behind a HARDCODED EMAIL LIST:
 *
 *     ALLOWED_PRIVATE_EMAILS = ['seckbara23@gmail.com', 'mariemelly@gmail.com']
 *
 * Wrong in fact — the real account is `mariemeify@gmail.com`, and a third real
 * account was absent — so enabling the ratified mode would have locked out the
 * learner holding every entitlement on the platform.
 *
 * Wrong in kind — an email address is not an authorization. Onboarding would
 * have required editing source and redeploying. The list was built as a
 * pre-launch SITE LOCKDOWN and was being asked to serve as ADMISSION.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 *   A learner who has legitimate platform access must not require their email
 *   address to be hardcoded in the repository.
 *
 * And the separation it must not blur: authentication ≠ admission ≠
 * entitlement ≠ enrollment ≠ organization membership.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  resolveAdmission, isAdmitted, ADMISSION_DENIAL_LABELS,
} from '@/lib/access-control'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)

const MW = stripTs(read('middleware.ts'))
const AC = stripTs(read('lib/access-control.ts'))
const PILOT = stripTs(read('lib/pilot.ts'))

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 — no learner may be admitted by a hardcoded email', () => {
  it('B-1: the email allowlist is gone from the codebase', () => {
    expect(AC, 'ALLOWED_PRIVATE_EMAILS is back').not.toContain('ALLOWED_PRIVATE_EMAILS')
    expect(AC, 'isAllowedPrivateUser is back').not.toContain('isAllowedPrivateUser')
    expect(MW, 'middleware still consults an email allowlist').not.toContain('isAllowedPrivateUser')
  })

  it('B-1: admission is decided from account state, not from an address', () => {
    expect(AC).toContain('account_status')
    // No email comparison may remain in the admission path.
    expect(AC, 'admission compares email addresses').not.toMatch(/@gmail\.com'/)
    expect(AC).not.toMatch(/email\s*===|\.email\?\.toLowerCase/)
  })

  it('B-1: middleware reads the profile rather than a literal list', () => {
    expect(MW).toMatch(/isAdmittedUser\(supabase, user\.id\)/)
    expect(MW).toMatch(/\.from\(\s*'profiles'\s*\)/)
    expect(MW).toMatch(/account_status/)
  })

  it('B-1: no production email address is used as an authority anywhere', () => {
    for (const f of ['lib/access-control.ts', 'middleware.ts']) {
      const src = stripTs(read(f))
      for (const addr of ['mariemeify@gmail.com', 'mariemelly@gmail.com', 'bawizee22@gmail.com']) {
        expect(src, `${f} hardcodes ${addr}`).not.toContain(addr)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ADMISSION IS A DECISION ABOUT THE ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 admission rule', () => {
  it('admits an active learner', () => {
    expect(isAdmitted({ account_status: 'active', platform_role: 'user' })).toBe(true)
  })

  it('refuses a suspended account, with the reason', () => {
    const r = resolveAdmission({ account_status: 'suspended', platform_role: 'user' })
    expect(r.admitted).toBe(false)
    expect(r.admitted === false && r.reason).toBe('suspended')
  })

  it('refuses a disabled account', () => {
    const r = resolveAdmission({ account_status: 'disabled', platform_role: 'user' })
    expect(r.admitted === false && r.reason).toBe('disabled')
  })

  it('FAILS CLOSED on an unknown status', () => {
    // A value the CHECK constraint would reject must not be treated as active.
    expect(isAdmitted({ account_status: 'whatever' })).toBe(false)
  })

  it('FAILS CLOSED with no profile row', () => {
    const r = resolveAdmission(null)
    expect(r.admitted).toBe(false)
    expect(r.admitted === false && r.reason).toBe('no_profile')
  })

  it('FAILS CLOSED when unauthenticated', () => {
    const r = resolveAdmission({ account_status: 'active' }, false)
    expect(r.admitted === false && r.reason).toBe('not_authenticated')
  })

  it('admits a platform admin on their role', () => {
    expect(isAdmitted({ platform_role: 'super_admin', account_status: 'active' })).toBe(true)
  })

  it('every denial has learner-facing copy', () => {
    for (const k of ['not_authenticated', 'no_profile', 'suspended', 'disabled'] as const) {
      expect(ADMISSION_DENIAL_LABELS[k]?.length ?? 0).toBeGreaterThan(10)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ADMISSION IS NOT ENTITLEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 keeps the four questions separate', () => {
  it('admission never consults entitlements, enrollments or organizations', () => {
    for (const term of ['entitlement', 'enrollment', 'has_course_access', 'organization']) {
      expect(AC.toLowerCase(), `admission consults ${term}`).not.toContain(term)
    }
  })

  it('the course seam never consults admission', () => {
    const seam = stripTs(read('lib/auth/course-access.ts'))
    expect(seam).not.toContain('isAdmitted')
    expect(seam).not.toContain('access-control')
  })

  it('being an admin does not grant a course', () => {
    // resolveAdmission returns a boolean about the APPLICATION, and nothing in
    // this module can open a course.
    expect(AC).not.toContain('course_id')
  })

  it('PLATFORM_MODE does not authorize courses', () => {
    const seam = stripTs(read('lib/auth/course-access.ts'))
    for (const flag of ['PLATFORM_MODE', 'PILOT_MODE', 'FREE_ACCESS_MODE', 'isPrivateMode']) {
      expect(seam, `${flag} leaked into the course seam`).not.toContain(flag)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED OPERATING MODE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 mode resolution fails closed', () => {
  it('an unrecognised value no longer falls back to pilot unconditionally', () => {
    // The old line was: RAW === 'private' || RAW === 'public' ? RAW : 'pilot'
    expect(PILOT, 'the permissive fallback is back')
      .not.toMatch(/\?\s*\(RAW as PlatformMode\)\s*:\s*'pilot'/)
    expect(PILOT).toContain('FALLBACK_MODE')
  })

  it('production degrades to private, non-production to pilot', () => {
    expect(PILOT).toMatch(/NODE_ENV === 'production'\s*\?\s*'private'\s*:\s*'pilot'/)
  })

  it('all three modes remain explicitly valid', () => {
    expect(PILOT).toMatch(/VALID_MODES[\s\S]{0,80}'private'[\s\S]{0,40}'pilot'[\s\S]{0,40}'public'/)
  })

  it('the value is trimmed, so whitespace is not an invalid mode', () => {
    expect(PILOT).toMatch(/\.trim\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC MARKETING STAYS PUBLIC (operating-mode.md)
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 private mode does not hide the marketing site', () => {
  // Sliced from the RAW source. The comment stripper cannot be trusted here:
  // a line comment mentioning a glob such as `/courses/*` contains `/*`, which
  // any naive scanner reads as the start of a block comment.
  const RAW_MW = read('middleware.ts')
  const exemptBlock = RAW_MW.slice(
    RAW_MW.indexOf('const PRIVATE_MODE_EXEMPT ='),
    RAW_MW.indexOf('const PRIVATE_MODE_EXEMPT_EXACT'),
  )

  it('the ratified public pages are exempt', () => {
    for (const p of ['/courses', '/contact', '/terms', '/privacy', '/parcours', '/secteurs']) {
      expect(exemptBlock, `${p} is not exempt in private mode`).toContain(`'${p}'`)
    }
  })

  it('the home page is exempt by EXACT match, not prefix', () => {
    // A '/' prefix entry would exempt the entire site and defeat the gate.
    expect(MW).toMatch(/PRIVATE_MODE_EXEMPT_EXACT = \['\/'\]/)
    expect(exemptBlock, "'/' must not be a prefix exemption").not.toMatch(/^\s*'\/',\s*$/m)
  })

  it('protected surfaces are NOT exempt', () => {
    for (const p of ['/learn', '/dashboard', '/checkout', '/certificate']) {
      expect(exemptBlock, `${p} was exempted from the private gate`).not.toContain(`'${p}'`)
    }
  })

  it('the auth flow stays reachable so a locked-out user can sign in', () => {
    for (const p of ['/login', '/forgot-password', '/reset-password', '/access-restricted']) {
      expect(exemptBlock).toContain(`'${p}'`)
    }
  })

  it('this matches the ratified operating mode', () => {
    expect(read('docs/security/operating-mode.md'))
      .toMatch(/Public marketing pages \| Publicly available/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN AND RBAC
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 admin boundaries', () => {
  it('/admin keeps its own gate and is not governed by the learner allowlist', () => {
    expect(MW).toMatch(/ADMIN_ROUTES = \['\/admin'\]/)
    const raw = read('middleware.ts')
    const block = raw.slice(raw.indexOf('const PRIVATE_MODE_EXEMPT ='),
                            raw.indexOf('const PRIVATE_MODE_EXEMPT_EXACT'))
    expect(block).toContain("'/admin'")
  })

  it('platform admin authority still comes from the owner allowlist, not account_status', () => {
    const session = stripTs(read('lib/auth/session.ts'))
    expect(session).toContain('getOwnerSession')
    expect(session, 'admin authority now depends on admission').not.toContain('isAdmitted')
  })

  it('an org admin gains no platform admission privilege', () => {
    expect(AC, 'admission consults organization role').not.toMatch(/has_org_role|is_org_member|org_admin/)
  })

  it('admission does not write anything', () => {
    expect(AC).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE EDGE READ ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W1 middleware admission read', () => {
  it('uses the session-scoped client — no service-role key at the edge', () => {
    expect(MW, 'the service role reached the edge').not.toContain('SERVICE_ROLE')
    expect(MW).toMatch(/async function isAdmittedUser/)
  })

  it('a failed read refuses rather than admits', () => {
    const fn = MW.slice(MW.indexOf('async function isAdmittedUser'))
    expect(fn.slice(0, 700)).toMatch(/catch[\s\S]{0,40}return false/)
  })

  it('runs only for non-exempt paths in private mode', () => {
    const gate = MW.slice(MW.indexOf('if (isPrivateMode)'))
    expect(gate.slice(0, 900)).toMatch(/isExempt/)
    expect(gate.slice(0, 900)).toMatch(/isAdmittedUser/)
  })
})
