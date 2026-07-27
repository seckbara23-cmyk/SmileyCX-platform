// @vitest-environment node
/**
 * SEC-2 security regression tests.
 *
 * These lock in the remediations from docs/security/sec-2-remediation.md so a
 * future change cannot silently re-open the SEC-1 findings:
 *
 *   F-1  public self-registration      → no signup path may exist in the source
 *   F-2  privilege escalation          → migration must pin platform_role
 *   F-3  no audit trail                → audit_log + instrumentation must exist
 *   F-4  no rate limiting              → provisioning must be rate limited
 *   §2   external config validation    → insecure config must fail loudly
 *
 * Several of these are source-level assertions. That is deliberate: the public
 * registration path was a CLIENT-side call straight to Supabase, so there is no
 * server function to unit test — the only durable guarantee is that the call
 * does not exist anywhere in the codebase.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const SOURCE_DIRS = ['app', 'components', 'lib']
const SOURCE_EXTS = new Set(['.ts', '.tsx'])

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc)
    else if (SOURCE_EXTS.has(extname(entry))) acc.push(full)
  }
  return acc
}

/** Every application source file (excluding tests). */
function appSources(): { path: string; text: string }[] {
  const files: string[] = []
  for (const d of SOURCE_DIRS) collectSourceFiles(join(ROOT, d), files)
  return files
    .filter(f => !f.includes('__tests__'))
    .map(path => ({ path, text: readFileSync(path, 'utf8') }))
}

const migration027 = readFileSync(
  join(ROOT, 'supabase/migrations/027_identity_hardening.sql'),
  'utf8'
)

// ── F-1: public registration is gone ─────────────────────────────────────────

