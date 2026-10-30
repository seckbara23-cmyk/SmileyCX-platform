// @vitest-environment node
/**
 * AUTH-02 — public student registration accessibility.
 *
 * ── WHAT THIS SLICE DID, AND WHY IT IS SMALL ──────────────────────────────
 *
 * Registration was not missing. XPA-6A built it, hardened it, and it has been
 * live on the commercial domain: `/signup` serves a real keyless form and
 * `registerLearner` validates, rate-limits, records legal acceptance, assigns
 * `platform_role` server-side and audits. There is no access key anywhere in
 * this repository — no key field, no invite table, no redemption path.
 *
 * Two things were wrong, and this slice fixes exactly those two:
 *
 *   1. REACHABILITY. `/signup` was the only learner auth page missing from
 *      middleware's `PRIVATE_MODE_EXEMPT`, so in private mode a logged-out
 *      visitor was redirected to `/login` — which offers no way to register.
 *      That mattered beyond private mode itself, because PLATFORM_MODE
 *      resolves to 'private' in production when the variable is MISSING or
 *      MISSPELLED. One typo silently disabled all public registration.
 *
 *   2. TRUTHFULNESS. `/login` told every visitor "Accès sur invitation
 *      uniquement", the course page labelled the registration link a waiting
 *      list, and the security module and deploy gate both asserted the platform
 *      is "invite-only — accounts must be provisioned by an administrator".
 *
 * ── WHAT IT DELIBERATELY DID NOT DO ───────────────────────────────────────
 *
 * It did not touch the registration authority, `disable_signup`, the fail-closed
 * PLATFORM_MODE resolution, the admin host boundary, or the corporate
 * organization-membership flow. The second half of this file asserts all of
 * that, and matters more than the first.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MW        = 'middleware.ts'
const PILOT     = 'lib/pilot.ts'
const LOGIN     = 'app/(auth)/login/LoginForm.tsx'
const SIGNUP    = 'app/(auth)/signup/page.tsx'
const COURSE    = 'app/(public)/courses/[slug]/page.tsx'
const AUTHCFG   = 'lib/security/auth-config.ts'
const PRODGATE  = 'scripts/security/verify-prod-config.mjs'
const REGACTION = 'app/actions/auth.ts'

/** Comments blanked so prose can neither satisfy nor trip a behavioural assertion. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
   .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
   .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => m.replace(/[^\n]/g, ' '))

/** The exempt-path array as middleware actually declares it. Parsed, not retyped. */
function privateModeExempt(): string[] {
  const code = strip(read(MW))
  const m = /const PRIVATE_MODE_EXEMPT\s*=\s*\[([\s\S]*?)\]/.exec(code)
  expect(m, 'PRIVATE_MODE_EXEMPT is no longer where this test looks').toBeTruthy()
  return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])
}

/** Every mode the application recognises, parsed from the source of truth. */
function validModes(): string[] {
  const m = /const VALID_MODES[^=]*=\s*\[([^\]]*)\]/.exec(read(PILOT))
  expect(m, 'VALID_MODES moved').toBeTruthy()
  return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])
}

