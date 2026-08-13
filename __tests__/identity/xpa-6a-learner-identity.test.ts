// @vitest-environment node
/**
 * XPA-6A — commercial registration, learner identity and domain separation.
 *
 * The property these tests exist to protect is a single sentence:
 *
 *     Creating an account grants NOTHING.
 *
 * Account, payment, enrollment and access are four separate facts (ratified
 * decision 4), and the failure mode worth fearing is the quiet one — a policy
 * arm, a default privilege or a mode flag that silently reconnects them.
 *
 * Source and SQL assertions dominate deliberately. The historical incidents on
 * this platform (SEC-1/F-1, XPA-5A's writable view, the blanket is_preview flag)
 * were all "a statement that reads like a restriction but only widens", and none
 * of them would have been caught by testing the happy path.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const MIGRATION_035 = 'supabase/migrations/035_learner_identity_and_access.sql'
const MIGRATION_036 = 'supabase/migrations/036_fix_content_policy_recursion.sql'
const VERCEL_HOST = 'smiley-cx-platform.vercel.app'

/** Blank comments and strings, preserving offsets — assert on CODE, not prose. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
}

/** Blank SQL comments only. */
function stripSql(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A registration', () => {
  const action = read('app/actions/auth.ts')
  const actionCode = stripComments(action)

  it('is refused on any non-commercial host', () => {
    expect(actionCode).toMatch(/isCommercialHost\(host\)/)
    // The host check runs before validation, rate limiting or account creation:
    // nothing may happen on the internal host, not even a rate-limit consume.
    const gate = actionCode.indexOf('isCommercialHost(host)')
    const create = actionCode.indexOf('createUser')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(create)
  })

  it('is enforced at the page AND the action, not by middleware alone', () => {
    expect(stripComments(read('app/(auth)/signup/page.tsx'))).toMatch(/isCommercialHost\(/)
    expect(actionCode).toMatch(/isCommercialHost\(/)
  })

  it('creates the account UNCONFIRMED — verification is not optional', () => {
    expect(actionCode).toMatch(/email_confirm:\s*false/)
    expect(actionCode).not.toMatch(/email_confirm:\s*true/)
  })

  it('records versioned legal acceptance for BOTH documents', () => {
    expect(actionCode).toMatch(/legal_acceptances/)
    expect(actionCode).toMatch(/document:\s*'terms'/)
    expect(actionCode).toMatch(/document:\s*'privacy'/)
    expect(actionCode).toMatch(/version:\s*TERMS_VERSION/)
    expect(actionCode).toMatch(/version:\s*PRIVACY_VERSION/)
  })

  it('FAILS CLOSED when legal acceptance cannot be recorded', () => {
    // The just-created account must be destroyed, not left as an account whose
    // consent we cannot evidence.
    const branch = actionCode.slice(actionCode.indexOf('if (legalError)'))
    expect(branch.slice(0, 900)).toMatch(/deleteUser\(/)
    expect(branch.slice(0, 900)).toMatch(/ok:\s*false/)
  })

  it('rejects a stale legal version instead of recording it', () => {
    expect(actionCode).toMatch(/acceptedTermsVersion\s*!==\s*TERMS_VERSION/)
    expect(actionCode).toMatch(/acceptedPrivacyVersion\s*!==\s*PRIVACY_VERSION/)
  })

  it('creates NO enrollment, entitlement, payment or organization membership', () => {
    for (const forbidden of [
      /from\(['"]enrollments['"]\)/,
      /from\(['"]payments['"]\)/,
      /from\(['"]organization_memberships['"]\)/,
      /enrollForFree/,
    ]) {
      expect(actionCode).not.toMatch(forbidden)
    }
  })

  it('provisions the profile idempotently', () => {
    expect(actionCode).toMatch(/\.upsert\(/)
    expect(actionCode).toMatch(/onConflict:\s*'id'/)
  })

  it('forces platform_role to the literal "user"', () => {
    expect(actionCode).toMatch(/platform_role:\s*'user'/)
    expect(actionCode).toMatch(/account_status:\s*'active'/)
  })

  it('returns ONE neutral message for success and for a duplicate email', () => {
    // Both the success path and the createUser-error path (which is what a
    // duplicate address produces) must return the same constant, and the error
    // path must report ok:true so the two are indistinguishable to the caller.
    expect(actionCode).toMatch(/NEUTRAL_REGISTRATION_MESSAGE/)
    const dupBranch = actionCode.slice(actionCode.indexOf('if (createError'))
    expect(dupBranch.slice(0, 800)).toMatch(/ok:\s*true,\s*message:\s*NEUTRAL_REGISTRATION_MESSAGE/)
  })

  it('rate limits by IP and by email address', () => {
    expect(actionCode).toMatch(/rateLimitDb\(`register:ip:/)
    expect(actionCode).toMatch(/rateLimitDb\(`register:email:/)
  })

  it('audits blocked attempts as well as successful ones', () => {
    expect(action).toMatch(/'user\.registration_blocked'/)
    expect(action).toMatch(/'user\.registered'/)
    expect(action).toMatch(/outcome:\s*'failure'/)
    expect(action).toMatch(/outcome:\s*'success'/)
  })

  it('requires a strong password for new accounts only', () => {
    const schemas = read('lib/validation/schemas.ts')
    expect(schemas).toMatch(/NewPasswordSchema/)
    expect(schemas).toMatch(/\.min\(12/)
    // Sign-IN must keep the old rule, or accounts created earlier lock out.
    const signIn = schemas.slice(schemas.indexOf('export const SignInSchema'))
    expect(signIn.slice(0, 200)).toMatch(/password:\s*PasswordSchema/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A email verification', () => {
  const verify = read('app/auth/verify/route.ts')

  it('exchanges a single-use OTP and audits both outcomes', () => {
    expect(verify).toMatch(/verifyOtp\(/)
    expect(verify).toMatch(/type:\s*'signup'/)
    expect(verify).toMatch(/'user\.email_verified'/)
    expect(verify).toMatch(/outcome:\s*'failure'/)
    expect(verify).toMatch(/outcome:\s*'success'/)
  })

  it('never logs or audits the token VALUE', () => {
    const code = stripComments(verify)

    // Scope the check to LOG and AUDIT call sites only. The token is of course
    // passed to verifyOtp — that is the entire point of the route — so a
    // file-wide scan for `tokenHash` as a value flags the one legitimate use
    // and proves nothing.
    const sinks = code.match(/(?:log\.\w+|logAuditEvent)\([\s\S]*?\)\s*$/gm) ?? []
    expect(sinks.length).toBeGreaterThan(2)

    for (const sink of sinks) {
      // Boolean(tokenHash) is deliberately allowed: presence is not the secret.
      const withoutPresenceCheck = sink.replace(/Boolean\(\s*tokenHash\s*\)/g, 'PRESENCE')
      expect(withoutPresenceCheck, sink.slice(0, 100)).not.toMatch(/tokenHash/)
    }
  })

  it('redirects only to the canonical domain, never to the request origin', () => {
    const code = stripComments(verify)
    expect(code).toMatch(/publicUrl\(/)
    expect(code).not.toMatch(/\borigin\b/)
  })

  it('uses the @supabase/ssr@0.3.0 cookie shape (get/set/remove), not getAll', () => {
    // The wrong shape is silently ignored, so the session is never persisted —
    // CX-AUTH-0 finding F-2, which tsc does not catch.
    expect(verify).toMatch(/get\(name: string\)/)
    expect(verify).not.toMatch(/getAll\s*\(/)
    expect(verify).not.toMatch(/setAll\s*\(/)
  })

  it('resend is rate limited and stays neutral even when limited', () => {
    const action = stripComments(read('app/actions/auth.ts'))
    const resend = action.slice(action.indexOf('export async function resendVerification'))
    expect(resend).toMatch(/rateLimitDb\(`verify-resend:/)
    const limited = resend.slice(resend.indexOf('if (!rl.success)'))
    expect(limited.slice(0, 700)).toMatch(/ok:\s*true,\s*message:\s*NEUTRAL_REGISTRATION_MESSAGE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN SEPARATION
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A domain separation', () => {
  it('learner-facing email templates never contain the internal hostname', () => {
    const templates = readdirSync(join(ROOT, 'lib/email/templates'))
    expect(templates.length).toBeGreaterThan(0)
    for (const f of templates) {
      const src = read(`lib/email/templates/${f}`)
      expect(src, `${f} must not name the deployment host`).not.toContain(VERCEL_HOST)
      expect(src, `${f} must not name any vercel.app host`).not.toMatch(/vercel\.app/)
    }
  })

  it('the verification link is composed from the canonical origin, not the request', () => {
    const action = stripComments(read('app/actions/auth.ts'))
    const dispatch = action.slice(action.indexOf('async function dispatchVerificationEmail'))
    expect(dispatch).toMatch(/publicUrl\(/)
    // Structurally incapable of reflecting the caller's host.
    expect(dispatch).not.toMatch(/\borigin\b/)
    expect(dispatch).not.toMatch(/headers\(\)/)
  })

  it('the recovery link is composed from the canonical origin', () => {
    const action = stripComments(read('app/actions/auth.ts'))
    const recover = action.slice(action.indexOf('export async function requestPasswordReset'))
    expect(recover).toMatch(/redirectTo:\s*publicUrl\(/)
    expect(recover).not.toMatch(/location\.origin/)
  })

  it('the internal hostname still appears in exactly the two carve-out files', () => {
    let hits: string[] = []
    try {
      hits = execFileSync(
        'git', ['grep', '-l', '-e', VERCEL_HOST, '--', 'app', 'components', 'lib', 'middleware.ts'],
        { cwd: ROOT, encoding: 'utf8' },
      ).split('\n').map(s => s.trim()).filter(Boolean)
    } catch { hits = [] }
    expect(hits.sort()).toEqual(['lib/hosts.ts', 'middleware.ts'])
  }, 20_000)

  it('no learner navigation links to the internal host', () => {
    for (const f of ['components/layout/Header.tsx', 'components/layout/Footer.tsx']) {
      expect(read(f)).not.toMatch(/vercel\.app/)
    }
  })

  it('authorization does not depend on the hostname', () => {
    // A spoofed Host header can at most change which BOUNDARY applies. Every
    // admin entry point calls requirePlatformAdmin(), which reads a verified
    // Supabase session and an email allowlist — neither derived from the host.
    const session = read('lib/auth/session.ts')
    expect(session).toMatch(/export async function requirePlatformAdmin/)
    expect(stripComments(session)).not.toMatch(/isAdminHost|resolveHost|x-forwarded-host/)

    const owner = read('lib/auth/owner-email.ts')
    expect(stripComments(owner)).not.toMatch(/host/i)
  })

  it('admin pages and actions each enforce authorization independently', () => {
    const files = execFileSync(
      'git', ['ls-files', 'app/(admin)'], { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').map(s => s.trim()).filter(f => /\/(page|actions)\.tsx?$/.test(f))

    expect(files.length).toBeGreaterThan(10)
    const unguarded = files.filter(f => !read(f).includes('requirePlatformAdmin'))
    expect(unguarded).toEqual([])
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// COURSE-ACCESS SEAM — registration grants nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A course access', () => {
  const sql = read(MIGRATION_035)
  const sqlCode = stripSql(sql)

  it('defines a single server-authoritative seam', () => {
    expect(sqlCode).toMatch(/create or replace function public\.has_course_access\(p_course_id uuid\)/)
    expect(sqlCode).toMatch(/security definer/i)
  })

  it('the seam requires an ACTIVE enrollment — not authentication, not publication', () => {
    const fn = sqlCode.slice(
      sqlCode.indexOf('create or replace function public.has_course_access'),
      sqlCode.indexOf('comment on function public.has_course_access'),
    )
    expect(fn).toMatch(/from public\.enrollments e/)
    expect(fn).toMatch(/e\.status\s*=\s*'active'/)
    expect(fn).toMatch(/public\.is_email_verified\(\)/)
    // The three arms that made everything public must NOT reappear here.
    expect(fn).not.toMatch(/is_free/)
    expect(fn).not.toMatch(/is_published/)
    expect(fn).not.toMatch(/auth\.uid\(\)\s+is\s+null/i)
  })

  it('every content policy is rewritten onto the seam', () => {
    for (const table of ['lessons', 'modules', 'quizzes', 'quiz_questions']) {
      const stmt = sqlCode.slice(
        sqlCode.indexOf(`create policy "${table}_visible"`),
        sqlCode.indexOf(`create policy "${table}_visible"`) + 1800,
      )
      expect(stmt, `${table} policy must call the seam`).toMatch(/public\.has_course_access\(/)
      expect(stmt, `${table} policy must not resurrect is_free`).not.toMatch(/is_free/)
      expect(stmt, `${table} policy must not resurrect the anonymous arm`).not.toMatch(/auth\.uid\(\)\s+is\s+null/i)
    }
  })

  it('the blanket is_preview flag is retired and asserted at apply time', () => {
    expect(sqlCode).toMatch(/update public\.lessons set is_preview = false/)
    expect(sqlCode).toMatch(/from public\.lessons where is_preview = true/)
    expect(sqlCode).toMatch(/raise exception 'every lesson \(%\) is still flagged is_preview/)
  })

  /**
   * The reset must not be an unconditional UPDATE.
   *
   * Re-running the migration a year from now would otherwise silently
   * un-publish whatever preview lessons an administrator had deliberately
   * chosen. That is repeatable, not idempotent.
   */
  it('the is_preview reset fires only while the blanket pattern holds', () => {
    const block = sqlCode.slice(sqlCode.indexOf('select count(*) into n_total'))
    expect(block.slice(0, 600)).toMatch(/if n_total > 0 and n_preview = n_total then/)
    const update = sqlCode.indexOf('update public.lessons set is_preview = false')
    const guard = sqlCode.indexOf('if n_total > 0 and n_preview = n_total then')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(update)
  })

  /**
   * And the assertion must check the DANGEROUS state, not "zero previews" —
   * asserting zero would turn a legitimate editorial act into a failed
   * migration on the next run.
   */
  it('the apply-time assertion permits a deliberate preview subset', () => {
    // Anchored on the raised message, not on a `-- 9d` comment marker: the
    // comments are stripped before these assertions run, so a comment anchor
    // silently matches position 0 and the test asserts nothing.
    const at = sqlCode.indexOf("raise exception 'every lesson")
    expect(at).toBeGreaterThan(-1)
    const assertion = sqlCode.slice(at - 400, at + 200)
    expect(assertion).toMatch(/n_preview = n_total/)
    // "zero previews" would forbid a legitimate editorial act.
    expect(assertion).not.toMatch(/n_preview\s*<>\s*0/)
  })

  it('an assessment has no preview arm', () => {
    for (const table of ['quizzes', 'quiz_questions']) {
      const start = sqlCode.indexOf(`create policy "${table}_visible"`)
      const stmt = sqlCode.slice(start, start + 1800)
      expect(stmt, `${table} must never be previewable`).not.toMatch(/is_preview/)
    }
  })

  it('free self-enrollment is closed and fails closed on a missing flag', () => {
    const enrol = read('app/actions/enrollment.ts')
    expect(enrol).toMatch(/NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT\s*===\s*'true'/)
    const code = stripComments(enrol)
    // The deny check must be the first thing the function does.
    //
    // Scoped to enrollForFree's own body. This previously searched the whole
    // file, which was a proxy that held only while enrollForFree owned the
    // first `.upsert(` in it. UAT-ACCESS-01 added `ensureAcademicEnrollment`
    // above it — a different function, with its own entitlement guard — and the
    // proxy broke while the guarantee did not. Assert the guarantee.
    const body = code.slice(code.indexOf('export async function enrollForFree'))
    const guard = body.indexOf('if (!SELF_ENROLLMENT_OPEN)')
    const insert = body.indexOf('.upsert(')
    expect(guard, 'enrollForFree lost its SELF_ENROLLMENT_OPEN guard').toBeGreaterThan(-1)
    expect(insert, 'enrollForFree no longer writes — has it been renamed?').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(insert)
  })

  it('Voice Practice requires course access, resolved from the scenario', () => {
    const ai = stripComments(read('app/actions/ai-practice.ts'))
    const start = ai.indexOf('export async function startVoiceSession')
    const body = ai.slice(start, ai.indexOf('export async function saveAiTurns'))
    expect(body).toMatch(/resolveCourseAccessById\(/)
    expect(body).toMatch(/courseIdForLesson\(/)
    // The course must come from the scenario, never from the request payload.
    expect(body).not.toMatch(/input\.courseId|parsed\.data\.courseId/)
  })

  it('the /learn route group is gated by the seam', () => {
    const layout = read('app/(learn)/learn/[courseSlug]/layout.tsx')
    expect(layout).toMatch(/resolveCourseAccess\(/)
    expect(layout).toMatch(/access\.allowed/)
  })

  /**
   * XPA-6B superseded the enrollment clause of this test: the seam now reads
   * entitlements, and asserting `.eq('status','active')` on enrollments would
   * pin the very coupling Q-L removed. What still matters — and is what this
   * test was always about — is that the TS mirror applies the same gate
   * conditions as the SQL function.
   */
  it('the TS contract mirrors the SQL one', () => {
    const ts = stripComments(read('lib/auth/course-access.ts'))
    expect(ts).toMatch(/email_confirmed_at/)
    expect(ts).toMatch(/account_status/)
    expect(ts).toMatch(/platform_role === 'super_admin'/)
    expect(ts).not.toMatch(/is_free/)
    expect(ts).not.toMatch(/is_published/)
  })

  it('public course-description pages are NOT restricted', () => {
    // `courses` itself is deliberately untouched — discovery must keep working.
    expect(sqlCode).not.toMatch(/create policy "courses_visible"/)
    expect(sqlCode).not.toMatch(/revoke .* on public\.courses/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CONTENT POLICY RECURSION — migration 036
//
// Migration 035 applied cleanly, passed every structural check, and left all
// four content tables unreadable by every caller that goes through RLS
// (42P17, infinite recursion). lessons_visible queried modules, modules_visible
// queried lessons.
//
// A policy can be perfectly formed and still be unevaluatable. These tests pin
// the structural rule that prevents it; the migration itself adds the
// behavioural check that catches whatever the rule misses.
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A content policies are evaluatable (migration 036)', () => {
  const sql036 = stripSql(read(MIGRATION_036))
  const CONTENT_TABLES = ['lessons', 'modules', 'quizzes', 'quiz_questions']

  it('no content policy queries another RLS-protected content table', () => {
    for (const table of CONTENT_TABLES) {
      const start = sql036.indexOf(`create policy "${table}_visible"`)
      expect(start, `${table}_visible must be redefined in 036`).toBeGreaterThan(-1)
      const policy = sql036.slice(start, sql036.indexOf(';', start))

      // Scope to the USING expression. The statement itself contains
      // `for select`, so scanning the whole thing flags every policy.
      const using = policy.slice(policy.indexOf('using ('))
      expect(using.length, `${table}_visible must have a USING clause`).toBeGreaterThan(8)

      // This single rule is what the outage came down to. Every cross-table
      // lookup must go through a SECURITY DEFINER resolver instead.
      expect(using, `${table}_visible USING must contain no subquery`).not.toMatch(/\bselect\b/i)
      expect(using, `${table}_visible USING must contain no EXISTS`).not.toMatch(/\bexists\b/i)
      for (const other of CONTENT_TABLES) {
        expect(using, `${table}_visible must not read public.${other}`)
          .not.toMatch(new RegExp(`public\\.${other}\\b`, 'i'))
      }
    }
  })

  it('every cross-table resolver is SECURITY DEFINER with a pinned search_path', () => {
    for (const fn of [
      'course_of_module', 'course_of_lesson', 'module_has_preview_lesson', 'course_of_quiz',
    ]) {
      const start = sql036.indexOf(`create or replace function public.${fn}`)
      expect(start, `${fn} must exist`).toBeGreaterThan(-1)
      const body = sql036.slice(start, sql036.indexOf('$$;', start))
      expect(body, fn).toMatch(/security definer/i)
      expect(body, fn).toMatch(/set search_path/i)
      expect(body, fn).toMatch(/\bstable\b/i)
    }
  })

  it('resolvers revoke default EXECUTE before granting it to the app roles', () => {
    for (const fn of [
      'course_of_module(uuid)', 'course_of_lesson(uuid)',
      'module_has_preview_lesson(uuid)', 'course_of_quiz(uuid)',
    ]) {
      const r = sql036.indexOf(`revoke all on function public.${fn}`)
      const g = sql036.indexOf(`grant execute on function public.${fn}`)
      expect(r, `${fn} must be revoked from public`).toBeGreaterThan(-1)
      expect(g, `${fn} must be granted to the app roles`).toBeGreaterThan(-1)
      expect(r).toBeLessThan(g)
    }
  })

  it('authorization semantics are unchanged — the seam itself is not touched', () => {
    // 036 fixes HOW a policy reaches the course id, never WHO gets access.
    expect(sql036).not.toMatch(/create or replace function public\.has_course_access/)
    for (const table of CONTENT_TABLES) {
      const start = sql036.indexOf(`create policy "${table}_visible"`)
      const policy = sql036.slice(start, sql036.indexOf(';', start))
      if (table === 'modules' || table === 'lessons') {
        expect(policy).toMatch(/public\.has_course_access\(/)
      } else {
        // Assessments have no preview arm and nothing else.
        expect(policy).toMatch(/^[\s\S]*public\.has_course_access\(public\.course_of_quiz\(/)
        expect(policy).not.toMatch(/is_preview/)
      }
      expect(policy).not.toMatch(/is_free|is_published/)
    }
  })

  /**
   * The check migration 035 should have had. Structural assertions cannot tell
   * "correctly denied" from "raises 42P17" — only reading the table as the real
   * role can.
   */
  it('exercises every policy as anon AND authenticated at apply time', () => {
    expect(sql036).toMatch(/set role %I|set role anon/)
    expect(sql036).toMatch(/array\['anon', 'authenticated'\]/)
    expect(sql036).toMatch(/select 1 from public\.%I limit 1/)
    expect(sql036).toMatch(/raise exception 'content policy is not evaluatable as role/)
    expect(sql036).toMatch(/reset role/)
  })

  it('re-asserts that anon still sees nothing, and discovery still works', () => {
    expect(sql036).toMatch(/raise exception 'anonymous caller can still read protected content/)
    expect(sql036).toMatch(/raise exception 'anonymous caller can no longer read the course catalogue/)
  })

  it('does not edit the applied migration 035', () => {
    // 035 is applied and ledger-reconciled. Corrections go forward.
    const changed = execFileSync(
      'git', ['log', '--oneline', '-1', '--', MIGRATION_035],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(changed.length).toBeGreaterThan(0)
    expect(read(MIGRATION_036)).toMatch(/forward fix/i)
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// PRIVILEGES AND SCHEMA SAFETY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A privileges', () => {
  const sql = read(MIGRATION_035)
  const sqlCode = stripSql(sql)

  it('REVOKES before it GRANTS on every new table (D-GRANT)', () => {
    const revokeAll = sqlCode.indexOf('revoke all on public.legal_acceptances from public')
    const grant = sqlCode.indexOf('grant select on public.legal_acceptances to authenticated')
    expect(revokeAll).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(revokeAll).toBeLessThan(grant)

    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sqlCode).toContain(`revoke all on public.legal_acceptances from ${role}`)
    }
  })

  it('grants anon NOTHING on legal_acceptances', () => {
    expect(sqlCode).not.toMatch(/grant\s+\w+\s+on\s+public\.legal_acceptances\s+to[^;]*anon/i)
  })

  it('asserts the resulting privilege matrix at apply time', () => {
    expect(sqlCode).toMatch(/information_schema\.role_table_grants/)
    expect(sqlCode).toMatch(/privilege_type\s*<>\s*'SELECT'/)
    expect(sqlCode).toMatch(/raise exception 'legal_acceptances: authenticated holds unintended privileges/)
    expect(sqlCode).toMatch(/raise exception 'legal_acceptances: anon\/PUBLIC still hold/)
  })

  it('asserts the seam denies an unauthenticated caller at apply time', () => {
    expect(sqlCode).toMatch(/raise exception 'has_course_access\(\) grants access with no authenticated user'/)
  })

  it('revokes default EXECUTE on new functions before granting it', () => {
    for (const fn of [
      'is_email_verified()',
      'current_account_status()',
      'current_disabled_at()',
      'has_course_access(uuid)',
    ]) {
      const r = sqlCode.indexOf(`revoke all on function public.${fn}`)
      const g = sqlCode.indexOf(`grant execute on function public.${fn}`)
      expect(r, `${fn} must be revoked from public`).toBeGreaterThan(-1)
      expect(g, `${fn} must be granted explicitly`).toBeGreaterThan(-1)
      expect(r).toBeLessThan(g)
    }
  })

  it('legal_acceptances has RLS on, SELECT-only policy, and no write policy', () => {
    expect(sqlCode).toMatch(/alter table public\.legal_acceptances enable row level security/)
    expect(sqlCode).toMatch(/create policy "legal_acceptances_select_own"[\s\S]*?for select/)
    expect(sqlCode).not.toMatch(/create policy "legal_acceptances[^"]*"[\s\S]{0,120}for (insert|update|delete)/i)
  })

  it('closes the account_status self-escalation the new column would open', () => {
    // Migration 027 pinned platform_role. account_status is a NEW privileged
    // column on the same self-updatable row, so it must be pinned too or a
    // suspended learner simply un-suspends themselves.
    const policy = sqlCode.slice(sqlCode.indexOf('create policy "profiles_update_own"'))
    expect(policy.slice(0, 1200)).toMatch(/with check/i)
    expect(policy.slice(0, 1200)).toMatch(/platform_role\s+is not distinct from/)
    expect(policy.slice(0, 1200)).toMatch(/account_status\s+is not distinct from/)
    expect(policy.slice(0, 1200)).toMatch(/disabled_at\s+is not distinct from/)
  })

  it('adds no payment, organization, entitlement or B2B object', () => {
    for (const forbidden of [
      /create table[^;]*\bpayments?\b/i,
      /create table[^;]*\bentitlements?\b/i,
      /create table[^;]*\bseats?\b/i,
      /create table[^;]*\borganizations?\b/i,
      /create table[^;]*\bevaluation/i,
    ]) {
      expect(sqlCode).not.toMatch(forbidden)
    }
  })

  it('contains no USING (true) and no GRANT ALL to anon or public', () => {
    expect(sqlCode).not.toMatch(/using\s*\(\s*true\s*\)/i)
    expect(sqlCode).not.toMatch(/grant\s+all\s+on\s+\S+\s+to\s+(anon|public)/i)
  })

  /**
   * ── The two defects that made the first apply fail ───────────────────────
   *
   * Both were ordering/recursion bugs that no amount of reading the intent
   * would catch, so they are pinned structurally.
   */

  it('adds every profiles column BEFORE any function that reads one', () => {
    // A `language sql` function is fully parse-analysed at CREATE time (unlike
    // plpgsql). current_account_status() reads profiles.account_status, so if
    // the ALTER TABLE moves below it the migration fails with 42703 on the
    // first function — which is exactly what happened.
    const alter = sqlCode.indexOf('alter table public.profiles')
    expect(alter).toBeGreaterThan(-1)

    for (const fn of [
      'create or replace function public.current_account_status',
      'create or replace function public.current_disabled_at',
      'create or replace function public.has_course_access',
    ]) {
      const at = sqlCode.indexOf(fn)
      expect(at, `${fn} must exist`).toBeGreaterThan(-1)
      expect(alter, `${fn} reads a profiles column, so the ALTER must come first`).toBeLessThan(at)
    }
  })

  it('no policy ON profiles contains a raw subquery FROM profiles', () => {
    // Re-entering the table a policy guards raises 42P17, "infinite recursion
    // detected in policy for relation profiles". Pinned values must be read
    // through the SECURITY DEFINER helpers instead — the pattern migration 027
    // established for exactly this reason.
    const start = sqlCode.indexOf('create policy "profiles_update_own"')
    expect(start).toBeGreaterThan(-1)
    const policy = sqlCode.slice(start, sqlCode.indexOf(';', start))

    expect(policy).not.toMatch(/from\s+public\.profiles/i)
    expect(policy).toMatch(/public\.current_platform_role\(\)/)
    expect(policy).toMatch(/public\.current_account_status\(\)/)
    expect(policy).toMatch(/public\.current_disabled_at\(\)/)
  })

  it('every helper reading its own guarded table is SECURITY DEFINER', () => {
    for (const fn of ['current_account_status', 'current_disabled_at', 'is_email_verified']) {
      const start = sqlCode.indexOf(`create or replace function public.${fn}`)
      const body = sqlCode.slice(start, sqlCode.indexOf('$$;', start))
      expect(body, fn).toMatch(/security definer/i)
      expect(body, fn).toMatch(/set search_path/i)
    }
  })

  it('fails fast and legibly when a dependency is missing', () => {
    expect(sqlCode).toMatch(/XPA-6A 035 preflight/)
    expect(sqlCode).toMatch(/to_regprocedure\('public\.is_platform_admin\(\)'\)/)
    expect(sqlCode).toMatch(/to_regprocedure\('public\.current_platform_role\(\)'\)/)
  })

  it('asserts the promised profiles columns actually exist afterwards', () => {
    const at = sqlCode.indexOf("raise exception 'profiles is missing expected column")
    expect(at).toBeGreaterThan(-1)
    const assertion = sqlCode.slice(at - 900, at + 120)
    expect(assertion).toMatch(/information_schema\.columns/)
    // The list checked must be the full set the migration adds.
    for (const c of [
      'first_name', 'last_name', 'display_name', 'preferred_language',
      'accepted_terms_version', 'accepted_privacy_version',
      'account_status', 'disabled_at',
    ]) {
      expect(assertion, `assertion must cover ${c}`).toContain(`'${c}'`)
    }
  })

  it('is idempotent — every object guards its own re-creation', () => {
    // ALTER ... ADD COLUMN
    const addCols = sqlCode.match(/add column (if not exists )?/g) ?? []
    expect(addCols.length).toBeGreaterThan(0)
    for (const c of addCols) expect(c).toContain('if not exists')

    // Constraints use drop-then-add rather than a conname-only probe, which
    // can collide with an identically named constraint on another table.
    for (const c of ['profiles_account_status_check', 'profiles_preferred_language_check']) {
      expect(sqlCode).toContain(`drop constraint if exists ${c}`)
      expect(sqlCode).toContain(`add constraint ${c}`)
    }

    expect(sqlCode).toMatch(/create table if not exists public\.legal_acceptances/)
    expect(sqlCode).toMatch(/create unique index if not exists/)

    // Every policy is dropped before it is created.
    const created = [...sqlCode.matchAll(/create policy "([^"]+)"/g)].map(m => m[1])
    expect(created.length).toBeGreaterThan(4)
    for (const name of created) {
      expect(sqlCode, `policy ${name} must be dropped before creation`)
        .toMatch(new RegExp(`drop policy if exists "${name}"`))
    }
  })

  it('does not modify migrations 001-027', () => {
    const changed = execFileSync(
      'git', ['status', '--porcelain', '--', 'supabase/migrations'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .filter(f => /\/(0[01]\d|02[0-7])_/.test(f))
    expect(changed).toEqual([])
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// SECRETS AND CONFIDENTIALITY
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A secrets and confidentiality', () => {
  it('the service-role key is never referenced from a client component', () => {
    const files = execFileSync(
      'git', ['ls-files', 'app', 'components', 'lib'], { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').map(s => s.trim()).filter(f => /\.tsx?$/.test(f))

    const offenders = files.filter(f => {
      const src = read(f)
      return /^'use client'/m.test(src) && /SUPABASE_SERVICE_ROLE_KEY|createAdminClient/.test(src)
    })
    expect(offenders).toEqual([])
  }, 20_000)

  it('no server-only secret is exposed through a NEXT_PUBLIC_ variable', () => {
    const files = execFileSync(
      'git', ['ls-files', 'app', 'components', 'lib'], { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').map(s => s.trim()).filter(f => /\.tsx?$/.test(f))

    for (const f of files) {
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_\w*(SERVICE_ROLE|SECRET|API_KEY)/)
    }
  }, 20_000)

  it('the CAPTCHA secret is server-only and denies when half-configured', () => {
    const captcha = read('lib/security/captcha.ts')
    expect(captcha).toMatch(/process\.env\.CAPTCHA_SECRET_KEY/)
    expect(captcha).not.toMatch(/NEXT_PUBLIC_CAPTCHA_SECRET/)
    const misconfigured = captcha.slice(captcha.indexOf('if (!secret)'))
    expect(misconfigured.slice(0, 500)).toMatch(/ok:\s*false/)
  })

  it('no audit call is given a secret VALUE to persist', () => {
    const action = read('app/actions/auth.ts')
    const audits = action.match(/logAuditEvent\(\{[\s\S]*?\n  \}\)/g) ?? []
    expect(audits.length).toBeGreaterThan(4)

    // Match secrets being PASSED, not the words appearing in a human-readable
    // reason string. `reason: 'token generation failed'` is exactly the sort of
    // message that should be recorded; `reason: hashedToken` is not.
    const secretValue = /[:,]\s*(password|token|tokenHash|hashedToken|captchaToken|accessToken|secret)\s*[,}\n]/i
    for (const a of audits) {
      expect(a, a.slice(0, 120)).not.toMatch(secretValue)
      expect(a).not.toMatch(/\$\{\s*(password|hashedToken|tokenHash)\s*\}/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION — earlier phases stay intact
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-6A regression — XPA-1..5 intact', () => {
  it('XPA-5A voice confidentiality is untouched', () => {
    const m034 = read('supabase/migrations/034_voice_scenario_confidentiality.sql')
    expect(m034).toMatch(/revoke all on public\.ai_scenarios from anon/)
    expect(m034).toMatch(/grant select on public\.public_voice_scenarios to anon, authenticated/)
    // 035 must not re-grant what 034 revoked.
    const m035 = stripSql(read(MIGRATION_035))
    expect(m035).not.toMatch(/grant[^;]*on public\.ai_scenarios/i)
  })

  it('the internal academic registry stays private', () => {
    const m035 = stripSql(read(MIGRATION_035))
    for (const t of ['course_codes', 'catalogues', 'learning_paths', 'learning_path_courses']) {
      expect(m035, `035 must not grant on ${t}`).not.toMatch(
        new RegExp(`grant[^;]*on public\\.${t}`, 'i'),
      )
    }
  })

  it('XPA-4 server-side quiz scoring is unchanged', () => {
    const quiz = read('app/actions/quiz.ts')
    expect(quiz).toMatch(/createAdminClient/)
    expect(quiz).toMatch(/submitQuizAnswers/)
  })

  it('quiz players still never select correct_answer', () => {
    for (const f of [
      'app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx',
      'app/(learn)/learn/[courseSlug]/final-exam/page.tsx',
    ]) {
      const src = read(f)
      const selects = src.match(/\.select\((['"`])[^'"`]*\1\)/g) ?? []
      for (const s of selects) expect(s, `${f}: ${s}`).not.toMatch(/correct_answer/)
    }
  })

  it('the discovery routes still exist', () => {
    for (const p of [
      'app/(public)/courses/page.tsx',
      'app/(public)/parcours/page.tsx',
      'app/(public)/secteurs/page.tsx',
      'app/(public)/courses/[slug]/page.tsx',
    ]) {
      expect(() => read(p)).not.toThrow()
    }
  })

  it('the brand module still refuses to name the deployment host', () => {
    const brand = read('lib/brand.ts')
    expect(brand).not.toMatch(/vercel\.app/)
    expect(brand).toMatch(/PUBLIC_SITE_URL/)
  })
})