describe('F-1 — public self-registration is removed', () => {
  it('no source file calls auth.signUp()', () => {
    const offenders = appSources()
      .filter(f => /\bauth\s*\.\s*signUp\s*\(/.test(f.text))
      .map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('no source file calls signInAnonymously() or admin.inviteUserByEmail()', () => {
    const offenders = appSources()
      .filter(f => /signInAnonymously\s*\(|inviteUserByEmail\s*\(/.test(f.text))
      .map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('the signup page contains no password field and cannot create an account', () => {
    const page = readFileSync(join(ROOT, 'app/(auth)/signup/page.tsx'), 'utf8')
    expect(page).not.toMatch(/\bauth\s*\.\s*signUp\s*\(/)
    expect(page).not.toMatch(/type=["']password["']/)
    expect(page).not.toMatch(/autoComplete=["']new-password["']/)
  })

  it('the signup page states that access is invitation-only', () => {
    const page = readFileSync(join(ROOT, 'app/(auth)/signup/page.tsx'), 'utf8')
    expect(page).toMatch(/invitation/i)
  })

  it('exactly one provisioning path exists: the admin server action', () => {
    const offenders = appSources()
      .filter(f => /auth\s*\.\s*admin\s*\.\s*createUser\s*\(/.test(f.text))
      .map(f => f.path.replace(ROOT, '').replace(/\\/g, '/'))
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('/admin/users/new/actions.ts')
  })
})

// ── Login and password reset must still work (no collateral damage) ──────────

describe('login and password reset are preserved', () => {
  it('login still calls signInWithPassword', () => {
    const login = readFileSync(join(ROOT, 'app/(auth)/login/LoginForm.tsx'), 'utf8')
    expect(login).toMatch(/signInWithPassword\s*\(/)
  })

  it('password reset still calls resetPasswordForEmail', () => {
    const forgot = readFileSync(join(ROOT, 'app/(auth)/forgot-password/page.tsx'), 'utf8')
    expect(forgot).toMatch(/resetPasswordForEmail\s*\(/)
  })
})

// ── F-2: privilege escalation is closed ──────────────────────────────────────

describe('F-2 — platform_role self-escalation is blocked', () => {
  it('the profiles UPDATE policy has an explicit WITH CHECK', () => {
    const policy = migration027.slice(
      migration027.indexOf('create policy "profiles_update_own"')
    )
    expect(policy).toMatch(/with check/i)
  })

  it('the WITH CHECK pins platform_role for non-admins', () => {
    expect(migration027).toMatch(/platform_role is not distinct from public\.current_platform_role\(\)/)
  })

  it('a BEFORE UPDATE trigger backstops the policy', () => {
    expect(migration027).toMatch(/create trigger profiles_enforce_role_change/i)
    expect(migration027).toMatch(/before update on public\.profiles/i)
  })

  it('the trigger raises insufficient_privilege (42501) on unauthorized role change', () => {
    expect(migration027).toMatch(/errcode\s*=\s*'42501'/)
  })

  it('the trigger still permits service_role and platform admins', () => {
    expect(migration027).toMatch(/current_user in \('service_role', 'postgres', 'supabase_admin'\)/)
    expect(migration027).toMatch(/public\.is_platform_admin\(\)/)
  })

  it('the role-reading helper is SECURITY DEFINER (no RLS recursion)', () => {
    const fn = migration027.slice(
      migration027.indexOf('create or replace function public.current_platform_role'),
      migration027.indexOf('comment on function public.current_platform_role')
    )
    expect(fn).toMatch(/security definer/i)
  })

  it('the migration does not broaden the USING clause', () => {
    // USING must remain exactly the pre-existing ownership-or-admin condition.
    expect(migration027).toMatch(/using \(\s*auth\.uid\(\) = id\s*or public\.is_platform_admin\(\)\s*\)/)
    expect(migration027).not.toMatch(/using \(\s*true\s*\)/i)
  })
})

// ── F-3: audit trail ─────────────────────────────────────────────────────────

describe('F-3 — identity events are auditable', () => {
  it('the audit_log table exists with the required forensic columns', () => {
    for (const col of [
      'event_type', 'actor_type', 'actor_id', 'subject_user_id',
      'method', 'invitation_id', 'outcome', 'created_at',
    ]) {
      expect(migration027).toContain(col)
    }
  })

  it('audit_log has NO foreign key to auth.users (records outlive users)', () => {
    const table = migration027.slice(
      migration027.indexOf('create table if not exists public.audit_log'),
      migration027.indexOf('create index if not exists audit_log_created_idx')
    )
    expect(table).not.toMatch(/references\s+auth\.users/i)
  })

  it('audit_log is admin-read-only with no write policies for app roles', () => {
    expect(migration027).toMatch(/create policy "audit_log_admin_read"[\s\S]*?for select[\s\S]*?is_platform_admin\(\)/i)
    expect(migration027).toMatch(/revoke update, delete on public\.audit_log from anon, authenticated/i)
    // No INSERT/UPDATE/DELETE policy may exist for audit_log.
    expect(migration027).not.toMatch(/create policy "audit_log[^"]*"\s+on public\.audit_log\s+for (insert|update|delete)/i)
  })

  it('user creation is audited on success and on failure', () => {
    const action = readFileSync(
      join(ROOT, 'app/(admin)/admin/users/new/actions.ts'), 'utf8'
    )
    expect(action).toMatch(/logAuditEvent/)
    expect(action).toMatch(/outcome:\s*'success'/)
    expect(action).toMatch(/outcome:\s*'failure'/)
  })

  it('user deletion snapshots the subject before destroying it', () => {
    const action = readFileSync(
      join(ROOT, 'app/(admin)/admin/users/[id]/actions.ts'), 'utf8'
    )
    // The snapshot SELECT must precede the destructive deleteUser call.
    const selectAt = action.indexOf(".from('profiles')")
    const deleteAt = action.indexOf('auth.admin.deleteUser')
    expect(selectAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(selectAt).toBeLessThan(deleteAt)
    expect(action).toMatch(/deletedProfile/)
  })

  it('the audit helper never persists secrets', () => {
    const helper = readFileSync(join(ROOT, 'lib/audit/log.ts'), 'utf8')
    expect(helper).not.toMatch(/\bpassword\s*[:,]/)
    expect(helper).not.toMatch(/access_token|service_role_key/)
  })
})

// ── F-4: rate limiting ───────────────────────────────────────────────────────

describe('F-4 — provisioning is rate limited', () => {
  it('admin provisioning uses the shared rateLimitDb infrastructure', () => {
    const action = readFileSync(
      join(ROOT, 'app/(admin)/admin/users/new/actions.ts'), 'utf8'
    )
    expect(action).toMatch(/rateLimitDb\(/)
    expect(action).toMatch(/from '@\/lib\/rate-limit'/)
  })

  /**
   * CX-AUTH-1 — the bespoke /api/admin/login route was removed along with the
   * unsigned `scx_admin` cookie it minted (CX-AUTH-0 finding F-3). Admin
   * authentication now uses the same Supabase Auth path as every other login.
   *
   * HONEST TRADE-OFF, recorded here rather than silently dropped: that route
   * carried application-level brute-force protection (5 attempts / 15 min, per
   * IP AND per username). Login is now a direct browser→Supabase call, so the
   * application server is not in the request path and cannot rate-limit it.
   * Brute-force protection is therefore Supabase-side only. Supabase enforces
   * its own auth rate limits, but the exact configured threshold could NOT be
   * verified from this repository.
   *
   * Tracked for CX-AUTH-2 (session lifecycle): either move sign-in to a server
   * action so rateLimitDb applies, or confirm and document the Supabase limit.
   */
  it('the unsigned-cookie admin login route is gone', () => {
    expect(() => readFileSync(join(ROOT, 'app/api/admin/login/route.ts'), 'utf8')).toThrow()
  })

  it('admin provisioning remains rate limited (unchanged by CX-AUTH-1)', () => {
    const action = readFileSync(
      join(ROOT, 'app/(admin)/admin/users/new/actions.ts'), 'utf8'
    )
    expect(action).toMatch(/rateLimitDb\(/)
  })

  it('provisioning validates the requested role against an allow-list', () => {
    const action = readFileSync(
      join(ROOT, 'app/(admin)/admin/users/new/actions.ts'), 'utf8'
    )
    expect(action).toMatch(/VALID_ROLES/)
    expect(action).toMatch(/Invalid platform role/)
  })
})

// ── §2: external configuration validation ────────────────────────────────────

describe('SEC-2 §2 — Supabase disable_signup is validated at runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  })

  async function loadModule() {
    return import('@/lib/security/auth-config')
  }

  it('reports "secure" when disable_signup is true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ disable_signup: true }), { status: 200 })
    ))
    const { checkSignupDisabled } = await loadModule()
    await expect(checkSignupDisabled()).resolves.toMatchObject({ status: 'secure' })
  })

  it('reports "insecure" when disable_signup is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ disable_signup: false }), { status: 200 })
    ))
    const { checkSignupDisabled } = await loadModule()
    await expect(checkSignupDisabled()).resolves.toMatchObject({
      status: 'insecure', disableSignup: false,
    })
  })

  it('reports "unknown" (never "secure") when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const { checkSignupDisabled } = await loadModule()
    const res = await checkSignupDisabled()
    expect(res.status).toBe('unknown')
    expect(res.status).not.toBe('secure')
  })

  /**
   * HOTFIX-3 — ratified policy change, NOT a relaxation.
   *
   * This previously asserted that a confirmed-insecure setting THREW in
   * production. That throw ran inside the instrumentation hook during server
   * preparation, so it took down every route (HOTFIX-1/HOTFIX-2) while doing
   * nothing to close the hole — POST /auth/v1/signup is served by Supabase
   * directly and never traverses this app.
   *
   * Enforcement moved EARLIER, to deploy time, where it is deterministic and
   * blocks the build before it ships (asserted below and in
   * auth-config-failclosed.test.ts). Runtime is now observability. The
   * detection logic itself is unchanged and still asserted above.
   */
  it('reports the insecure state at runtime WITHOUT taking the server down', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ disable_signup: false }), { status: 200 })
    ))
    const { assertSignupDisabled, ERR_SIGNUP_ENABLED } = await loadModule()

    const res = await assertSignupDisabled()
    expect(res.status).toBe('insecure')
    expect(res.code).toBe(ERR_SIGNUP_ENABLED)
    // Must never be misreported as verified.
    expect(res.status).not.toBe('secure')
  })

  it('logs the insecure state at FATAL level so it cannot be missed', async () => {
    const source = readFileSync(join(ROOT, 'lib/security/auth-config.ts'), 'utf8')
    const insecureBranch = source.slice(
      source.indexOf("case 'insecure':"),
      source.indexOf("case 'unknown':")
    )
    expect(insecureBranch).toMatch(/log\.fatal/)
    expect(insecureBranch).not.toMatch(/throw/)
  })

  it('deploy-time enforcement still blocks an insecure build', async () => {
    const gate = readFileSync(join(ROOT, 'scripts/security/verify-prod-config.mjs'), 'utf8')
    expect(gate).toMatch(/DEPLOYMENT BLOCKED/)
    expect(gate).toMatch(/process\.exitCode = 1/)
  })

  it('the deploy gate is wired into the build and cannot be forgotten', () => {
    // npm runs `prebuild` automatically before `npm run build`, which is what
    // Vercel invokes — so enforcement needs no dashboard configuration.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.prebuild).toContain('verify-prod-config.mjs')
  })

  it('the startup hook cannot brick server preparation', async () => {
    const instrumentation = readFileSync(join(ROOT, 'instrumentation.ts'), 'utf8')
    // A try/catch backstop must wrap the check so no future change can throw.
    expect(instrumentation).toMatch(/try\s*\{/)
    expect(instrumentation).toMatch(/catch/)
  })

  it('does not throw in production when signup is disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ disable_signup: true }), { status: 200 })
    ))
    const { assertSignupDisabled } = await loadModule()
    await expect(assertSignupDisabled()).resolves.toMatchObject({ status: 'secure' })
  })

  it('does not take the server down on an unreachable settings endpoint', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { assertSignupDisabled } = await loadModule()
    await expect(assertSignupDisabled()).resolves.toMatchObject({ status: 'unknown' })
  })

  it('is wired into the server startup hook', () => {
    const instrumentation = readFileSync(join(ROOT, 'instrumentation.ts'), 'utf8')
    expect(instrumentation).toMatch(/assertSignupDisabled/)
    const config = readFileSync(join(ROOT, 'next.config.mjs'), 'utf8')
    expect(config).toMatch(/instrumentationHook:\s*true/)
  })
})