function sourceFiles(dirs: readonly string[] = ['app', 'components', 'lib']): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries
    try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) { walk(p); continue }
      if (/\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  dirs.forEach(walk)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 1. /signup is reachable in every mode', () => {
  it('all three modes exist, so "every mode" is a closed set', () => {
    expect(validModes().sort()).toEqual(['pilot', 'private', 'public'])
  })

  it('/signup is exempt from the private-mode site-wide gate', () => {
    expect(privateModeExempt(), '/signup is gated in private mode').toContain('/signup')
  })

  it('every learner auth page is exempt — signup was the only gap', () => {
    const exempt = privateModeExempt()
    const code = strip(read(MW))
    const m = /const LEARNER_AUTH_PAGES\s*=\s*\[([^\]]*)\]/.exec(code)
    expect(m, 'LEARNER_AUTH_PAGES moved').toBeTruthy()
    const authPages = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])
    expect(authPages).toContain('/signup')
    for (const p of authPages) {
      expect(exempt, `${p} is a learner auth page but is gated in private mode`).toContain(p)
    }
    // And the recovery landing, which arrives from an email link with no session.
    expect(exempt).toContain('/reset-password')
  })

  it('pilot and public modes never consult the private gate at all', () => {
    // The gate is guarded by isPrivateMode, so the other two modes cannot block
    // /signup regardless of the exempt list.
    const code = strip(read(MW))
    expect(code).toMatch(/if\s*\(\s*isPrivateMode\s*\)/)
    expect(code).toMatch(/import \{[^}]*isPrivateMode[^}]*\} from '@\/lib\/access-control'/)
    // And it is derived from PLATFORM_MODE at its single source of truth.
    expect(strip(read('lib/access-control.ts')))
      .toMatch(/export const isPrivateMode = PLATFORM_MODE === 'private'/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 2. a misconfigured PLATFORM_MODE cannot silently block signup', () => {
  it('the fail-closed resolution is UNCHANGED — this slice did not open it', () => {
    const src = read(PILOT)
    // Production still degrades toward lockdown. That is the XPA-8 W1 control
    // and the brief forbids a global fail-open change.
    expect(src).toMatch(/FALLBACK_MODE[\s\S]{0,120}production[\s\S]{0,40}'private'/)
    expect(src).toMatch(/'pilot'/)
  })

  it('the degradation is now REPORTED, with a diagnostic naming the variable', () => {
    const src = read(PILOT)
    expect(src).toMatch(/PLATFORM_MODE_DIAGNOSTIC/)
    expect(src).toMatch(/NEXT_PUBLIC_PLATFORM_MODE is not set/)
    expect(src).toMatch(/unrecognised value/)
  })

  it('the diagnostic never prints the misconfigured VALUE', () => {
    // A mistyped variable could contain anything, including something pasted
    // there by accident. The message reports its LENGTH.
    const src = strip(read(PILOT))
    const diag = /PLATFORM_MODE_DIAGNOSTIC[\s\S]*?(?=\n\/\/|\nif \()/.exec(src)
    expect(diag).toBeTruthy()
    expect(diag![0], 'the raw value is interpolated into the diagnostic')
      .not.toMatch(/\$\{RAW\}/)
    expect(diag![0]).toMatch(/RAW\.length/)
  })

  it('the diagnostic is server-side only — this module reaches client bundles', () => {
    const src = strip(read(PILOT))
    expect(src).toMatch(/typeof window === 'undefined'/)
    // PAYMENTS_ENABLED is imported by client components, so pilot.ts must stay
    // importable from the browser: no server-only, no node APIs.
    expect(src).not.toMatch(/import 'server-only'/)
    expect(src).not.toMatch(/require\(|from 'fs'|from 'node:/)
  })

  it('reporting is not gating — the diagnostic changes no resolved value', () => {
    const src = strip(read(PILOT))
    // PLATFORM_MODE is assigned exactly once, before any diagnostic exists.
    expect((src.match(/export const PLATFORM_MODE\b/g) ?? []).length).toBe(1)
    const assign = /export const PLATFORM_MODE: PlatformMode =([\s\S]*?)\n\n/.exec(src)
    expect(assign).toBeTruthy()
    expect(assign![1], 'the diagnostic leaked into mode resolution')
      .not.toMatch(/DIAGNOSTIC|console/)
  })

  it('an unset or misspelled mode still leaves /signup exempt', () => {
    // The two halves together are the actual fix: whatever the variable says,
    // the registration path is exempt, so a typo cannot close registration.
    expect(privateModeExempt()).toContain('/signup')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 3. private and admin routes remain protected', () => {
  it('protected learner areas are NOT exempt from the private gate', () => {
    const exempt = privateModeExempt()
    for (const p of ['/learn', '/dashboard', '/checkout', '/certificate', '/app']) {
      expect(exempt, `${p} became publicly reachable in private mode`).not.toContain(p)
    }
  })

  it('the auth-required list is unchanged', () => {
    const m = /const AUTH_REQUIRED\s*=\s*\[([^\]]*)\]/.exec(strip(read(MW)))
    expect(m).toBeTruthy()
    expect([...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort())
      .toEqual(['/app', '/certificate', '/checkout', '/dashboard', '/learn'])
  })

  it('the admin host boundary and admin route protection are untouched', () => {
    const code = strip(read(MW))
    expect(code).toMatch(/isAdminHost\(resolveHost\(request\.headers\)\)/)
    const m = /const ADMIN_ROUTES\s*=\s*\[([^\]]*)\]/.exec(code)
    expect(m).toBeTruthy()
    expect([...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])).toEqual(['/admin'])
  })

  it('the signup PAGE still enforces isCommercialHost, so the admin host is refused', () => {
    const page = strip(read(SIGNUP))
    expect(page).toMatch(/isCommercialHost/)
    expect(page).toMatch(/redirect\('\/login'\)/)
  })

  it('and the server ACTION enforces it independently of the page', () => {
    // A redirect in the browser is not an authorization control: an action can
    // be invoked without the page ever rendering.
    expect(strip(read(REGACTION))).toMatch(/isCommercialHost/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 4. no invitation-only messaging on student entry points', () => {
  const STUDENT_ENTRY = [LOGIN, SIGNUP, COURSE] as const

  it('no student entry point claims access is invitation-only', () => {
    for (const f of STUDENT_ENTRY) {
      const src = strip(read(f))
      expect(src, `${f} still says access is invitation-only`)
        .not.toMatch(/sur invitation/i)
      expect(src, `${f} still offers a waiting list instead of registration`)
        .not.toMatch(/liste d('|&apos;)attente/i)
    }
  })

  it('the login page offers free registration and links to /signup', () => {
    const src = strip(read(LOGIN))
    expect(src).toMatch(/href="\/signup"/)
    expect(src).toMatch(/gratuitement/i)
    expect(src).toMatch(/espace étudiant/i)
  })

  it('the paid-course message states free signup AND the access requirement', () => {
    const src = strip(read(COURSE))
    expect(src, 'the course page no longer says registration is free')
      .toMatch(/inscription est gratuite|Inscription gratuite/i)
    expect(src, 'the course page no longer states that access needs an entitlement')
      .toMatch(/droit d('|&apos;)acc(è|&egrave;)s/i)
  })

  it('the security module and deploy gate no longer assert an invite-only policy', () => {
    for (const f of [AUTHCFG, PRODGATE]) {
      const src = read(f)
      // The phrase may survive only where it is explicitly described as the
      // CORRECTED wording; it must not be stated as current policy.
      const stated = src
        .split('\n')
        .filter(l => /invite-only/.test(l))
        // A QUOTED occurrence is the OLD wording being cited, not claimed.
        .filter(l => !/["'][^"']*invite-only/.test(l))
        .filter(l => !/used to|AUTH-02|corrected|stopped being true/i.test(l))
      expect(stated, `${f} still asserts invite-only: ${stated.join(' | ')}`).toEqual([])
    }
  })

  it('both still describe the control they actually enforce', () => {
    expect(read(AUTHCFG)).toMatch(/registerLearner/)
    expect(read(PRODGATE)).toMatch(/registerLearner/)
    expect(read(PRODGATE)).toMatch(/auth\/v1\/signup/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 5. corporate invitations are untouched', () => {
  it('organization membership still uses invitation terminology', () => {
    // "Accès sur invitation" was wrong for STUDENTS. It remains correct for
    // organization membership, which genuinely is invitation-based.
    expect(read('lib/organizations/index.ts')).toMatch(/Invitation en attente/)
    expect(read('app/(admin)/admin/organizations/[id]/page.tsx'))
      .toMatch(/Invitations en attente/)
  })

  it('the corporate membership action is unchanged by this slice', () => {
    const src = read('app/actions/organizations.ts')
    expect(src).toMatch(/PENDING/)
    expect(src).toMatch(/Invitation enregistrée/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 6. the registration authority is unchanged', () => {
  const action = read(REGACTION)
  const code = strip(action)

  it('registerLearner is still the only registration entry point', () => {
    expect(action).toMatch(/export async function registerLearner/)
    // A CALL or an IMPORT — not a mention. `registerLearner` is now also named
    // inside INSECURE_SIGNUP_MESSAGE, a user-facing string that describes the
    // control; naming it there is documentation, not a second entry point.
    const callers = sourceFiles().filter(f => {
      if (f === REGACTION) return false
      const code = strip(read(f))
      return /registerLearner\s*\(/.test(code)
          || /import\s*\{[^}]*registerLearner/.test(code)
    })
    expect(callers).toEqual(['app/(auth)/signup/RegisterForm.tsx'])
  })

  it('no code anywhere calls Supabase public signup', () => {
    const offenders = sourceFiles().filter(f => /auth\.signUp\s*\(/.test(strip(read(f))))
    expect(offenders, `auth.signUp called by: ${offenders.join(', ')}`).toEqual([])
  })

  it('the disable_signup control is still enforced by the deploy gate', () => {
    expect(read(PRODGATE)).toMatch(/disable_signup/)
    expect(read(PRODGATE)).toMatch(/DEPLOYMENT BLOCKED/)
    expect(read(AUTHCFG)).toMatch(/disable_signup/)
  })

  it('platform_role is written server-side from a literal, never from input', () => {
    expect(code).toMatch(/platform_role:\s*'user'/)
    // The input schema has no role field to ignore in the first place.
    const schema = /export const RegistrationSchema[\s\S]*?\.refine/.exec(read('lib/validation/schemas.ts'))
    expect(schema).toBeTruthy()
    expect(schema![0], 'the registration schema accepts a role field')
      .not.toMatch(/\brole\b|platform_role/)
  })

  it('email verification, legal acceptance, rate limits and CAPTCHA all remain', () => {
    expect(code).toMatch(/sendVerificationEmail/)
    expect(code).toMatch(/legal_acceptances/)
    expect(code).toMatch(/rateLimitDb/)
    expect(code).toMatch(/REGISTER_IP_LIMIT/)
    expect(code).toMatch(/REGISTER_EMAIL_LIMIT/)
    expect(code).toMatch(/verifyCaptcha/)
    expect(code).toMatch(/logAuditEvent/)
  })

  it('anti-enumeration responses are preserved', () => {
    expect(action).toMatch(/NEUTRAL_REGISTRATION_MESSAGE/)
    expect(action).toMatch(/NEUTRAL_RECOVERY_MESSAGE/)
  })

  it('profile provisioning is still idempotent at both layers', () => {
    expect(code).toMatch(/onConflict:\s*'id'/)
    const mig = read('supabase/migrations/001_phase_a_rls_fix.sql')
    expect(mig).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    // The trigger writes the role as a literal too — not from user metadata.
    expect(mig).toMatch(/raw_user_meta_data->>'full_name'[\s\S]{0,40}'user'/)
  })

  it('registration grants NO entitlement, enrollment or payment', () => {
    for (const t of ['entitlements', 'enrollments', 'payments']) {
      expect(code, `registration touches ${t}`)
        .not.toMatch(new RegExp(`from\\(\\s*['"]${t}['"]\\s*\\)`))
    }
    expect(code).not.toMatch(/\.rpc\(\s*['"]complete_payment/)
  })

  it('login and password reset are untouched', () => {
    expect(read(LOGIN)).toMatch(/signInWithPassword/)
    expect(action).toMatch(/export async function requestPasswordReset/)
    expect(action).toMatch(/export async function resendVerification/)
    expect(existsSync(join(ROOT, 'app/(auth)/reset-password/page.tsx'))).toBe(true)
    expect(existsSync(join(ROOT, 'app/(auth)/forgot-password/page.tsx'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('AUTH-02 · 7. scope guard: nothing unrelated moved', () => {
  it('no migration was added', () => {
    const migs = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    // XP-PAYTECH-04 authored 063 (the payment state machine); it is admitted by name.
    expect(migs).toHaveLength(62)
    expect(migs).toContain('063_payment_state_machine.sql')
    // XP-PAYTECH-05 authored 064 (payment exceptions); it is admitted by name.
    expect(migs).toContain('064_payment_exceptions.sql')
  })

  it('payment work stayed paused — 062 and the transport client are untouched', () => {
    const { createHash } = require('crypto') as typeof import('crypto')
    const raw = readFileSync(join(ROOT, 'supabase/migrations/062_atomic_payment_completion.sql'))
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('899cd3832573383b20df4dc09003f702a860c4ccb4651caead1a0bee817f31bb')
    // XP-PAYTECH-01 added a second provider: its credential boundary, its
    // transport, its IPN verification, the shared completion chokepoint and
    // provider selection. 062 itself is still byte-identical (asserted above),
    // which is what "payment work stayed paused" was really protecting.
    expect(readdirSync(join(ROOT, 'lib/payments')).sort()).toEqual([
      'paydunya-client.ts',
      'paydunya-config.ts',
      'payment-completion.ts',
      'payment-database-guard.ts', 'payment-exceptions.ts',
      'paytech-callbacks.ts',
      'paytech-client.ts',
      'paytech-config.ts',
      'paytech-ipn.ts',
      'paytech-reconcile.ts',
      'paytech-settlement-contract.ts',
      'providers.ts',
      'purchase-eligibility.ts',
    ])
    // PayDunya is still unwired: no module IMPORTS its transport. The PayTech
    // integration deliberately did not activate the PayDunya path.
    //
    // Matched as an import rather than as a bare substring: the PayTech modules
    // cite `paydunya-client.ts` in their prose, to explain which behaviours were
    // copied and which could not be, so a substring match would flag the
    // documentation instead of a caller.
    const callers = sourceFiles().filter(f =>
      /from\s+['"][^'"]*paydunya-client['"]/.test(read(f)))
    expect(callers, `the PayDunya client gained a caller: ${callers.join(', ')}`).toEqual([])
  })

  it('the payment feature flag is still off and PLATFORM_MODE is still pilot locally', () => {
    expect(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED ?? 'unset').not.toBe('true')
    if (existsSync(join(ROOT, '.env.local'))) {
      const env = read('.env.local')
      expect(env).not.toMatch(/^NEXT_PUBLIC_PAYMENTS_ENABLED\s*=\s*true/m)
      expect(env).toMatch(/^NEXT_PUBLIC_PLATFORM_MODE\s*=\s*pilot/m)
    }
  })
})
