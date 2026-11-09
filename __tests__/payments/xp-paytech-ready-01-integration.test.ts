// @vitest-environment node
/**
 * XP-PAYTECH-04 — the PayTech journey against a REAL PostgreSQL engine.
 *
 * ── WHAT IS REAL AND WHAT IS NOT ──────────────────────────────────────────
 *
 * REAL, unmodified, imported from the repository:
 *   * `app/actions/paytech-checkout.ts`              startPaytechCheckout()
 *   * `app/api/payments/paytech/ipn/route.ts`        POST / GET
 *   * `app/api/payments/paytech/reconcile/route.ts`  GET (the sweep)
 *   * `app/(admin)/admin/payments/reconcile-actions.ts`  verify / close
 *   * `lib/payments/*`                               reconcile, completion, client, IPN crypto
 *   * `lib/auth/course-access.ts`                    the eligibility seam
 *   * `app/(admin)/admin/payments/exception-actions.ts`  every exception decision
 *   * `public.complete_payment()`                    extracted VERBATIM from 062
 *   * migrations 063 and 064                         executed WHOLE — preflight,
 *                                                    self-test, assertions
 *   * the entitlement objects of 037 and the payment constraints, indexes,
 *     policies and privilege statements of 058/059/060, extracted VERBATIM
 *
 * The SQL runs on PGlite (PostgreSQL 17, WASM), in memory. Supabase's roles are
 * approximated: anon / authenticated / service_role (BYPASSRLS) receive
 * Supabase's default privileges FIRST, so the migrations' REVOKEs must do the
 * work they claim.
 *
 * MOCKED, and only these:
 *   * PayTech — `fetch` is stubbed; no request leaves the process.
 *   * the SETTLEMENT CONTRACT — PayTech has not documented its status
 *     response, so the real constant is `null` (nothing is ever inferred). The
 *     suite injects a FIXTURE contract, clearly labelled, to exercise the
 *     machinery, and also runs with `null` to prove the fail-closed default.
 *   * the Supabase HTTP layer — a PostgREST-equivalent shim, one transaction
 *     per call with the caller's role set locally.
 *   * the logger (captured), the admin session guard, `next/headers`,
 *     `next/navigation`, `next/cache` and the email sender (captured).
 *
 * MODELLED (not from a migration): auth.users, profiles, courses, the base
 * payments/enrollments columns, the 001/005 learner policies, the helpers
 * `has_course_access()` calls, and `check_rate_limit()`.
 *
 * NOT PROVEN: live production state; PayTech's real behaviour; two-session
 * lock contention (PGlite has one connection, so concurrent handlers
 * interleave at STATEMENT granularity).
 */
import { tickedCheckoutConsent } from '@/lib/legal/checkout-consent'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite, types } from '@electric-sql/pglite'

const ROOT = process.cwd()

// ── fixed identities ───────────────────────────────────────────────────────
const API_KEY = 'pk_test_ready01_harness_only'
const API_SECRET = 'sk_test_ready01_harness_only'
const CRON = 'cron-secret-harness-only-0123456789'
const L1 = '10000000-0000-4000-8000-000000000001'
const L2 = '10000000-0000-4000-8000-000000000002'
const ADM = '10000000-0000-4000-8000-0000000000ad'
const C1 = '20000000-0000-4000-8000-000000000001'   // 45 000 XOF, published
const C2 = '20000000-0000-4000-8000-000000000002'   // 30 000 XOF, published
const C3 = '20000000-0000-4000-8000-000000000003'   // unpublished
const PRICE_C1 = 45_000
const OWNERS = ['owner@example.test', 'second@example.test']
const NOTE = 'Vérifié dans le tableau de bord PayTech, transaction relue.'

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64')
const hmacHex = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex')

/** A TEST FIXTURE. PayTech has documented no status response; this is not one. */
const FIXTURE_CONTRACT = {
  confirmedBy: 'TEST FIXTURE — not a PayTech statement',
  request: { method: 'GET', path: '/payment/get-status', tokenParam: 'token_payment' },
  successPath: 'success',
  statusPath: 'payment.status',
  paid: ['completed'], failed: ['failed'], cancelled: ['canceled'], pending: ['pending'],
  amountPath: 'payment.amount', currencyPath: 'payment.currency', referencePath: 'payment.ref_command',
} as const

// ── hoisted state shared with the module mocks ─────────────────────────────
// The first import of the server action pulls in the Supabase SSR client.
vi.setConfig({ testTimeout: 30_000 })

const H = vi.hoisted(() => ({
  makeClient: null as unknown as (_role: 'service_role' | 'authenticated') => unknown,
  user: null as null | { id: string; email: string; email_confirmed_at: string | null },
  logs: [] as { level: string; module: string; args: unknown[] }[],
  rpcFault: null as null | Record<string, unknown>,
  /** Fails only the named function, leaving every other call working. */
  rpcFaultFor: null as null | { fn: string; error: Record<string, unknown>; when?: (args: Record<string, unknown>) => boolean },
  denyAdmin: false,
  emails: [] as { to: string; reference: string }[],
  emailMode: 'ok' as 'ok' | 'fail' | 'fail_second' | 'dry',
  /** Runs while an alert goes out, for races. */
  emailDuring: null as null | (() => Promise<void>),
  /** XP-LAUNCH-FINAL-11: the learner's purchase confirmations. */
  confirmations: [] as { to: string; data: Record<string, unknown> }[],
  confirmationMode: 'ok' as 'ok' | 'fail',
  contract: null as null | Record<string, unknown>,
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => H.makeClient('service_role') }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => H.makeClient('authenticated') }))
vi.mock('@/lib/logger', () => {
  const make = (module: string) => {
    const rec = (level: string) => (...args: unknown[]) => { H.logs.push({ level, module, args }) }
    const l = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') }
    return { ...l, child: () => l }
  }
  return { createLogger: make, logger: make('root') }
})
vi.mock('@/lib/payments/paytech-settlement-contract', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return { ...orig, get PAYTECH_SETTLEMENT_CONTRACT() { return H.contract } }
})
vi.mock('@/lib/auth/session', () => ({
  requirePlatformAdmin: async () => {
    if (H.denyAdmin) throw Object.assign(new Error('NEXT_REDIRECT'), { url: '/login?error=forbidden' })
    return { id: '10000000-0000-4000-8000-0000000000ad', email: 'owner@example.test' }
  },
}))
vi.mock('@/lib/email', () => ({
  sendPaymentExceptionAlert: async (to: string, data: { reference: string }) => {
    H.emails.push({ to, reference: data.reference })
    if (H.emailDuring) await H.emailDuring()
    if (H.emailMode === 'fail') return { success: false, error: 'simulated' }
    if (H.emailMode === 'fail_second' && H.emails.length % 2 === 0) return { success: false, error: 'simulated' }
    if (H.emailMode === 'dry') return { success: true, dryRun: true }
    return { success: true }
  },
  sendPaymentConfirmationEmail: async (to: string, data: Record<string, unknown>) => {
    H.confirmations.push({ to, data })
    return H.confirmationMode === 'fail' ? { success: false, error: 'simulated' } : { success: true }
  },
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'harness' }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }) },
}))

// ── the database ───────────────────────────────────────────────────────────
let db: PGlite

async function asSuper(text: string, params: unknown[] = []): Promise<any[]> {
  return (await db.query(text, params)).rows as any[]
}

/** One PostgREST-style request: its own transaction, the caller's role set locally. */
async function asRole(role: string, sub: string | null, text: string, params: unknown[] = []): Promise<any[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [role, sub ?? ''])
    return (await tx.query(text, params)).rows as any[]
  })
}

function pgError(e: any) {
  return { message: String(e?.message ?? e), details: e?.detail ?? null, hint: e?.hint ?? null, code: e?.code ?? null }
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`harness: unsupported identifier ${s}`)
  return `"${s}"`
}
const colList = (cols: string) => {
  if (cols.trim() === '*') return '*'
  return cols.split(',').map(c => {
    if (c.includes('(')) throw new Error(`harness: embedded select not supported: ${c}`)
    return ident(c.trim())
  }).join(', ')
}
const param = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v)

class Query {
  private op: 'select' | 'insert' | 'update' = 'select'
  private cols = '*'
  private returning: string | null = null
  private filters: [string, string, unknown][] = []
  private patch: Record<string, unknown> = {}
  private orderBy: string | null = null
  private asc = true
  private lim: number | null = null
  private readonly role: string
  private readonly sub: string | null
  private readonly table: string
  constructor(role: string, sub: string | null, table: string) { this.role = role; this.sub = sub; this.table = table }
  select(cols = '*') { if (this.op === 'select') this.cols = cols; else this.returning = cols; return this }
  insert(row: Record<string, unknown>) { this.op = 'insert'; this.patch = row; return this }
  update(p: Record<string, unknown>) { this.op = 'update'; this.patch = p; return this }
  eq(c: string, v: unknown) { this.filters.push(['=', c, v]); return this }
  neq(c: string, v: unknown) { this.filters.push(['<>', c, v]); return this }
  lt(c: string, v: unknown) { this.filters.push(['<', c, v]); return this }
  gt(c: string, v: unknown) { this.filters.push(['>', c, v]); return this }
  in(c: string, v: unknown[]) { this.filters.push(['in', c, v]); return this }
  is(c: string, v: null) {
    if (v !== null) throw new Error('harness: .is() supports null only')
    this.filters.push(['isnull', c, null]); return this
  }
  not(c: string, op: string, v: null) {
    if (op !== 'is' || v !== null) throw new Error('harness: .not() supports is-null only')
    this.filters.push(['notnull', c, null]); return this
  }
  order(c: string, o: { ascending?: boolean } = {}) { this.orderBy = c; this.asc = o.ascending !== false; return this }
  limit(n: number) { this.lim = n; return this }

  private build(): [string, unknown[]] {
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(param(v)); return `$${params.length}` }
    const where = this.filters.length
      ? ' where ' + this.filters.map(([op, c, v]) =>
          op === 'in' ? `${ident(c)}::text = any(${p(v)}::text[])`
          : op === 'isnull' ? `${ident(c)} is null`
          : op === 'notnull' ? `${ident(c)} is not null`
          : `${ident(c)} ${op} ${p(v)}`).join(' and ')
      : ''
    const t = `public.${ident(this.table)}`
    if (this.op === 'select') {
      let s = `select ${colList(this.cols)} from ${t}${where}`
      if (this.orderBy) s += ` order by ${ident(this.orderBy)} ${this.asc ? 'asc' : 'desc'}`
      if (this.lim !== null) s += ` limit ${Number(this.lim)}`
      return [s, params]
    }
    const ret = this.returning ? ` returning ${colList(this.returning)}` : ''
    const keys = Object.keys(this.patch)
    if (this.op === 'insert') {
      const vals = keys.map(k => p(this.patch[k]))
      return [`insert into ${t} (${keys.map(ident).join(', ')}) values (${vals.join(', ')})${ret}`, params]
    }
    const sets = keys.map(k => `${ident(k)} = ${p(this.patch[k])}`)
    return [`update ${t} set ${sets.join(', ')}${where}${ret}`, params]
  }
  private async exec(): Promise<{ data: any; error: any }> {
    const [text, params] = this.build()
    try {
      const data = await asRole(this.role, this.sub, text, params)
      return { data, error: null, count: data.length } as { data: any; error: any }
    } catch (e) { return { data: null, error: pgError(e) } }
  }
  async single() {
    const r = await this.exec()
    if (r.error) return r
    return r.data.length === 1 ? { data: r.data[0], error: null }
      : { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${r.data.length}`, details: null, hint: null } }
  }
  async maybeSingle() {
    const r = await this.exec()
    if (r.error) return r
    if (r.data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows', details: null, hint: null } }
    return { data: r.data[0] ?? null, error: null }
  }
  then(onF: (_v: any) => unknown, onR?: (_e: unknown) => unknown) {
    return this.exec()
      .then(r => (this.op !== 'select' && this.returning === null ? { data: null, error: r.error } : r))
      .then(onF, onR)
  }
}

H.makeClient = (role) => {
  const sub = role === 'authenticated' ? H.user?.id ?? null : null
  return {
    auth: { getUser: async () => ({ data: { user: role === 'authenticated' ? H.user : null }, error: null }) },
    from: (table: string) => new Query(role, sub, table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (H.rpcFault) { const f = H.rpcFault; H.rpcFault = null; return { data: null, error: f } }
      if (H.rpcFaultFor?.fn === fn && (H.rpcFaultFor.when?.(args) ?? true)) return { data: null, error: H.rpcFaultFor.error }
      const names = Object.keys(args)
      const text = `select public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(', ')}) as r`
      try { return { data: (await asRole(role, sub, text, names.map(n => args[n])))[0]?.r ?? null, error: null } }
      catch (e) { return { data: null, error: pgError(e) } }
    },
  }
}

// ── the schema: migration text where it matters ────────────────────────────
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const mig = (f: string) => read(join('supabase', 'migrations', f))
/** A STATEMENT, anchored at column 0, so the commented-out examples never match. */
function take(src: string, re: RegExp, label: string): string {
  const m = new RegExp(`^(?:${re.source})`, 'm').exec(src)
  if (!m) throw new Error(`harness could not extract ${label} — the migration text changed`)
  return m[0]
}
const M037 = mig('037_entitlements.sql')
const M058 = mig('058_payment_provider_foundation.sql')
const M059 = mig('059_payment_column_select_security.sql')
const M060 = mig('060_payment_completion_contract.sql')
const M062 = mig('062_atomic_payment_completion.sql')
const M063 = mig('063_payment_state_machine.sql')
const M064 = mig('064_payment_exceptions.sql')
const M065 = mig('065_commercial_offers.sql')

const FROM = {
  auditLog:          take(mig('027_identity_hardening.sql'), /create table if not exists public\.audit_log \([\s\S]*?\n\);/, '027 audit_log'),
  entitlementsTable: take(M037, /create table if not exists public\.entitlements \([\s\S]*?\n\);/, '037 entitlements'),
  liveIndex:         take(M037, /create unique index if not exists entitlements_one_live_per_course_idx[\s\S]*?;/, '037 live index'),
  accessible:        take(M037, /create or replace function public\.entitlement_accessible\([\s\S]*?\$\$;/, '037 entitlement_accessible'),
  learnerView:       take(M037, /create or replace view public\.my_course_access as[\s\S]*?group by ent\.course_id;/, '037 my_course_access'),
  hasAccess:         take(M037, /create or replace function public\.has_course_access\(p_course_id uuid\)[\s\S]*?\$\$;/, '037 has_course_access'),
  entRls:            take(M037, /alter table public\.entitlements enable row level security;/, '037 rls'),
  entRevokes:        take(M037, /revoke all on public\.entitlements from public;\nrevoke all on public\.entitlements from anon;\nrevoke all on public\.entitlements from authenticated;/, '037 revokes'),
  viewRevokes:       take(M037, /revoke all on public\.my_course_access from public;[\s\S]*?grant select on public\.my_course_access to authenticated;/, '037 view grants'),
  modeValid:         take(M058, /alter table public\.payments\n  add constraint payments_provider_mode_valid[\s\S]*?;/, '058 mode valid'),
  modeRequired:      take(M058, /alter table public\.payments\n  add constraint payments_provider_mode_required[\s\S]*?;/, '058 mode required'),
  inflight:          take(M058, /create unique index payments_one_inflight_intent_per_course[\s\S]*?;/, '058 in-flight index'),
  noBrowserUpdate:   take(M058, /create policy "payments_no_browser_update"[\s\S]*?;/, '058 update policy'),
  noBrowserDelete:   take(M058, /create policy "payments_no_browser_delete"[\s\S]*?;/, '058 delete policy'),
  revoke058:         take(M058, /revoke all on public\.payments from anon, authenticated;\ngrant select on public\.payments to anon, authenticated;/, '058 privileges'),
  revoke059:         take(M059, /revoke all on public\.payments from public, anon, authenticated;/, '059 revoke'),
  grant059:          take(M059, /grant select \([\s\S]*?\) on public\.payments to authenticated;/, '059 column grant'),
  statusValid:       take(M060, /alter table public\.payments\n  add constraint payments_status_valid[\s\S]*?;/, '060 status'),
  tokenUnique:       take(M060, /create unique index payments_provider_token_unique[\s\S]*?;/, '060 replay key'),
  completePayment:   take(M062, /create function public\.complete_payment\([\s\S]*?\$fn\$;/, '062 complete_payment'),
  revoke062:         take(M062, /revoke all on function public\.complete_payment\([^)]*\)\s*from public, anon, authenticated;/, '062 revoke'),
  grant062:          take(M062, /grant execute on function public\.complete_payment\([^)]*\)\s*to service_role;/, '062 grant'),
}

/** 063's own ROLLBACK block, uncommented — exercised, not merely read. */
const ROLLBACK_063 = (() => {
  const tail = M063.slice(M063.indexOf('-- ROLLBACK — removes the guard and the marker.'))
  const start = tail.indexOf('-- begin;')
  const end = tail.indexOf('-- commit;') + '-- commit;'.length
  return tail.slice(start, end).split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
})()

/** 064's own ROLLBACK block, uncommented. */
const ROLLBACK_064 = (() => {
  const tail = M064.slice(M064.indexOf('-- ROLLBACK — removes the workflow.'))
  const start = tail.indexOf('-- begin;')
  const end = tail.indexOf('-- commit;') + '-- commit;'.length
  return tail.slice(start, end).split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
})()

/** 065's own ROLLBACK block, uncommented: it restores 062's and 064's functions verbatim. */
const ROLLBACK_065 = (() => {
  const tail = M065.slice(M065.indexOf('-- ROLLBACK — removes the packs and the six-month window;'))
  const start = tail.indexOf('-- begin;')
  const end = tail.indexOf('-- commit;') + '-- commit;'.length
  return tail.slice(start, end).split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
})()

/**
 * XP-LAUNCH-FINAL-08: 065 seeds the two packs from the seven paid courses by their V8
 * code, and its preflight refuses to run without them. Every test starts from an empty
 * catalogue (beforeEach truncates courses, which cascades to the packs' composition), so
 * applying 065 needs them first. Prices are Marième's confirmed V4 prices.
 */
const CATALOGUE_V4 = [
  ['C1-F1', 9900], ['C1-F2', 9900], ['C1-F3', 9900], ['C2-F4', 14900],
  ['C2-F1', 14900], ['C2-F2', 14900], ['C2-F5', 14900],
] as const
async function seedCatalogueCodes() {
  for (const [code, price] of CATALOGUE_V4) {
    await db.exec(`insert into public.courses (slug, title, code, price, currency, is_published)
      values ('seed-${code.toLowerCase()}', 'Formation ${code}', '${code}', ${price}, 'XOF', true)
      on conflict (code) do nothing`)
  }
}

/**
 * 064 comes off only after 065 (which replaced three of its functions and added a
 * trigger 064's preflight refuses to sit beside), and goes back on before it.
 */
async function rollback064() {
  await db.exec(ROLLBACK_065)
  await db.exec(ROLLBACK_064)
}
async function apply064Then065() {
  await db.exec(M064)
  await seedCatalogueCodes()
  await db.exec(M065)
}

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, full_name text,
  platform_role text not null default 'user',
  account_status text not null default 'active'
);
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, description text not null default '',
  code text unique,  -- 028 (courses_code_unique)
  price numeric(10,2) not null default 0, currency text not null default 'XOF',
  is_published boolean not null default false, is_free boolean not null default false
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  course_id uuid references public.courses(id) on delete set null,
  amount numeric(10,2) not null,
  currency text not null default 'XOF',
  method text not null check (method in ('orange_money','wave','card')),
  status text not null default 'pending',
  reference text unique not null,
  provider_reference text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  company_id uuid,
  provider text, provider_mode text, provider_token text, entitlement_id uuid,
  failure_reason text, last_ipn_at timestamptz
);
create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active','expired','suspended')),
  unique (user_id, course_id)
);
${FROM.auditLog}
${FROM.entitlementsTable}
alter table public.entitlements add column organization_id uuid;  -- 040
${FROM.liveIndex}
${FROM.accessible}
${FROM.learnerView}

create function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.profiles where id = auth.uid() and platform_role = 'super_admin') $$;
create function public.is_email_verified() returns boolean language sql stable security definer set search_path = public, auth as
  $$ select exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null) $$;
create function public.current_account_status() returns text language sql stable security definer set search_path = public as
  $$ select account_status from public.profiles where id = auth.uid() $$;
create function public.check_rate_limit(p_key text, p_limit integer, p_window_ms bigint) returns jsonb language sql as
  $$ select jsonb_build_object('success', true, 'count', 1, 'limit', p_limit, 'reset_at', 0) $$;
${FROM.hasAccess}

${FROM.modeValid}
${FROM.modeRequired}
${FROM.inflight}
${FROM.statusValid}
${FROM.tokenUnique}
${FROM.completePayment}

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all tables in schema auth to service_role;

alter table public.payments enable row level security;
create policy "payments_own" on public.payments for select using (user_id = auth.uid() or public.is_platform_admin());
create policy "payments_insert_own" on public.payments for insert with check (user_id = auth.uid());
alter table public.enrollments enable row level security;
create policy "enrollments_own" on public.enrollments for select using (user_id = auth.uid());
create policy "enrollments_insert_own" on public.enrollments for insert with check (user_id = auth.uid());

${FROM.entRls}
${FROM.entRevokes}
${FROM.viewRevokes}
${FROM.noBrowserUpdate}
${FROM.noBrowserDelete}
${FROM.revoke058}
${FROM.revoke059}
${FROM.grant059}
${FROM.revoke062}
${FROM.grant062}
`

// ── the fake provider ──────────────────────────────────────────────────────
const P = {
  next: 0,
  requests: [] as Record<string, unknown>[],
  statusCalls: [] as string[],
  /** token → the ref_command it was opened with */
  refs: new Map<string, string>(),
  /** token → what get-status answers; undefined makes the transport fail */
  status: new Map<string, unknown>(),
  during: null as null | (() => Promise<void>),
  /** Runs inside get-status, before the provider answers — for races. */
  duringStatus: null as null | (() => Promise<void>),
}

/** A get-status answer in the FIXTURE contract's shape. */
function says(token: string, status: string, amount: number = PRICE_C1) {
  P.status.set(token, { success: 1, payment: { status, amount, currency: 'XOF', ref_command: P.refs.get(token) ?? 'SCX-NONE' } })
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ── helpers ────────────────────────────────────────────────────────────────
type U = { id: string; email: string; email_confirmed_at: string | null }
const user = (id: string, verified = true): U =>
  ({ id, email: `${id.slice(-4)}@example.test`, email_confirmed_at: verified ? '2026-01-01T00:00:00Z' : null })

async function checkout(u: U | null, courseId: string, extra: Record<string, unknown> = {}) {
  H.user = u
  const { startPaytechCheckout } = await import('@/app/actions/paytech-checkout')
  // XP-LAUNCH-FINAL-11: every purchase carries the three ticked boxes of CGV art. 4.
  return startPaytechCheckout({ courseId, consent: tickedCheckoutConsent(), ...extra } as Parameters<typeof startPaytechCheckout>[0])
}

async function access(u: U, courseId: string) {
  H.user = u
  const { resolveCourseAccessById } = await import('@/lib/auth/course-access')
  return resolveCourseAccessById(courseId)
}

async function rowFor(token: string) {
  return (await asSuper(`select * from public.payments where provider_token = $1`, [token]))[0] ?? null
}

async function setEnvironment(mode: 'live' | 'sandbox') {
  await asSuper(`update public.payment_environment set mode = $1, set_at = now()`, [mode])
}

/** A notification as PayTech documents it, signed with the real algorithm. */
async function ipn(
  token: string,
  over: Record<string, unknown> = {},
  opts: { signAmount?: number; secret?: string; form?: boolean; ref?: string; rawClientPhone?: string } = {},
) {
  const row = await rowFor(token).catch(() => null)
  const ref = opts.ref ?? row?.reference ?? P.refs.get(token) ?? 'SCX-NOT-A-ROW'
  const amount = opts.signAmount ?? (row ? Number(row.amount) : PRICE_C1)
  const payload: Record<string, unknown> = {
    type_event: 'sale_complete', token, ref_command: ref, item_name: 'Formation',
    item_price: String(amount), currency: 'XOF', env: 'test',
    payment_method: 'Wave', client_phone: '770000000',
    custom_field: Buffer.from(JSON.stringify({ payment_id: row?.id ?? null })).toString('base64'),
    api_key_sha256: sha256(API_KEY), api_secret_sha256: sha256(API_SECRET),
    hmac_compute: hmacHex(opts.secret ?? API_SECRET, `${amount}|${ref}|${API_KEY}`),
    ...over,
  }
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
  const { POST } = await import('@/app/api/payments/paytech/ipn/route')
  const res = await POST(new Request('https://xp-preview.vercel.app/api/payments/paytech/ipn', {
    method: 'POST',
    headers: { 'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: opts.form
      ? new URLSearchParams(payload as Record<string, string>).toString()
      : opts.rawClientPhone
        ? JSON.stringify(payload).replace('"770000000"', opts.rawClientPhone)
        : JSON.stringify(payload),
  }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function sweep(auth: string | null = `Bearer ${CRON}`) {
  const { GET } = await import('@/app/api/payments/paytech/reconcile/route')
  const headers: Record<string, string> = {}
  if (auth !== null) headers.authorization = auth
  const res = await GET(new Request('https://xp-preview.vercel.app/api/payments/paytech/reconcile', { headers }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/** Run an admin form action; return the notice it redirected with. */
async function adminAction(name: 'verifyPaytechPayment' | 'closeUnpaidPaytechPayment', fields: Record<string, string>) {
  const mod = await import('@/app/(admin)/admin/payments/reconcile-actions')
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  try {
    await mod[name](fd)
  } catch (e) {
    const url = (e as { url?: string }).url
    if (!url) throw e
    return new URL(url, 'https://x.test').searchParams.get('notice')
  }
  throw new Error('the action did not redirect')
}

async function counts() {
  const [r] = await asSuper(`select
    (select count(*) from public.payments)::int as payments,
    (select count(*) from public.payments where status = 'completed')::int as completed,
    (select count(*) from public.entitlements)::int as entitlements,
    (select count(*) from public.enrollments)::int as enrollments,
    (select count(*) from public.audit_log where event_type = 'payment.completed')::int as audits`)
  return r as { payments: number; completed: number; entitlements: number; enrollments: number; audits: number }
}

async function entitlementsOf(userId: string) {
  return asSuper(`select course_id, source, status, external_ref from public.entitlements where user_id = $1 order by created_at`, [userId])
}

/** As a learner session: may the database itself open this course? */
async function dbHasAccess(userId: string, courseId: string) {
  return (await asRole('authenticated', userId, `select public.has_course_access($1) as ok`, [courseId]))[0].ok as boolean
}

async function startAndToken(u: U, courseId = C1) {
  const r = await checkout(u, courseId)
  expect(r.error, `checkout refused: ${r.error}`).toBeUndefined()
  return r.redirectUrl!.split('/').pop()!
}

/** Age a row so the sweep and checkout treat it as stale/abandoned. */
async function age(token: string | null, minutes: number, id?: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id ?? token))) throw new Error('harness: unsafe identifier')
  await db.exec(
    `alter table public.payments disable trigger payments_transition_guard;
     update public.payments set created_at = now() - make_interval(mins => ${Number(minutes)})
      where ${id ? `id = '${id}'` : `provider_token = '${token}'`};
     alter table public.payments enable trigger payments_transition_guard;`)
}

// ── XP-PAYTECH-05 helpers ──────────────────────────────────────────────────
/** An opened attempt moved straight to a closed state, however that came about. */
async function closedAttempt(status: 'cancelled' | 'failed' | 'expired', u: U = user(L1), courseId = C1) {
  const token = await startAndToken(u, courseId)
  const { id } = await rowFor(token)
  await asRole('service_role', null, `update public.payments set status = $1, failure_reason = 'closed_for_test' where id = $2`, [status, id])
  return { token, id: id as string }
}

async function exceptionFor(token: string) {
  return (await asSuper(`select e.* from public.payment_exceptions e join public.payments p on p.id = e.payment_id
    where p.provider_token = $1`, [token]))[0] ?? null
}

async function exceptionFor2(id: string) {
  return (await asSuper(`select * from public.payment_exceptions where id = $1`, [id]))[0] ?? null
}

async function exceptionAudit() {
  return asSuper(`select event_type, actor_type, actor_id, actor_email, subject_user_id, outcome, reason, metadata
    from public.audit_log where event_type like 'payment.exception%' order by created_at, id`)
}

const refundFields = (exceptionId: string) => ({
  exceptionId, note: NOTE, attest: 'yes', attestAll: 'yes', externalReference: 'PT-REFUND-0001',
  amount: String(PRICE_C1), currency: 'XOF', refundedOn: new Date().toISOString().slice(0, 10),
})

/** Make a report look older than it is. The guard forbids this for everyone else. */
async function ageException(token: string, hours: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('harness: unsafe identifier')
  await db.exec(
    `alter table public.payment_exceptions disable trigger payment_exceptions_guard;
     update public.payment_exceptions set first_reported_at = now() - make_interval(hours => ${Number(hours)})
      where payment_id = (select id from public.payments where provider_token = '${token}');
     alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
}

type ExName = 'acknowledgeExceptionReport' | 'reopenExceptionAfterReview' | 'confirmExceptionReceipt' | 'withdrawExceptionReceipt' | 'dismissException' | 'requireExceptionRefund'
  | 'withdrawExceptionRefund' | 'recordExceptionAccess' | 'recordExceptionRefund' | 'recheckException'

/** One alert run, as the sweep and a new report start it. */
async function sendAlerts() {
  const { sendPendingExceptionAlerts } = await import('@/lib/payments/payment-exceptions')
  return sendPendingExceptionAlerts()
}

/** Run an exception action; return its notice, or where it sent a refused caller. */
async function exAction(name: ExName, fields: Record<string, string>) {
  const mod = await import('@/app/(admin)/admin/payments/exception-actions')
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  // The page sends the version of the record it read. A test about a stale or a missing
  // one says so.
  if (!('evidenceVersion' in fields) && /^[0-9a-f-]{36}$/.test(fields.exceptionId ?? '')) {
    const [row] = await asSuper(`select to_jsonb(e) ->> 'evidence_version' as v from public.payment_exceptions e where e.id = $1`, [fields.exceptionId])
    if (row?.v !== null && row?.v !== undefined) fd.set('evidenceVersion', String(row.v))
  }
  // A refund decision's own attestation has its own test. Everywhere else the box is ticked.
  if (name === 'requireExceptionRefund' && !('attestAll' in fields)) fd.set('attestAll', 'yes')
  if (!('evidenceCount' in fields) && /^[0-9a-f-]{36}$/.test(fields.exceptionId ?? '')) {
    const [row] = await asSuper(`select cardinality(evidence_fingerprints) + cardinality(provider_answers) + greatest(cardinality(provider_amounts) - 1, 0)
      + (case when evidence_overflow_at is null then 0 else 1 end) as n from public.payment_exceptions where id = $1`, [fields.exceptionId])
    if (row) fd.set('evidenceCount', String(row.n))
  }
  try {
    await mod[name](fd)
  } catch (e) {
    const url = (e as { url?: string }).url
    if (!url) throw e
    return new URL(url, 'https://x.test').searchParams.get('notice') ?? `REDIRECT:${url}`
  }
  throw new Error('the action did not redirect')
}

/** What the page's form sends for a record it has just shown in full. */
const reviewedForm = (e: { id: string; evidence_version?: number; evidence_fingerprints: string[]; provider_answers?: string[]; provider_amounts?: unknown[]; evidence_overflow_at?: string | null; post_settlement_report_at?: string | null }) => ({
  exceptionId: e.id, note: NOTE, attest: 'yes', attestAll: 'yes',
  ...(e.evidence_version === undefined ? {} : { evidenceVersion: String(e.evidence_version) }),
  evidenceCount: String(e.evidence_fingerprints.length + (e.provider_answers?.length ?? 0) + Math.max((e.provider_amounts?.length ?? 0) - 1, 0) + (e.evidence_overflow_at ? 1 : 0)),
})

// ── lifecycle ──────────────────────────────────────────────────────────────
describe('XP-PAYTECH-04 — PayTech journey on a real PostgreSQL engine', () => {
  beforeAll(async () => {
    db = new PGlite({
      parsers: { [types.NUMERIC]: (v: string) => Number(v), [types.TIMESTAMPTZ]: (v: string) => v },
    })
    await db.exec(SCHEMA)
    // What Supabase does to every new object in public, so 063's and 064's REVOKEs
    // must do the work they claim.
    await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
    // Migration 063, WHOLE: preflight, objects, self-test, assertions.
    await db.exec(M063)
    // Migration 064, WHOLE, on top of it.
    await db.exec(M064)
    // XP-LAUNCH-FINAL-08: migration 065, WHOLE, on top of that. Every test below runs
    // against its complete_payment(): six months, packs, rollover.
    await seedCatalogueCodes()
    await db.exec(M065)
    await db.exec(`create function public.harness_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated storage failure'; end $$`)
  }, 120_000)

  afterAll(async () => { await db?.close() })

  beforeEach(async () => {
    await asSuper(`drop trigger if exists harness_fault on public.entitlements`)
    await asSuper(`truncate public.audit_log, public.entitlements, public.enrollments, public.payments, public.courses, public.profiles, auth.users cascade`)
    // The suite runs PayTech TEST mode, so its database is a declared sandbox.
    // `live` is exercised explicitly below.
    await setEnvironment('sandbox')
    await asSuper(`insert into auth.users (id, email, email_confirmed_at) values
      ($1, 'l1@example.test', now()), ($2, 'l2@example.test', now()), ($3, 'owner@example.test', now())`, [L1, L2, ADM])
    await asSuper(`insert into public.profiles (id, email, platform_role) values
      ($1, 'l1@example.test', 'user'), ($2, 'l2@example.test', 'user'), ($3, 'owner@example.test', 'super_admin')`, [L1, L2, ADM])
    await asSuper(`insert into public.courses (id, slug, title, price, currency, is_published) values
      ($1, 'c1', 'Fondamentaux', 45000, 'XOF', true),
      ($2, 'c2', 'Avancé', 30000, 'XOF', true),
      ($3, 'c3', 'Brouillon', 20000, 'XOF', false)`, [C1, C2, C3])

    H.user = null; H.logs = []; H.rpcFault = null; H.contract = FIXTURE_CONTRACT
    H.rpcFaultFor = null; H.denyAdmin = false; H.emails = []; H.emailMode = 'ok'; H.emailDuring = null
    H.confirmations = []; H.confirmationMode = 'ok'
    P.next = 0; P.requests = []; P.statusCalls = []; P.refs = new Map(); P.status = new Map(); P.during = null; P.duringStatus = null

    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u === 'https://paytech.sn/api/payment/request-payment') {
        const body = JSON.parse(String(init?.body))
        P.requests.push(body)
        if (P.during) { const d = P.during; P.during = null; await d() }
        const token = `tokready01x${String(++P.next).padStart(4, '0')}`
        P.refs.set(token, String(body.ref_command))
        const redirect = `https://paytech.sn/payment/checkout/${token}`
        return json({ success: 1, token, redirect_url: redirect, redirectUrl: redirect })
      }
      if (u.startsWith('https://paytech.sn/api/payment/get-status')) {
        const token = new URL(u).searchParams.get('token_payment') ?? ''
        P.statusCalls.push(token)
        if (P.duringStatus) { const d = P.duringStatus; P.duringStatus = null; await d() }
        const s = P.status.get(token)
        if (s === undefined) throw new TypeError('fetch failed')
        return json(s)
      }
      throw new Error(`harness: unexpected outbound request to ${u}`)
    }))
    vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', 'true')
    vi.stubEnv('PAYTECH_MODE', 'test')
    vi.stubEnv('PAYTECH_TEST_API_KEY', API_KEY)
    vi.stubEnv('PAYTECH_TEST_API_SECRET', API_SECRET)
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('VERCEL_URL', 'xp-preview.vercel.app')
    vi.stubEnv('PAYTECH_CALLBACK_BASE_URL', '')
    vi.stubEnv('CRON_SECRET', CRON)
    vi.stubEnv('ADMIN_OWNER_EMAILS', OWNERS.join(','))
  })

  // ═══ migration 063 itself ═══════════════════════════════════════════════
  describe('M063 the state machine migration', () => {
    it('ran WHOLE on top of the verbatim 062 — preflight, self-test and assertions all passed', async () => {
      // 064's follow trigger sits beside it; it is proved in its own section.
      const t = await asSuper(`select tgname, tgenabled from pg_trigger where tgrelid = 'public.payments'::regclass and tgname = 'payments_transition_guard' and not tgisinternal`)
      expect(t).toEqual([{ tgname: 'payments_transition_guard', tgenabled: 'O' }])
      expect(await asSuper(`select count(*)::int as n from public.payment_environment`)).toEqual([{ n: 1 }])
    })

    it('refuses to run twice (its preflight sees its own objects)', async () => {
      await expect(db.exec(M063)).rejects.toThrow(/063 preflight/)
      await db.exec('rollback').catch(() => undefined)
    })

    it('the guard enforces the state machine for every role, including service_role', async () => {
      const token = await startAndToken(user(L1))
      const r = await rowFor(token)
      const attempt = (sql: string) => asRole('service_role', null, sql, [r.id])
      await expect(attempt(`update public.payments set provider_token = 'other-token-abc' where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('provider_token_write_once') })
      await expect(attempt(`update public.payments set amount = 1 where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_identity_immutable') })
      await expect(attempt(`update public.payments set user_id = '${L2}' where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_owner_immutable') })
      await expect(attempt(`update public.payments set provider_mode = 'live' where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('provider_mode_write_once') })
      await expect(attempt(`delete from public.payments where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_delete_refused') })
    })

    it('a completed payment is final: no road back to processing, only to refunded', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      const r = await rowFor(token)
      await expect(asRole('service_role', null, `update public.payments set status = 'processing' where id = $1`, [r.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('illegal_status_transition') })
      await expect(asRole('service_role', null, `update public.payments set completed_at = now() where id = $1`, [r.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('completed_at_immutable') })
      await asRole('service_role', null, `update public.payments set status = 'refunded' where id = $1`, [r.id])
      expect((await rowFor(token)).status).toBe('refunded')
    })

    it('ON DELETE SET NULL still works through the guard (a learner can be deleted)', async () => {
      const token = await startAndToken(user(L2))
      says(token, 'completed')
      await ipn(token)
      await asSuper(`delete from public.profiles where id = $1`, [L2])
      expect((await rowFor(token)).user_id).toBeNull()
    })

    it('its ROLLBACK block runs, proves itself, and changes no payment', async () => {
      const token = await startAndToken(user(L1))
      const before = await counts()
      // In reverse order of application: 065 replaces functions of 062 and 064, 064
      // depends on 063, and 063's preflight refuses to re-apply beside 064's trigger.
      await db.exec(ROLLBACK_065)
      expect(await asSuper(`select to_regclass('public.course_packs') as t`)).toEqual([{ t: null }])
      await db.exec(ROLLBACK_064)
      await db.exec(ROLLBACK_063)
      expect(await asSuper(`select count(*)::int as n from pg_trigger where tgname = 'payments_transition_guard'`)).toEqual([{ n: 0 }])
      expect(await asSuper(`select to_regclass('public.payment_environment') as t`)).toEqual([{ t: null }])
      expect(await counts()).toEqual(before)
      expect((await rowFor(token)).status).toBe('processing')
      // …and re-applying 063 restores it (its preflight accepts the rolled-back state).
      await db.exec(M063)
      await db.exec(M064)
      await seedCatalogueCodes()
      await db.exec(M065)
      await setEnvironment('sandbox')
      expect(await asSuper(`select count(*)::int as n from pg_trigger where tgname = 'payments_transition_guard'`)).toEqual([{ n: 1 }])
    })
  })

  // ═══ safeguard 4: test payments never grant production entitlements ═════
  describe('SAFEGUARD 4 — a test payment is incapable of a production entitlement', () => {
    it('in a LIVE database, complete_payment of a test-mode payment rolls back whole', async () => {
      const token = await startAndToken(user(L1))
      const row = await rowFor(token)
      await setEnvironment('live')
      // Called directly as service_role: the database refuses on its own, with
      // no application guard in front of it (see DATABASE GUARD for those).
      await expect(asRole('service_role', null,
        `select public.complete_payment('paytech','test','${token}','${row.reference}','${row.reference}',${Number(row.amount)},'XOF')`))
        .rejects.toMatchObject({ detail: expect.stringContaining('test_payment_in_live_database') })
      expect(await counts()).toMatchObject({ completed: 0, entitlements: 0, enrollments: 0, audits: 0 })
      expect((await rowFor(token)).status).toBe('processing')
      expect(await dbHasAccess(L1, C1)).toBe(false)
    })

    it('the same payment completes in a database explicitly declared a sandbox', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a sandbox database refuses a LIVE-mode completion, symmetrically', async () => {
      const token = await startAndToken(user(L1))
      const r = await rowFor(token)
      await asSuper(`insert into public.payments (user_id, course_id, amount, currency, method, status, reference, provider, provider_mode, provider_token)
                     values ($1, $2, 30000, 'XOF', 'card', 'processing', 'SCX-LIVE-1', 'paytech', 'live', 'tok-live-0001')`, [L1, C2])
      await expect(asRole('service_role', null,
        `select public.complete_payment('paytech','live','tok-live-0001','SCX-LIVE-1','SCX-LIVE-1',30000,'XOF')`))
        .rejects.toMatchObject({ detail: expect.stringContaining('live_payment_in_sandbox_database') })
      expect(r).toBeTruthy()
    })

    it('production refuses test mode before the database is even asked', async () => {
      const { paytechCheckoutAvailability, paytechProcessingAvailability } = await import('@/lib/payments/providers')
      const env = { VERCEL_ENV: 'production', PAYTECH_MODE: 'test', PAYTECH_TEST_API_KEY: 'k', PAYTECH_TEST_API_SECRET: 's',
                    PAYTECH_CHECKOUT_ENABLED: 'true', PAYTECH_ALLOW_PRODUCTION: 'true' }
      expect(paytechCheckoutAvailability(env).available).toBe(false)
      expect(paytechProcessingAvailability(env).available).toBe(false)
    })

    it('the application cannot turn a live database into a sandbox', async () => {
      await expect(asRole('service_role', null, `update public.payment_environment set mode = 'sandbox'`))
        .rejects.toMatchObject({ code: '42501' })
      await expect(asRole('authenticated', L1, `select mode from public.payment_environment`))
        .rejects.toMatchObject({ code: '42501' })
    })
  })

  // ═══ 1. successful payment, end to end ══════════════════════════════════
  describe('T01 successful payment', () => {
    it('checkout → provider → IPN → settlement → payment, entitlement, enrollment, audit, access', async () => {
      expect((await access(user(L1), C1)).reason).toBe('not_entitled')
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBe('https://paytech.sn/payment/checkout/tokready01x0001')

      const req = P.requests[0]
      const row = await rowFor('tokready01x0001')
      expect(req).toMatchObject({ item_price: PRICE_C1, currency: 'XOF', env: 'test', ref_command: row.reference,
        ipn_url: 'https://xp-preview.vercel.app/api/payments/paytech/ipn' })
      expect(row).toMatchObject({ user_id: L1, course_id: C1, amount: PRICE_C1, currency: 'XOF',
        status: 'processing', provider: 'paytech', provider_mode: 'test' })
      expect(row.metadata).toMatchObject({ provider: 'paytech', checkoutUrl: r.redirectUrl })

      says('tokready01x0001', 'completed')
      expect(await ipn('tokready01x0001')).toEqual({ status: 200, body: { received: true, detail: 'completed' } })

      const done = await rowFor('tokready01x0001')
      const ents = await asSuper(`select * from public.entitlements where user_id = $1`, [L1])
      expect(ents).toHaveLength(1)
      expect(ents[0]).toMatchObject({ course_id: C1, source: 'INDIVIDUAL_PURCHASE', status: 'ACTIVE', external_ref: done.reference })
      expect(done).toMatchObject({ status: 'completed', entitlement_id: ents[0].id })
      expect(await asSuper(`select course_id, payment_id, status from public.enrollments where user_id = $1`, [L1]))
        .toEqual([{ course_id: C1, payment_id: done.id, status: 'active' }])
      const audit = await asSuper(`select metadata from public.audit_log where event_type = 'payment.completed'`)
      expect(audit).toHaveLength(1)
      expect(JSON.stringify(audit[0].metadata)).not.toContain('tokready01x0001')

      expect(await access(user(L1), C1)).toMatchObject({ allowed: true })
      expect(await dbHasAccess(L1, C1)).toBe(true)
      expect(await dbHasAccess(L1, C2)).toBe(false)
      expect((await checkout(user(L1), C1)).error).toMatch(/déjà accès/)
      expect(P.requests).toHaveLength(1)
    })

    it('accepts the form-encoded body PayTech\'s PHP examples and plugins read', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, {}, { form: true })).body.detail).toBe('completed')
    })
  })

  // ═══ 2–4. failed, cancelled, pending ════════════════════════════════════
  describe('T02–T04 non-paid outcomes', () => {
    it('T02 failed: terminal as "failed" nothing granted', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      expect((await ipn(token, { type_event: 'sale_canceled' })).body.detail).toBe('failed')
      expect(await rowFor(token)).toMatchObject({ status: 'failed', failure_reason: 'settlement_failed' })
      expect(await counts()).toMatchObject({ entitlements: 0, completed: 0 })
    })

    it('T03 cancelled: terminal, nothing granted, and a FRESH attempt may be opened', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'canceled')
      expect((await ipn(token, { type_event: 'sale_canceled' })).body.detail).toBe('cancelled')
      const fresh = await startAndToken(user(L1))
      expect(fresh).not.toBe(token)
      expect(P.requests[1].ref_command).not.toBe(P.requests[0].ref_command)
      expect(await counts()).toMatchObject({ payments: 2, entitlements: 0 })
    })

    it('T04 pending: nothing granted, recorded, and the sweep finishes it later', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      expect(await ipn(token)).toEqual({ status: 200, body: { received: true, detail: 'unsettled:pending' } })
      expect(await rowFor(token)).toMatchObject({ status: 'processing', failure_reason: 'settlement_pending' })
      says(token, 'completed')
      await age(token, 20)
      expect((await sweep()).body).toMatchObject({ checked: 1, completed: 1 })
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('T04b settlement unreachable: 503 — come back — and nothing granted (READY-P2)', async () => {
      const token = await startAndToken(user(L1))
      const res = await ipn(token)
      expect(res.status).toBe(503)
      expect(res.body.detail).toBe('unsettled:network_error')
      expect(await rowFor(token)).toMatchObject({ status: 'processing', failure_reason: 'settlement_unknown:network_error' })
    })
  })

  // ═══ 5. forged notifications ════════════════════════════════════════════
  describe('T05 forged notification', () => {
    it('no credential hashes → 401, no write, no provider call', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, { api_key_sha256: undefined, api_secret_sha256: undefined })).status).toBe(401)
      expect((await rowFor(token)).last_ipn_at).toBeNull()
      expect(P.statusCalls).toEqual([])
    })

    it('HMAC under a different secret → "unverified", no provider call', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, {}, { secret: 'sk_attacker_guess' })).body.detail).toBe('unverified')
      expect(P.statusCalls).toEqual([])
      expect(await counts()).toMatchObject({ entitlements: 0 })
    })

    it('an AUTHENTIC notification with its outcome flipped cannot grant: the provider decides', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'canceled')
      expect((await ipn(token, { type_event: 'sale_complete' })).body.detail).toBe('cancelled')
      expect(await counts()).toMatchObject({ entitlements: 0, completed: 0 })
    })

    it('a signed refund event is not for this endpoint', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, { type_event: 'refund_complete' })).body.detail).toBe('unverified')
      expect(P.statusCalls).toEqual([])
    })

    it('GET cannot reach fulfilment; the browser return pages have no write path', async () => {
      const { GET } = await import('@/app/api/payments/paytech/ipn/route')
      expect((await GET()).status).toBe(405)
      for (const p of ['app/payment/success/page.tsx', 'app/payment/cancel/page.tsx', 'app/(platform)/checkout/confirm/page.tsx']) {
        expect(read(p), p).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
      }
    })
  })

  // ═══ 6. wrong amount ════════════════════════════════════════════════════
  describe('T06 incorrect amount', () => {
    it('signed over a different amount → unverified', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed', 100)
      expect((await ipn(token, { item_price: '100' }, { signAmount: 100 })).body.detail).toBe('unverified')
      expect(await counts()).toMatchObject({ entitlements: 0 })
    })

    it('correctly signed but CLAIMING another amount → refused', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, { item_price: '100' })).body.detail).toBe('amount_mismatch')
    })

    it('the PROVIDER confirming another amount → refused, recorded', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed', 100)
      expect((await ipn(token)).body.detail).toBe('refused:settlement_amount_mismatch')
      expect((await rowFor(token)).failure_reason).toBe('settlement_amount_mismatch')
      expect(await counts()).toMatchObject({ entitlements: 0 })
    })

    it('safeguard 8 — the browser cannot set the price or currency', async () => {
      await checkout(user(L1), C1, { amount: 1, price: 1, currency: 'EUR' })
      expect(P.requests[0]).toMatchObject({ item_price: PRICE_C1, currency: 'XOF' })
      expect(await asSuper(`select amount, currency from public.payments`)).toEqual([{ amount: PRICE_C1, currency: 'XOF' }])
    })

    it('safeguard 8 — a course priced in anything but XOF cannot be bought', async () => {
      await asSuper(`update public.courses set currency = 'EUR' where id = $1`, [C2])
      expect((await checkout(user(L1), C2)).error).toMatch(/réglable en ligne/)
      expect(P.requests).toHaveLength(0)
    })
  })

  // ═══ 7–8. wrong course, wrong user ══════════════════════════════════════
  describe('T07–T08 incorrect course or user identifier', () => {
    it('payload fields naming another course and learner change nothing', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token, {
        custom_field: Buffer.from(JSON.stringify({ course_id: C2, user_id: L2 })).toString('base64'),
        course_id: C2, user_id: L2,
      })
      expect(await entitlementsOf(L1)).toMatchObject([{ course_id: C1 }])
      expect(await entitlementsOf(L2)).toEqual([])
    })

    it('another order\'s ref_command on this token is not authentic', async () => {
      const t1 = await startAndToken(user(L1), C1)
      const t2 = await startAndToken(user(L2), C2)
      says(t1, 'completed')
      expect((await ipn(t1, {}, { ref: (await rowFor(t2)).reference })).body.detail).toBe('unverified')
    })

    it('the provider echoing another order\'s reference is never "paid"', async () => {
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: 'completed', amount: PRICE_C1, currency: 'XOF', ref_command: 'SCX-ELSE' } })
      expect((await ipn(token)).body.detail).toBe('unsettled:reference_mismatch')
      expect(await counts()).toMatchObject({ entitlements: 0 })
    })

    it('the session decides who pays', async () => {
      await checkout(user(L2), C1, { userId: L1, user_id: L1 })
      expect(await asSuper(`select user_id from public.payments`)).toEqual([{ user_id: L2 }])
    })
  })

  // ═══ 9–11. duplicate, replay, expired ═══════════════════════════════════
  describe('T09–T11 duplicate, replay, expired or invalid', () => {
    it('T09 a duplicate is a success and writes no second grant', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('completed')
      expect((await ipn(token)).body.detail).toBe('already_completed')
      expect(await counts()).toMatchObject({ completed: 1, entitlements: 1, enrollments: 1, audits: 1 })
    })

    it('T10 a replayed cancellation after completion cannot revoke the purchase', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'canceled')
      expect((await ipn(token, { type_event: 'sale_canceled' })).body.detail).toBe('already_completed')
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('T11 unknown token → 404, nothing written', async () => {
      await startAndToken(user(L1))
      expect((await ipn('tokready01xNOPE')).status).toBe(404)
    })

    it('T11 a paid notification for an EXPIRED order is not re-opened', async () => {
      const token = await startAndToken(user(L1))
      await asSuper(`update public.payments set status = 'expired' where provider_token = $1`, [token])
      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('already_terminal')
      expect(await counts()).toMatchObject({ entitlements: 0 })
    })

    it('T11 unpublished course, unverified email, no session: refused before any provider call', async () => {
      expect((await checkout(user(L1), C3)).error).toBe('Formation introuvable.')
      expect((await checkout(user(L1, false), C1)).error).toMatch(/Confirmez votre adresse email/)
      expect((await checkout(null, C1)).error).toMatch(/connecté/)
      expect(P.requests).toHaveLength(0)
    })
  })

  // ═══ 12. database failure ═══════════════════════════════════════════════
  describe('T12 database failure during entitlement creation', () => {
    it('all-or-nothing, and now answered 503 so a retrying provider comes back (READY-P2)', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await asSuper(`create trigger harness_fault before insert on public.entitlements for each row execute function public.harness_fail()`)
      const res = await ipn(token)
      expect(res.status).toBe(503)
      expect(res.body.detail).toBe('refused:unknown_error')
      expect(await rowFor(token)).toMatchObject({ status: 'processing', entitlement_id: null })
      expect(await counts()).toMatchObject({ entitlements: 0, enrollments: 0, audits: 0, completed: 0 })
      await asSuper(`drop trigger harness_fault on public.entitlements`)
      expect((await ipn(token)).body.detail).toBe('completed')
    })

    it('an RPC transport failure is likewise retryable', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      H.rpcFault = { message: 'TypeError: fetch failed', details: null, hint: null, code: '' }
      expect((await ipn(token)).status).toBe(503)
      expect(await counts()).toMatchObject({ completed: 0 })
    })
  })

  // ═══ 13. concurrency — safeguard 5 ═════════════════════════════════════
  describe('T13 / SAFEGUARD 5 — concurrent retries, notifications and reconciliation', () => {
    it('five simultaneous notifications produce exactly one completion', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      const details = (await Promise.all(Array.from({ length: 5 }, () => ipn(token)))).map(r => r.body.detail)
      expect(details.filter(d => d === 'completed')).toHaveLength(1)
      expect(details.filter(d => d === 'already_completed')).toHaveLength(4)
      expect(await counts()).toMatchObject({ completed: 1, entitlements: 1, enrollments: 1, audits: 1 })
    })

    it('IPN × 2, the sweep, an admin verify and a checkout retry, all at once: one completion, one row', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 20)
      H.user = user(L1)
      const results = await Promise.all([
        ipn(token), ipn(token), sweep(),
        adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id }),
        checkout(user(L1), C1),
      ])
      expect(await counts()).toMatchObject({ payments: 1, completed: 1, entitlements: 1, audits: 1 })
      expect(P.requests, 'no second checkout was opened').toHaveLength(1)
      expect(results.length).toBe(5)
    })

    it('two simultaneous checkouts open at most one chargeable attempt', async () => {
      const [a, b] = await Promise.all([checkout(user(L1), C1), checkout(user(L1), C1)])
      const live = await asSuper(`select count(*)::int as n from public.payments where status in ('pending','processing')`)
      expect(live[0].n).toBe(1)
      expect([a, b].filter(r => r.redirectUrl)).toHaveLength(1)
      expect(P.requests.length).toBeLessThanOrEqual(1)
    })

    it('a cancellation racing a completion: whichever lands first is final', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      // A stale "cancelled" answer arriving after completion changes nothing.
      says(token, 'canceled')
      await age(token, 20)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
    })
  })

  // ═══ 14–15. learner-session writes ══════════════════════════════════════
  describe('T14–T15 unauthorized direct enrolment and payment modification', () => {
    it('a learner cannot write an entitlement, or call complete_payment', async () => {
      await expect(asRole('authenticated', L1,
        `insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'INDIVIDUAL_PURCHASE', 'ACTIVE')`, [L1, C1]))
        .rejects.toMatchObject({ code: '42501' })
      const token = await startAndToken(user(L1))
      const row = await rowFor(token)
      await expect(asRole('authenticated', L1,
        `select public.complete_payment('paytech','test',$1,$2,$2,$3,'XOF')`, [token, row.reference, PRICE_C1]))
        .rejects.toMatchObject({ code: '42501' })
    })

    it('a self-written enrolment grants no access', async () => {
      await asRole('authenticated', L1, `insert into public.enrollments (user_id, course_id) values ($1, $2)`, [L1, C1])
      expect(await dbHasAccess(L1, C1)).toBe(false)
    })

    it('a learner cannot mark, insert, delete or read the token of a payment', async () => {
      const token = await startAndToken(user(L1))
      await expect(asRole('authenticated', L1, `update public.payments set status = 'completed' where provider_token = $1`, [token]))
        .rejects.toMatchObject({ code: '42501' })
      await expect(asRole('authenticated', L1,
        `insert into public.payments (user_id, course_id, amount, method, status, reference) values ($1, $2, 1, 'wave', 'completed', 'FORGED')`, [L1, C1]))
        .rejects.toMatchObject({ code: '42501' })
      await expect(asRole('authenticated', L1, `delete from public.payments where provider_token = $1`, [token]))
        .rejects.toMatchObject({ code: '42501' })
      await expect(asRole('authenticated', L1, `select provider_token from public.payments`)).rejects.toMatchObject({ code: '42501' })
      await expect(asRole('authenticated', L1, `select metadata from public.payments`)).rejects.toMatchObject({ code: '42501' })
    })
  })

  // ═══ regression tests, by finding ═════════════════════════════════════════
  describe('READY-F1 closed: a retry never orphans or re-sends an opened checkout (safeguard 1)', () => {
    it('with settlement UNKNOWN, a second click opens nothing and points to the existing order', async () => {
      H.contract = null   // the real state of the world: no contract confirmed
      const first = await startAndToken(user(L1))
      const ref = (await rowFor(first)).reference
      const second = await checkout(user(L1), C1)
      expect(second.redirectUrl).toBeUndefined()
      expect(second.reference).toBe(ref)
      expect(second.error).toMatch(/vérification/)
      expect(P.requests, 'a second chargeable checkout was opened').toHaveLength(1)
      expect((await rowFor(first)).provider_token).toBe(first)
      expect(P.statusCalls, 'with no contract, PayTech is not even asked').toEqual([])
    })

    it('with settlement PENDING, the SAME checkout URL is offered again — never a new one', async () => {
      const first = await startAndToken(user(L1))
      says(first, 'pending')
      const again = await checkout(user(L1), C1)
      expect(again.redirectUrl).toBe(`https://paytech.sn/payment/checkout/${first}`)
      expect(P.requests).toHaveLength(1)
    })

    it('with settlement PAID, the retry completes the purchase and sends the learner in', async () => {
      const first = await startAndToken(user(L1))
      says(first, 'completed')
      expect(await checkout(user(L1), C1)).toEqual({ accessUrl: '/courses/c1' })
      expect(await dbHasAccess(L1, C1)).toBe(true)
      expect(P.requests).toHaveLength(1)
    })

    it('with settlement CANCELLED, a fresh attempt with a NEW reference is opened', async () => {
      const first = await startAndToken(user(L1))
      says(first, 'canceled')
      const second = await startAndToken(user(L1))
      expect(second).not.toBe(first)
      expect(P.requests[1].ref_command).not.toBe(P.requests[0].ref_command)
      expect((await rowFor(first)).status).toBe('cancelled')
    })

    it('an attempt that was never opened (provider timed out) is closed and replaced', async () => {
      let n = 0
      vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith('/payment/request-payment') && n++ === 0) {
          throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
        }
        const body = JSON.parse(String(init?.body))
        P.requests.push(body)
        return json({ success: 1, token: 'tokready01xRETRY1', redirect_url: 'https://paytech.sn/payment/checkout/tokready01xRETRY1' })
      }))
      expect((await checkout(user(L1), C1)).error).toMatch(/momentanément indisponible/)
      const closed = await asSuper(`select status, failure_reason, provider_token from public.payments`)
      expect(closed).toEqual([{ status: 'expired', failure_reason: 'provider_request_timeout', provider_token: null }])
      expect((await checkout(user(L1), C1)).redirectUrl).toBe('https://paytech.sn/payment/checkout/tokready01xRETRY1')
    })
  })

  describe('READY-F2 closed: a retry racing a completion cannot corrupt the ledger', () => {
    it('the completed payment stays completed, keeps its token, and no second charge is possible', async () => {
      const first = await startAndToken(user(L1))
      says(first, 'completed')
      // While the RETRY is asking PayTech about the open attempt, the first
      // tab's payment completes through its notification.
      P.duringStatus = async () => { expect((await ipn(first)).body.detail).toBe('completed') }
      const retry = await checkout(user(L1), C1)
      expect(retry).toEqual({ accessUrl: '/courses/c1' })
      expect(P.requests, 'no second checkout was opened').toHaveLength(1)
      const row = await rowFor(first)
      expect(row).toMatchObject({ status: 'completed', provider_token: first })
      expect(await counts()).toMatchObject({ payments: 1, completed: 1, audits: 1 })
      // And the database itself refuses the old corruption outright.
      await expect(asRole('service_role', null,
        `update public.payments set status = 'processing', provider_token = 'tok-new' where id = $1`, [row.id]))
        .rejects.toMatchObject({ detail: expect.stringMatching(/provider_token_write_once|illegal_status_transition/) })
    })
  })

  describe('READY-F3 closed: checkout refuses exactly where complete_payment would refuse', () => {
    const STATES: { name: string; ent: string; refuses: boolean }[] = [
      { name: 'REVOKED',           ent: `'MANUAL_ADMIN','REVOKED', null, null, now()`, refuses: true },
      { name: 'SUSPENDED',         ent: `'MANUAL_ADMIN','SUSPENDED', null, null, null`, refuses: true },
      { name: 'PENDING',           ent: `'MANUAL_ADMIN','PENDING', null, null, null`, refuses: true },
      { name: 'ACTIVE but expired',ent: `'PROMOTIONAL_GRANT','ACTIVE', now() - interval '10 days', now() - interval '1 day', null`, refuses: true },
      { name: 'EXPIRED',           ent: `'PROMOTIONAL_GRANT','EXPIRED', now() - interval '10 days', now() - interval '1 day', null`, refuses: false },
      { name: 'CANCELLED',         ent: `'MANUAL_ADMIN','CANCELLED', null, null, null`, refuses: false },
    ]
    for (const st of STATES) {
      it(`${st.name}: checkout ${st.refuses ? 'refuses' : 'proceeds'}, and 062 agrees`, async () => {
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status, starts_at, expires_at, revoked_at)
                       values ($1, $2, ${st.ent})`, [L1, C1])
        const r = await checkout(user(L1), C1)
        expect(Boolean(r.error), JSON.stringify(r)).toBe(st.refuses)
        if (st.refuses) {
          expect(r.error).toMatch(/régularisation/)
          expect(P.requests).toHaveLength(0)
        }
        // Ground truth from the real 062, on a scratch payment.
        await asSuper(`insert into public.payments (user_id, course_id, amount, currency, method, status, reference, provider, provider_mode, provider_token)
                       values ($1, $2, 45000, 'XOF', 'card', 'processing', 'SCX-PARITY', 'paytech', 'test', 'tok-parity-0001')
                       on conflict do nothing`, [L1, C1]).catch(() => undefined)
        let refusedBy062 = false
        try {
          await asRole('service_role', null,
            `select public.complete_payment('paytech','test','tok-parity-0001','SCX-PARITY','SCX-PARITY',45000,'XOF')`)
        } catch { refusedBy062 = true }
        if (st.refuses) expect(refusedBy062, 'checkout refused something 062 would accept').toBe(true)
      })
    }
  })

  describe('READY-F6 closed: the chokepoint reads 062\'s answer', () => {
    it('entitlementId and requiresReview come back populated', async () => {
      const token = await startAndToken(user(L1))
      const row = await rowFor(token)
      const { completeVerifiedPayment } = await import('@/lib/payments/payment-completion')
      const out = await completeVerifiedPayment({
        provider: 'paytech', providerMode: 'test', providerToken: token,
        providerReference: row.reference, reference: row.reference, amount: PRICE_C1, currency: 'XOF',
      })
      const [ent] = await asSuper(`select id from public.entitlements where user_id = $1`, [L1])
      expect(out).toEqual({ kind: 'completed', entitlementId: ent.id, requiresReview: false })
    })
  })

  describe('the owner is not a buyer', () => {
    it('a super_admin is "already entitled"', async () => {
      expect((await checkout(user(ADM), C1)).error).toMatch(/déjà accès/)
    })
  })

  describe('READY-F8 / SAFEGUARD 3 — nothing is inferred from an undocumented answer', () => {
    it('with NO contract, every path answers unknown and nothing moves', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      expect((await ipn(token)).status).toBe(503)
      await age(token, 20)
      expect((await sweep()).body).toMatchObject({ checked: 1, unknown: 1 })
      expect(await rowFor(token)).toMatchObject({ status: 'processing', failure_reason: 'settlement_unknown:contract_unconfirmed' })
      expect(P.statusCalls).toEqual([])
      expect(await counts()).toMatchObject({ completed: 0, entitlements: 0 })
    })

    it('a top-level "success" envelope over a nested pending is NOT paid (READY-P1)', async () => {
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, status: 'success', payment: { status: 'pending', amount: PRICE_C1, currency: 'XOF', ref_command: P.refs.get(token) } })
      expect((await ipn(token)).body.detail).toBe('unsettled:pending')
    })

    it('a status word the contract does not list is unknown, and its SHAPE (not values) is logged', async () => {
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: 'paye', amount: PRICE_C1, currency: 'XOF', ref_command: P.refs.get(token) } })
      expect((await ipn(token)).body.detail).toBe('unsettled:status_unrecognised')
      const warn = H.logs.find(l => l.level === 'warn' && JSON.stringify(l.args).includes('shape'))
      expect(JSON.stringify(warn?.args)).toContain('payment.status')
      expect(JSON.stringify(warn?.args)).not.toContain('paye')
    })

    it('sandbox: an IPN signed over the 100–150 CFA debit never verifies', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed', 137)
      expect((await ipn(token, { item_price: '137', final_item_price: '137' }, { signAmount: 137 })).body.detail).toBe('unverified')
    })

    it('no hmac_compute → unverified; Base64 key hashes → 401', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token, { hmac_compute: undefined })).body.detail).toBe('unverified')
      expect((await ipn(token, { api_key_sha256: sha256b64(API_KEY), api_secret_sha256: sha256b64(API_SECRET) })).status).toBe(401)
    })
  })

  // ═══ the sweep ══════════════════════════════════════════════════════════
  describe('SWEEP — /api/payments/paytech/reconcile', () => {
    it('refuses without CRON_SECRET configured, and with a wrong one', async () => {
      vi.stubEnv('CRON_SECRET', '')
      expect((await sweep()).status).toBe(503)
      vi.stubEnv('CRON_SECRET', CRON)
      expect((await sweep(null)).status).toBe(401)
      expect((await sweep('Bearer wrong')).status).toBe(401)
      expect((await sweep(`Bearer ${CRON}x`)).status).toBe(401)
    })

    it('closes intents that were never opened, and only those', async () => {
      await asSuper(`insert into public.payments (user_id, course_id, amount, method, status, reference, provider, provider_mode, created_at)
                     values ($1, $2, 45000, 'card', 'pending', 'SCX-UNOPENED', 'paytech', 'test', now() - interval '2 hours')`, [L1, C1])
      const opened = await startAndToken(user(L2), C1)
      await age(opened, 120)
      const r = await sweep()
      expect(r.body).toMatchObject({ ok: true, closedUnopened: 1, checked: 1, unknown: 1 })
      expect((await asSuper(`select status, failure_reason from public.payments where reference = 'SCX-UNOPENED'`))[0])
        .toEqual({ status: 'expired', failure_reason: 'abandoned_unopened' })
      expect((await rowFor(opened)).status, 'an OPENED attempt was closed on a guess').toBe('processing')
    })

    it('leaves fresh attempts to their own notification', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await sweep()).body).toMatchObject({ checked: 0 })
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('answers with counts only — no reference, token, amount or identity', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 30)
      const body = JSON.stringify((await sweep()).body)
      for (const s of [token, (await rowFor(token)).reference, L1, '45000']) expect(body).not.toContain(s)
    })

    it('safeguard 2 — keeps reconciling when new checkout is switched off', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 20)
      vi.stubEnv('PAYTECH_CHECKOUT_ENABLED', '')
      expect((await sweep()).body).toMatchObject({ completed: 1 })
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })
  })

  // ═══ admin reconciliation ═══════════════════════════════════════════════
  describe('ADMIN — verify and manual close', () => {
    it('verify asks PayTech and completes only what it confirms; audited', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect(await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })).toBe('verify_completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
      const audit = await asSuper(`select actor_type, actor_id, outcome, metadata from public.audit_log where event_type = 'payment.verification_requested'`)
      expect(audit).toMatchObject([{ actor_type: 'admin', actor_id: ADM, outcome: 'success' }])
    })

    it('close is refused when PayTech says paid — and the payment is NOT closed', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect(await adminAction('closeUnpaidPaytechPayment', {
        paymentId: (await rowFor(token)).id, reason: 'Vérifié dans le tableau de bord', attest: 'yes',
      })).toBe('close_refused_provider_says_paid')
      expect((await rowFor(token)).status, 'the provider said paid; the close must not win').toBe('completed')
    })

    it('close is refused when PayTech says the checkout is still payable', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      expect(await adminAction('closeUnpaidPaytechPayment', {
        paymentId: (await rowFor(token)).id, reason: 'Vérifié dans le tableau de bord', attest: 'yes',
      })).toBe('close_refused_provider_says_pending')
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('with NO contract, a human attestation closes the attempt and frees the learner — auditing the reason', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      expect((await checkout(user(L1), C1)).error, 'blocked before the close').toMatch(/vérification/)
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: (await rowFor(token)).id, reason: 'court', attest: 'yes' }))
        .toBe('close_reason_required')
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: (await rowFor(token)).id, reason: 'Paiement abandonné, vérifié PayTech' }))
        .toBe('close_attestation_required')
      expect(await adminAction('closeUnpaidPaytechPayment', {
        paymentId: (await rowFor(token)).id, reason: 'Paiement abandonné, vérifié PayTech', attest: 'yes',
      })).toBe('close_done')
      expect(await rowFor(token)).toMatchObject({ status: 'expired', failure_reason: 'manual_reconciliation_unpaid' })
      const [a] = await asSuper(`select outcome, reason from public.audit_log where event_type = 'payment.manually_closed' and outcome = 'success'`)
      expect(a).toEqual({ outcome: 'success', reason: 'Paiement abandonné, vérifié PayTech' })
      expect(await counts()).toMatchObject({ entitlements: 0 })
      // Freed: a new attempt opens.
      expect((await checkout(user(L1), C1)).redirectUrl).toBeTruthy()
    })

    it('neither action exists that can mark a payment paid', () => {
      const src = read('app/(admin)/admin/payments/reconcile-actions.ts')
      expect(src).not.toMatch(/complete_payment|completeVerifiedPayment|status:\s*'completed'/)
      expect(src).not.toMatch(/createAdminClient|createClient/)
    })
  })

  // ═══ a deployment that may not act on this database ═════════════════════
  describe('DATABASE GUARD — no payment work outside production unless the database says sandbox', () => {
    /** Everything a payment operation could have touched. */
    async function snapshot() {
      const [r] = await asSuper(`select
        (select coalesce(json_agg(p order by p.created_at, p.id), '[]'::json)::text from public.payments p) as payments,
        (select count(*) from public.entitlements)::int as entitlements,
        (select count(*) from public.enrollments)::int as enrollments,
        (select count(*) from public.audit_log)::int as audits`)
      return r
    }

    const hideMarker = () => asSuper(`alter table public.payment_environment rename to payment_environment_hidden`)
    const showMarker = () => asSuper(`alter table public.payment_environment_hidden rename to payment_environment`)

    describe.each([
      ['is marked live', () => setEnvironment('live'), async () => undefined],
      ['has no marker (063 not applied)', hideMarker, showMarker],
    ] as const)('the database %s', (_label, arrange, restore) => {
      /** One opened attempt the provider would call paid, then the database is made non-sandbox. */
      async function opened() {
        const token = await startAndToken(user(L1))
        says(token, 'completed')
        await age(token, 60)
        const row = await rowFor(token)
        await arrange()
        P.requests = []; P.statusCalls = []
        return { token, row, before: await snapshot() }
      }

      it('an authentic paid notification changes nothing and does not ask PayTech', async () => {
        const { token, row, before } = await opened()
        try {
          const payload = {
            type_event: 'sale_complete', token, ref_command: row.reference, item_price: String(row.amount), currency: 'XOF',
            api_key_sha256: sha256(API_KEY), api_secret_sha256: sha256(API_SECRET),
            hmac_compute: hmacHex(API_SECRET, `${row.amount}|${row.reference}|${API_KEY}`),
          }
          const { POST } = await import('@/app/api/payments/paytech/ipn/route')
          const res = await POST(new Request('https://xp-preview.vercel.app/api/payments/paytech/ipn', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          }))
          expect(res.status).toBe(503)
          expect(P.statusCalls).toEqual([])
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('the sweep changes nothing', async () => {
        const { before } = await opened()
        try {
          expect((await sweep()).status).toBe(503)
          expect(P.statusCalls).toEqual([])
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('admin "verify" changes nothing and writes no audit row', async () => {
        const { row, before } = await opened()
        try {
          expect(await adminAction('verifyPaytechPayment', { paymentId: row.id })).toBe('environment_refused')
          expect(P.statusCalls).toEqual([])
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('admin "close" cannot close on an attestation alone, even with no contract', async () => {
        H.contract = null
        const { row, before } = await opened()
        try {
          expect(await adminAction('closeUnpaidPaytechPayment', {
            paymentId: row.id, reason: 'Vérifié dans le tableau de bord', attest: 'yes',
          })).toBe('environment_refused')
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('checkout opens nothing and calls no provider', async () => {
        const { before } = await opened()
        try {
          const r = await checkout(user(L2), C1)
          expect(r.redirectUrl).toBeUndefined()
          expect(r.error).toMatch(/pas disponible/)
          expect(P.requests).toEqual([])
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('the shared procedures refuse when called directly', async () => {
        const { row, before } = await opened()
        try {
          const { reconcilePaytechPayment, closeAfterManualReconciliation } = await import('@/lib/payments/paytech-reconcile')
          expect(await reconcilePaytechPayment(row, { source: 'admin' })).toEqual({ kind: 'unknown', reason: 'environment_refused' })
          expect(await closeAfterManualReconciliation(row)).toEqual({ kind: 'refused', reason: 'environment_refused' })
          expect(P.statusCalls).toEqual([])
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('every write in the chokepoint refuses when called directly', async () => {
        const { token, row, before } = await opened()
        try {
          const c = await import('@/lib/payments/payment-completion')
          expect(await c.completeVerifiedPayment({
            provider: 'paytech', providerMode: 'test', providerToken: token, providerReference: row.reference,
            reference: row.reference, amount: Number(row.amount), currency: 'XOF',
          })).toEqual({ kind: 'refused', reason: 'environment_refused', retryable: false })
          await c.touchIpnReceipt({ providerToken: token, failureReason: 'x' })
          await c.recordSettlementNote({ paymentId: row.id, failureReason: 'x' })
          expect(await c.recordTerminalFailure({ providerToken: token, status: 'failed', failureReason: 'x' })).toEqual({ changed: false })
          expect(await c.closeUnopenedAttempt({ paymentId: row.id, failureReason: 'x' })).toEqual({ changed: false })
          expect(await c.closeAttemptAfterManualReconciliation({ paymentId: row.id })).toEqual({ changed: false })
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })

      it('a developer machine with no VERCEL_ENV is refused the same way', async () => {
        const { row, before } = await opened()
        vi.stubEnv('VERCEL_ENV', '')
        try {
          expect(await adminAction('verifyPaytechPayment', { paymentId: row.id })).toBe('environment_refused')
          expect(await snapshot()).toEqual(before)
        } finally { await restore() }
      })
    })

    it('a declared sandbox is allowed: the same notification completes', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      const { status, body } = await ipn(token)
      expect(status).toBe(200)
      expect(body.detail).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a production deployment does not consult the marker', async () => {
      const { paymentDatabaseAuthority } = await import('@/lib/payments/payment-database-guard')
      await hideMarker()
      try {
        expect(await paymentDatabaseAuthority({ VERCEL_ENV: 'production' })).toEqual({ allowed: true, reason: null })
        expect(await paymentDatabaseAuthority({ VERCEL_ENV: 'preview' })).toEqual({ allowed: false, reason: 'marker_unreadable' })
      } finally { await showMarker() }
    })

    it('the application cannot declare the database a sandbox', async () => {
      await setEnvironment('live')
      await expect(asRole('service_role', null, `update public.payment_environment set mode = 'sandbox'`)).rejects.toThrow()
      const { paymentDatabaseAuthority } = await import('@/lib/payments/payment-database-guard')
      expect(await paymentDatabaseAuthority({ VERCEL_ENV: 'preview' })).toEqual({ allowed: false, reason: 'database_not_sandbox' })
    })
  })

  // ═══ logging ════════════════════════════════════════════════════════════
  // ═══ XP-PAYTECH-05: a report the state machine cannot act on ═══════════
  describe('XP-PAYTECH-05 M064 — the exception migration', () => {
    it('ran WHOLE on top of 063: preflight, self-test and assertions all passed', async () => {
      const t = await asSuper(`select tgname from pg_trigger where tgrelid = 'public.payments'::regclass and not tgisinternal order by 1`)
      // XP-LAUNCH-FINAL-08: 065 adds its own guard beside 063's and 064's.
      expect(t.map(r => r.tgname)).toEqual(['payment_exceptions_follow_payment', 'payments_offer_guard', 'payments_transition_guard'])
      expect(await asSuper(`select count(*)::int as n from public.payment_exceptions`)).toEqual([{ n: 0 }])
    })

    it('refuses to run twice', async () => {
      await expect(db.exec(M064)).rejects.toThrow(/064 preflight/)
      await db.exec('rollback').catch(() => undefined)
    })

    it.each(['anon', 'authenticated'])('%s holds nothing on the table or the functions', async (role) => {
      const sub = role === 'authenticated' ? L1 : null
      const denied = /permission denied/
      await expect(asRole(role, sub, `select * from public.payment_exceptions`)).rejects.toThrow(denied)
      await expect(asRole(role, sub, `update public.payment_exceptions set report_count = 9`)).rejects.toThrow(denied)
      await expect(asRole(role, sub, `delete from public.payment_exceptions`)).rejects.toThrow(denied)
      for (const call of [
        `public.payment_exception_report(gen_random_uuid(), 'paid_hint', 'ipn')`,
        `public.payment_exception_decide(gen_random_uuid(), 'dismiss', gen_random_uuid(), null, 'a long enough note')`,
        `public.payment_exception_record_refund(gen_random_uuid(), gen_random_uuid(), null, 'REF-1', 1, 'XOF', now(), 'a long enough note')`,
        `public.payment_exception_blocking_reference(gen_random_uuid(), gen_random_uuid())`,
      ]) {
        await expect(asRole(role, sub, `select ${call}`), call).rejects.toThrow(denied)
      }
    })

    it('the application can only READ the table: a refund cannot be forged by a direct write', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      const denied = /permission denied/
      const asApp = (sql: string, params: unknown[] = []) => asRole('service_role', null, sql, params)
      expect(await asApp(`select id from public.payment_exceptions where id = $1`, [e.id])).toHaveLength(1)
      await expect(asApp(`delete from public.payment_exceptions`)).rejects.toThrow(denied)
      await expect(asApp(`truncate public.payment_exceptions`)).rejects.toThrow(denied)
      // The two steps that would otherwise forge a refund with no receipt and no audit row.
      await expect(asApp(`update public.payment_exceptions set refund_state = 'required' where id = $1`, [e.id])).rejects.toThrow(denied)
      await expect(asApp(`update public.payment_exceptions set refund_state = 'confirmed', refund_external_reference = 'FORGED', refund_amount = 1, refund_currency = 'XOF', refund_confirmed_at = now(), refund_recorded_by = gen_random_uuid(), refund_recorded_at = now(), state = 'resolved', resolution = 'refund_confirmed', resolved_at = now() where id = $1`, [e.id])).rejects.toThrow(denied)
      await expect(asApp(`update public.payment_exceptions set alert_sent_at = now() where id = $1`, [e.id])).rejects.toThrow(denied)
      await expect(asApp(`insert into public.payment_exceptions (payment_id, state, first_signal, last_signal, payment_received) values ($1, 'open', 'paid_hint', 'paid_hint', 'reported')`, [id])).rejects.toThrow(denied)
      // And the helpers cannot be reached to forge an audit row or a refusal.
      await expect(asApp(`select public.payment_exception_refuse('x')`)).rejects.toThrow(denied)
      await expect(asApp(`select public.payment_exception_audit('x', 'system', null, null, null, null, null, null, null, '{}'::jsonb)`)).rejects.toThrow(denied)
      expect(await exceptionFor(token)).toMatchObject({ refund_state: 'not_assessed', state: 'open' })
    })

    it('only the functions that must write are DEFINER, and all have a pinned search_path', async () => {
      const rows = await asSuper(`select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as cfg from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'payment_exception%'`)
      expect(rows).toHaveLength(10)
      expect(rows.filter(r => r.prosecdef).map(r => r.proname).sort()).toEqual([
        'payment_exception_decide', 'payment_exception_escalate_watching', 'payment_exception_mark_alerted',
        'payment_exception_record_refund', 'payment_exception_report', 'payment_exceptions_follow_payment',
      ])
      // No schema anyone can write to is ever searched.
      for (const r of rows) expect(r.cfg, r.proname).toBe('search_path=pg_catalog, pg_temp')
    })

    it('the guard binds even the table owner, for a hand-written UPDATE', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      const attempt = (sql: string) => asSuper(sql, [e.id])
      await expect(attempt(`update public.payment_exceptions set payment_id = gen_random_uuid() where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('exception_identity_immutable') })
      await expect(attempt(`update public.payment_exceptions set first_signal = 'provider_paid' where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('exception_identity_immutable') })
      await expect(attempt(`update public.payment_exceptions set refund_state = 'confirmed', refund_external_reference = 'X', refund_amount = 1, refund_currency = 'XOF', refund_confirmed_at = now(), refund_recorded_by = gen_random_uuid(), refund_recorded_at = now() where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('illegal_refund_transition') })
      // An obligation to refund money nobody has confirmed arrived.
      await expect(attempt(`update public.payment_exceptions set refund_state = 'required' where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('receipt_not_confirmed') })
      await expect(attempt(`delete from public.payment_exceptions where id = $1`))
        .rejects.toMatchObject({ detail: expect.stringContaining('exception_delete_refused') })
      // A resolution that claims a refund, with no refund on record.
      await expect(attempt(`update public.payment_exceptions set state = 'resolved', resolution = 'refund_confirmed', resolved_at = now() where id = $1`))
        .rejects.toMatchObject({ code: '23514' })
    })

    it('a new record must start clean, so a refund or a grant cannot be forged by INSERT', async () => {
      const { id } = await closedAttempt('expired')
      const insert = (cols: string, vals: string) => asSuper(
        `insert into public.payment_exceptions (payment_id, state, first_signal, last_signal, payment_received${cols}) values ($1, 'open', 'paid_hint', 'paid_hint', 'reported'${vals})`, [id])
      await expect(insert(`, refund_state, refund_external_reference, refund_amount, refund_currency, refund_confirmed_at, refund_recorded_by, refund_recorded_at`,
        `, 'confirmed', 'FORGED', 1, 'XOF', now(), gen_random_uuid(), now()`))
        .rejects.toMatchObject({ detail: expect.stringContaining('exception_must_start_clean') })
      await expect(insert(`, access_state, access_entitlement_id`, `, 'granted', gen_random_uuid()`))
        .rejects.toMatchObject({ detail: expect.stringContaining('exception_must_start_clean') })
    })

    it('evidence that money moved cannot be taken back, and a settled refund is final', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e.payment_received).toBe('confirmed_by_provider')
      await expect(asSuper(`update public.payment_exceptions set payment_received = 'not_received' where id = $1`, [e.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_evidence_downgrade') })

      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', refundFields(e.id))
      await expect(asSuper(`update public.payment_exceptions set refund_amount = 1 where id = $1`, [e.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('refund_facts_final') })
      await expect(asSuper(`update public.payment_exceptions set resolved_by = gen_random_uuid() where id = $1`, [e.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('illegal_exception_transition') })
      await expect(asSuper(`update public.payment_exceptions set resolved_at = now() - interval '1 year' where id = $1`, [e.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('illegal_exception_transition') })
      await expect(asSuper(`update public.payment_exceptions set state = 'open', resolution = null, resolved_at = null where id = $1`, [e.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('illegal_exception_transition') })
    })

    it('a signal outside the vocabulary, or free text as detail, is refused', async () => {
      const { id } = await closedAttempt('expired')
      const report = (signal: string, detail: string | null) => asRole('service_role', null,
        `select public.payment_exception_report($1, $2, 'ipn', $3)`, [id, signal, detail])
      await expect(report('paid', null)).rejects.toMatchObject({ detail: expect.stringContaining('invalid_signal') })
      await expect(report('paid_hint', 'Free text from a payload')).rejects.toMatchObject({ detail: expect.stringContaining('invalid_detail') })
      await expect(asRole('service_role', null, `select public.payment_exception_report(gen_random_uuid(), 'paid_hint', 'ipn')`))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_not_found') })
    })

    it.each(['open', 'watching'])('its ROLLBACK refuses while an exception is %s, because money may be owed', async (state) => {
      H.contract = null
      const token = state === 'open' ? (await closedAttempt('expired')).token : await startAndToken(user(L1))
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe(state)
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/settle them first/)
      await db.exec('rollback').catch(() => undefined)
      expect((await exceptionFor(token)).state).toBe(state)
    })

    it('its ROLLBACK refuses while a paid report after settlement is unreviewed', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', refundFields(e.id))
      await ipn(token, { client_phone: '771111111' })
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/settle them first/)
      await db.exec('rollback').catch(() => undefined)
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })

    it('its ROLLBACK runs once everything is settled, changes no payment, and 064 re-applies; without 063 it refuses', async () => {
      H.contract = null
      const { token: settled } = await closedAttempt('expired', user(L2), C2)
      await ipn(settled)
      await exAction('dismissException', { exceptionId: (await exceptionFor(settled)).id, note: NOTE, attest: 'yes', attestAll: 'yes' })
      expect((await exceptionFor(settled)).state).toBe('resolved')
      H.contract = FIXTURE_CONTRACT

      const token = await startAndToken(user(L1))
      const before = await counts()
      // XP-LAUNCH-FINAL-08: 065 replaced three of 064's functions; it is rolled back first.
      await db.exec(ROLLBACK_065)
      await db.exec(ROLLBACK_064)
      expect(await asSuper(`select to_regclass('public.payment_exceptions') as t`)).toEqual([{ t: null }])
      expect(await asSuper(`select count(*)::int as n from pg_trigger where tgname = 'payment_exceptions_follow_payment'`)).toEqual([{ n: 0 }])
      expect(await asSuper(`select count(*)::int as n from pg_proc where proname like 'payment_exception%'`)).toEqual([{ n: 0 }])
      expect(await counts()).toEqual(before)
      expect((await rowFor(token)).status).toBe('processing')

      await db.exec(ROLLBACK_063)
      await expect(db.exec(M064)).rejects.toThrow(/063 is not in effect/)
      await db.exec('rollback').catch(() => undefined)
      await db.exec(M063)
      await db.exec(M064)
      await seedCatalogueCodes()
      await db.exec(M065)
      await setEnvironment('sandbox')
      expect(await asSuper(`select count(*)::int as n from public.payment_exceptions`)).toEqual([{ n: 0 }])
    })
  })

  describe('XP-PAYTECH-05 — a late paid report is kept and grants nothing', () => {
    it.each(['cancelled', 'failed', 'expired'] as const)('on a %s payment', async (status) => {
      H.contract = null
      const { token } = await closedAttempt(status)
      const before = await counts()

      const res = await ipn(token)

      // Acknowledged, because the report is safely recorded.
      expect(res.status).toBe(200)
      expect(res.body.detail).toBe('already_terminal')
      expect(await exceptionFor(token)).toMatchObject({
        state: 'open', first_signal: 'paid_hint', last_signal: 'paid_hint',
        payment_received: 'reported', access_state: 'not_granted', refund_state: 'not_assessed', report_count: 1,
      })
      // The payment is exactly as it was, and no money or access moved.
      const r = await rowFor(token)
      expect(r.status).toBe(status)
      expect(r.completed_at).toBeNull()
      expect(r.entitlement_id).toBeNull()
      expect(await counts()).toEqual(before)
      expect(await dbHasAccess(L1, C1)).toBe(false)
      // A notification alone never prompts a status request while the contract is null.
      expect(P.statusCalls).toEqual([])
    })

    it('on a refunded payment too: it could be a second charge', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await asRole('service_role', null, `update public.payments set status = 'refunded' where provider_token = $1`, [token])
      H.contract = null
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect((await rowFor(token)).status).toBe('refunded')
    })

    it('the provider confirming payment raises the evidence, and still grants nothing', async () => {
      const { token } = await closedAttempt('cancelled')
      says(token, 'completed')
      const before = await counts()
      expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_paid', payment_received: 'confirmed_by_provider' })
      expect(P.statusCalls).toEqual([token])
      expect(await counts()).toEqual(before)
      expect((await rowFor(token)).status).toBe('cancelled')
    })

    it('the provider confirming a DIFFERENT amount is kept with the reason', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 1)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ last_signal: 'completion_refused', detail: 'settlement_amount_mismatch', payment_received: 'confirmed_by_provider' })
    })

    it.each([
      ['pending', 'provider_says_pending'],
      ['failed', 'provider_says_failed'],
      ['canceled', 'provider_says_cancelled'],
    ])('a paid notification the provider contradicts with "%s" stays visible as a conflict', async (word, detail) => {
      const { token } = await closedAttempt('expired')
      says(token, word)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', detail, payment_received: 'reported' })
    })

    it('a cancellation on a closed payment is not an exception', async () => {
      const { token } = await closedAttempt('expired')
      expect((await ipn(token, { type_event: 'sale_canceled' })).status).toBe(200)
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a repeated paid notification on a completed payment changes nothing about it, and is counted', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await ipn(token)).body.detail).toBe('already_completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally', repeat_count: 1 })
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a notification without our credentials writes nothing', async () => {
      const { token } = await closedAttempt('expired')
      expect((await ipn(token, { api_key_sha256: 'x' })).status).toBe(401)
      expect(await exceptionFor(token)).toBeNull()
    })

    it.each([
      ['a bad signature', {}, { secret: 'sk_wrong' }, 'ipn_signature_mismatch'],
      ['no signature', { hmac_compute: undefined }, {}, 'ipn_signature_absent'],
      ['a promotion', { promo_enabled: '1' }, {}, 'ipn_promo_applied'],
      ['an unknown event', { type_event: 'refund_complete' }, {}, 'ipn_unknown_event'],
    ])('our credentials with %s on a closed payment is kept as unproven, and grants nothing', async (_label, over, opts, detail) => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      const before = await counts()
      const res = await ipn(token, over, opts)
      expect(res.status).toBe(200)
      expect(res.body.detail).toBe('unverified')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'unverified_report', detail, payment_received: 'not_established' })
      expect((await rowFor(token)).status).toBe('expired')
      expect(await counts()).toEqual(before)
      expect(P.statusCalls).toEqual([])
    })

    it('an unproven report on an in-flight payment watches, and a close opens it', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      expect((await ipn(token, {}, { secret: 'sk_wrong' })).body.detail).toBe('unverified')
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', payment_received: 'not_established' })
      const notice = await adminAction('closeUnpaidPaytechPayment', { paymentId: (await rowFor(token)).id, reason: 'Vérifié dans le tableau de bord.', attest: 'yes' })
      expect(notice).toBe('close_done_exception')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('an unproven report that cannot be recorded is NOT acknowledged', async () => {
      const { token } = await closedAttempt('expired')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      expect((await ipn(token, {}, { secret: 'sk_wrong' })).status).toBe(503)
    })

    it('on a completed payment a bad signature is kept without touching it', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, {}, { secret: 'sk_wrong' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', different_signal: 'unverified_report' })
      expect(e.different_report_at).not.toBeNull()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('on a completed payment a signed unknown event is kept, and cannot open it: its type is not signed', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { type_event: 'refund_complete' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'unverified_report', detail: 'ipn_unknown_event', payment_received: 'confirmed_by_provider' })
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a claimed amount or currency that disagrees is kept, and the in-flight payment is not moved', async () => {
      const a = await startAndToken(user(L1))
      expect((await ipn(a, { final_item_price: '1' })).body.detail).toBe('amount_mismatch')
      expect(await exceptionFor(a)).toMatchObject({ state: 'open', last_signal: 'amount_mismatch', detail: 'ipn_amount_mismatch', payment_received: 'reported' })
      expect((await rowFor(a)).status).toBe('processing')

      const b = await startAndToken(user(L2))
      expect((await ipn(b, { currency: 'EUR' })).body.detail).toBe('currency_mismatch')
      expect(await exceptionFor(b)).toMatchObject({ state: 'open', last_signal: 'currency_mismatch', detail: 'ipn_currency_mismatch' })
    })
  })

  describe('XP-PAYTECH-05 — conflicts on a completed payment', () => {
    async function completed() {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      return token
    }

    it('a cancellation is kept and revokes nothing', async () => {
      const token = await completed()
      H.contract = null
      expect((await ipn(token, { type_event: 'sale_canceled' })).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'cancel_hint', payment_received: 'confirmed_by_provider' })
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('the provider still saying paid answers the cancellation: nothing is opened', async () => {
      const token = await completed()
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toBeNull()
    })

    it('the provider saying not paid is a conflict for a human, and reverses nothing', async () => {
      const token = await completed()
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid' })
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a paid notification that resolved normally can still be questioned later', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid', resolution: null })
    })
  })

  describe('XP-PAYTECH-05 — duplicate notifications are idempotent', () => {
    it('five in a row: one record, five counted, one audit row, one alert', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      for (let i = 0; i < 5; i++) expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ report_count: 5, state: 'open' })
      expect(await asSuper(`select count(*)::int as n from public.payment_exceptions`)).toEqual([{ n: 1 }])
      expect((await exceptionAudit()).map(a => a.event_type)).toEqual(['payment.exception_recorded'])
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('five at once: still one record, every report counted', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      const results = await Promise.all(Array.from({ length: 5 }, () => ipn(token)))
      expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
      expect(await exceptionFor(token)).toMatchObject({ report_count: 5, state: 'open' })
      expect((await exceptionAudit()).map(a => a.event_type)).toEqual(['payment.exception_recorded'])
    })

    it('new evidence is the only thing that writes another audit row', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      await ipn(token)
      expect((await exceptionAudit()).map(a => a.event_type))
        .toEqual(['payment.exception_recorded', 'payment.exception_evidence_raised'])
      expect(await exceptionFor(token)).toMatchObject({ report_count: 4, payment_received: 'confirmed_by_provider' })
    })

    it('replays never multiply alerts, even while a recipient keeps failing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      for (let i = 0; i < 6; i++) await ipn(token)
      expect(H.emails).toHaveLength(OWNERS.length)   // Only the first report sent. The sweep retries.
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()
    })

    it('twelve replays at once send one round of alerts', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await Promise.all(Array.from({ length: 12 }, () => ipn(token)))
      expect(H.emails.map(m => m.to).sort()).toEqual([...OWNERS].sort())
    })

    it('an unproven report never displaces what is already known', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 1)
      await ipn(token)
      expect((await exceptionFor(token)).detail).toBe('settlement_amount_mismatch')
      await ipn(token, {}, { secret: 'sk_wrong' })
      expect(await exceptionFor(token)).toMatchObject({
        last_signal: 'completion_refused', detail: 'settlement_amount_mismatch', payment_received: 'confirmed_by_provider', report_count: 2,
      })
    })

    it('a report that could not be recorded is NOT acknowledged, and the retry records it', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      const refused = await ipn(token)
      expect(refused.status).toBe(503)
      expect(refused.body.detail).toBe('exception_unrecorded')
      expect(await exceptionFor(token)).toBeNull()

      H.rpcFaultFor = null
      expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', report_count: 1 })
    })

    it('a mismatch that could not be recorded is NOT acknowledged either', async () => {
      const token = await startAndToken(user(L1))
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      expect((await ipn(token, { currency: 'EUR' })).status).toBe(503)
    })
  })

  describe('XP-PAYTECH-05 — races and manual resolution', () => {
    const closeFields = (id: string) => ({ paymentId: id, reason: 'Vérifié dans le tableau de bord PayTech.', attest: 'yes' })

    it('paid notification THEN manual close: the signal survives and an exception opens', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      expect((await ipn(token)).status).toBe(503)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', payment_received: 'reported' })
      expect(H.emails).toEqual([])   // In flight, it may yet settle: no alert.

      const notice = await adminAction('closeUnpaidPaytechPayment', closeFields((await rowFor(token)).id))

      expect(notice).toBe('close_done_exception')
      expect((await rowFor(token)).status).toBe('expired')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported', report_count: 1 })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('manual close THEN paid notification: the same exception', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      expect(await adminAction('closeUnpaidPaytechPayment', closeFields((await rowFor(token)).id))).toBe('close_done')
      expect(await exceptionFor(token)).toBeNull()
      expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
    })

    it('paid notification AND manual close at once: one open exception, whichever wins', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      const id = (await rowFor(token)).id
      await Promise.all([ipn(token), adminAction('closeUnpaidPaytechPayment', closeFields(id))])
      expect((await rowFor(token)).status).toBe('expired')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect(await asSuper(`select count(*)::int as n from public.payment_exceptions`)).toEqual([{ n: 1 }])
    })

    it('paid notification THEN normal completion: resolved with no alert and no second grant', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      expect((await ipn(token)).body.detail).toBe('unsettled:pending')
      expect((await exceptionFor(token)).state).toBe('watching')

      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('completed')

      expect(await exceptionFor(token)).toMatchObject({
        state: 'resolved', resolution: 'settled_normally', payment_received: 'confirmed_by_provider', refund_state: 'not_required',
      })
      expect(H.emails).toEqual([])
      expect(await counts()).toMatchObject({ completed: 1, entitlements: 1, enrollments: 1, audits: 1 })
      expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_settled')
    })

    it('provider says paid while the row closes under it: 062 refuses and the money is not lost', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      P.duringStatus = async () => {
        await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_meanwhile' where provider_token = $1`, [token])
      }
      const res = await ipn(token)
      expect(res.status).toBe(200)
      expect(res.body.detail).toBe('refused:status_not_completable')
      expect(await exceptionFor(token)).toMatchObject({
        state: 'open', last_signal: 'completion_refused', detail: 'status_not_completable', payment_received: 'confirmed_by_provider',
      })
      expect((await rowFor(token)).status).toBe('expired')
      expect(await dbHasAccess(L1, C1)).toBe(false)
    })

    it('provider failure closing a row with an earlier paid notification opens the conflict', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'canceled')
      await age(token, 20)
      await sweep()
      expect((await rowFor(token)).status).toBe('cancelled')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', first_signal: 'paid_hint' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('paid but 062 refuses for a revoked learner: kept, not closable, and nothing granted', async () => {
      const token = await startAndToken(user(L1))
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason)
        values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('refused:entitlement_revoked_requires_decision')
      expect(await exceptionFor(token)).toMatchObject({
        state: 'open', last_signal: 'completion_refused', detail: 'entitlement_revoked_requires_decision', payment_received: 'confirmed_by_provider',
      })
      const r = await rowFor(token)
      expect(r.status).toBe('processing')
      expect(await adminAction('closeUnpaidPaytechPayment', closeFields(r.id))).toBe('close_refused_provider_says_paid')
      expect((await rowFor(token)).status).toBe('processing')
      expect(await dbHasAccess(L1, C1)).toBe(false)
    })

    it('a manual close never proceeds if the report behind a refusal could not be kept', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed', 1)
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      expect(await adminAction('closeUnpaidPaytechPayment', closeFields((await rowFor(token)).id))).toBe('close_refused_report_unrecorded')
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('a mismatch cleared on an in-flight payment cannot hide a later paid report', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      const e = await exceptionFor(token)
      await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes', attestAll: 'yes' })
      expect((await exceptionFor(token)).state).toBe('resolved')

      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', resolution: null, payment_received: 'reported' })

      expect(await adminAction('closeUnpaidPaytechPayment', closeFields((await rowFor(token)).id))).toBe('close_done_exception')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('a paid notification is kept when the provider says failed and something else closed the row first', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      P.duringStatus = async () => {
        await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_meanwhile' where provider_token = $1`, [token])
      }
      const res = await ipn(token)
      expect(res.status).toBe(200)
      expect(res.body.detail).toBe('already_terminal')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', payment_received: 'reported' })
    })

    it('a failed closure write is not mistaken for someone else closing it', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      await asSuper(`create trigger harness_fault_payments before update of status on public.payments for each row
        when (new.status = 'failed') execute function public.harness_fail()`)
      try {
        const res = await ipn(token)
        expect(res.status).toBe(503)
        expect((await rowFor(token)).status).toBe('processing')
        expect(await exceptionFor(token)).toMatchObject({ state: 'watching' })
      } finally {
        await asSuper(`drop trigger harness_fault_payments on public.payments`)
      }
    })

    it('a report and a refund at once leave one consistent outcome (statement interleaving only)', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await Promise.all([ipn(token), exAction('recordExceptionRefund', refundFields(e.id))])
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'refund_confirmed', refund_state: 'confirmed' })
    })
  })

  describe('XP-PAYTECH-05 — checkout must not take the money twice', () => {
    async function openException(u = user(L1), courseId = C1) {
      H.contract = null
      const { token } = await closedAttempt('expired', u, courseId)
      await ipn(token)
      H.contract = FIXTURE_CONTRACT
      return { token, exception: await exceptionFor(token), reference: (await rowFor(token)).reference as string }
    }

    it('refuses a new attempt while an exception is open, naming the reference', async () => {
      const { reference } = await openException()
      const opened = P.requests.length
      const before = await counts()
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.error).toMatch(/Aucun nouveau paiement/)
      expect(r.reference).toBe(reference)
      expect(P.requests).toHaveLength(opened)
      expect(await counts()).toEqual(before)
    })

    it('leaves another course and another learner alone', async () => {
      await openException()
      expect((await checkout(user(L1), C2)).redirectUrl).toBeDefined()
      expect((await checkout(user(L2), C1)).redirectUrl).toBeDefined()
    })

    it('a report landing while the provider is being called stops the attempt before any URL is handed out', async () => {
      H.contract = null
      const { token: earlier } = await closedAttempt('expired')
      P.during = async () => { await ipn(earlier) }
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.error).toMatch(/Aucun nouveau paiement/)
      expect(r.reference).toBe((await rowFor(earlier)).reference)
      const [latest] = await asSuper(`select status, failure_reason, provider_token from public.payments where user_id = $1 order by created_at desc limit 1`, [L1])
      expect(latest).toEqual({ status: 'expired', failure_reason: 'superseded_by_exception', provider_token: null })
    })

    it('also stops it if the check after the provider call cannot be read', async () => {
      P.during = async () => {
        H.rpcFaultFor = { fn: 'payment_exception_blocking_reference', error: { message: 'storage down', details: null } }
      }
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.error).toBeDefined()
      const [latest] = await asSuper(`select status, provider_token from public.payments where user_id = $1`, [L1])
      expect(latest).toEqual({ status: 'expired', provider_token: null })
    })

    it('fails closed if it cannot tell', async () => {
      const opened = P.requests.length
      H.rpcFaultFor = { fn: 'payment_exception_blocking_reference', error: { message: 'storage down', details: null } }
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.error).toBeDefined()
      expect(P.requests).toHaveLength(opened)
    })

    it('does not re-offer another open checkout while the exception is open', async () => {
      const first = await startAndToken(user(L1))
      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'test' where provider_token = $1`, [first])
      const second = await startAndToken(user(L1))
      expect(second).not.toBe(first)
      H.contract = null
      await ipn(first)
      H.contract = FIXTURE_CONTRACT
      says(second, 'pending')
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.reference).toBe((await rowFor(first)).reference)
    })

    it('opens again once an operator finds nothing to return', async () => {
      const { exception } = await openException()
      expect(await exAction('dismissException', { exceptionId: exception.id, note: NOTE, attest: 'yes', attestAll: 'yes' })).toBe('exception_dismiss_done')
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('opens again once a refund is confirmed, and not while it is only required', async () => {
      const { exception } = await openException()
      await exAction('confirmExceptionReceipt', { exceptionId: exception.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: exception.id, note: NOTE })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      await exAction('recordExceptionRefund', refundFields(exception.id))
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('a double payment is flagged for the operator: one attempt completed, the other late', async () => {
      const first = await startAndToken(user(L1))
      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'test' where provider_token = $1`, [first])
      const second = await startAndToken(user(L1))
      says(second, 'completed')
      await ipn(second)
      says(first, 'completed')
      await ipn(first)

      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      const [e] = (await listPaymentExceptions())!
      expect(e).toMatchObject({
        paymentReceived: 'confirmed_by_provider', accessLive: true,
        otherCompletedReference: (await rowFor(second)).reference,
        payment: { reference: (await rowFor(first)).reference, status: 'expired', amount: PRICE_C1 },
        courseTitle: 'Fondamentaux',
        learner: { email: 'l1@example.test' },
      })
      expect(await counts()).toMatchObject({ completed: 1, entitlements: 1 })
    })

    it('regression: a paid notification on an attempt in flight changes nothing for checkout', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.reference).toBe((await rowFor(token)).reference)
      expect(P.requests).toHaveLength(1)
    })
  })

  describe('XP-PAYTECH-05 — the operator workflow', () => {
    async function reported(status: 'cancelled' | 'failed' | 'expired' = 'expired') {
      H.contract = null
      const { token, id } = await closedAttempt(status)
      await ipn(token)
      return { token, id, exception: await exceptionFor(token) }
    }
    const decisions = (e: { id: string }) => ({ exceptionId: e.id, note: NOTE, attestAll: 'yes' })

    it('received, refund required, refund confirmed: four separate facts and no invalid transition', async () => {
      const { token, exception: e } = await reported()
      const before = await counts()
      const beforeRow = await rowFor(token)
      const outbound = vi.mocked(fetch).mock.calls.length

      expect(await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })).toBe('exception_confirm_received_done')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_operator', refund_state: 'not_assessed', access_state: 'not_granted' })

      expect(await exAction('requireExceptionRefund', decisions(e))).toBe('exception_require_refund_done')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_operator', refund_state: 'required' })

      expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refund_recorded')
      expect(await exceptionFor(token)).toMatchObject({
        state: 'resolved', resolution: 'refund_confirmed', refund_state: 'confirmed', access_state: 'not_granted',
        refund_external_reference: 'PT-REFUND-0001', refund_amount: PRICE_C1, refund_currency: 'XOF',
        refund_recorded_by: ADM, resolved_by: ADM,
      })

      // The payment never moved: 063's closure is final, and no 'refunded' was forced.
      const r = await rowFor(token)
      expect(r.status).toBe('expired')
      expect(r.failure_reason).toBe(beforeRow.failure_reason)
      expect(await counts()).toEqual(before)
      expect(await dbHasAccess(L1, C1)).toBe(false)
      // Nothing was sent to anyone: this RECORDS a refund, it does not make one.
      expect(vi.mocked(fetch).mock.calls.length).toBe(outbound)
    })

    it('every step is audited with who, why and what, and the record links the payment', async () => {
      const { id, exception: e } = await reported()
      await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
      await exAction('requireExceptionRefund', decisions(e))
      await exAction('recordExceptionRefund', refundFields(e.id))

      const audit = await exceptionAudit()
      expect(audit.map(a => a.event_type)).toEqual([
        'payment.exception_recorded', 'payment.exception_receipt_confirmed',
        'payment.exception_refund_required', 'payment.exception_refund_confirmed',
      ])
      expect(audit[0]).toMatchObject({ actor_type: 'system', actor_id: null, outcome: 'success', subject_user_id: L1 })
      for (const a of audit.slice(1)) {
        expect(a).toMatchObject({ actor_type: 'admin', actor_id: ADM, actor_email: 'owner@example.test', outcome: 'success', reason: NOTE, subject_user_id: L1 })
      }
      for (const a of audit) expect(a.metadata).toMatchObject({ paymentId: id, exceptionId: e.id })
      expect(audit[3].metadata).toMatchObject({ refundReference: 'PT-REFUND-0001', refundAmount: PRICE_C1, paymentStatusAfter: 'expired' })
    })

    it('the order is enforced: nothing can be skipped', async () => {
      const { exception: e } = await reported()
      expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refused_refund_not_required')
      expect(await exAction('requireExceptionRefund', decisions(e))).toBe('exception_refused_receipt_not_confirmed')
      expect(await exAction('recordExceptionAccess', decisions(e))).toBe('exception_refused_receipt_not_confirmed')
      await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
      expect(await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })).toBe('exception_refused_receipt_already_confirmed')
      expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_refused_payment_confirmed_cannot_dismiss')
      await exAction('requireExceptionRefund', decisions(e))
      expect(await exAction('requireExceptionRefund', decisions(e))).toBe('exception_refused_refund_already_decided')
      expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_refused_refund_already_decided')
      expect(await exAction('recordExceptionAccess', decisions(e))).toBe('exception_refused_refund_already_decided')
    })

    describe('correcting a mistake', () => {
      it('a mistaken refund decision can be withdrawn, so it cannot block the learner for good', async () => {
        const { token, exception: e } = await reported()
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        await exAction('requireExceptionRefund', decisions(e))
        expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()

        expect(await exAction('withdrawExceptionRefund', decisions(e))).toBe('exception_withdraw_refund_done')
        expect((await exceptionFor(token)).refund_state).toBe('not_assessed')

        expect(await exAction('withdrawExceptionReceipt', decisions(e))).toBe('exception_withdraw_receipt_done')
        expect((await exceptionFor(token)).payment_received).toBe('reported')

        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_dismiss_done')
        expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
        const events = (await exceptionAudit()).map(a => a.event_type)
        expect(events).toContain('payment.exception_refund_withdrawn')
        expect(events).toContain('payment.exception_receipt_withdrawn')
      })

      it('a confirmation with a refund decision resting on it cannot be withdrawn', async () => {
        const { exception: e } = await reported()
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        await exAction('requireExceptionRefund', decisions(e))
        expect(await exAction('withdrawExceptionReceipt', decisions(e))).toBe('exception_refused_refund_already_decided')
      })

      it('what PayTech confirmed cannot be withdrawn, and neither can a recorded refund', async () => {
        const { token } = await closedAttempt('expired')
        says(token, 'completed')
        await ipn(token)
        const e = await exceptionFor(token)
        expect(await exAction('withdrawExceptionReceipt', decisions(e))).toBe('exception_refused_receipt_not_operator_confirmed')
        await exAction('requireExceptionRefund', decisions(e))
        await exAction('recordExceptionRefund', refundFields(e.id))
        expect(await exAction('withdrawExceptionRefund', decisions(e))).toBe('exception_refused_exception_not_open')
        expect((await exceptionFor(token)).refund_state).toBe('confirmed')
      })

      it('withdrawing restores the evidence that was there, not a guess at it', async () => {
        H.contract = null
        const { token } = await closedAttempt('expired')
        await ipn(token, {}, { secret: 'sk_wrong' })
        await ipn(token)
        const e = await exceptionFor(token)
        expect(e).toMatchObject({ first_signal: 'unverified_report', payment_received: 'reported' })
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        await exAction('withdrawExceptionReceipt', decisions(e))
        expect((await exceptionFor(token)).payment_received).toBe('reported')
      })

      it('a notification during a confirmation survives the withdrawal', async () => {
        const { token } = await closedAttempt('expired')
        says(token, 'pending')
        await sweep()
        const e = await exceptionFor(token)
        expect(e.payment_received).toBe('not_established')
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        H.contract = null
        await ipn(token)
        expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_operator')
        await exAction('withdrawExceptionReceipt', decisions(e))
        expect((await exceptionFor(token)).payment_received).toBe('reported')
      })

      it('a report with no notification behind it returns to "not established"', async () => {
        const { token } = await closedAttempt('expired')
        says(token, 'pending')
        await sweep()
        const e = await exceptionFor(token)
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        await exAction('withdrawExceptionReceipt', decisions(e))
        expect((await exceptionFor(token)).payment_received).toBe('not_established')
      })
    })

    it('a refused decision is audited as a failure', async () => {
      const { exception: e } = await reported()
      await exAction('requireExceptionRefund', decisions(e))
      const refused = (await exceptionAudit()).filter(a => a.event_type === 'payment.exception_decision_refused')
      expect(refused).toMatchObject([{ actor_id: ADM, outcome: 'failure', reason: NOTE, metadata: { exceptionId: e.id, refusal: 'receipt_not_confirmed' } }])
    })

    it('missing proof of intent never reaches the database', async () => {
      const { exception: e } = await reported()
      expect(await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: 'short', attest: 'yes' })).toBe('close_reason_required')
      expect(await exAction('confirmExceptionReceipt', decisions(e))).toBe('close_attestation_required')
      expect(await exAction('dismissException', decisions(e))).toBe('close_attestation_required')
      expect(await exAction('confirmExceptionReceipt', { exceptionId: 'not-a-uuid', note: NOTE, attest: 'yes' })).toBe('invalid')
      expect((await exceptionFor2(e.id)).payment_received).toBe('reported')
      expect((await exceptionAudit()).map(a => a.event_type)).toEqual(['payment.exception_recorded'])
    })

    describe('recording a refund', () => {
      async function ready() {
        const { token, exception: e } = await reported()
        await exAction('confirmExceptionReceipt', { ...decisions(e), attest: 'yes' })
        await exAction('requireExceptionRefund', decisions(e))
        return { token, e }
      }

      it.each([
        ['more than was paid', { amount: String(PRICE_C1 + 1) }, 'exception_refused_refund_amount_invalid'],
        ['a partial refund, until a policy exists', { amount: '40000' }, 'exception_refused_refund_partial_not_supported'],
        ['a date that does not exist', { refundedOn: '2026-02-31' }, 'exception_refund_invalid'],
        ['a date that is not one', { refundedOn: '2026-13-45' }, 'exception_refund_invalid'],
        ['no amount', { amount: '0' }, 'exception_refund_invalid'],
        ['another currency', { currency: 'EUR' }, 'exception_refund_invalid'],
        ['a malformed reference', { externalReference: '<script>' }, 'exception_refund_invalid'],
        ['a date before the payment', { refundedOn: '2020-01-01' }, 'exception_refused_refund_date_invalid'],
        ['no attestation', { attest: 'no' }, 'close_attestation_required'],
      ])('refuses %s', async (_label, over, notice) => {
        const { token, e } = await ready()
        expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...over })).toBe(notice)
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', refund_state: 'required', refund_external_reference: null })
      })

      it('the database refuses a currency or a future date on its own', async () => {
        const { e } = await ready()
        const call = (currency: string, when: string) => asRole('service_role', null,
          `select public.payment_exception_record_refund($1, $2, null, 'REF-DIRECT-1', 45000, $3, $4::timestamptz, 'a long enough note', null, null,
             (select evidence_version from public.payment_exceptions where id = $1))`,
          [e.id, ADM, currency, when])
        await expect(call('EUR', new Date().toISOString())).rejects.toMatchObject({ detail: expect.stringContaining('refund_currency_mismatch') })
        await expect(call('XOF', new Date(Date.now() + 86_400_000).toISOString())).rejects.toMatchObject({ detail: expect.stringContaining('refund_date_invalid') })
      })

      it('recording the same refund twice changes nothing; a different one is refused', async () => {
        const { token, e } = await ready()
        await exAction('recordExceptionRefund', refundFields(e.id))
        const once = await exceptionFor(token)
        expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refund_already_recorded')
        expect(await exceptionFor(token)).toEqual(once)
        expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), externalReference: 'PT-REFUND-0002' })).toBe('exception_refused_refund_already_recorded')
        expect((await exceptionAudit()).filter(a => a.event_type === 'payment.exception_refund_confirmed')).toHaveLength(1)
      })

      it('one external refund cannot settle two exceptions', async () => {
        const { e } = await ready()
        await exAction('recordExceptionRefund', refundFields(e.id))
        H.contract = null
        const { token: other } = await closedAttempt('expired', user(L2), C2)
        await ipn(other)
        const o = await exceptionFor(other)
        await exAction('confirmExceptionReceipt', { ...decisions(o), attest: 'yes' })
        await exAction('requireExceptionRefund', decisions(o))
        expect(await exAction('recordExceptionRefund', { ...refundFields(o.id), amount: '30000' })).toBe('exception_refused_refund_reference_reused')
        expect((await exceptionFor(other)).refund_state).toBe('required')
      })

      it('an IN-FLIGHT payment may close to failed, the one move 063 allows it', async () => {
        const token = await startAndToken(user(L1))
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason) values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
        says(token, 'completed')
        await ipn(token)
        const e = await exceptionFor(token)
        await exAction('requireExceptionRefund', decisions(e))
        expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refund_recorded')
        expect(await rowFor(token)).toMatchObject({ status: 'failed', failure_reason: 'exception_refund_confirmed', completed_at: null })
      })

      it('a COMPLETED payment moves to refunded, and access is left for a human', async () => {
        const token = await startAndToken(user(L1))
        says(token, 'completed')
        await ipn(token)
        says(token, 'failed')
        await ipn(token, { type_event: 'sale_canceled' })
        const e = await exceptionFor(token)
        await exAction('requireExceptionRefund', decisions(e))
        expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refund_recorded_access_live')
        expect((await rowFor(token)).status).toBe('refunded')
        expect(await dbHasAccess(L1, C1)).toBe(true)
        expect((await exceptionAudit()).at(-1)!.metadata).toMatchObject({ accessStillLive: true, paymentStatusBefore: 'completed', paymentStatusAfter: 'refunded' })
      })

      it.each([
        ['a future date', { refundedOn: '2099-12-31' }, 'exception_refund_invalid'],
      ])('refuses %s, rather than quietly recording today', async (_label, over, notice) => {
        const { token, e } = await ready()
        expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...over })).toBe(notice)
        expect((await exceptionFor(token)).refund_confirmed_at).toBeNull()
      })
    })

    describe('nothing to return', () => {
      it('records that no funds arrived, and a different notification reopens it', async () => {
        const { token, exception: e } = await reported()
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_dismiss_done')
        expect(await exceptionFor(token)).toMatchObject({
          state: 'resolved', resolution: 'nothing_to_return', payment_received: 'not_received', refund_state: 'not_required', resolved_by: ADM,
        })
        const emails = H.emails.length

        await ipn(token, { client_phone: '771111111' })

        expect(await exceptionFor(token)).toMatchObject({
          state: 'open', resolution: null, resolved_at: null, resolved_by: null,
          payment_received: 'reported', refund_state: 'not_assessed', report_count: 2,
        })
        expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_reopened')
        expect(H.emails.length).toBeGreaterThan(emails)
      })

      it('a provider confirmation overrides an operator who found nothing', async () => {
        const { token, exception: e } = await reported()
        await exAction('dismissException', { ...decisions(e), attest: 'yes' })
        H.contract = FIXTURE_CONTRACT
        says(token, 'completed')
        await ipn(token)
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider', resolution: null })
      })

      it('a notification\'s claim on a settled payment is counted and alerted on, and reopens nothing', async () => {
        const token = await startAndToken(user(L1))
        says(token, 'pending')
        await ipn(token)
        says(token, 'completed')
        await ipn(token)
        expect((await exceptionFor(token)).resolution).toBe('settled_normally')

        H.emails = []
        await ipn(token, { final_item_price: '1' })
        expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'amount_mismatch', resolution: 'settled_normally' })
        await sweep()
        expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      })

      it('"still payable" cannot undo a review, and the sweep keeps working', async () => {
        const { token, exception: e } = await reported()
        await exAction('dismissException', { ...decisions(e), attest: 'yes' })
        H.contract = FIXTURE_CONTRACT
        says(token, 'pending')
        const res = await sweep()
        expect(res.body.exception_unrecorded).toBeUndefined()
        expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'provider_pending', provider_answer: 'provider_pending', payment_received: 'not_received' })
      })

      it('clearing a mismatch on an in-flight payment does not claim the money never came', async () => {
        const token = await startAndToken(user(L1))
        await ipn(token, { final_item_price: '1' })
        const e = await exceptionFor(token)
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_dismiss_done')
        expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return', payment_received: 'reported' })
        expect((await rowFor(token)).status).toBe('processing')
      })

      it('money the provider confirmed cannot be dismissed', async () => {
        const { token } = await closedAttempt('expired')
        says(token, 'completed')
        await ipn(token)
        const e = await exceptionFor(token)
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_refused_payment_confirmed_cannot_dismiss')
        expect((await exceptionFor(token)).state).toBe('open')
      })

      it('a question over a completed payment can be dismissed, and it stays paid', async () => {
        const token = await startAndToken(user(L1))
        says(token, 'completed')
        await ipn(token)
        says(token, 'failed')
        await ipn(token, { type_event: 'sale_canceled' })
        const e = await exceptionFor(token)
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes', attestAll: 'yes' })).toBe('exception_dismiss_done')
        expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', payment_received: 'confirmed_by_provider' })
        expect((await rowFor(token)).status).toBe('completed')
      })
    })

    describe('recording access', () => {
      async function confirmed() {
        const r = await reported()
        await exAction('confirmExceptionReceipt', { ...decisions(r.exception), attest: 'yes' })
        return r
      }

      it('refuses when no access exists, and creates none', async () => {
        const { token, exception: e } = await confirmed()
        const before = await counts()
        expect(await exAction('recordExceptionAccess', decisions(e))).toBe('exception_refused_no_live_entitlement')
        expect(await counts()).toEqual(before)
        expect(await dbHasAccess(L1, C1)).toBe(false)
        expect((await exceptionFor(token)).access_state).toBe('not_granted')
      })

      it('refuses revoked access, and another learner\'s or another course\'s access', async () => {
        const { exception: e } = await confirmed()
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason) values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L2, C1])
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C2])
        expect(await exAction('recordExceptionAccess', decisions(e))).toBe('exception_refused_no_live_entitlement')
      })

      it('records a grant made elsewhere, writes no entitlement, and leaves the payment closed', async () => {
        const { token, exception: e } = await confirmed()
        const [grant] = await asSuper(`insert into public.entitlements (user_id, course_id, source, status, granted_by, granted_reason)
          values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE', $3, 'Paiement tardif honoré') returning id`, [L1, C1, ADM])
        const before = await counts()

        expect(await exAction('recordExceptionAccess', decisions(e))).toBe('exception_record_access_done')

        expect(await exceptionFor(token)).toMatchObject({
          state: 'resolved', resolution: 'access_honoured', access_state: 'granted', access_entitlement_id: grant.id, refund_state: 'not_required',
        })
        expect(await counts()).toEqual(before)
        expect((await rowFor(token)).status).toBe('expired')
      })
    })

    describe('re-checking with PayTech', () => {
      it('with no confirmed contract it asks nothing and changes nothing', async () => {
        const { token, exception: e } = await reported()
        const before = await exceptionFor(token)
        expect(await exAction('recheckException', { exceptionId: e.id })).toBe('exception_rechecked')
        expect(P.statusCalls).toEqual([])
        expect(await exceptionFor(token)).toEqual(before)
      })

      it('with a contract it can raise the evidence, and only that', async () => {
        const { token, exception: e } = await reported()
        H.contract = FIXTURE_CONTRACT
        says(token, 'completed')
        const before = await counts()
        expect(await exAction('recheckException', { exceptionId: e.id })).toBe('exception_rechecked')
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
        expect(await counts()).toEqual(before)
        expect((await rowFor(token)).status).toBe('expired')
      })

      it('the provider denying it stays visible, and the operator still decides', async () => {
        const { token, exception: e } = await reported()
        H.contract = FIXTURE_CONTRACT
        says(token, 'failed')
        await exAction('recheckException', { exceptionId: e.id })
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_answer: 'provider_not_paid', payment_received: 'reported' })
      })

      it('can question a completed payment on request, and reverses nothing', async () => {
        const token = await startAndToken(user(L1))
        says(token, 'completed')
        await ipn(token)
        H.contract = null
        await ipn(token, { type_event: 'sale_canceled' })
        const e = await exceptionFor(token)
        H.contract = FIXTURE_CONTRACT
        says(token, 'failed')
        await exAction('recheckException', { exceptionId: e.id })
        expect(await exceptionFor(token)).toMatchObject({ last_signal: 'provider_not_paid' })
        expect((await rowFor(token)).status).toBe('completed')
      })
    })
  })

  describe('XP-PAYTECH-05 — a paid report after settlement could be a second real payment', () => {
    const FACTS = ['state', 'resolution', 'resolved_at', 'resolved_by', 'refund_state', 'refund_external_reference', 'refund_amount',
      'refund_currency', 'refund_confirmed_at', 'refund_recorded_by', 'refund_recorded_at', 'access_state', 'access_entitlement_id', 'payment_received']
    const facts = (e: Record<string, unknown>) => Object.fromEntries(FACTS.map(k => [k, e[k]]))

    async function refunded() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', refundFields(e.id))
      H.emails = []
      return { token, id: e.id as string }
    }

    it('reaches a human, blocks a new attempt, and changes no settled fact', async () => {
      const { token, id } = await refunded()
      const before = facts(await exceptionFor(token))
      const money = await counts()

      const res = await ipn(token, { client_phone: '771111111' })

      expect(res.status).toBe(200)
      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(facts(after)).toEqual(before)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_reported_after_settlement')
      expect(await counts()).toEqual(money)

      const { countOpenPaymentExceptions, paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      expect(await countOpenPaymentExceptions()).toBe(1)
      expect((await paymentExceptionQueue())![0]).toMatchObject({ id, state: 'resolved' })
      expect((await paymentExceptionQueue())!).toHaveLength(1)

      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.reference).toBe((await rowFor(token)).reference)
    })

    it('an administrator reviews it, which frees checkout and changes no settled fact', async () => {
      const { token, id } = await refunded()
      await ipn(token)
      const before = facts(await exceptionFor(token))

      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE })).toBe('close_attestation_required')
      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: 'short', attest: 'yes' })).toBe('close_reason_required')
      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_acknowledge_report_done')

      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).toBeNull()
      expect(facts(after)).toEqual(before)
      expect((await exceptionAudit()).at(-1)).toMatchObject({
        event_type: 'payment.exception_settlement_report_reviewed', actor_id: ADM, reason: NOTE, outcome: 'success',
      })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('repeats while it awaits review only count, and a different report after a review flags again', async () => {
      const { token, id } = await refunded()
      await ipn(token, { client_phone: '771111111' })
      const audit = (await exceptionAudit()).length
      const emails = H.emails.length
      await ipn(token, { client_phone: '771111111' })
      await ipn(token, { client_phone: '771111111' })
      expect(H.emails).toHaveLength(emails)
      expect((await exceptionAudit()).length).toBe(audit + 1)
      expect((await exceptionFor(token)).report_count).toBe(4)

      await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })
      await ipn(token, { client_phone: '772222222' })
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(H.emails).toHaveLength(emails + OWNERS.length)
    })

    it('after an access decision too, and it grants nothing more', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      await exAction('recordExceptionAccess', { exceptionId: e.id, note: NOTE, attestAll: 'yes' })
      const before = await counts()
      await ipn(token, { client_phone: '771111111' })
      expect(await exceptionFor(token)).toMatchObject({ resolution: 'access_honoured', state: 'resolved' })
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(await counts()).toEqual(before)
    })

    it.each([
      ['paid', 'completed', 45000],
      ['paid, with a different amount', 'completed', 1],
      ['failed', 'failed', 45000],
      ['still payable', 'pending', 45000],
    ])('a notification flags it whatever the provider then answers: %s', async (_label, word, amount) => {
      const { token } = await refunded()
      const before = facts(await exceptionFor(token))
      H.contract = FIXTURE_CONTRACT
      says(token, word as string, amount as number)

      const res = await ipn(token, { client_phone: '771111111' })

      expect(res.status).toBe(200)
      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(facts(after)).toEqual(before)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.reference).toBe((await rowFor(token)).reference)
    })

    it.each([
      ['amount', { final_item_price: '1' }],
      ['currency', { currency: 'EUR' }],
    ])('a notification claiming a different %s flags it too', async (_label, over) => {
      const { token } = await refunded()
      const before = facts(await exceptionFor(token))
      expect((await ipn(token, over)).status).toBe(200)
      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(facts(after)).toEqual(before)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a provider answering "paid" with a different amount flags it on a sweep, once', async () => {
      const { token, id } = await refunded()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', 1)
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      await exAction('acknowledgeExceptionReport', reviewedForm(await exceptionFor(token)))
      await sweep()
      await exAction('recheckException', { exceptionId: id })
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
    })

    it('a provider that keeps answering "paid" after a refund does not flag it on every sweep', async () => {
      const { token } = await refunded()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await sweep()
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      expect(H.emails).toEqual([])
    })

    it('an unproven report does not flag it', async () => {
      const { token } = await refunded()
      await ipn(token, {}, { secret: 'sk_wrong' })
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
    })

    it('stays above newer settled records in the queue, and appears once', async () => {
      const { token, id } = await refunded()
      await ipn(token)
      const { token: other } = await closedAttempt('expired', user(L2), C1)
      await ipn(other)
      const newer = await exceptionFor(other)
      await exAction('dismissException', { exceptionId: newer.id, note: NOTE, attest: 'yes', attestAll: 'yes' })

      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      expect((await paymentExceptionQueue())!.map(e => e.id)).toEqual([id, newer.id])
    })

    it('there is nothing to review on a record with no such report', async () => {
      const { id } = await refunded()
      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_refused_no_report_to_review')
    })
  })

  describe('XP-PAYTECH-06 — a repeat cannot keep blocking a learner', () => {
    /** The form an administrator submits, stating how much evidence it showed. */
    const reviewed = reviewedForm

    async function dismissed() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.emails = []
      return { token }
    }

    async function refundedAndReviewed() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })
      H.emails = []
      return { token, id: e.id as string }
    }

    it('after "nothing to return", the same notification is counted and changes nothing else', async () => {
      const { token } = await dismissed()
      const before = await exceptionFor(token)
      const money = await counts()
      const audit = (await exceptionAudit()).length

      expect((await ipn(token)).status).toBe(200)

      expect(await exceptionFor(token)).toMatchObject({
        state: 'resolved', resolution: 'nothing_to_return', payment_received: 'not_received', refund_state: 'not_required',
        resolved_at: before.resolved_at, resolved_by: before.resolved_by, last_signal: before.last_signal,
        report_count: before.report_count + 1, repeat_count: 1, notification_reopens: 0,
      })
      expect(H.emails).toHaveLength(0)
      expect(await counts()).toEqual(money)
      expect((await exceptionAudit()).map(a => a.event_type).slice(audit)).toEqual(['payment.exception_repeat_recorded'])
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('thirty replays never block, never send on arrival, and write one audit row', async () => {
      const { token } = await dismissed()
      const audit = (await exceptionAudit()).length
      for (let i = 0; i < 30; i++) await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 30, report_count: 31 })
      expect(H.emails).toHaveLength(0)
      expect((await exceptionAudit()).length).toBe(audit + 1)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('after a recorded refund, the same notification does not flag or block, and no settled fact moves', async () => {
      const { token } = await refundedAndReviewed()
      const before = await exceptionFor(token)

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({
        state: 'resolved', resolution: 'refund_confirmed', refund_state: 'confirmed',
        refund_external_reference: before.refund_external_reference, post_settlement_report_at: null, repeat_count: 1,
      })
      expect(H.emails).toHaveLength(0)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('after a recorded access decision too', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      expect(await exAction('recordExceptionAccess', { exceptionId: e.id, note: NOTE, evidenceCount: '1' })).toBe('exception_record_access_done')
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ resolution: 'access_honoured', post_settlement_report_at: null, repeat_count: 1 })
    })

    it('after a flag is reviewed, the notification behind it no longer flags', async () => {
      const { token, id } = await refundedAndReviewed()
      await ipn(token, { client_phone: '771111111' })
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))).toBe('exception_acknowledge_report_done')
      H.emails = []

      await ipn(token, { client_phone: '771111111' })

      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, repeat_count: 1 })
      expect(H.emails).toHaveLength(0)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('the same values as form fields are the same notification', async () => {
      const { token } = await dismissed()
      await ipn(token, {}, { form: true })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })
    })

    it('altered unsigned fields can reopen a record three times at most, and then only count', async () => {
      const { token } = await dismissed()
      for (const n of [1, 2, 3]) {
        await ipn(token, { client_phone: `77000000${n}` })
        const e = await exceptionFor(token)
        expect(e).toMatchObject({ state: 'open', notification_reopens: n })
        expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
        await exAction('dismissException', reviewed(e))
      }
      H.emails = []

      await ipn(token, { client_phone: '770000004' })

      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', notification_reopens: 3, repeat_count: 1 })
      expect(H.emails).toHaveLength(0)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('altered unsigned fields can flag a settled record three times at most too', async () => {
      const { token, id } = await refundedAndReviewed()
      for (const n of [1, 2, 3]) {
        await ipn(token, { client_phone: `77000000${n}` })
        expect(await exceptionFor2(id)).toMatchObject({ notification_reopens: n })
        expect((await exceptionFor2(id)).post_settlement_report_at).not.toBeNull()
        await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor2(id)))
      }
      await ipn(token, { client_phone: '770000004' })
      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, notification_reopens: 3, repeat_count: 1 })
    })

    it('distinct digests are bounded, and every report is still counted', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      for (let n = 0; n < 20; n++) await ipn(token, { client_phone: `7700000${String(n).padStart(2, '0')}` })
      await sweep()
      expect((await exceptionFor(token)).repeat_alert_due_at).toBeNull()

      for (let n = 20; n < 23; n++) await ipn(token, { client_phone: `7700000${String(n).padStart(2, '0')}` })

      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(20)
      expect(e.report_count).toBe(23)
      expect(e.repeat_alert_due_at).not.toBeNull()
    })

    it('no one can shrink what was seen, even the table owner', async () => {
      const { token } = await dismissed()
      await expect(asSuper(`update public.payment_exceptions set evidence_fingerprints = '{}', reviewed_fingerprints = '{}'
        where payment_id = (select id from public.payments where provider_token = $1)`, [token]))
        .rejects.toThrow(/exception_identity_immutable|payment exception refused/)
    })

    it('a digest of the wrong shape is refused', async () => {
      H.contract = null
      const { id } = await closedAttempt('expired')
      await expect(asRole('service_role', null,
        `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, 'not-a-digest')`, [id])).rejects.toThrow(/payment exception refused/)
    })
  })

  describe('XP-PAYTECH-06 — genuinely new evidence is never held back', () => {
    const reviewed = reviewedForm

    async function dismissed() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.emails = []
      return { token }
    }

    /** Use up everything notifications alone may do, leaving the record resolved. */
    async function spent() {
      const { token } = await dismissed()
      for (const n of [1, 2, 3]) {
        await ipn(token, { client_phone: `77000000${n}` })
        await exAction('dismissException', reviewed(await exceptionFor(token)))
      }
      expect((await exceptionFor(token)).notification_reopens).toBe(3)
      H.emails = []
      return { token }
    }

    async function refundedAndReviewed() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })
      H.emails = []
      return { token, id: e.id as string }
    }

    it.each([
      ['another payer', { client_phone: '771111111' }, 'paid_hint'],
      ['another method', { payment_method: 'Orange Money' }, 'paid_hint'],
      ['another claimed amount', { final_item_price: '1' }, 'amount_mismatch'],
      ['another currency', { currency: 'EUR' }, 'currency_mismatch'],
    ])('after "nothing to return", %s reopens it at once, alerts and blocks', async (_label, over, signal) => {
      const { token } = await dismissed()

      await ipn(token, over)

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: signal, resolution: null, repeat_count: 0 })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      const r = await checkout(user(L1), C1)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.reference).toBe((await rowFor(token)).reference)
    })

    it.each([
      ['amount', { final_item_price: '1' }, { final_item_price: '2' }, 'amount_mismatch'],
      ['currency', { currency: 'EUR' }, { currency: 'USD' }, 'currency_mismatch'],
    ])('a different %s claim after a reviewed one reopens it, while the same claim only counts', async (_label, first, second, signal) => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, first)
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await ipn(token, first)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })

      await ipn(token, second)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: signal })
    })

    it('new evidence clears the repeat count, so an open record never shows a stale one', async () => {
      const { token } = await dismissed()
      await ipn(token)
      expect((await exceptionFor(token)).repeat_alert_due_at).not.toBeNull()

      await ipn(token, { client_phone: '771111111' })

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', repeat_count: 0, repeat_alert_due_at: null })
    })

    it('after a recorded refund, a different notification flags it, alerts and blocks, and no settled fact moves', async () => {
      const { token } = await refundedAndReviewed()
      const before = await exceptionFor(token)

      await ipn(token, { client_phone: '771111111' })

      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(after).toMatchObject({
        state: 'resolved', resolution: 'refund_confirmed', refund_state: before.refund_state,
        refund_external_reference: before.refund_external_reference,
      })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('the provider confirming payment reopens it, even on the very notification that was reviewed', async () => {
      const { token } = await dismissed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider', repeat_count: 0 })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('the provider is not limited on a notification, once notifications have had their say', async () => {
      const { token } = await spent()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token, { client_phone: '770000009' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider', notification_reopens: 3 })
    })

    it('nor on a sweep', async () => {
      const { token } = await spent()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider', notification_reopens: 3 })
    })

    it('another attempt by the same learner is its own evidence', async () => {
      const first = await dismissed()
      const second = await closedAttempt('expired')

      await ipn(second.token)

      expect(await exceptionFor(second.token)).toMatchObject({ state: 'open', repeat_count: 0 })
      expect((await exceptionFor(first.token)).repeat_count).toBe(0)
      expect((await exceptionFor(second.token)).evidence_fingerprints[0])
        .not.toBe((await exceptionFor(first.token)).evidence_fingerprints[0])
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a report that failed its signature, once reviewed, does not hide a signed one with the same content', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, {}, { secret: 'not-the-secret' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ first_signal: 'unverified_report', state: 'open' })
      await exAction('dismissException', reviewed(e))

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', payment_received: 'reported', repeat_count: 0 })
    })

    it('a review cannot cover a notification the administrator was not shown', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const shown = await exceptionFor(token)

      await ipn(token, { client_phone: '771111111' })

      expect(await exAction('dismissException', reviewed(shown))).toBe('exception_refused_evidence_changed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', reviewed_fingerprints: [] })
      expect((await exceptionAudit()).at(-1)).toMatchObject({ event_type: 'payment.exception_decision_refused', outcome: 'failure' })

      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect((await exceptionFor(token)).reviewed_fingerprints).toHaveLength(2)
    })

    it('a refund or a flag review cannot cover one either', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      const refundForm = reviewed(await exceptionFor(token))
      await ipn(token, { client_phone: '771111111' })
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...refundForm })).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).refund_state).toBe('required')
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '2', attestAll: 'yes' })).toBe('exception_refund_recorded')

      await ipn(token, { client_phone: '772222222' })
      const reviewForm = reviewed(await exceptionFor(token))
      await ipn(token, { client_phone: '773333333' })
      expect(await exAction('acknowledgeExceptionReport', reviewForm)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })

    it('a form that does not say what it showed reviews nothing, so a repeat still acts', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: 'many' })
      expect((await exceptionFor(token)).reviewed_fingerprints).toEqual([])
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('while a record is open, a repeat keeps it open and the learner blocked', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', report_count: 2, repeat_count: 0 })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('a repeat still reaches a human: the sweep alerts once, and again only after a week', async () => {
      const { token } = await dismissed()
      await ipn(token)
      await ipn(token)
      expect(H.emails).toHaveLength(0)

      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(JSON.stringify(H.emails)).not.toContain('770000000')
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)

      await ipn(token)
      const e = await exceptionFor(token)
      const days = (new Date(e.repeat_alert_due_at).getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThanOrEqual(7)
      await sweep()
      expect(H.emails).toHaveLength(0)

      await asSuper(`update public.payment_exceptions set repeat_alert_due_at = now() - interval '1 minute' where id = $1`, [e.id])
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await exceptionFor(token)).repeat_alert_due_at).toBeNull()
    })

    it('a failed alert about a repeat stays due', async () => {
      const { token } = await dismissed()
      await ipn(token)
      H.emailMode = 'fail'
      await sweep()
      expect((await exceptionFor(token)).repeat_alert_due_at).not.toBeNull()
      H.emailMode = 'ok'
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await exceptionFor(token)).repeat_alert_due_at).toBeNull()
    })

    it('the queue keeps it in view above newer resolved records, and reviewing it clears the count', async () => {
      const { token } = await dismissed()
      await ipn(token)
      const { id } = await exceptionFor(token)
      const other = await closedAttempt('expired', user(L2), C1)
      await ipn(other.token)
      await exAction('dismissException', reviewed(await exceptionFor(other.token)))

      const { countOpenPaymentExceptions, paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      const queue = (await paymentExceptionQueue())!
      expect(queue.map(e => e.id)[0]).toBe(id)
      expect(queue).toHaveLength(2)
      expect(queue[0]).toMatchObject({ repeatCount: 1, evidenceCount: 1 })
      expect(JSON.stringify(queue)).not.toContain((await exceptionFor(token)).evidence_fingerprints[0])
      expect(await countOpenPaymentExceptions()).toBe(1)

      expect(await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))).toBe('exception_acknowledge_report_done')
      expect(await exceptionFor(token)).toMatchObject({ repeat_count: 0, repeat_alert_due_at: null, state: 'resolved' })
      expect(await countOpenPaymentExceptions()).toBe(0)
    })

    it('a second, different notification on an open record reaches a human, and a refund cannot pass over it', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()
      H.emails = []

      await ipn(token, { client_phone: '771111111' })
      expect(H.emails).toHaveLength(0)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)

      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      expect((await paymentExceptionQueue())![0]).toMatchObject({ state: 'open', evidenceCount: 2, repeatCount: 0 })
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '2', attestAll: '' })).toBe('close_attestation_required')
      expect((await exceptionFor(token)).refund_state).toBe('required')
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '2', attestAll: 'yes' })).toBe('exception_refund_recorded')
      expect((await exceptionFor(token)).repeat_alert_due_at).toBeNull()
      expect((await exceptionAudit()).at(-1).metadata).toMatchObject({ notifications: 2, seenVersion: expect.any(Number) })
    })

    it.each(['dismiss', 'refund', 'access'] as const)('a %s decision covers an alert still due about a second notification', async (kind) => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token, { client_phone: '771111111' })
      const e = await exceptionFor(token)
      expect(e.repeat_alert_due_at).not.toBeNull()
      const shown = { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: '2', attestAll: 'yes' }

      if (kind === 'dismiss') {
        expect(await exAction('dismissException', shown)).toBe('exception_dismiss_done')
      } else {
        await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
        if (kind === 'refund') {
          await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
          expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '2', attestAll: 'yes' })).toBe('exception_refund_recorded')
        } else {
          await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
          expect(await exAction('recordExceptionAccess', shown)).toBe('exception_record_access_done')
        }
      }

      expect((await exceptionFor(token)).repeat_alert_due_at).toBeNull()
      expect((await exceptionAudit()).at(-1).metadata).toMatchObject({ notifications: 2, seenVersion: expect.any(Number) })
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('an access decision cannot pass over a second notification either', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token, { client_phone: '771111111' })
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      expect(await exAction('recordExceptionAccess', { exceptionId: e.id, note: NOTE, evidenceCount: '2' })).toBe('close_attestation_required')
      expect(await exAction('recordExceptionAccess', { exceptionId: e.id, note: NOTE, evidenceCount: '2', attestAll: 'yes' })).toBe('exception_record_access_done')
    })

    it('past the limit, a different notification is marked as different, not as a repeat, and alerts at the next sweep', async () => {
      const { token } = await spent()
      await ipn(token)
      await sweep()
      H.emails = []

      await ipn(token, { client_phone: '770000009' })

      const e = await exceptionFor(token)
      expect(e.different_report_at).not.toBeNull()
      expect(e).toMatchObject({ state: 'resolved', notification_reopens: 3 })
      expect(H.emails).toHaveLength(0)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []

      await ipn(token, { client_phone: '770000008' })
      await sweep()
      expect(H.emails).toHaveLength(0)

      expect(await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))).toBe('exception_acknowledge_report_done')
      expect(await exceptionFor(token)).toMatchObject({ different_report_at: null, repeat_count: 0 })
    })

    it('past the limit, a different claim is named for the administrator, and writes nothing a later decision compares', async () => {
      const { token } = await spent()
      const before = await exceptionFor(token)
      await ipn(token, { final_item_price: '1' })
      expect(await exceptionFor(token)).toMatchObject({
        state: 'resolved', different_signal: 'amount_mismatch', last_signal: before.last_signal, detail: before.detail,
      })
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      expect(await exceptionFor(token)).toMatchObject({ different_signal: null, different_report_at: null })
    })

    it('a variant past the limit cannot make the provider\'s same answer look new again', async () => {
      const { token, id } = await refundedAndReviewed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', PRICE_C1 + 1)
      for (const n of [0, 1, 2, 3]) {
        await ipn(token, { client_phone: `77000000${n}` })
        expect((await exceptionFor2(id)).post_settlement_report_at).not.toBeNull()
        await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor2(id)))
      }
      expect(await exceptionFor2(id)).toMatchObject({ notification_reopens: 3, detail: 'settlement_amount_mismatch' })

      await ipn(token, { final_item_price: '7' })
      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, detail: 'settlement_amount_mismatch' })
      await ipn(token, { client_phone: '770000000' })

      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, detail: 'settlement_amount_mismatch' })
    })

    it('a variant while a record is open cannot make the provider\'s same answer look new again', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch' })
      await ipn(token, { final_item_price: '1' })
      expect(await exceptionFor(token)).toMatchObject({ detail: 'ipn_amount_mismatch', provider_answer: 'settlement_amount_mismatch' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1, notification_reopens: 0 })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('the provider\'s new mismatch reopens a reviewed one, however it arrives', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      expect((await exceptionFor(token)).state).toBe('resolved')
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)

      await sweep()

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', detail: 'settlement_amount_mismatch', notification_reopens: 0 })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('a plain repeat is not marked as different', async () => {
      const { token } = await dismissed()
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ repeat_count: 1, different_report_at: null })
    })

    it('a report that failed its signature after a review does not vanish, and blocks nobody', async () => {
      const { token } = await dismissed()
      const before = await exceptionFor(token)

      await ipn(token, {}, { secret: 'not-the-secret' })

      const e = await exceptionFor(token)
      expect(e.different_report_at).not.toBeNull()
      expect(e).toMatchObject({ state: 'resolved', repeat_count: 1, last_signal: before.last_signal, payment_received: 'not_received' })
      expect(H.emails).toHaveLength(0)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)

      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      await ipn(token, {}, { secret: 'not-the-secret' })
      expect(await exceptionFor(token)).toMatchObject({ repeat_count: 1, different_report_at: null })
    })

    it('after a refund too, without moving a settled fact', async () => {
      const { token, id } = await refundedAndReviewed()
      await ipn(token, {}, { secret: 'not-the-secret' })
      const e = await exceptionFor2(id)
      expect(e.different_report_at).not.toBeNull()
      expect(e).toMatchObject({ resolution: 'refund_confirmed', refund_state: 'confirmed', post_settlement_report_at: null, repeat_count: 1 })
    })

    it('the provider contradicting a completed payment reopens it, even on the very notification that was reviewed', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      H.contract = null
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'cancel_hint' })
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))

      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })

      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid', repeat_count: 0 })

      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })
    })

    it('the provider reporting another amount after a refund flags it, once, and uses up nothing', async () => {
      const { token, id } = await refundedAndReviewed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', PRICE_C1 + 1)

      await ipn(token)

      const e = await exceptionFor2(id)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e).toMatchObject({ detail: 'settlement_amount_mismatch', notification_reopens: 0, resolution: 'refund_confirmed' })

      await exAction('acknowledgeExceptionReport', reviewed(e))
      await ipn(token)
      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, repeat_count: 1 })
    })

    it('a provider that keeps answering "paid" after a refund is not news on a reviewed notification', async () => {
      const { token, id } = await refundedAndReviewed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, repeat_count: 1 })
    })

    it('an in-flight payment with a reviewed report that came again warns before a manual close', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { watchedPaymentIds } = await import('@/lib/payments/payment-exceptions')
      const { id } = await rowFor(token)
      expect((await watchedPaymentIds()).has(id)).toBe(false)

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })
      expect((await watchedPaymentIds()).has(id)).toBe(true)
    })

    it('a flagged record that also receives a reviewed notification stays flagged and blocked', async () => {
      const { token, id } = await refundedAndReviewed()
      await ipn(token, { client_phone: '771111111' })
      await ipn(token)
      const e = await exceptionFor2(id)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.repeat_count).toBe(1)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      await exAction('acknowledgeExceptionReport', reviewed(e))
      expect(await exceptionFor2(id)).toMatchObject({ post_settlement_report_at: null, repeat_count: 0 })
    })

    it('past the digest cap a review still holds, and an unrecorded digest is new evidence', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      for (let n = 0; n < 21; n++) await ipn(token, { client_phone: `7700000${String(n).padStart(2, '0')}` })
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await ipn(token, { client_phone: '770000000' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', repeat_count: 1 })

      await ipn(token, { client_phone: '770000020' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', notification_reopens: 1 })
    })

    it('an administrator who finds real money can reopen a repeat and settle it', async () => {
      const { token } = await dismissed()
      await ipn(token)
      const e = await exceptionFor(token)
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: 'short', attest: 'yes' })).toBe('close_reason_required')
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: NOTE })).toBe('close_attestation_required')

      expect(await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')

      expect(await exceptionFor(token)).toMatchObject({
        state: 'open', resolution: null, payment_received: 'reported', refund_state: 'not_assessed',
        repeat_count: 0, repeat_alert_due_at: null, different_report_at: null, reviewed_fingerprints: [],
      })
      expect((await exceptionAudit()).at(-1)).toMatchObject({
        event_type: 'payment.exception_reopened_by_administrator', actor_id: ADM, reason: NOTE, outcome: 'success',
      })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      expect(await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })).toBe('exception_confirm_received_done')
      expect(await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })).toBe('exception_require_refund_done')
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })).toBe('exception_refund_recorded')
    })

    it('money found later, with no repeat at all, can still be reopened', async () => {
      const { token } = await dismissed()
      await ipn(token)
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(0)
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('on a settled record it flags instead, and no settled fact moves', async () => {
      const { token, id } = await refundedAndReviewed()
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')
      const e = await exceptionFor2(id)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e).toMatchObject({ state: 'resolved', resolution: 'refund_confirmed', refund_state: 'confirmed', repeat_count: 0 })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      expect(await exAction('acknowledgeExceptionReport', reviewed(e))).toBe('exception_acknowledge_report_done')
      expect(token).toBeTruthy()
    })

    it('on a completed payment nobody has questioned it flags, and offers no refund of the legitimate payment', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e.resolution).toBe('settled_normally')

      expect(await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')

      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(after).toMatchObject({ state: 'resolved', resolution: 'settled_normally', refund_state: 'not_required' })
      expect(await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })).toBe('exception_refused_exception_not_open')
      expect(await exAction('recordExceptionRefund', refundFields(e.id))).toBe('exception_refused_exception_not_open')
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exAction('acknowledgeExceptionReport', reviewed(after))).toBe('exception_acknowledge_report_done')
    })

    it('a notification cannot turn that flag into an open record that offers a refund', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
      H.contract = null

      await ipn(token, { type_event: 'sale_canceled' })

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.different_report_at).not.toBeNull()
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', repeat_count: 1, notification_reopens: 0 })
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('the provider contradicting that payment does open it, and the flag stays', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
      says(token, 'failed')

      await ipn(token, { type_event: 'sale_canceled' })

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', last_signal: 'provider_not_paid', provider_answer: 'provider_not_paid' })
      expect(e.post_settlement_report_at).not.toBeNull()
    })

    it('an open record is not reopened, and a record with nothing to review says so', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_refused_exception_not_resolved')
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_refused_no_report_to_review')
    })

    it('its ROLLBACK refuses while a repeat is unreviewed', async () => {
      const { token } = await dismissed()
      await ipn(token)
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/settle them first/)
      await db.exec('rollback').catch(() => undefined)
      expect((await exceptionFor(token)).repeat_count).toBe(1)
    })
  })

  // ═══ XP-PAYTECH-06B: evidence that used to be lost ═══════════════════════════
  describe('XP-PAYTECH-06B — a different paid notification on a completed payment reaches a person', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const reviewed = reviewedForm
    async function completed() {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      expect((await ipn(token)).body.detail).toBe('completed')
      expect((await rowFor(token)).status).toBe('completed')
      H.emails = []
      return token
    }

    it('it is recorded, marked and alerted on, and the payment stays exactly as it was', async () => {
      const token = await completed()
      const before = await rowFor(token)
      const ents = await entitlementsOf(L1)

      expect((await ipn(token, { client_phone: '771234567', payment_method: 'Orange Money' })).status).toBe(200)

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', refund_state: 'not_required', repeat_count: 1 })
      expect(e.different_report_at).not.toBeNull()
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(e.reviewed_fingerprints).toHaveLength(1)
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await rowFor(token)).toMatchObject({ status: before.status, completed_at: before.completed_at })
      expect(await entitlementsOf(L1)).toEqual(ents)
    })

    it('it never blocks the learner, because the completed payment still holds', async () => {
      const token = await completed()
      await ipn(token, { client_phone: '771234567' })
      const blocked = await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1])
      expect(blocked[0].r).toBeNull()
    })

    it('the notification that completed the payment is what its completion covers, so a normal payment leaves no record', async () => {
      const token = await completed()
      expect(await exceptionFor(token)).toBeNull()
      expect(await needsHuman()).toBe(0)
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a sweep completes the payment, and its notification arriving late is taken as the one the completion covers', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      H.emails = []

      await ipn(token)
      expect(await exceptionFor(token)).toBeNull()

      await ipn(token, { client_phone: '771234567' })
      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
    })

    it('the same notification again is counted, not called different, and surfaces at most weekly', async () => {
      const token = await completed()
      for (let i = 0; i < 5; i++) await ipn(token)

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', repeat_count: 5 })
      expect(e.different_report_at).toBeNull()
      expect(e.evidence_fingerprints).toHaveLength(1)
      await sweep()
      expect(H.emails).toHaveLength(OWNERS.length)
      H.emails = []
      await ipn(token)
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('on a completed payment an administrator flagged, it still counts and alerts', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      await sweep()
      H.emails = []

      await ipn(token, { client_phone: '771234567' })

      const e = await exceptionFor(token)
      expect(e.different_report_at).not.toBeNull()
      expect(e.repeat_count).toBe(1)
      expect(e.evidence_fingerprints).toHaveLength(2)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('on an open record, it is added and alerted on, without rewriting what the record says', async () => {
      const token = await completed()
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid' })
      await sweep()
      H.emails = []
      const held = (await exceptionFor(token)).evidence_fingerprints.length

      await ipn(token, { client_phone: '771234567' })

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', last_signal: 'provider_not_paid' })
      expect(e.evidence_fingerprints).toHaveLength(held + 1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a record opened on a completed payment starts from the notification its completion covers', async () => {
      const token = await completed()
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })

      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(e.reviewed_fingerprints).toHaveLength(1)
      await sweep()
      H.emails = []

      await ipn(token)

      const after = await exceptionFor(token)
      expect(after.evidence_fingerprints).toHaveLength(2)
      expect(after.state).toBe('open')
      expect(after.repeat_alert_due_at).toBeNull()
    })

    it('the code that marks a completing notification is never written to a record', async () => {
      const token = await completed()
      const { id } = await rowFor(token)
      await asRole('service_role', null,
        `select public.payment_exception_report($1, 'paid_hint', 'ipn', 'ipn_completing_payment', $2)`, [id, 'b'.repeat(64)])
      const e = await exceptionFor(token)
      expect(e.detail).toBeNull()
      expect(e.different_report_at).not.toBeNull()
    })

    it('a browser or the application cannot read or change what a completion covers', async () => {
      const token = await completed()
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await expect(asRole(role, null, `select * from public.payment_completion_notices`)).rejects.toThrow(/permission denied/)
        await expect(asRole(role, null, `insert into public.payment_completion_notices (payment_id, fingerprint) values (gen_random_uuid(), repeat('a', 64))`)).rejects.toThrow(/permission denied/)
      }
      const [{ n }] = await asSuper(`select count(*)::int as n from public.payment_completion_notices where payment_id = (select id from public.payments where provider_token = $1)`, [token])
      expect(n).toBe(1)
    })

    it('what a completion covers cannot be rewritten or removed, not even by the table owner', async () => {
      await completed()
      await expect(asSuper(`update public.payment_completion_notices set fingerprint = repeat('c', 64)`)).rejects.toMatchObject({ detail: expect.stringContaining('completion_notice_immutable') })
      await expect(asSuper(`delete from public.payment_completion_notices`)).rejects.toMatchObject({ detail: expect.stringContaining('completion_notice_immutable') })
    })

    it('a failed signature on a completed payment is kept, even with no record yet', async () => {
      const token = await completed()
      await ipn(token, { hmac_compute: 'a'.repeat(64), client_phone: '771234567' })

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', different_signal: 'unverified_report' })
      expect(e.different_report_at).not.toBeNull()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('a real second payment at another amount, which cannot match the signature, is kept too', async () => {
      const token = await completed()
      await ipn(token, { item_price: String(PRICE_C1 * 2) }, { signAmount: PRICE_C1 * 2 })

      const e = await exceptionFor(token)
      expect(e).not.toBeNull()
      expect(await needsHuman()).toBe(1)
    })

    it('recording it cannot fail silently: an unrecorded report is retried', async () => {
      const token = await completed()
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }
      const res = await ipn(token, { client_phone: '771234567' })
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
      expect((await ipn(token, { client_phone: '771234567' })).status).toBe(200)
      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
    })

    it('once reviewed, the same different notification only counts', async () => {
      const token = await completed()
      await ipn(token, { client_phone: '771234567' })
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      expect(await needsHuman()).toBe(0)

      await ipn(token, { client_phone: '771234567' })

      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(1)
      expect(e.different_report_at).toBeNull()
      expect(e.state).toBe('resolved')
    })
  })

  describe('XP-PAYTECH-06B — a payment that completes does not swallow notifications that disagreed', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()

    it('two different notifications while in flight, then completion: flagged, alerted and counted', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { client_phone: '771111111' })
      await ipn(token, { client_phone: '772222222', payment_method: 'Orange Money' })
      expect((await exceptionFor(token)).state).toBe('watching')
      H.emails = []

      says(token, 'completed')
      await age(token, 90)
      await sweep()

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('that flag blocks nobody and offers no refund on the completed payment', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { client_phone: '771111111' })
      await ipn(token, { client_phone: '772222222' })
      says(token, 'completed')
      await ipn(token, { client_phone: '772222222' })

      expect((await rowFor(token)).status).toBe('completed')
      const blocked = await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1])
      expect(blocked[0].r).toBeNull()
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('one notification while in flight, then completion: settled quietly, because one payment covers it', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      H.emails = []
      says(token, 'completed')
      await ipn(token)

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', repeat_count: 0 })
      expect(e.post_settlement_report_at).toBeNull()
      expect(e.different_report_at).toBeNull()
      expect(await needsHuman()).toBe(0)
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a different notification that itself completes the payment is not lost', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { client_phone: '771111111' })
      says(token, 'completed')

      await ipn(token, { client_phone: '772222222' })

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(await needsHuman()).toBe(1)
    })

    it('an escalated record with a second notification, then completion, stays in front of a person', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { client_phone: '771111111' })
      await ageException(token, 48)
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      await ipn(token, { client_phone: '772222222' })
      H.emails = []

      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await age(token, 90)
      await sweep()

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      // The second notification was due, and the completion flagged the record.
      expect(H.emails.map(m => m.to)).toEqual([...OWNERS, ...OWNERS])
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })
  })

  describe('XP-PAYTECH-06B — contradictory evidence after a decision is kept and flagged', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const reviewed = reviewedForm
    async function refundedOnClosed() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), evidenceCount: String(e.evidence_fingerprints.length) })).toBe('exception_refund_recorded')
      H.emails = []
      return { token, id }
    }
    async function accessOnInFlight() {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      const { id } = await exceptionFor(token)
      await ageException(token, 48)
      await sweep()
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      expect(await exAction('recordExceptionAccess', reviewed(await exceptionFor(token)))).toBe('exception_record_access_done')
      H.emails = []
      return { token, id }
    }

    it('after a refund, a sweep that hears a different amount flags it once, and repeating it does not', async () => {
      const { token } = await refundedOnClosed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', 1)

      await sweep()

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e).toMatchObject({ resolution: 'refund_confirmed', refund_state: 'confirmed', provider_answer: 'settlement_amount_mismatch' })
      expect(await needsHuman()).toBe(1)
      expect(H.emails.length).toBeGreaterThan(0)

      await exAction('acknowledgeExceptionReport', reviewed(e))
      await sweep()
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('that news is not used up by a sweep, so a notification can still flag afterwards', async () => {
      const { token } = await refundedOnClosed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', 1)
      await sweep()
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))

      await ipn(token, { client_phone: '771234567' })

      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })

    it('after a refund, the provider answering "paid" with the right amount is no news, however often', async () => {
      const { token } = await refundedOnClosed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      for (let i = 0; i < 3; i++) await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('after a refund, "not paid" is what the provider should say, so a sweep and a re-check leave it', async () => {
      const { token, id } = await refundedOnClosed()
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await sweep()
      await exAction('recheckException', { exceptionId: id })
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('access honoured, the payment then completes, and the provider says it failed: flagged and alerted', async () => {
      const { token } = await accessOnInFlight()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      H.emails = []
      says(token, 'failed')

      await ipn(token, { type_event: 'sale_canceled' })

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ resolution: 'access_honoured', provider_answer: 'provider_not_paid' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await needsHuman()).toBe(1)
    })

    it('access honoured on a closed attempt, and a scheduled check says it was never paid: flagged, once', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      await exAction('recordExceptionAccess', reviewed(await exceptionFor(token)))
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')

      await sweep()

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ resolution: 'access_honoured', provider_answer: 'provider_not_paid' })
      expect(e.post_settlement_report_at).not.toBeNull()

      await exAction('acknowledgeExceptionReport', reviewed(e))
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
    })

    it('a sweep hearing "not paid" on an ordinary closed attempt writes nothing at all', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('failed')
      says(token, 'failed')
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
    })

    it('on a dismissed record, a scheduled "not paid" is left alone, and its report count does not climb', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const before = await exceptionFor(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', report_count: before.report_count, provider_answer: null })
    })

    it('a flagged refund record absorbs nothing: each different notification is kept, marked and alerted on', async () => {
      const { token } = await refundedOnClosed()
      await ipn(token, { client_phone: '771000000' })
      const flagged = await exceptionFor(token)
      expect(flagged.post_settlement_report_at).not.toBeNull()
      expect(flagged.notification_reopens).toBe(1)
      await sweep()
      H.emails = []

      for (let n = 1; n <= 5; n++) await ipn(token, { client_phone: `77100000${n}` })

      const e = await exceptionFor(token)
      expect(e.different_report_at).not.toBeNull()
      expect(e.repeat_count).toBe(5)
      expect(e.notification_reopens).toBe(1)
      expect(e.evidence_fingerprints).toHaveLength(flagged.evidence_fingerprints.length + 5)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('each different notification leaves one audit row, and a repeat of one does not', async () => {
      const { token } = await refundedOnClosed()
      await ipn(token, { client_phone: '771000000' })
      const before = (await exceptionAudit()).length

      await ipn(token, { client_phone: '771000001' })
      await ipn(token, { client_phone: '771000002' })
      await ipn(token, { client_phone: '771000002' })

      const rows = (await exceptionAudit()).slice(before)
      expect(rows.filter(r => r.event_type === 'payment.exception_different_report_recorded')).toHaveLength(2)
      expect(rows.every(r => !JSON.stringify(r.metadata).match(/[a-f0-9]{64}/))).toBe(true)
    })

    it('provider news on a flagged record alerts again, and stays flagged after a dismissal', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      says(token, 'failed')

      await ipn(token, { type_event: 'sale_canceled' })
      const open = await exceptionFor(token)
      expect(open).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid' })
      expect(open.post_settlement_report_at).not.toBeNull()

      await exAction('dismissException', reviewed(open))

      const after = await exceptionFor(token)
      expect(after.state).toBe('resolved')
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
    })
  })

  describe('XP-PAYTECH-06B — a provider repeating itself cannot keep blocking a learner', () => {
    const reviewed = reviewedForm
    const answer = (token: string, amount: number, currency: string) =>
      P.status.set(token, { success: 1, payment: { status: 'pending', amount, currency, ref_command: P.refs.get(token) } })

    it('a notification rewriting the record while it is open does not make the same answer new', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch' })
      await ipn(token, { currency: 'EUR' })
      expect((await exceptionFor(token)).last_signal).toBe('currency_mismatch')
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await sweep()

      expect((await exceptionFor(token)).state).toBe('resolved')
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('past the limit, repeated cycles of a variant and a sweep cannot reopen the record', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      for (const n of [1, 2, 3]) {
        await ipn(token, { client_phone: `77000000${n}` })
        await exAction('dismissException', reviewed(await exceptionFor(token)))
      }
      expect((await exceptionFor(token)).notification_reopens).toBe(3)

      for (let cycle = 0; cycle < 6; cycle++) {
        await ipn(token, { currency: 'EUR', client_phone: `7711111${cycle}` })
        await sweep()
        const e = await exceptionFor(token)
        expect(e.state, `cycle ${cycle}`).toBe('resolved')
        expect(e.notification_reopens).toBe(3)
      }
    })

    it('a provider alternating between two answers reopens once for each, and then only counts', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      await age(token, 90)
      const states: string[] = []
      for (const [amount, currency] of [[PRICE_C1 + 1, 'XOF'], [PRICE_C1, 'EUR'], [PRICE_C1 + 1, 'XOF'], [PRICE_C1, 'EUR'], [PRICE_C1 + 1, 'XOF']] as const) {
        answer(token, amount, currency)
        await sweep()
        const e = await exceptionFor(token)
        states.push(e.state)
        if (e.state === 'open') await exAction('dismissException', reviewed(e))
      }
      expect(states).toEqual(['open', 'open', 'resolved', 'resolved', 'resolved'])
      expect((await exceptionFor(token)).provider_answers).toEqual(['settlement_amount_mismatch', 'settlement_currency_mismatch'])
    })

    it('the queue still shows what the provider last said, whatever a notification wrote', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      await ipn(token, { currency: 'EUR' })
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      const [row] = (await paymentExceptionQueue())!
      expect(row).toMatchObject({ lastSignal: 'currency_mismatch', providerAnswer: 'settlement_amount_mismatch' })
      // What a form sends back counts the provider's answer as well as the notification.
      expect(row.evidenceCount).toBe(2)
    })

    it('a crafted notification cannot write the provider\'s answer', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { detail: 'settlement_amount_mismatch', signal: 'provider_not_paid', provider_answer: 'settlement_amount_mismatch' })
      expect(await exceptionFor(token)).toMatchObject({ provider_answer: null, provider_answers: [] })
    })

    it('the provider saying not paid, then paid, then not paid: counted and alerted, not reopened', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      says(token, 'completed')
      await ipn(token, { type_event: 'sale_canceled' })
      says(token, 'failed')
      H.emails = []

      await ipn(token, { type_event: 'sale_canceled' })

      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.repeat_count).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })
  })

  describe('XP-PAYTECH-06B — digest limits and alert windows suppress nothing for good', () => {
    const reviewed = reviewedForm
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    async function atTheCap() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      for (let n = 0; n < 20; n++) await ipn(token, { client_phone: `7700000${String(n).padStart(2, '0')}` })
      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(20)
      expect(e.evidence_overflow_at).toBeNull()
      return { token, e }
    }

    it('a 21st digest makes a form from before it out of date, and its decision cannot cancel the alert', async () => {
      const { token, e } = await atTheCap()
      await sweep()
      const form = reviewed(e)

      await ipn(token, { client_phone: '770000099' })

      expect(await exAction('dismissException', form)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).state).toBe('open')
      expect((await exceptionFor(token)).repeat_alert_due_at).not.toBeNull()
    })

    it('the same goes for acknowledging a mark', async () => {
      const { token } = await atTheCap()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set notification_reopens = 3 where payment_id = (select id from public.payments where provider_token = $1)`, [token])
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      await ipn(token, { client_phone: '770000001' })
      const form = reviewed(await exceptionFor(token))

      await ipn(token, { client_phone: '770000099' })

      expect(await exAction('acknowledgeExceptionReport', form)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
    })

    it('after a review, the next one past the cap makes a form out of date again', async () => {
      const { token } = await atTheCap()
      await ipn(token, { client_phone: '770000099' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      expect((await exceptionFor(token)).evidence_overflow_at).toBeNull()
      expect((await exceptionFor(token)).evidence_fingerprints).toHaveLength(20)
    })

    it('a digest that could not be stored can never read as reviewed', async () => {
      const { token } = await atTheCap()
      await ipn(token, { client_phone: '770000099' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await ipn(token, { client_phone: '770000099' })

      const e = await exceptionFor(token)
      expect(['open', 'resolved']).toContain(e.state)
      expect(e.state === 'open' || e.different_report_at !== null).toBe(true)
    })

    it('a flood past the cap writes a bounded audit trail and cannot lock an administrator out', async () => {
      const { token } = await atTheCap()
      const before = (await exceptionAudit()).length
      for (let n = 0; n < 10; n++) await ipn(token, { client_phone: `7799999${n}` })
      expect((await exceptionAudit()).length - before).toBeLessThanOrEqual(1)

      const form = reviewed(await exceptionFor(token))
      for (let n = 0; n < 5; n++) await ipn(token, { client_phone: `7788888${n}` })
      expect(await exAction('dismissException', form)).toBe('exception_dismiss_done')
    })

    it('below the cap, an alert window delays an alert and no notification can push it further', async () => {
      const { token } = await atTheCap()
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set notification_reopens = 3 where payment_id = (select id from public.payments where provider_token = $1)`, [token])
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      H.emails = []

      // An alert about this record has only just gone out, so the next waits its week.
      await ipn(token, { client_phone: '770000001' })
      const first = (await exceptionFor(token)).repeat_alert_due_at
      expect(first).not.toBeNull()
      expect(new Date(first).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000)
      for (let n = 3; n < 8; n++) await ipn(token, { client_phone: `77000000${n}` })
      expect((await exceptionFor(token)).repeat_alert_due_at).toBe(first)
      await sweep()
      expect(H.emails).toHaveLength(0)

      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set repeat_alert_due_at = now() - interval '1 minute' where payment_id = (select id from public.payments where provider_token = $1)`, [token])
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a decision that does not say what it was shown cancels no alert', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { client_phone: '771111111' })
      await sweep()
      await ipn(token, { client_phone: '772222222' })
      expect((await exceptionFor(token)).repeat_alert_due_at).not.toBeNull()
      const { id } = await exceptionFor(token)

      expect(await exAction('dismissException', { exceptionId: id, note: NOTE, attest: 'yes', attestAll: 'yes', evidenceVersion: '' }))
        .toBe('exception_refused_evidence_version_required')

      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      expect(e.repeat_alert_due_at).not.toBeNull()
      expect(e.reviewed_fingerprints).toEqual([])
      expect(await needsHuman()).toBe(1)
    })

    it('a report with no digest that failed its signature is marked, not merely counted', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { id } = await rowFor(token)

      await asRole('service_role', null, `select public.payment_exception_report($1, 'unverified_report', 'ipn', 'ipn_signature_mismatch')`, [id])

      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — the sweep cannot starve an alert or stop unnoticed', () => {
    const insertOpen = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const [{ id }] = await asSuper(
          `insert into public.payments (amount, currency, method, status, reference, provider, provider_mode, provider_token, user_id, course_id)
           values (100, 'XOF', 'card', 'pending', $1, 'paytech', 'test', $2, $3, $4) returning id`,
          [`SCX-ALERT-${i}`, `alert-token-${i}`, L1, C2],
        )
        await asRole('service_role', null, `update public.payments set status = 'failed', failure_reason = 'closed_for_test' where id = $1`, [id])
        await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'sweep')`, [id])
      }
    }

    it('with every address failing, every record still gets its turn', async () => {
      await insertOpen(30)
      H.emails = []
      H.emailMode = 'fail'
      const { sendPendingExceptionAlerts } = await import('@/lib/payments/payment-exceptions')
      const seen = new Set<string>()
      const random = vi.spyOn(Math, 'random')
      for (const r of [0, 0.2, 0.4, 0.6, 0.8]) {
        random.mockReturnValue(r)
        H.emails = []
        await sendPendingExceptionAlerts()
        for (const m of H.emails) seen.add(m.reference)
      }
      random.mockRestore()
      expect(seen.size).toBe(30)
    })

    it('a healthy run drains a backlog of 30 in two runs', async () => {
      await insertOpen(30)
      const { sendPendingExceptionAlerts } = await import('@/lib/payments/payment-exceptions')
      await sendPendingExceptionAlerts()
      await sendPendingExceptionAlerts()
      const [{ n }] = await asSuper(`select count(*)::int as n from public.payment_exceptions where alert_sent_at is null`)
      expect(n).toBe(0)
    })

    it('alerts still go out when PayTech processing is unavailable', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set alert_sent_at = null`)
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      H.emails = []
      vi.stubEnv('PAYTECH_TEST_API_KEY', '')

      const res = await sweep()

      expect(res.status).toBe(503)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('an unauthenticated caller reaches none of it', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set alert_sent_at = null`)
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      H.emails = []
      expect((await sweep('Bearer wrong')).status).toBe(401)
      expect((await sweep(null)).status).toBe(401)
      expect(H.emails).toHaveLength(0)
    })

    it('a finished sweep leaves a dated row with counts only, and the page can read it', async () => {
      const { lastSweepFinishedAt } = await import('@/lib/payments/payment-exceptions')
      expect(await lastSweepFinishedAt()).toEqual({ readable: true, at: null })

      expect((await sweep()).status).toBe(200)

      const after = await lastSweepFinishedAt()
      expect(after.readable).toBe(true)
      expect(after.at).not.toBeNull()
      const [row] = await asSuper(`select metadata, outcome, actor_type from public.audit_log where event_type = 'payment.reconciliation_sweep_finished'`)
      expect(row).toMatchObject({ outcome: 'success', actor_type: 'system' })
      expect(Object.values(row.metadata).every(v => typeof v === 'number')).toBe(true)
    })

    it('a sweep that could not run leaves no such row', async () => {
      vi.stubEnv('PAYTECH_TEST_API_KEY', '')
      expect((await sweep()).status).toBe(503)
      const { lastSweepFinishedAt } = await import('@/lib/payments/payment-exceptions')
      expect((await lastSweepFinishedAt()).at).toBeNull()
    })

    it('a sweep on a database this deployment may not act on writes nothing', async () => {
      await setEnvironment('live')
      expect((await sweep()).status).toBe(503)
      await setEnvironment('sandbox')
      const { lastSweepFinishedAt } = await import('@/lib/payments/payment-exceptions')
      expect((await lastSweepFinishedAt()).at).toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — reports arriving together', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()

    it('two different notifications at once on a completed payment: one is covered and the other reaches a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')

      await Promise.all([ipn(token, { client_phone: '771111111' }), ipn(token, { client_phone: '772222222' })])

      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(e.different_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
    })

    it('a notification and a sweep at once: the payment completes once and the notification is covered', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 90)

      await Promise.all([ipn(token), sweep(), sweep()])

      expect((await rowFor(token)).status).toBe('completed')
      expect((await counts()).audits).toBe(1)
      expect((await entitlementsOf(L1))).toHaveLength(1)
      expect(await needsHuman()).toBe(0)
    })

    it('two different notifications and a sweep at once, then completion: nothing is lost', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await age(token, 90)
      await Promise.all([ipn(token, { client_phone: '771111111' }), ipn(token, { client_phone: '772222222' }), sweep()])
      says(token, 'completed')

      await Promise.all([sweep(), ipn(token, { client_phone: '772222222' })])

      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).evidence_fingerprints).toHaveLength(2)
      expect(await needsHuman()).toBe(1)
    })

    it('twelve copies of one notification at once on a completed payment never block and never call it different', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      H.emails = []

      await Promise.all(Array.from({ length: 12 }, () => ipn(token)))

      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(12)
      expect(e.different_report_at).toBeNull()
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect(H.emails).toHaveLength(0)
    })

    it('a payment completing while a different notification is being checked: that one is still kept', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      P.duringStatus = async () => { expect((await ipn(token, { client_phone: '771111111' })).body.detail).toBe('completed') }

      const res = await ipn(token, { client_phone: '772222222' })

      expect(res.status).toBe(200)
      expect((await rowFor(token)).status).toBe('completed')
      expect((await counts()).audits).toBe(1)
      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(e.different_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
    })

    it('a review racing a different notification: refused, so it cannot be marked reviewed unseen', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { client_phone: '771111111' })
      const e = await exceptionFor(token)
      const form = { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: String(e.evidence_fingerprints.length) }

      const [, notice] = await Promise.all([ipn(token, { client_phone: '772222222' }), exAction('dismissException', form)])

      const after = await exceptionFor(token)
      if (notice === 'exception_dismiss_done') {
        // The decision went first, so what arrived after it is judged as new evidence.
        expect(after.state).toBe('open')
        expect(after.reviewed_fingerprints).toEqual(e.evidence_fingerprints)
      } else {
        expect(notice).toBe('exception_refused_evidence_changed')
        expect(after.state).toBe('open')
        expect(after.reviewed_fingerprints).toEqual([])
      }
      expect(after.evidence_fingerprints).toHaveLength(2)
    })

    it('a sweep completing the payment while its notification is being checked does not count it as a repeat', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await age(token, 90)
      H.emails = []
      P.duringStatus = async () => { await sweep() }

      await ipn(token)

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', repeat_count: 0 })
      expect(e.post_settlement_report_at).toBeNull()
      expect(await needsHuman()).toBe(0)
    })

    it('a closure racing a paid notification leaves the record open for a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      await age(token, 90)

      await Promise.all([ipn(token), sweep()])

      expect((await rowFor(token)).status).toBe('failed')
      expect((await exceptionFor(token)).state).toBe('open')
    })
  })

  describe('XP-PAYTECH-06B — 064 refuses a database it could not protect', () => {
    /** Take 064 out, change the database, and put it all back whatever happens. */
    async function refusedWhen(change: string, undo: string, why: RegExp) {
      await rollback064()
      await db.exec(change)
      try {
        await expect(db.exec(M064)).rejects.toThrow(why)
        await db.exec('rollback').catch(() => undefined)
      } finally {
        await db.exec(undo)
        await apply064Then065()
      }
    }

    it('service_role without BYPASSRLS, because checkout would then see nothing blocking it', async () => {
      await refusedWhen('alter role service_role nobypassrls', 'alter role service_role bypassrls', /does not bypass row level security/)
    })

    it('an entitlements table without a column an access decision reads', async () => {
      await refusedWhen(
        'alter table public.entitlements rename column created_at to created_on',
        'alter table public.entitlements rename column created_on to created_at',
        /does not have the columns 037 created/,
      )
    })

    it('running it twice says that, rather than naming a trigger', async () => {
      await expect(db.exec(M064)).rejects.toThrow(/tables already exist/)
      await db.exec('rollback').catch(() => undefined)
    })

    it('its rollback removes the second table and its guard as well', async () => {
      await rollback064()
      const [{ t, g }] = await asSuper(`select to_regclass('public.payment_completion_notices') as t, to_regprocedure('public.payment_completion_notices_guard()') as g`)
      await apply064Then065()
      expect(t).toBeNull()
      expect(g).toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — what happens to a learner through all of this', () => {
    it('a legitimate notification delivered twice on a closed, reviewed attempt never blocks a new checkout', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: String(e.evidence_fingerprints.length) })
      await ipn(token)
      await ipn(token)

      expect((await exceptionFor(token)).state).toBe('resolved')
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('a conflicting notification on an in-flight payment is held, the payment can still complete, and it is then only flagged', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { currency: 'EUR' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'currency_mismatch' })
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect(e.post_settlement_report_at).not.toBeNull()
    })

    it('a paid notification kept during a transient refusal survives if no retry ever comes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      H.rpcFaultFor = { fn: 'complete_payment', error: { message: 'simulated', code: 'XX000' } }
      const res = await ipn(token)
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'watching', last_signal: 'paid_hint' })
      expect(e.evidence_fingerprints).toHaveLength(1)
    })

    it('its retry then completes the payment without counting as a repeat of itself', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      H.rpcFaultFor = { fn: 'complete_payment', error: { message: 'simulated', code: 'XX000' } }
      await ipn(token)
      H.rpcFaultFor = null
      H.emails = []

      expect((await ipn(token)).body.detail).toBe('completed')

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', repeat_count: 0 })
      expect(e.different_report_at).toBeNull()
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('rolling back refuses while a second notification is still due an alert', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { client_phone: '771111111' })
      await ageException(token, 48)
      await sweep()
      await ipn(token, { client_phone: '772222222' })
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/unsettled exceptions exist/)
      await db.exec('rollback').catch(() => undefined)
    })
  })

  describe('XP-PAYTECH-06B — a provider\'s answer is kept, wherever it lands', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const reviewed = reviewedForm

    it('a conflict on an escalated record survives the payment completing', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open' })
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('settlement_amount_mismatch')

      says(token, 'completed')
      await sweep()

      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', resolution: null })
      expect(await needsHuman()).toBe(1)
    })

    it('an escalated record with no conflict still settles by itself', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect(await needsHuman()).toBe(0)
    })

    it.each([
      ['a re-check', async (id: string) => { await exAction('recheckException', { exceptionId: id }) }],
    ])('paid at another amount on a completed payment is recorded, on %s', async (_name, ask) => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const { id } = await exceptionFor(token)
      says(token, 'completed', PRICE_C1 + 1)

      await ask(id)

      expect(await exceptionFor(token)).toMatchObject({
        state: 'open', last_signal: 'amount_mismatch', provider_answer: 'settlement_amount_mismatch',
      })
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('paid at another amount on a cancellation notification is recorded too', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', PRICE_C1 + 1)

      await ipn(token, { type_event: 'sale_canceled' })

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch' })
    })

    it('paid in another currency is recorded as well', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      P.status.set(token, { success: 1, payment: { status: 'completed', amount: PRICE_C1, currency: 'EUR', ref_command: P.refs.get(token) } })
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_currency_mismatch' })
    })

    it('paid at the right amount is still no conflict', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a scheduled "not paid" on a record awaiting a refund decision is recorded once, and alerted', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      await sweep()
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      const before = await exceptionFor(token)

      await sweep()

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ provider_answer: 'provider_not_paid', refund_state: 'required' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      const audit = (await exceptionAudit()).map(r => r.event_type)
      expect(audit).toContain('payment.exception_provider_answer_recorded')

      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect((await exceptionFor(token)).report_count).toBe(before.report_count + 1)
    })

    it('that answer makes a refund form out of date, so the refund cannot pass over it', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      const form = { ...refundFields(id), ...reviewed(await exceptionFor(token)) }
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await sweep()

      expect(await exAction('recordExceptionRefund', form)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).refund_state).toBe('required')
    })

    it('a provider\'s new answer on a record already alerted on alerts again, and an old form is refused', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      const old = await exceptionFor(token)
      expect(old.state).toBe('open')
      await sweep()
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)

      await sweep()

      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await exAction('dismissException', reviewed(old))).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
    })

    it('"not paid" on a just-closed attempt adds to the record without raising a second alert', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'canceled')
      await age(token, 20)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_answer: 'provider_not_paid' })
    })

    it('after a refund, the provider saying it can still be paid is flagged once', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(id), evidenceCount: reviewed(await exceptionFor(token)).evidenceCount })
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending')

      await sweep()

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.provider_answer).toBe('provider_pending')
      await exAction('acknowledgeExceptionReport', reviewed(e))
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
    })

    it('"still payable" still cannot undo a dismissal', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('a refunded payment is still asked about, so a different amount after the refund is found', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(id), attestAll: 'yes', evidenceCount: reviewed(await exceptionFor(token)).evidenceCount })
      expect((await rowFor(token)).status).toBe('refunded')
      says(token, 'completed', PRICE_C1 + 1)

      await sweep()

      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — an attempt the provider contradicts has an honest way out', () => {
    const reviewed = reviewedForm
    const close = (id: string) => adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: 'Vérifié, rien reçu au tableau de bord.', attest: 'yes' })
    const answer = (token: string, status: string, amount = PRICE_C1 + 1) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency: 'XOF', ref_command: P.refs.get(token) } })

    it.each(['pending', 'failed', 'canceled'])('the provider answers %s at another amount: recorded, closed by an attested check, no false refund', async (word) => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      answer(token, word)
      await age(token, 90)
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('settlement_amount_mismatch')
      expect((await rowFor(token)).status).not.toBe('failed')
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()

      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_conflict')

      expect(await close(id)).toBe('close_done_exception')
      expect((await rowFor(token)).status).toBe('expired')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')

      const again = await checkout(user(L1), C1)
      expect(again.error).toBeUndefined()
      expect(again.redirectUrl).toBeDefined()
      expect((await exceptionFor(token)).refund_state).toBe('not_required')
    })

    it('a notification hitting that conflict is acknowledged, and its digest is kept', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      answer(token, 'failed')
      const res = await ipn(token)
      expect(res.status).toBe(200)
      expect(res.body.detail).toBe('conflict:settlement_amount_mismatch')
      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect(e.last_signal).toBe('amount_mismatch')
    })

    it('in another currency, it behaves the same', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      P.status.set(token, { success: 1, payment: { status: 'failed', amount: PRICE_C1, currency: 'EUR', ref_command: P.refs.get(token) } })
      await age(token, 90)
      await sweep()
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_conflict')
      expect(await close(id)).toBe('close_done_exception')
    })

    it('the provider saying PAID at another amount still cannot be closed as unpaid', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      answer(token, 'completed')
      await age(token, 90)
      await sweep()
      expect(await close(id)).toBe('close_refused_provider_says_paid')
      expect(['pending', 'processing']).toContain((await rowFor(token)).status)
    })
  })

  describe('XP-PAYTECH-06B — a cancellation claimed by a notification', () => {
    const reviewed = reviewedForm

    it('on a closed attempt whose access decision rests on it: flagged, and the payment does not move', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      await exAction('recordExceptionAccess', reviewed(await exceptionFor(token)))
      H.emails = []

      expect((await ipn(token, { type_event: 'sale_canceled' })).status).toBe(200)

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.resolution).toBe('access_honoured')
      expect((await rowFor(token)).status).toBe('expired')
    })

    it('on an open record: kept, without rewriting what the record says', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token, { type_event: 'sale_canceled' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', last_signal: 'paid_hint' })
      expect(e.evidence_fingerprints).toHaveLength(2)
    })

    it('on an in-flight payment being watched: kept', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      await ipn(token, { type_event: 'sale_canceled' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'watching', last_signal: 'paid_hint' })
      expect(e.evidence_fingerprints).toHaveLength(2)
    })

    it('with nothing on record, or on a settled refund: nothing is written, because it proves nothing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      expect((await ipn(token, { type_event: 'sale_canceled' })).status).toBe(200)
      expect(await exceptionFor(token)).toBeNull()

      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(id), evidenceCount: reviewed(await exceptionFor(token)).evidenceCount })
      const before = await exceptionFor(token)
      await ipn(token, { type_event: 'sale_canceled' })
      expect((await exceptionFor(token)).report_count).toBe(before.report_count)
    })

    it('if it cannot be kept, it is retried', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }
      const res = await ipn(token, { type_event: 'sale_canceled' })
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
    })
  })

  describe('XP-PAYTECH-06B — what a completion covers cannot come apart from it', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()

    it('if it cannot be remembered, nothing completes and the notification is retried', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }

      expect((await ipn(token)).status).toBe(503)

      H.rpcFaultFor = null
      expect(['pending', 'processing']).toContain((await rowFor(token)).status)
      expect((await counts()).completed).toBe(0)
      expect((await ipn(token)).body.detail).toBe('completed')
      expect(await exceptionFor(token)).toBeNull()
    })

    it('so a later different notification cannot take its place, even if no retry ever comes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token, { client_phone: '771111111' })

      await ipn(token, { client_phone: '772222222' })

      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
    })

    it('a normal payment logs no warning about an exception', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect(H.logs.filter(l => l.level === 'warn' && l.args.includes('payment exception recorded'))).toHaveLength(0)
    })

    it('a completion refused for good keeps what it covered, on the record that says so', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason)
        values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', last_signal: 'completion_refused' })
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect(e.reviewed_fingerprints).toHaveLength(0)
    })

    it('the same notification while a different one is on record does not complete it twice or count itself', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { client_phone: '771111111' })
      says(token, 'completed')
      await ipn(token, { client_phone: '771111111' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', repeat_count: 0 })
      expect(e.post_settlement_report_at).toBeNull()
      expect((await counts()).audits).toBe(1)
    })

    it('a failed signature while in flight is not what the completion covers, so a real notification is told apart', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { hmac_compute: 'a'.repeat(64), client_phone: '771111111' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', first_signal: 'unverified_report' })
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.reviewed_fingerprints).toEqual([])
    })
  })

  describe('XP-PAYTECH-06B — only the provider can put a completed payment in question', () => {
    const reviewed = reviewedForm
    const completed = async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      return token
    }
    const refundOffered = async (token: string) => (await exceptionFor(token)).state === 'open'

    it.each([
      ['a rewritten amount', { final_item_price: '1' }, 'amount_mismatch'],
      ['a rewritten currency', { currency: 'EUR' }, 'currency_mismatch'],
      ['an unknown event', { type_event: 'refund_complete' }, 'unverified_report'],
    ])('%s is recorded on a settled record, so no refund is offered on it', async (_name, over, signal) => {
      const token = await completed()
      expect((await ipn(token, over)).status).toBe(200)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', different_signal: signal })
      expect(e.different_report_at).not.toBeNull()
      expect(await refundOffered(token)).toBe(false)
      expect((await rowFor(token)).status).toBe('completed')
      expect(await dbHasAccess(L1, C1)).toBe(true)
    })

    it('a cancellation during a provider outage is recorded the same way', async () => {
      const token = await completed()
      H.contract = null
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', different_signal: 'cancel_hint' })
      expect(await refundOffered(token)).toBe(false)
    })

    it('an administrator can then ask, and it is the provider\'s answer that opens it', async () => {
      const token = await completed()
      H.contract = null
      await ipn(token, { type_event: 'sale_canceled' })
      const { id } = await exceptionFor(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')

      await exAction('recheckException', { exceptionId: id })

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid' })
    })

    it('an administrator asking and hearing it was paid leaves it settled', async () => {
      const token = await completed()
      H.contract = null
      await ipn(token, { type_event: 'sale_canceled' })
      const { id } = await exceptionFor(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await exAction('recheckException', { exceptionId: id })
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('holding one notification, the most anyone can do is keep a weekly alert alive', async () => {
      const token = await completed()
      for (let i = 0; i < 6; i++) await ipn(token, { final_item_price: String(i + 1), client_phone: `77000000${i}` })
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.notification_reopens).toBe(0)
      await sweep()
      H.emails = []
      await ipn(token, { final_item_price: '9', client_phone: '770000009' })
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('a review of that record covers what it showed', async () => {
      const token = await completed()
      await ipn(token, { final_item_price: '1' })
      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      await ipn(token, { final_item_price: '1' })
      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(1)
      expect(e.different_report_at).toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — a decision covers every report on the record', () => {
    const reviewed = reviewedForm

    it('dismissing more than one report needs its own attestation', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { client_phone: '771111111' })
      await ipn(token, { client_phone: '772222222' })
      const { attestAll: _attestAll, ...form } = reviewed(await exceptionFor(token))

      expect(await exAction('dismissException', form)).toBe('close_attestation_required')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
    })

    it('one report needs none', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { attestAll: _attestAll, ...form } = reviewed(await exceptionFor(token))
      expect(await exAction('dismissException', form)).toBe('exception_dismiss_done')
    })

    it('a reopening by one administrator tells the others', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.emails = []
      await exAction('reopenExceptionAfterReview', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })
  })

  describe('XP-PAYTECH-06B — what a person decided, or the provider said, outlasts a completion', () => {
    const reviewed = reviewedForm
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()

    it('money an administrator confirmed on an escalated record stays open when the payment completes', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      await exAction('confirmExceptionReceipt', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
    })

    it('a provider mismatch, a dismissal, a paid notification, then completion: open, for a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      says(token, 'pending')
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe('watching')
      H.emails = []
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('money an administrator attested to on an in-flight attempt is flagged when the payment completes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { id } = await exceptionFor(token)
      expect(await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')
      expect((await exceptionFor(token)).state).toBe('open')
      H.emails = []
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      expect((await rowFor(token)).status).toBe('completed')
      expect(e.state).toBe('resolved')
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a reopening with nothing on the record is flagged on completion too, though it holds no notification', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'admin')`, [id])
      await ageException(token, 48)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: '0' })
      await exAction('reopenExceptionAfterReview', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })

    it('a dismissal on an attempt that then completes is flagged, and the payment holds', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.emails = []
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      const e = await exceptionFor(token)
      expect((await rowFor(token)).status).toBe('completed')
      expect(e).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return', payment_received: 'confirmed_by_provider' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('reopening a completed payment keeps what its completion covered', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(1)
      expect(e.different_report_at).toBeNull()
    })

    it('the provider paid at another amount on a closed attempt: a refund of what was received can be recorded', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', PRICE_C1 - 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })

      const notice = await exAction('recordExceptionRefund', {
        ...refundFields(id), amount: String(PRICE_C1 - 5000), evidenceCount: reviewed(await exceptionFor(token)).evidenceCount,
      })

      expect(notice).toBe('exception_refund_recorded')
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'refund_confirmed', refund_amount: PRICE_C1 - 5000 })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('with that answer on record, only its whole amount or the whole payment can be recorded', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', PRICE_C1 - 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      expect((await exceptionFor(token)).provider_amount).toBe(PRICE_C1 - 5000)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      const count = reviewed(await exceptionFor(token)).evidenceCount
      const attempt = (amount: number) => exAction('recordExceptionRefund', { ...refundFields(id), amount: String(amount), evidenceCount: count })

      expect(await attempt(1)).toBe('exception_refused_refund_partial_not_supported')
      expect(await attempt(PRICE_C1 - 5001)).toBe('exception_refused_refund_partial_not_supported')
      expect(await attempt(PRICE_C1 * 100)).toBe('exception_refused_refund_amount_invalid')
      expect((await exceptionFor(token)).state).toBe('open')

      expect(await attempt(PRICE_C1)).toBe('exception_refund_recorded')
    })

    it('a later "not paid" does not leave any amount recordable', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', PRICE_C1 - 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      says(token, 'failed')
      await sweep()
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: '5', evidenceCount: form.evidenceCount, attestAll: 'yes' })).toBe('exception_refused_refund_partial_not_supported')
    })

    it.each([['pending', 0], ['pending', -1]])('the provider answering %s at %d claims no amount, so it is what any pending answer is', async (word, amount) => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      P.status.set(token, { success: 1, payment: { status: word, amount, currency: 'XOF', ref_command: P.refs.get(token) } })
      expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', provider_answer: null, provider_amount: null })
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: 'Vérifié, rien reçu au tableau de bord.', attest: 'yes' })).toBe('close_refused_provider_says_pending')
    })

    it.each([['failed', 0], ['canceled', 0]])('the provider answering %s at %d claims no amount, and closes the attempt as it says', async (word, amount) => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: word, amount, currency: 'XOF', ref_command: P.refs.get(token) } })
      expect((await ipn(token)).status).toBe(200)
      expect((await rowFor(token)).status).toBe(word === 'failed' ? 'failed' : 'cancelled')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_amount: null })
      expect((await exceptionFor(token)).provider_answers).not.toContain('settlement_amount_mismatch')
    })

    it.each([[0], [-45000]])('the provider saying paid at %d is kept as a conflict, and proves no money', async (amount) => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: 'completed', amount, currency: 'XOF', ref_command: P.refs.get(token) } })
      expect((await ipn(token)).status).toBe(200)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'amount_mismatch', provider_amount: null, payment_received: 'reported' })
    })

    it('an amount on an unpaid answer is not what was received, so it cannot be refunded', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 - 5000)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ provider_answer: 'settlement_amount_mismatch', provider_amount: null })
    })

    it('the provider naming a different amount alerts again, leaves a trail, and only an amount it named can be recorded', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', PRICE_C1 - 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      const tab = reviewed(await exceptionFor(token))
      await sweep()
      H.emails = []
      says(token, 'completed', PRICE_C1 - 15000)

      await sweep()

      expect((await exceptionFor(token)).provider_amount).toBe(PRICE_C1 - 15000)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      const audit = (await exceptionAudit()).at(-1)!
      expect(audit.metadata).toMatchObject({ providerAmount: PRICE_C1 - 15000 })
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), ...tab, amount: String(PRICE_C1 - 15000) })).toBe('exception_refused_evidence_changed')
      const fresh = reviewed(await exceptionFor(token))
      const attempt = (amount: number) => exAction('recordExceptionRefund', { ...refundFields(id), amount: String(amount), evidenceCount: fresh.evidenceCount, attestAll: 'yes' })
      expect(await attempt(PRICE_C1 - 20000)).toBe('exception_refused_refund_partial_not_supported')
      expect(await attempt(PRICE_C1 - 15000)).toBe('exception_refund_recorded')
    })

    it('the provider then saying paid at our amount takes its other amount away', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', PRICE_C1 - 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      says(token, 'completed')

      await sweep()

      expect((await exceptionFor(token)).provider_amount).toBeNull()
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: String(PRICE_C1 - 5000), evidenceCount: form.evidenceCount, attestAll: 'yes' })).toBe('exception_refused_refund_partial_not_supported')
    })

    it('if the provider\'s closing answer cannot be kept, the alert about the record still goes out', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      H.emails = []
      says(token, 'failed')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }
      await ipn(token)
      H.rpcFaultFor = null
      expect((await rowFor(token)).status).toBe('failed')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('what a completion raises on an open record is audited', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await ipn(token)
      says(token, 'completed')
      await age(token, 90)
      const before = (await exceptionAudit()).length
      await sweep()
      expect((await exceptionAudit()).slice(before).map(r => r.event_type)).toContain('payment.exception_evidence_raised')
    })

    it('only the provider\'s word about the amount can carry one', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      const report = (detail: string, amount: number) => asRole('service_role', null,
        `select public.payment_exception_report($1, 'paid_hint', 'ipn', $2, null, $3)`, [id, detail, amount])
      await expect(report('ipn_amount_mismatch', 1)).rejects.toMatchObject({ detail: expect.stringContaining('invalid_provider_amount') })
      await expect(report('settlement_amount_mismatch', -1)).rejects.toMatchObject({ detail: expect.stringContaining('invalid_provider_amount') })
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a notification claiming another amount does not make that amount recordable', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { final_item_price: '1' })
      expect((await exceptionFor(token)).provider_amount).toBeNull()
    })

    it('a provider saying failed as it closes an attempt is kept on an access decision, and flags it', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      await exAction('recordExceptionAccess', reviewed(await exceptionFor(token)))
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await age(token, 90)

      await sweep()

      expect((await rowFor(token)).status).toBe('failed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ resolution: 'access_honoured', provider_answer: 'provider_not_paid' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a provider saying failed as it closes an attempt with confirmed receipt alerts again', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await sweep()
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await age(token, 90)

      await sweep()

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('if that answer cannot be kept, the notification carrying it is retried', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }
      const res = await ipn(token, { type_event: 'sale_canceled' })
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
    })

    it('an open record that stays open at completion no longer calls the money only reported', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
    })

    it('what a completion does to a record is audited', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      says(token, 'completed')
      await age(token, 90)
      const before = (await exceptionAudit()).length
      await sweep()
      expect((await exceptionAudit()).slice(before).map(r => r.event_type)).toContain('payment.exception_reported_after_settlement')
    })

    it('reopening a dismissed report that failed its check raises it, and it then blocks', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { hmac_compute: 'a'.repeat(64) })
      await ageException(token, 48)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'not_established' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await exAction('reopenExceptionAfterReview', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
    })

    it('a blank claimed amount claims nothing', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      const res = await ipn(token, { final_item_price: '  ' })
      expect(res.body.detail).toBe('completed')
      expect(await exceptionFor(token)).toBeNull()
    })

    it('with no such answer from the provider, a partial refund is still refused', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: String(PRICE_C1 - 5000), evidenceCount: form.evidenceCount })).toBe('exception_refused_refund_partial_not_supported')
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: String(PRICE_C1 + 5000), evidenceCount: form.evidenceCount })).toBe('exception_refused_refund_amount_invalid')
    })

    it('the warning before a close stays once an administrator has confirmed money', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      await sweep()
      const { paymentId, id } = { paymentId: (await rowFor(token)).id, id: (await exceptionFor(token)).id }
      const { watchedPaymentIds } = await import('@/lib/payments/payment-exceptions')
      expect((await watchedPaymentIds()).has(paymentId)).toBe(true)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      expect((await watchedPaymentIds()).has(paymentId)).toBe(true)
    })

    it('the warning before a close covers money the provider itself confirmed', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      const { watchedPaymentIds } = await import('@/lib/payments/payment-exceptions')
      expect((await watchedPaymentIds()).has((await rowFor(token)).id)).toBe(true)
    })

    it('a recent attempt behind more than 200 that keep answering pending is still reached', async () => {
      H.contract = FIXTURE_CONTRACT
      await asSuper(`insert into auth.users (id, email, email_confirmed_at)
        select ('30000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 's' || i || '@example.test', now() from generate_series(0, 204) i`)
      await asSuper(`insert into public.profiles (id, email, platform_role)
        select ('30000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 's' || i || '@example.test', 'user' from generate_series(0, 204) i`)
      await asSuper(`insert into public.payments (amount, currency, method, status, reference, provider, provider_mode, provider_token, user_id, course_id, created_at)
        select 45000, 'XOF', 'card', 'processing', 'SCX-STALE-' || i, 'paytech', 'test', 'stale-token-' || i,
               ('30000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, $1::uuid, now() - interval '30 days' + make_interval(mins => i)
          from generate_series(0, 204) i`, [C1])
      for (let i = 0; i <= 204; i++) { P.refs.set(`stale-token-${i}`, `SCX-STALE-${i}`); says(`stale-token-${i}`, 'pending') }
      const random = vi.spyOn(Math, 'random')
      const asked = new Set<string>()
      for (let r = 0; r < 12; r++) {
        random.mockReturnValue(r / 12)
        P.statusCalls = []
        await sweep()
        for (const t of P.statusCalls) asked.add(t)
      }
      random.mockRestore()
      expect(asked.has('stale-token-204')).toBe(true)
      expect(asked.has('stale-token-0')).toBe(true)
    })
  })

  describe('XP-PAYTECH-06B — a report that proves nothing blocks nobody', () => {
    it('a failed signature on a closed attempt stays in front of an administrator, and the learner can pay', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { hmac_compute: 'a'.repeat(64) })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'not_established' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)

      const r = await checkout(user(L1), C1)
      expect(r.error).toBeUndefined()
      expect(r.redirectUrl).toBeDefined()
    })

    it('a valid paid notification on the same record does block', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { hmac_compute: 'a'.repeat(64) })
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ last_signal: 'paid_hint', payment_received: 'reported' })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('"still payable" on a closed attempt does block, because the old link could still be paid', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'pending')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_pending' })
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })
  })

  describe('XP-PAYTECH-06B — a malformed notification', () => {
    it('nested too deep to read is refused, not thrown', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const res = await ipn(token, {}, { rawClientPhone: '['.repeat(30_000) + '1' + ']'.repeat(30_000) })
      expect(res.status).toBe(400)
      expect(await exceptionFor(token)).toBeNull()
      expect(['pending', 'processing']).toContain((await rowFor(token)).status)
    })
  })

  describe('XP-PAYTECH-06B — a completion does not settle what it does not cover', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const reviewed = reviewedForm

    it('a failed signature while in flight, then a sweep completes it: flagged, alerted and counted', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: String(PRICE_C1 * 2) }, { signAmount: PRICE_C1 * 2 })
      expect((await exceptionFor(token)).state).toBe('watching')
      H.emails = []
      says(token, 'completed')
      await age(token, 90)

      await sweep()

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('an unsigned rewrite in flight cannot leave a refund on offer once the payment completes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'amount_mismatch' })
      says(token, 'completed')

      await ipn(token)

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'settled_normally', refund_state: 'not_required' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      expect(await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })).toBe('exception_refused_exception_not_open')
    })

    it('money an administrator confirmed stays open when the payment completes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('a notification remembered for a completion that never came is not lost when the attempt closes', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', 'ipn_completing_payment', $2)`, [id, 'a'.repeat(64)])
      expect(await exceptionFor(token)).toBeNull()

      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_for_test' where id = $1`, [id])

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', first_signal: 'paid_hint', payment_received: 'reported' })
      expect(e.evidence_fingerprints).toEqual(['a'.repeat(64)])
      expect(e.reviewed_fingerprints).toEqual([])
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a closure with nothing remembered writes nothing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a paid notification with a remembered one before it is told apart while still in flight', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', 'ipn_completing_payment', $2)`, [id, 'a'.repeat(64)])
      says(token, 'pending')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(2)
      expect(e.reviewed_fingerprints).toEqual([])
    })

    it('the provider answering at another amount just as the payment completes is still kept', async () => {
      const token = await (async () => {
        H.contract = FIXTURE_CONTRACT
        const t = await startAndToken(user(L1))
        says(t, 'completed')
        await ipn(t)
        return t
      })()
      const { id } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch')`, [id])
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch' })
    })

    it('reviewing that record is possible, and the same answer again changes nothing', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', PRICE_C1 + 1)
      await age(token, 90)
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const before = await exceptionFor(token)
      await sweep()
      await sweep()
      const after = await exceptionFor(token)
      expect(after.report_count).toBe(before.report_count)
      expect(after.last_reported_at).toBe(before.last_reported_at)
    })
  })

  describe('XP-PAYTECH-06B — the provider saying it again, and saying it after a decision', () => {
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const reviewed = reviewedForm
    async function refunded() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(id), evidenceCount: reviewed(await exceptionFor(token)).evidenceCount })
      H.emails = []
      return { token, id }
    }

    it('"still payable" on a dismissed attempt is marked and alerted on once, and blocks nobody', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'pending')

      await sweep()

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', different_signal: 'provider_pending', provider_answer: 'provider_pending' })
      expect(e.different_report_at).not.toBeNull()
      expect(await needsHuman()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()

      await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))
      H.emails = []
      await sweep()
      await sweep()
      expect((await exceptionFor(token)).different_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('the sweep asking about a refunded payment again and again writes nothing', async () => {
      const { token } = await refunded()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      const before = await exceptionFor(token)
      await sweep()
      await sweep()
      const after = await exceptionFor(token)
      expect(after.report_count).toBe(before.report_count)
      expect(after.last_signal).toBe(before.last_signal)
      expect(after.last_reported_at).toBe(before.last_reported_at)
    })

    it('an administrator asking again and hearing the same "not paid" does not reopen a dismissal', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { id } = await exceptionFor(token)
      for (let i = 0; i < 3; i++) {
        await exAction('recheckException', { exceptionId: id })
        expect((await exceptionFor(token)).state).toBe('resolved')
      }
    })

    it('a mistaken dismissal of what the provider said can be undone, and a refund reached', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', PRICE_C1 + 1)
      await ipn(token, { type_event: 'sale_canceled' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { id } = await exceptionFor(token)
      expect((await exceptionFor(token)).state).toBe('resolved')

      expect(await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')

      expect((await exceptionFor(token)).state).toBe('open')
      expect(await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })).toBe('exception_require_refund_done')
    })

    it('with nothing from the provider, a reopening on a completed payment still only flags', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.post_settlement_report_at).not.toBeNull()
    })

    it('an administrator hearing "failed" does not turn a record that blocked nobody into a block', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token, { hmac_compute: 'a'.repeat(64) })
      const { id } = await exceptionFor(token)
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
      const started = await rowFor(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')

      await exAction('recheckException', { exceptionId: id })

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ last_signal: 'unverified_report', provider_answer: 'provider_not_paid', state: 'open' })
      const blocked = await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [started.user_id, started.course_id])
      expect(blocked[0].r).toBeNull()
    })

    it('a paid notification on a record the provider opened, with no digest yet, is alerted on and audited', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'pending')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_pending' })
      await sweep()
      H.emails = []
      const before = (await exceptionAudit()).length
      H.contract = null

      await ipn(token)

      const e = await exceptionFor(token)
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect((await exceptionAudit()).length).toBeGreaterThan(before)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('on a flagged, dismissed record, a variant of a cancellation the provider has answered only counts', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      says(token, 'completed')
      await ipn(token)
      await exAction('reopenExceptionAfterReview', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes' })
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()

      await ipn(token, { type_event: 'sale_canceled', client_phone: '771234567' })

      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.repeat_count).toBe(1)
    })

    it('its rollback refuses while repeats are unreviewed, even with no alert due', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await ipn(token)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.repeat_count).toBe(1)
      expect(e.repeat_alert_due_at).toBeNull()
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/unsettled exceptions exist/)
      await db.exec('rollback').catch(() => undefined)
    })
  })

  describe('XP-PAYTECH-06B — the sweep reaches attempts behind older ones', () => {
    it('30 attempts stale, more than one run asks about: each is reached over a few runs', async () => {
      H.contract = FIXTURE_CONTRACT
      for (let i = 0; i < 30; i++) {
        const uid = `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        await asSuper(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [uid, `s${i}@example.test`])
        await asSuper(`insert into public.profiles (id, email, platform_role) values ($1, $2, 'user')`, [uid, `s${i}@example.test`])
        await asSuper(
          `insert into public.payments (amount, currency, method, status, reference, provider, provider_mode, provider_token, user_id, course_id, created_at)
           values (45000, 'XOF', 'card', 'processing', $1, 'paytech', 'test', $2, $3, $4, now() - interval '2 hours' - make_interval(mins => $5::int))`,
          [`SCX-STALE-${i}`, `stale-token-${i}`, uid, C1, 60 - i],
        )
        P.refs.set(`stale-token-${i}`, `SCX-STALE-${i}`)
        says(`stale-token-${i}`, 'pending')
      }
      const random = vi.spyOn(Math, 'random')
      const asked = new Set<string>()
      for (const r of [0, 0.2, 0.4, 0.6, 0.8]) {
        random.mockReturnValue(r)
        P.statusCalls = []
        await sweep()
        for (const t of P.statusCalls) asked.add(t)
      }
      random.mockRestore()
      expect(asked.size).toBe(30)
    })
  })

  describe('XP-PAYTECH-06B — behaviour pinned after the final mutation run', () => {
    const reviewed = reviewedForm
    const paymentAlerts = async () => { H.emails = []; await sweep(); return H.emails }
    const report = (id: string, signal: string, source: string, detail: string | null = null, fingerprint: string | null = null) =>
      asRole('service_role', null, `select public.payment_exception_report($1, $2, $3, $4, $5) as r`, [id, signal, source, detail, fingerprint])
        .then(rows => rows[0].r as Record<string, unknown>)

    // No caller reports from a notification without a digest today, and a real status check
    // takes a later branch. This pins the guard against a direct call.
    it('a mismatch already on record, with no digest, reopens no dismissal, whatever a notification wrote since', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      P.status.set(token, { success: 1, payment: { status: 'failed', amount: PRICE_C1 + 1, currency: 'XOF', ref_command: P.refs.get(token) } })
      await age(token, 90)
      await sweep()
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: 'Vérifié, rien reçu au tableau de bord.', attest: 'yes' })).toBe('close_done_exception')
      await report(id, 'paid_hint', 'ipn', null, 'a'.repeat(64))
      expect((await exceptionFor(token)).last_signal).toBe('paid_hint')
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await report(id, 'amount_mismatch', 'ipn', 'settlement_amount_mismatch')

      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return' })
    })

    it('past the digest cap, the queue counts the overflow, so its own form is not refused as out of date', async () => {
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      for (let n = 0; n < 21; n++) await report(id, 'paid_hint', 'ipn', null, String(n).padStart(64, 'a'))
      const [shown] = (await paymentExceptionQueue())!
      expect(shown).toMatchObject({ evidenceCount: 21, notificationCount: 21, evidenceOverflow: true })

      const notice = await exAction('dismissException', { ...reviewed(await exceptionFor(token)), evidenceCount: String(shown.evidenceCount) })

      expect(notice).toBe('exception_dismiss_done')
    })

    it('only a successful sweep of this exact event counts as a finished one', async () => {
      const { lastSweepFinishedAt } = await import('@/lib/payments/payment-exceptions')
      const write = (event: string, outcome: string) => asSuper(
        `insert into public.audit_log (event_type, actor_type, outcome, metadata) values ($1, 'system', $2, '{}'::jsonb)`, [event, outcome])
      await write('payment.reconciliation_sweep_finished', 'failure')
      await write('payment.exception_recorded', 'success')
      expect(await lastSweepFinishedAt()).toEqual({ readable: true, at: null })

      await sweep()
      const finished = (await lastSweepFinishedAt()).at
      expect(finished).not.toBeNull()
      await asSuper(`select pg_sleep(0.01)`)
      await write('payment.reconciliation_sweep_finished', 'failure')
      await write('payment.exception_recorded', 'success')
      expect((await lastSweepFinishedAt()).at).toBe(finished)
    })

    it('the rollback refuses while an alert is due, even with no repeat counted', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      await report(id, 'paid_hint', 'ipn', null, 'b'.repeat(64))
      await exAction('dismissException', { exceptionId: (await exceptionFor(token)).id, note: NOTE, attest: 'yes', attestAll: 'yes' })
      await db.exec(`alter table public.payment_exceptions disable trigger payment_exceptions_guard;
        update public.payment_exceptions set repeat_alert_due_at = now() where payment_id = '${id}';
        alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', repeat_count: 0 })
      expect(e.post_settlement_report_at).toBeNull()
      expect(e.repeat_alert_due_at).not.toBeNull()

      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/unsettled exceptions exist/)
      await db.exec('rollback').catch(() => undefined)
    })

    it('the same notification remembered twice before a completion is one notification, and opens no record', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)

      expect((await report(id, 'paid_hint', 'ipn', 'ipn_completing_payment', 'a'.repeat(64))).outcome).toBe('completion_noted')
      expect((await report(id, 'paid_hint', 'ipn', 'ipn_completing_payment', 'a'.repeat(64))).outcome).toBe('replayed')

      expect(await exceptionFor(token)).toBeNull()
    })

    it('a retry after a failed completion settles what the failure kept, and alerts nobody', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await asSuper(`create trigger harness_fault before insert on public.entitlements for each row execute function public.harness_fail()`)
      expect((await ipn(token)).status).toBe(503)
      await asSuper(`drop trigger harness_fault on public.entitlements`)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', report_count: 1 })

      expect((await ipn(token)).body.detail).toBe('completed')

      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect((await paymentAlerts())).toHaveLength(0)
    })

    it('a closed attempt is never taken as completing: the paid notification opens a record', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')

      const r = await report(id, 'paid_hint', 'ipn', 'ipn_completing_payment', 'a'.repeat(64))

      expect(r.outcome).toBe('created')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', first_signal: 'paid_hint', evidence_fingerprints: ['a'.repeat(64)] })
      const [{ n }] = await asSuper(`select count(*)::int as n from public.payment_completion_notices where payment_id = $1`, [id])
      expect(n).toBe(0)
    })

    it('the first notification on a record the provider opened is audited and alerted on', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      const before = await exceptionFor(token)
      expect(before.state).toBe('open')
      expect(before.alert_sent_at).not.toBeNull()
      expect(before.evidence_fingerprints).toEqual([])
      H.emails = []
      H.contract = null

      await ipn(token)

      const after = await exceptionFor(token)
      expect(after.evidence_fingerprints).toHaveLength(1)
      expect(after.repeat_alert_due_at).not.toBeNull()
      expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_different_report_recorded')
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('"not paid" on a report nobody has confirmed is kept, and alerts nobody again', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      const before = await exceptionFor(token)
      expect(before).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect(before.alert_sent_at).not.toBeNull()
      H.emails = []
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')

      await adminAction('verifyPaytechPayment', { paymentId: id })

      const after = await exceptionFor(token)
      expect(after.provider_answers).toEqual(['provider_not_paid'])
      expect(after.alert_sent_at).toEqual(before.alert_sent_at)
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('the provider closing an attempt: its answer is kept on the record that closure opened', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe('watching')
      says(token, 'failed')
      await age(token, 90)

      await sweep()

      expect((await rowFor(token)).status).toBe('failed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid', provider_answers: ['provider_not_paid'] })
    })

    it('if that answer cannot be kept, the check says so, and the record the closure opened is still alerted on', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      says(token, 'pending')
      await ipn(token)
      says(token, 'failed')
      H.emails = []
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }

      const notice = await adminAction('verifyPaytechPayment', { paymentId: id })

      H.rpcFaultFor = null
      expect(notice).toBe('verify_exception_unrecorded')
      expect((await rowFor(token)).status).toBe('failed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answers: [] })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('an attempt still in flight, paid at another amount: the amount reaches the record and the queue', async () => {
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed', PRICE_C1 - 5000)

      await ipn(token)

      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'completion_refused', provider_amount: PRICE_C1 - 5000 })
      expect((await paymentExceptionQueue())![0].providerAmount).toBe(PRICE_C1 - 5000)
    })
  })

  describe('XP-PAYTECH-06B — the provider changing its amount', () => {
    const reviewed = reviewedForm
    const needsHuman = async () => (await import('@/lib/payments/payment-exceptions')).countOpenPaymentExceptions()
    const named = (e: { provider_amounts?: unknown[] }) => (e.provider_amounts ?? []).map(Number)
    async function namedAndAwaitingRefund(amount: number) {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', amount)
      await sweep()
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      return { token, id: id as string }
    }
    async function refundedAt(amount: number) {
      const { token, id } = await namedAndAwaitingRefund(amount)
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: String(amount), evidenceCount: form.evidenceCount })).toBe('exception_refund_recorded')
      H.emails = []
      return { token, id }
    }

    it('after a refund, another amount flags the record, alerts and leaves a trail, and only once', async () => {
      const { token } = await refundedAt(5000)
      says(token, 'completed', 9000)

      await sweep()

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e).toMatchObject({ resolution: 'refund_confirmed', refund_amount: 5000, provider_amount: 9000 })
      expect(named(e)).toEqual([5000, 9000])
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await needsHuman()).toBe(1)
      expect((await exceptionAudit()).at(-1)).toMatchObject({
        event_type: 'payment.exception_reported_after_settlement', metadata: { providerAmount: 9000 },
      })

      await exAction('acknowledgeExceptionReport', reviewed(e))
      H.emails = []
      await sweep()
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('after a refund of another amount, "paid at ours" flags the record and takes nothing off it', async () => {
      const { token } = await refundedAt(5000)
      says(token, 'completed')

      await sweep()

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.provider_amount).toBeNull()
      expect(named(e)).toEqual([5000, PRICE_C1])
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await exceptionAudit()).at(-1)!.event_type).toBe('payment.exception_reported_after_settlement')
    })

    it('after an access decision, another amount flags the record too', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 5000)
      await sweep()
      const { id } = await exceptionFor(token)
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, C1])
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionAccess', { exceptionId: id, note: NOTE, evidenceCount: form.evidenceCount })).toBe('exception_record_access_done')
      H.emails = []
      says(token, 'completed', 90000)

      await sweep()

      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.resolution).toBe('access_honoured')
      expect(named(e)).toEqual([5000, 90000])
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('on a dismissed record, another amount from the provider reopens it', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id: paymentId } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'amount_mismatch', 'sweep', 'settlement_amount_mismatch')`, [paymentId])
      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_for_test' where id = $1`, [paymentId])
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      says(token, 'completed', 5000)

      await sweep()

      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      expect(e.provider_amount).toBe(5000)
    })

    it('on a completed payment dismissed after one other amount, a second one reopens it', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      says(token, 'completed', 5000)
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_amount: 5000 })
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const { id } = await exceptionFor(token)
      expect((await exceptionFor(token)).state).toBe('resolved')
      says(token, 'completed', 9000)

      await exAction('recheckException', { exceptionId: id })

      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      expect(e.provider_amount).toBe(9000)
      expect(named(e)).toEqual([5000, 9000])
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('an amount it has named before is not news: alternating raises at most one alert a week, and flags nothing', async () => {
      const { token } = await namedAndAwaitingRefund(5000)
      says(token, 'completed', 9000)
      await sweep()
      H.emails = []
      const before = await exceptionFor(token)
      for (const amount of [5000, 9000, 5000]) {
        says(token, 'completed', amount)
        await sweep()
      }
      const e = await exceptionFor(token)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(e.provider_amount).toBe(5000)
      expect(named(e)).toEqual([5000, 9000])
      expect(e.alert_sent_at).toEqual(before.alert_sent_at)
      expect(e.post_settlement_report_at).toBeNull()
    })

    it('saying the same amount again on a refunded record writes nothing', async () => {
      const { token } = await refundedAt(5000)
      const before = await exceptionFor(token)
      await sweep()
      await sweep()
      const after = await exceptionFor(token)
      expect(after.report_count).toBe(before.report_count)
      expect(after.last_reported_at).toBe(before.last_reported_at)
      expect(after.post_settlement_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('the amounts it can name are bounded, and the next one still reaches a person and is kept as the last', async () => {
      H.contract = null
      const { token, id: paymentId } = await closedAttempt('expired')
      for (let amount = 1; amount <= 21; amount++) {
        await asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, $2)`, [paymentId, amount])
      }
      await sweep()
      H.emails = []
      const atCap = await exceptionFor(token)
      expect(named(atCap)).toHaveLength(20)
      expect(atCap.provider_amount).toBe(21)
      expect(atCap.repeat_alert_due_at).toBeNull()
      expect(atCap.repeat_alerted_at).not.toBeNull()

      await asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, 22)`, [paymentId])

      const past = await exceptionFor(token)
      expect(named(past)).toHaveLength(20)
      expect(past.provider_amount).toBe(22)
      expect(past.alert_sent_at).toEqual(atCap.alert_sent_at)
      expect(new Date(past.repeat_alert_due_at).getTime()).toBe(new Date(atCap.repeat_alerted_at).getTime() + 7 * 24 * 3600 * 1000)
    })

    it('a payment completing takes the other amount away, tells someone, and only what it was paid at can be refunded', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed', 5000)
      await age(token, 90)
      await sweep()
      expect((await exceptionFor(token)).provider_amount).toBe(5000)
      H.emails = []
      says(token, 'completed')

      await sweep()

      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      expect(e.provider_amount).toBeNull()
      expect(named(e)).toEqual([5000, PRICE_C1])
      expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_provider_answer_recorded')
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)

      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      const form = reviewed(await exceptionFor(token))
      const attempt = (amount: number) => exAction('recordExceptionRefund', { ...refundFields(e.id), amount: String(amount), evidenceCount: form.evidenceCount, attestAll: 'yes' })
      expect(await attempt(5000)).toBe('exception_refused_refund_partial_not_supported')
      expect((await rowFor(token)).status).toBe('completed')
      expect(await attempt(PRICE_C1)).toBe('exception_refund_recorded_access_live')
    })

    it('when the provider says it was paid more than we charged, the amount charged needs a further attestation', async () => {
      const { token, id } = await namedAndAwaitingRefund(90000)
      const form = reviewed(await exceptionFor(token))
      const attempt = (amount: number) => exAction('recordExceptionRefund', { ...refundFields(id), amount: String(amount), evidenceCount: form.evidenceCount })

      expect(await attempt(PRICE_C1)).toBe('exception_refused_refund_charged_attestation_required')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await attempt(90000)).toBe('exception_refund_recorded')
    })

    async function completedThenNamed(amount: number) {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      says(token, 'completed', amount)
      await ipn(token, { type_event: 'sale_canceled' })
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      return { token, id: id as string }
    }
    const refundOf = async (token: string, id: string, amount: number) => exAction('recordExceptionRefund', {
      ...refundFields(id), amount: String(amount), evidenceCount: reviewed(await exceptionFor(token)).evidenceCount, attestAll: 'yes',
    })

    it('a completed payment is never refunded below what it was paid at, whatever the provider says now', async () => {
      const { token, id } = await completedThenNamed(5000)

      expect(await refundOf(token, id, 5000)).toBe('exception_refused_refund_partial_not_supported')

      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await refundOf(token, id, PRICE_C1)).toBe('exception_refund_recorded_access_live')
      expect((await rowFor(token)).status).toBe('refunded')
    })

    it('a completed payment the provider says was paid more can be refunded at that, and at the amount charged only under a further attestation', async () => {
      const { token, id } = await completedThenNamed(90000)
      expect(await refundOf(token, id, PRICE_C1)).toBe('exception_refused_refund_charged_attestation_required')
      expect(await refundOf(token, id, 90000)).toBe('exception_refund_recorded_access_live')
    })

    it('the provider naming the other amount again after a completion does not reopen the way to a partial refund', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed', 5000)
      await age(token, 90)
      await sweep()
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      const { id } = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      says(token, 'completed', 5000)

      await exAction('recheckException', { exceptionId: id })

      expect((await exceptionFor(token)).provider_amount).toBe(5000)
      expect(await refundOf(token, id, 5000)).toBe('exception_refused_refund_partial_not_supported')
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('on a closed attempt, a lower amount named after a higher one can be recorded only under the attestation covering both', async () => {
      const { token, id } = await namedAndAwaitingRefund(90000)
      says(token, 'completed', 5000)
      await sweep()
      const form = reviewed(await exceptionFor(token))
      const attempt = (extra: Record<string, string>) => exAction('recordExceptionRefund', { ...refundFields(id), amount: '5000', evidenceCount: form.evidenceCount, ...extra })

      expect(await attempt({ attestAll: '' })).toBe('close_attestation_required')
      expect(await attempt({ attestAll: 'yes' })).toBe('exception_refund_recorded')
      expect(named(await exceptionFor(token))).toEqual([90000, 5000])
    })

    it('when it said less, either its amount or the amount charged can still be recorded', async () => {
      const { token, id } = await namedAndAwaitingRefund(5000)
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), amount: String(PRICE_C1), evidenceCount: form.evidenceCount })).toBe('exception_refund_recorded')
      expect((await exceptionFor(token)).refund_amount).toBe(PRICE_C1)
    })

    it('a new amount makes a form from before it out of date, and the queue counts it the same way', async () => {
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      const { token, id } = await namedAndAwaitingRefund(5000)
      const stale = reviewed(await exceptionFor(token))
      expect(stale.evidenceCount).toBe('1')
      says(token, 'completed', 9000)
      await sweep()
      const attempt = (form: Record<string, string>) => exAction('recordExceptionRefund', { ...refundFields(id), ...form, amount: '9000' })

      expect(await attempt(stale)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).state).toBe('open')

      const [shown] = (await paymentExceptionQueue())!
      expect(shown).toMatchObject({ evidenceCount: 2, providerAmounts: [5000, 9000] })
      expect(await attempt({ evidenceCount: String(shown.evidenceCount), evidenceVersion: String(shown.evidenceVersion), attestAll: 'yes' })).toBe('exception_refund_recorded')
    })
  })

  describe('XP-PAYTECH-06B — the alert about a further notification', () => {
    it('on an open record it is at most weekly, so a sender cannot make it more frequent', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      const report = (fingerprint: string) => asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, $2)`, [id, fingerprint])
      await report('b'.repeat(64))
      expect(new Date((await exceptionFor(token)).repeat_alert_due_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      const alerted = await exceptionFor(token)
      expect(alerted.repeat_alerted_at).not.toBeNull()
      expect(alerted.repeat_alert_due_at).toBeNull()

      await report('c'.repeat(64))

      const due = new Date((await exceptionFor(token)).repeat_alert_due_at).getTime()
      expect(due).toBe(new Date(alerted.repeat_alerted_at).getTime() + 7 * 24 * 3600 * 1000)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })
  })

  describe('XP-PAYTECH-06B — what the last full review found', () => {
    const blocked = async () => (await checkout(user(L1), C1)).redirectUrl === undefined

    async function refunded() {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const { id } = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
      expect(await exAction('recordExceptionRefund', { ...refundFields(id), ...reviewedForm(await exceptionFor(token)) })).toBe('exception_refund_recorded')
      return { token, id: id as string }
    }

    /** Open, with a flag an administrator's reopening left on it, and a refund required. */
    async function openWithFlag() {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { item_price: '1' })
      await exAction('dismissException', reviewedForm(await exceptionFor(token)))
      says(token, 'completed')
      await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })
      const { id } = await exceptionFor(token)
      says(token, 'failed')
      await exAction('recheckException', { exceptionId: id })
      await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open' })
      expect(e.post_settlement_report_at).not.toBeNull()
      return { token, id: id as string }
    }

    describe('a form loaded before a flag was raised or cleared', () => {
      it('an acknowledgement loaded with no flag showing cannot clear one an administrator then raised', async () => {
        const { token, id } = await refunded()
        await ipn(token)
        const stale = reviewedForm(await exceptionFor(token))
        expect(stale.flagShown).toBeUndefined()
        expect(await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')
        const flagged = await exceptionFor(token)
        expect(flagged.post_settlement_report_at).not.toBeNull()
        expect(await blocked()).toBe(true)

        expect(await exAction('acknowledgeExceptionReport', stale)).toBe('exception_refused_evidence_changed')

        expect((await exceptionFor(token)).post_settlement_report_at).toBe(flagged.post_settlement_report_at)
        expect(await blocked()).toBe(true)

        expect(await exAction('acknowledgeExceptionReport', reviewedForm(flagged))).toBe('exception_acknowledge_report_done')
        expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
        expect(await blocked()).toBe(false)
      })

      it('an acknowledgement cannot clear the flag a completion raised after it was loaded', async () => {
        H.contract = FIXTURE_CONTRACT
        const token = await startAndToken(user(L1))
        says(token, 'pending')
        await ipn(token, { item_price: '1' })
        await exAction('dismissException', reviewedForm(await exceptionFor(token)))
        await ipn(token, { item_price: '1' })
        const before = await exceptionFor(token)
        expect(before.repeat_count).toBeGreaterThan(0)
        const stale = reviewedForm(before)
        says(token, 'completed')
        await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })
        expect((await rowFor(token)).status).toBe('completed')
        const flagged = await exceptionFor(token)
        expect(flagged.post_settlement_report_at).not.toBeNull()

        expect(await exAction('acknowledgeExceptionReport', stale)).toBe('exception_refused_evidence_changed')

        expect((await exceptionFor(token)).post_settlement_report_at).toBe(flagged.post_settlement_report_at)
      })

      it('a dismissal from before the flag is refused, and one from after it agrees with the record', async () => {
        const { token } = await openWithFlag()
        const e = await exceptionFor(token)
        expect(await exAction('dismissException', { ...reviewedForm(e), evidenceVersion: String(e.evidence_version - 1) })).toBe('exception_refused_evidence_changed')
        expect(await exAction('dismissException', reviewedForm(e))).toBe('exception_dismiss_done')
      })

      it('a refund form showing the flag agrees with the record', async () => {
        const { token, id } = await openWithFlag()
        await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
        await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })

        expect(await exAction('recordExceptionRefund', { ...refundFields(id), ...reviewedForm(await exceptionFor(token)) })).toBe('exception_refund_recorded_access_live')
      })

      it('a refund form is out of date once someone else has reviewed the flag it showed', async () => {
        const { token, id } = await openWithFlag()
        await exAction('confirmExceptionReceipt', { exceptionId: id, note: NOTE, attest: 'yes' })
        await exAction('requireExceptionRefund', { exceptionId: id, note: NOTE })
        const shown = await exceptionFor(token)
        const form = { ...refundFields(id), ...reviewedForm(shown) }
        expect(await exAction('acknowledgeExceptionReport', reviewedForm(shown))).toBe('exception_acknowledge_report_done')

        expect(await exAction('recordExceptionRefund', form)).toBe('exception_refused_evidence_changed')

        expect((await exceptionFor(token)).refund_state).toBe('required')
      })

      it('a flag already showing does not ask for the further attestation by itself', async () => {
        const { token, id } = await refunded()
        await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
        const e = await exceptionFor(token)
        expect(e.evidence_fingerprints).toHaveLength(1)
        const { attestAll, ...form } = reviewedForm(e)
        expect(attestAll).toBe('yes')

        expect(await exAction('acknowledgeExceptionReport', form)).toBe('exception_acknowledge_report_done')
      })
    })

    describe('a cancellation the provider answers as paid', () => {
      it('leaves nothing on the payment it completes, and tells nobody', async () => {
        H.contract = FIXTURE_CONTRACT
        const token = await startAndToken(user(L1))
        says(token, 'completed')

        await ipn(token, { type_event: 'sale_canceled' })

        expect((await rowFor(token)).status).toBe('completed')
        expect(await exceptionFor(token)).toBeNull()
        H.emails = []
        await sweep()
        expect(H.emails).toHaveLength(0)
      })
    })

    describe('a flag an administrator raised', () => {
      it('the queue says so until it is reviewed, and not for a flag a notification raised', async () => {
        const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
        const { token, id } = await refunded()

        await exAction('reopenExceptionAfterReview', { exceptionId: id, note: NOTE, attest: 'yes' })
        const flagged = await exceptionFor(token)
        expect(flagged.administrator_flagged_at).not.toBeNull()
        expect((await paymentExceptionQueue())![0].administratorFlaggedAt).toBe(flagged.administrator_flagged_at)

        await exAction('acknowledgeExceptionReport', reviewedForm(flagged))
        expect((await exceptionFor(token)).administrator_flagged_at).toBeNull()

        const paymentId = (await rowFor(token)).id
        await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, $2)`, [paymentId, 'b'.repeat(64)])
        expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
        expect((await paymentExceptionQueue())![0].administratorFlaggedAt).toBeNull()
      })
    })

    describe('a request that does not say what it showed', () => {
      async function twoNotifications() {
        H.contract = null
        const { token } = await closedAttempt('expired')
        await ipn(token)
        await ipn(token, { item_price: '1' })
        const e = await exceptionFor(token)
        expect(e.evidence_fingerprints).toHaveLength(2)
        return { token, id: e.id as string }
      }

      it('needs the further attestation to dismiss, and the record stays open', async () => {
        const { token, id } = await twoNotifications()

        expect(await exAction('dismissException', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('close_attestation_required')

        expect((await exceptionFor(token)).state).toBe('open')
      })

      it('needs it to record access, and to record a refund', async () => {
        const { id } = await twoNotifications()
        expect(await exAction('recordExceptionAccess', { exceptionId: id, note: NOTE })).toBe('close_attestation_required')
        const { attestAll, ...bare } = refundFields(id)
        expect(attestAll).toBe('yes')
        expect(await exAction('recordExceptionRefund', bare)).toBe('close_attestation_required')
      })

      it('a form that says it showed one report still does not need it', async () => {
        H.contract = null
        const { token } = await closedAttempt('expired')
        await ipn(token)
        const { id } = await exceptionFor(token)

        expect(await exAction('dismissException', { exceptionId: id, note: NOTE, attest: 'yes', evidenceCount: '1' })).toBe('exception_dismiss_done')
      })
    })
  })

  describe('XP-PAYTECH-06B — a form from before a change is refused, whatever a count would say', () => {
    const reviewed = reviewedForm
    const report = (id: string, fingerprint: string) =>
      asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, $2)`, [id, fingerprint])
    const unverified = (id: string, fingerprint: string) =>
      asRole('service_role', null, `select public.payment_exception_report($1, 'unverified_report', 'ipn', 'ipn_signature_mismatch', $2)`, [id, fingerprint])

    /** A refund already recorded on a closed attempt, then a further paid report: flagged. */
    async function flaggedAfterRefund() {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })).toBe('exception_refund_recorded')
      await ipn(token, { client_phone: '771111111' })
      const flagged = await exceptionFor(token)
      expect(flagged.post_settlement_report_at).not.toBeNull()
      return { token, id, exceptionId: e.id as string, flagged }
    }

    it('a flag raised again on a flagged record makes an older acknowledgement stale', async () => {
      const { token, exceptionId } = await flaggedAfterRefund()
      const tab = reviewed(await exceptionFor(token))
      expect(await exAction('reopenExceptionAfterReview', { exceptionId, note: NOTE, attest: 'yes' })).toBe('exception_reopen_after_review_done')
      const raised = (await exceptionFor(token)).administrator_flagged_at
      expect(raised).not.toBeNull()

      expect(await exAction('acknowledgeExceptionReport', tab)).toBe('exception_refused_evidence_changed')

      const after = await exceptionFor(token)
      expect(after.post_settlement_report_at).not.toBeNull()
      expect(after.administrator_flagged_at).toBe(raised)
      expect(await exAction('acknowledgeExceptionReport', reviewed(after))).toBe('exception_acknowledge_report_done')
    })

    it('a review and a new notification that cancel out cannot pass an older form', async () => {
      const { token, id, exceptionId } = await flaggedAfterRefund()
      const tab = reviewed(await exceptionFor(token))
      expect(await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))).toBe('exception_acknowledge_report_done')
      await unverified(id, 'c'.repeat(64))
      const held = await exceptionFor(token)
      expect(held.evidence_fingerprints).toContain('c'.repeat(64))
      expect(held.repeat_alert_due_at).not.toBeNull()

      expect(await exAction('acknowledgeExceptionReport', tab)).toBe('exception_refused_evidence_changed')

      const after = await exceptionFor2(exceptionId)
      expect(after.reviewed_fingerprints).not.toContain('c'.repeat(64))
      expect(after.repeat_alert_due_at).toBe(held.repeat_alert_due_at)
    })

    it('an amount named after a form loaded makes that refund form stale', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed')
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      expect(e.payment_received).toBe('confirmed_by_provider')
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      const tab = { ...refundFields(e.id), ...reviewed(await exceptionFor(token)) }

      says(token, 'completed', 500)
      await exAction('recheckException', { exceptionId: e.id })
      expect((await exceptionFor(token)).provider_amount).toBe(500)

      expect(await exAction('recordExceptionRefund', tab)).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).refund_state).toBe('required')
    })

    it.each([
      ['confirmExceptionReceipt', 'reported'],
      ['requireExceptionRefund', 'confirmed'],
      ['withdrawExceptionRefund', 'required'],
      ['withdrawExceptionReceipt', 'confirmed'],
      ['reopenExceptionAfterReview', 'dismissed'],
    ] as const)('%s refuses a form from before a change as well', async (action, stage) => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      const { id: exceptionId } = await exceptionFor(token)
      const base = { exceptionId, note: NOTE, attest: 'yes', attestAll: 'yes' }
      if (stage === 'confirmed' || stage === 'required') await exAction('confirmExceptionReceipt', base)
      if (stage === 'required') await exAction('requireExceptionRefund', base)
      if (stage === 'dismissed') await exAction('dismissException', base)
      const tab = reviewed(await exceptionFor(token))
      await unverified(id, 'd'.repeat(64))

      expect(await exAction(action, tab)).toBe('exception_refused_evidence_changed')
      expect(await exAction(action, reviewed(await exceptionFor(token)))).toBe(
        action === 'confirmExceptionReceipt' ? 'exception_confirm_received_done'
          : action === 'requireExceptionRefund' ? 'exception_require_refund_done'
          : action === 'withdrawExceptionRefund' ? 'exception_withdraw_refund_done'
          : action === 'withdrawExceptionReceipt' ? 'exception_withdraw_receipt_done'
          : 'exception_reopen_after_review_done')
    })

    it.each(['acknowledgeExceptionReport', 'recordExceptionAccess', 'reopenExceptionAfterReview', 'requireExceptionRefund'] as const)(
      '%s with no version says nothing about what it showed, and is refused', async (action) => {
        const { token, exceptionId } = await flaggedAfterRefund()
        const before = await exceptionFor(token)
        const notice = await exAction(action, { exceptionId, note: NOTE, attest: 'yes', attestAll: 'yes', evidenceCount: '1', evidenceVersion: '' })
        expect(notice).toBe('exception_refused_evidence_version_required')
        const after = await exceptionFor(token)
        expect(after.post_settlement_report_at).toBe(before.post_settlement_report_at)
        expect(after.repeat_alert_due_at).toBe(before.repeat_alert_due_at)
      })

    it('a dismissal with no version ends no alert', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      await ipn(token)
      H.emailMode = 'ok'
      const e = await exceptionFor(token)
      const notice = await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes', evidenceCount: '1', evidenceVersion: '' })
      expect(notice).toBe('exception_refused_evidence_version_required')
      const after = await exceptionFor(token)
      expect(after.state).toBe('open')
      expect(after.alert_sent_at).toBeNull()
    })

    it('a flood cannot keep every form out of date: the version stops at the cap, and repeats never move it', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      const start = (await exceptionFor(token)).evidence_version as number
      for (let i = 0; i < 10; i++) await ipn(token)
      await ipn(token, { type_event: 'sale_canceled' })
      const afterRepeats = (await exceptionFor(token)).evidence_version as number
      expect(afterRepeats).toBeLessThanOrEqual(start + 1)

      for (let i = 0; i < 30; i++) await report(id, (i + 100).toString(16).padStart(64, 'a'))
      const atCap = await exceptionFor(token)
      expect(atCap.evidence_overflow_at).not.toBeNull()
      expect(atCap.evidence_version).toBeLessThanOrEqual(afterRepeats + 20)

      const form = reviewed(atCap)
      for (let i = 0; i < 10; i++) await report(id, (i + 200).toString(16).padStart(64, 'b'))
      expect((await exceptionFor(token)).evidence_version).toBe(atCap.evidence_version)
      expect(await exAction('dismissException', form)).toBe('exception_dismiss_done')
    })

    it('nobody sets the version, the table owner included: it moves by one whatever a write says', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await asSuper(`update public.payment_exceptions set evidence_version = 999 where id = $1`, [e.id])
      expect((await exceptionFor(token)).evidence_version).toBe(e.evidence_version + 1)
      await asSuper(`update public.payment_exceptions set evidence_version = 0 where id = $1`, [e.id])
      expect((await exceptionFor(token)).evidence_version).toBe(e.evidence_version + 2)
    })

    it('a provider alternating between amounts it has named moves the version, so the form shows the current one', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed', 90000)
      await adminAction('verifyPaytechPayment', { paymentId: id })
      says(token, 'completed', 60000)
      const e = await exceptionFor(token)
      await exAction('recheckException', { exceptionId: e.id })
      says(token, 'completed', 90000)
      await exAction('recheckException', { exceptionId: e.id })
      const tab = reviewed(await exceptionFor(token))
      says(token, 'completed', 60000)
      await exAction('recheckException', { exceptionId: e.id })

      expect(await exAction('requireExceptionRefund', tab)).toBe('exception_refused_evidence_changed')
      const now = await exceptionFor(token)
      expect(now.provider_amount).toBe(60000)
      expect(now.repeat_alert_due_at).not.toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — amounts that are not a claim, and answers that are', () => {
    const reviewed = reviewedForm

    it('an unpaid answer saying 0 claims nothing: no record, no alert, no conflict', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', 0)
      await age(token, 90)
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
      expect(H.emails).toHaveLength(0)
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('a failed answer saying 0 closes the attempt as failed', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'failed', 0)
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('failed')
      expect(await exceptionFor(token)).toBeNull()
    })

    it('an unpaid answer naming a real other amount is still a conflict', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending', 5000)
      await age(token, 90)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'amount_mismatch' })
    })

    it('paid at 0 on an attempt in flight proves no money: recorded, not completed, and it has an honest exit', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed', 0)
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('processing')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect(e.provider_answers).toContain('settlement_amount_mismatch')
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: e.payment_id, reason: NOTE, attest: 'yes' })).toBe('close_done_exception')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      const freed = await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1])
      expect(freed[0].r).toBeNull()
    })

    it('paid at a negative amount on a closed attempt is the same: reported, and it can be dismissed', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed', -5)
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_dismiss_done')
    })

    it('a paid answer with no readable amount where the contract requires one is kept, not lost, on an attempt in flight', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: 'completed', currency: 'XOF', ref_command: P.refs.get(token) } })
      await age(token, 90)
      await sweep()
      expect((await rowFor(token)).status).toBe('processing')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_amount_unreadable' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)

      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: e.payment_id, reason: NOTE, attest: 'yes' })).toBe('close_done_exception')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    it('the same answer on a closed attempt is kept once, on a sweep, and the next sweep adds no alert', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      P.status.set(token, { success: 1, payment: { status: 'completed', currency: 'XOF', ref_command: P.refs.get(token) } })
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_amount_unreadable' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('an amount and a currency that both differ are both kept', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      P.status.set(token, { success: 1, payment: { status: 'completed', amount: 90000, currency: 'EUR', ref_command: P.refs.get(token) } })
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      expect(e.provider_answers).toEqual(expect.arrayContaining(['settlement_amount_mismatch', 'settlement_currency_mismatch']))
      expect(e.provider_amount).toBe(90000)
    })

    it('the same on an attempt in flight', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      P.status.set(token, { success: 1, payment: { status: 'completed', amount: 90000, currency: 'EUR', ref_command: P.refs.get(token) } })
      await age(token, 90)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.provider_answers).toEqual(expect.arrayContaining(['settlement_amount_mismatch', 'settlement_currency_mismatch']))
      expect(e.provider_amount).toBe(90000)
    })

    it('a notification in JSON claiming a numeric currency is read as a claim, as the same one in a form is', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      const json = await ipn(token, { currency: 952 })
      expect(json.body.detail).toBe('currency_mismatch')
      expect(await exceptionFor(token)).toMatchObject({ last_signal: 'currency_mismatch' })
    })

    it('on a completed payment the provider then saying paid at our amount takes back its other amount', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', 90000)
      await ipn(token, { type_event: 'sale_canceled' })
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', provider_amount: 90000 })

      says(token, 'completed')
      await exAction('recheckException', { exceptionId: e.id })

      const now = await exceptionFor(token)
      expect(now.provider_amount).toBeNull()
      expect(now.provider_amounts.map(Number)).toEqual(expect.arrayContaining([90000, PRICE_C1]))
      expect(now.last_signal).not.toBe('provider_paid')
      await exAction('requireExceptionRefund', reviewed(now))
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(await exceptionFor(token)), amount: String(PRICE_C1) })).toBe('exception_refund_recorded_access_live')
    })

    it('a completed payment with no record, and the provider saying paid at our amount, stays with no record', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await age(token, 90)
      await sweep()
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toBeNull()
    })

    it('the amount the provider last named, or any it named before, can be recorded as refunded, and only under its own attestation', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed', 90000)
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      says(token, 'completed', 60000)
      await exAction('recheckException', { exceptionId: e.id })
      await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))
      const form = reviewed(await exceptionFor(token))

      const attempt = (extra: Record<string, string>) => exAction('recordExceptionRefund', { ...refundFields(e.id), ...form, ...extra })
      expect(await attempt({ amount: '90000', attestAll: '' })).toBe('close_attestation_required')
      expect(await attempt({ amount: '70000' })).toBe('exception_refused_refund_amount_invalid')
      expect(await attempt({ amount: String(PRICE_C1) })).toBe('exception_refused_refund_charged_attestation_required')
      expect(await attempt({ amount: '90000' })).toBe('exception_refund_recorded')
      expect((await exceptionFor(token)).refund_amount).toBe(90000)
    })

    it('a provider that said paid and then failed leaves a dismissal open to an attested check, and the money it confirmed on the record', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed')
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      expect(e.payment_received).toBe('confirmed_by_provider')
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_refused_payment_confirmed_cannot_dismiss')

      says(token, 'failed')
      await exAction('recheckException', { exceptionId: e.id })
      expect((await exceptionFor(token)).provider_answer).toBe('provider_not_paid')

      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return', payment_received: 'confirmed_by_provider' })
    })

    it('saying paid once more reopens that dismissal once, and a provider that keeps flipping cannot keep blocking the learner', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed')
      await adminAction('verifyPaytechPayment', { paymentId: id })
      const e = await exceptionFor(token)
      const flip = async (word: string) => { says(token, word); await exAction('recheckException', { exceptionId: e.id }) }
      await flip('failed')
      await exAction('dismissException', reviewed(await exceptionFor(token)))

      await flip('completed')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
      await flip('failed')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')

      await flip('completed')
      await flip('failed')
      await flip('completed')
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('money an administrator confirmed is not dismissed that way: they withdraw their own confirmation first', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
    })
  })

  describe('XP-PAYTECH-06B — a person is not left stranded, or left unaware', () => {
    const reviewed = reviewedForm
    const ageAlert = (token: string, days: number) => {
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('harness: unsafe identifier')
      return db.exec(
        `alter table public.payment_exceptions disable trigger payment_exceptions_guard;
         update public.payment_exceptions set alert_sent_at = now() - make_interval(days => ${Number(days)})
          where payment_id = (select id from public.payments where provider_token = '${token}');
         alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
    }

    it('an attempt the provider keeps calling pending can be closed under attestation once it is old', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      const { id } = await rowFor(token)
      await age(token, 6 * 24 * 60)
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_refused_provider_says_pending')
      expect((await rowFor(token)).status).toBe('processing')

      await age(token, 8 * 24 * 60)
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      expect((await rowFor(token)).status).toBe('expired')
    })

    it('an open record alerted on more than a week ago is alerted on again, once a week and no more', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)

      await ageAlert(token, 8)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a manual close whose attestation cannot be written does not happen', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await asSuper(`create trigger harness_audit_fault before insert on public.audit_log for each row execute function public.harness_fail()`)
      try {
        expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_refused_audit_unavailable')
      } finally {
        await asSuper(`drop trigger harness_audit_fault on public.audit_log`)
      }
      expect((await rowFor(token)).status).toBe('processing')
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      const rows = await asSuper(`select event_type, reason from public.audit_log where event_type in ('payment.manual_close_attested', 'payment.manually_closed') order by created_at, event_type`)
      expect(rows.map(r => r.event_type)).toEqual(expect.arrayContaining(['payment.manual_close_attested', 'payment.manually_closed']))
      expect(rows.every(r => r.reason === NOTE)).toBe(true)
    })

    it('a settled record that needs nothing is never reminded about', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await ageAlert(token, 8)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a report arriving while the alert goes out stays due', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      H.emailMode = 'fail'
      await ipn(token)
      H.emailMode = 'ok'
      H.emailDuring = async () => {
        H.emailDuring = null
        await asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, 90000)`, [id])
      }
      H.emails = []
      await sendAlerts()
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()

      H.emails = []
      await sendAlerts()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()
    })

    it('a different report arriving while the alert goes out stays due too', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const report = (fingerprint: string) => asRole('service_role', null, `select public.payment_exception_report($1, 'unverified_report', 'ipn', 'ipn_signature_mismatch', $2)`, [id, fingerprint])
      await report('a'.repeat(64))
      const first = (await exceptionFor(token)).repeat_alert_due_at
      expect(first).not.toBeNull()
      H.emailDuring = async () => {
        H.emailDuring = null
        await db.exec(`alter table public.payment_exceptions disable trigger payment_exceptions_guard;
          update public.payment_exceptions set repeat_alert_due_at = now() where payment_id = '${id}';
          alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
      }
      await sendAlerts()
      expect((await exceptionFor(token)).repeat_alert_due_at).not.toBeNull()
    })

    it('a flag raised by a completion is alerted on at once, not at the next daily sweep', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { client_phone: '771111111' })
      await ipn(token, { client_phone: '772222222' })
      H.emails = []
      says(token, 'completed')
      await ipn(token, { client_phone: '772222222' })
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a normal completion sends nothing', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect(H.emails).toHaveLength(0)
    })

    it('the sweep budget includes the time spent alerting', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      await ipn(token)
      H.emailMode = 'ok'
      const late = await startAndToken(user(L2))
      says(late, 'pending')
      await age(late, 90)
      const real = Date.now
      H.emailDuring = async () => {
        H.emailDuring = null
        const jump = real() + 60_000
        vi.spyOn(Date, 'now').mockImplementation(() => jump)
      }
      H.emails = []
      try {
        const { body } = await sweep()
        expect(H.emails.length).toBeGreaterThan(0)
        expect(body.checked).toBe(0)
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('money a person confirmed stops being only their word when the payment completes, so there is nothing left to withdraw', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token)
      await asRole('service_role', null, `select public.payment_exception_escalate_watching(0)`)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_operator')

      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_provider')

      expect(await exAction('withdrawExceptionReceipt', { exceptionId: e.id, note: NOTE })).toBe('exception_refused_receipt_not_operator_confirmed')
      expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_provider')
    })

    it('the provider saying failed while another path completes the payment is kept, not lost', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'failed')
      await age(token, 90)
      P.duringStatus = async () => {
        says(token, 'completed')
        expect((await ipn(token)).body.detail).toBe('completed')
        says(token, 'failed')
      }
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid' })
    })

    it('a remembered notification that never completed keeps a later failed signature from hiding it', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', 'ipn_completing_payment', $2)`, [id, 'a'.repeat(64)])
      await asRole('service_role', null, `select public.payment_exception_report($1, 'unverified_report', 'ipn', 'ipn_signature_mismatch', $2)`, [id, 'b'.repeat(64)])
      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_for_test' where id = $1`, [id])
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect((await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r).not.toBeNull()
    })

    it('a different notification prompting an answer the provider already gave does not reopen a dismissed record on a completed payment', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await ipn(token, { type_event: 'sale_canceled' })
      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      await exAction('dismissException', reviewed(e))
      expect((await exceptionFor(token)).state).toBe('resolved')

      await ipn(token, { type_event: 'sale_canceled', client_phone: '771234567' })

      const after = await exceptionFor(token)
      expect(after.state).toBe('resolved')
      expect(after.notification_reopens).toBe(0)
      expect(after.different_report_at).not.toBeNull()
    })

    it('an amount past the cap on a settled record is counted as needing a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      const report = (amount: number) => asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, $2)`, [id, amount])
      for (let i = 0; i < 20; i++) await report(50_000 + i)
      const e = await exceptionFor(token)
      expect(e.provider_amounts).toHaveLength(20)
      await exAction('requireExceptionRefund', reviewed(e))
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(await exceptionFor(token)), amount: '50019' })).toBe('exception_refund_recorded')
      const settled = await exceptionFor(token)
      expect(settled).toMatchObject({ state: 'resolved', repeat_count: 0 })
      const { countOpenPaymentExceptions: before } = await import('@/lib/payments/payment-exceptions')
      expect(await before()).toBe(0)

      await report(99_000)
      const after = await exceptionFor(token)
      expect(after.repeat_count).toBeGreaterThan(0)
      expect(after.different_report_at).not.toBeNull()
      const { countOpenPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      expect(await countOpenPaymentExceptions()).toBe(1)
    })

    it('a refund decision on more than one report needs its own attestation', async () => {
      H.contract = null
      const { token, id } = await closedAttempt('expired')
      await ipn(token)
      await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, $2)`, [id, 'e'.repeat(64)])
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      const form = reviewed(await exceptionFor(token))
      expect(await exAction('requireExceptionRefund', { ...form, attestAll: '' })).toBe('close_attestation_required')
      expect(await exAction('requireExceptionRefund', form)).toBe('exception_require_refund_done')
    })

    it('what the administrator wrote is kept on the record for the next one to read', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const e = await exceptionFor(token)
      expect(e.last_decision_note).toBe(NOTE)
      expect(e.last_decision_at).not.toBeNull()
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      expect((await paymentExceptionQueue())![0]).toMatchObject({ lastDecisionNote: NOTE })
    })

    it('a refund recorded again writes an audit row, though it changes nothing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })).toBe('exception_refund_already_recorded')
      const rows = (await exceptionAudit()).filter(a => a.event_type === 'payment.exception_refund_repeated')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ actor_type: 'admin', actor_id: ADM })
    })
  })

  describe('XP-PAYTECH-06B — the sweep looks where it did not', () => {
    it('it asks about recently completed payments, and a provider now saying failed reaches a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      const before = await rowFor(token)
      says(token, 'failed')
      H.emails = []

      const { body } = await sweep()

      expect(body.completedChecked).toBe(1)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await rowFor(token)).toMatchObject({ status: 'completed', completed_at: before.completed_at })
      expect((await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r).toBeNull()

      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect((await exceptionFor(token)).report_count).toBeGreaterThanOrEqual(1)
    })

    it('a provider still saying paid at our amount leaves nothing behind', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
      expect(H.emails).toHaveLength(0)
    })

    it('with no confirmed contract it asks nothing about them', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      H.contract = null
      P.statusCalls = []
      const { body } = await sweep()
      expect(body.completedChecked).toBeUndefined()
      expect(P.statusCalls).toEqual([])
    })

    it('with more stale attempts than both ends hold, the middle can still be reached', async () => {
      H.contract = FIXTURE_CONTRACT
      await db.exec(`alter table public.payments disable trigger payments_transition_guard;
        insert into public.payments (amount, currency, method, status, reference, provider, provider_mode, provider_token, created_at)
        select 45000, 'XOF', 'card', 'processing', 'SWEEP-MID-' || g, 'paytech', 'test', 'tokmiddle' || lpad(g::text, 6, '0'), now() - make_interval(hours => 1000 - g)
          from generate_series(1, 600) g;
        alter table public.payments enable trigger payments_transition_guard;`)
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.9)
      try {
        expect((await sweep()).body.checked).toBe(25)
      } finally {
        random.mockRestore()
      }
      const reached = await asSuper(`select reference from public.payments where reference like 'SWEEP-MID-%' and failure_reason = 'payment_identity_incomplete'`)
      expect(reached.map(r => Number(String(r.reference).slice('SWEEP-MID-'.length))).some(n => n > 200 && n <= 400)).toBe(true)
    }, 120_000)
  })

  describe('XP-PAYTECH-06B — pinned after the mutation set was rewritten', () => {
    const reviewed = reviewedForm
    const ageAlert = (token: string, days: number) => {
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('harness: unsafe identifier')
      return db.exec(
        `alter table public.payment_exceptions disable trigger payment_exceptions_guard;
         update public.payment_exceptions set alert_sent_at = now() - make_interval(days => ${Number(days)})
          where payment_id = (select id from public.payments where provider_token = '${token}');
         alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
    }

    it('a paid answer with no readable amount on a completed payment is kept for a person', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      P.status.set(token, { success: 1, payment: { status: 'completed', currency: 'XOF', ref_command: P.refs.get(token) } })
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_unreadable' })
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('an amount and a currency that both differ on a completed payment are both kept', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      P.status.set(token, { success: 1, payment: { status: 'completed', amount: 90000, currency: 'EUR', ref_command: P.refs.get(token) } })
      await ipn(token, { type_event: 'sale_canceled' })
      const e = await exceptionFor(token)
      expect(e.provider_answers).toEqual(expect.arrayContaining(['settlement_amount_mismatch', 'settlement_currency_mismatch']))
      expect(e.provider_amount).toBe(90000)
    })

    it('the provider saying paid at our amount writes nothing on a record it has not questioned', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { client_phone: '771111111' })
      const before = await exceptionFor(token)
      await exAction('recheckException', { exceptionId: before.id })
      const after = await exceptionFor(token)
      expect(after.evidence_version).toBe(before.evidence_version)
      expect(after.report_count).toBe(before.report_count)
    })

    it('money a person confirmed is not dismissed because the provider said not paid: they withdraw it first', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await exAction('recheckException', { exceptionId: e.id })
      expect((await exceptionFor(token)).provider_answer).toBe('provider_not_paid')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
      expect(await exAction('withdrawExceptionReceipt', reviewed(await exceptionFor(token)))).toBe('exception_withdraw_receipt_done')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
    })

    it('the reason for a refund is kept on the record too', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: 'Confirmé après relecture du tableau.', attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: 'Le remboursement doit être effectué.' })
      await exAction('recordExceptionRefund', { ...refundFields(e.id), note: 'Remboursé, référence relue au tableau.', evidenceCount: '1' })
      expect((await exceptionFor(token)).last_decision_note).toBe('Remboursé, référence relue au tableau.')
    })

    it('a reminder is the sweep\'s alone: a report on one payment sends nothing about another', async () => {
      H.contract = null
      const { token: first } = await closedAttempt('expired')
      await ipn(first)
      await ageAlert(first, 8)
      const { token: second } = await closedAttempt('expired', user(L2), C2)
      H.emails = []
      await ipn(second)
      const reference = (await rowFor(second)).reference
      expect(H.emails.length).toBeGreaterThan(0)
      expect(H.emails.every(m => m.reference === reference)).toBe(true)
    })

    it('no reminder comes before the week is out', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ageAlert(token, 3)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a flagged record waiting for a person is reminded about as well', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('confirmExceptionReceipt', { exceptionId: e.id, note: NOTE, attest: 'yes' })
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', { ...refundFields(e.id), evidenceCount: '1' })
      await ipn(token, { client_phone: '771111111' })
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      await ageAlert(token, 8)
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a provider that names an amount, then one it named, marks a settled record once it has moved', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      const report = (amount: number) => asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, $2)`, [id, amount])
      await report(90000)
      await report(60000)
      const e = await exceptionFor(token)
      await exAction('requireExceptionRefund', reviewed(e))
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(await exceptionFor(token)), amount: '60000' })).toBe('exception_refund_recorded')
      await report(90000)
      const after = await exceptionFor(token)
      expect(after.provider_amount).toBe(90000)
      expect(after.repeat_count).toBe(1)
      expect(after.different_report_at).not.toBeNull()
      expect(after.post_settlement_report_at).toBeNull()
    })
  })

  describe('XP-PAYTECH-06B — a provider going back on what it said reaches a person', () => {
    const reviewed = reviewedForm
    const blocking = async () => (await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r
    const raw = (token: string, status: string, amount: unknown, currency: unknown) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency, ref_command: P.refs.get(token) ?? 'X' } })

    /** Closed, paid at an amount it named, then not paid, then dismissed. */
    async function dismissedAfterNotPaid(say: (token: string) => void) {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      say(token)
      await sweep()
      says(token, 'failed')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('provider_not_paid')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
      H.emails = []
      return token
    }

    it('paid at an amount it already named, after a dismissal on "not paid", reopens the record', async () => {
      const token = await dismissedAfterNotPaid(t => says(t, 'completed', 50000))
      says(token, 'completed', 50000)
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await blocking()).not.toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('paid in a currency it already named, after a dismissal on "not paid", reopens the record too', async () => {
      const token = await dismissedAfterNotPaid(t => raw(t, 'completed', PRICE_C1, 'USD'))
      raw(token, 'completed', PRICE_C1, 'USD')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('after that it is marked and alerted on at most weekly, and it blocks nobody', async () => {
      const token = await dismissedAfterNotPaid(t => says(t, 'completed', 50000))
      says(token, 'completed', 50000)
      await sweep()
      says(token, 'failed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      H.emails = []

      says(token, 'completed', 50000)
      await sweep()

      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return' })
      expect(e.different_report_at).not.toBeNull()
      expect(e.repeat_alert_due_at).not.toBeNull()
      expect(await blocking()).toBeNull()
      const { countOpenPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      expect(await countOpenPaymentExceptions()).toBe(1)
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)

      // It keeps changing its mind: the alert stays weekly, whatever it says next.
      H.emails = []
      says(token, 'failed')
      await sweep()
      says(token, 'completed', 50000)
      await sweep()
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect(await blocking()).toBeNull()
    })

    it('on a completed payment, not paid, dismissed, paid, then not paid again is marked and alerted on', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      says(token, 'completed')
      await sweep()
      H.emails = []
      says(token, 'failed')
      await sweep()
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.different_report_at).not.toBeNull()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect((await rowFor(token)).status).toBe('completed')
      const audit = (await exceptionAudit()).map(a => a.event_type)
      expect(audit).toContain('payment.exception_provider_answer_recorded')
    })

    it('a sweep hearing "not paid" again after "paid" writes that down, so the dismissal it allows is open', async () => {
      const token = await dismissedAfterNotPaid(t => says(t, 'completed', 50000))
      says(token, 'completed', 50000)
      await sweep()
      expect((await exceptionFor(token)).provider_answer).not.toBe('provider_not_paid')
      says(token, 'failed')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('provider_not_paid')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
    })

    it('"not paid" is what a dismissed attempt the provider never called paid should hear, every day, and writes nothing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      const before = await exceptionFor(token)
      H.contract = FIXTURE_CONTRACT
      says(token, 'failed')
      await sweep()
      await sweep()
      expect(await exceptionFor(token)).toEqual(before)
    })

    it('paid at nothing in another currency on a closed attempt proves no money, and can be dismissed', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      raw(token, 'completed', 0, 'USD')
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect(e.provider_answers).toEqual(expect.arrayContaining(['settlement_amount_mismatch', 'settlement_currency_mismatch']))
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
    })

    it('money the provider confirmed can be dismissed if its last word is that the attempt can still be paid', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
      says(token, 'pending')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('provider_pending')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', payment_received: 'confirmed_by_provider' })
      expect(await blocking()).toBeNull()
    })

    it('a word the contract does not list, on a completed payment, reaches a person and leaves the shape in the log', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      const before = await rowFor(token)
      says(token, 'reversed')
      H.logs = []
      H.emails = []
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised' })
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(H.logs.some(l => l.level === 'warn' && String(l.args[1]).includes('status response not recognised'))).toBe(true)
      expect(await rowFor(token)).toMatchObject({ status: 'completed', completed_at: before.completed_at })
      expect(await blocking()).toBeNull()
    })

    it('the same word on a closed attempt may mean money moved, so it opens a record for a person, and is logged', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      says(token, 'reversed')
      H.logs = []
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised' })
      expect(H.logs.some(l => l.level === 'warn' && String(l.args[1]).includes('status response not recognised'))).toBe(true)
    })

    it('a form from before the payment completed is out of date, on a record the provider had already confirmed', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      raw(token, 'completed', PRICE_C1, 'USD')
      await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })
      const held = await exceptionFor(token)
      expect(held).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      await exAction('requireExceptionRefund', reviewed(held))
      const stale = { ...refundFields(held.id), ...reviewed(await exceptionFor(token)) }
      H.emails = []
      says(token, 'completed')
      await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })
      expect((await rowFor(token)).status).toBe('completed')

      expect(await exAction('recordExceptionRefund', stale)).toBe('exception_refused_evidence_changed')
      expect((await rowFor(token)).status).toBe('completed')
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('an attested close past the week stays closed: a sweep hearing "pending" again does not block the learner', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      const { id } = await rowFor(token)
      await age(token, 8 * 24 * 60)
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      H.emails = []
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
      expect(H.emails).toHaveLength(0)
      expect(await blocking()).toBeNull()
    })

    it('but it paying after that close is still news', async () => {
      H.contract = FIXTURE_CONTRACT
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      const { id } = await rowFor(token)
      await age(token, 8 * 24 * 60)
      await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })
      says(token, 'completed')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      expect(await blocking()).not.toBeNull()
    })

    it('a sweep stopped by its budget does not read as a finished sweep', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      await ipn(token)
      H.emailMode = 'ok'
      const late = await startAndToken(user(L2))
      says(late, 'pending')
      await age(late, 90)
      const real = Date.now
      H.emailDuring = async () => {
        H.emailDuring = null
        const jump = real() + 60_000
        vi.spyOn(Date, 'now').mockImplementation(() => jump)
      }
      try {
        const { body } = await sweep()
        expect(body.stoppedAtBudget).toBe(1)
      } finally {
        vi.restoreAllMocks()
      }
      expect(await asSuper(`select count(*)::int as n from public.audit_log where event_type = 'payment.reconciliation_sweep_finished'`)).toEqual([{ n: 0 }])
    })

    it('an amount past the limit leaves a trail, because nothing else keeps it', async () => {
      H.contract = FIXTURE_CONTRACT
      const { token, id } = await closedAttempt('expired')
      const report = (amount: number) => asRole('service_role', null, `select public.payment_exception_report($1, 'completion_refused', 'sweep', 'settlement_amount_mismatch', null, $2)`, [id, amount])
      for (let i = 0; i < 20; i++) await report(50_000 + i)
      await report(99_000)
      await report(98_000)
      expect((await exceptionFor(token)).provider_amount).toBe(98_000)
      const said = (await exceptionAudit()).map(a => (a.metadata as { providerAmount?: number }).providerAmount)
      expect(said).toEqual(expect.arrayContaining([99_000, 98_000]))
    })
  })

  describe('XP-PAYTECH-05 — only an authorised administrator', () => {
    const ACTIONS = [
      'acknowledgeExceptionReport', 'confirmExceptionReceipt', 'withdrawExceptionReceipt', 'dismissException', 'requireExceptionRefund',
      'withdrawExceptionRefund', 'recordExceptionAccess', 'recordExceptionRefund', 'recheckException', 'reopenExceptionAfterReview',
    ] as const

    it.each(ACTIONS)('%s redirects a non-administrator and writes nothing', async (name) => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const before = await exceptionFor(token)
      const audit = (await exceptionAudit()).length
      H.denyAdmin = true
      expect(await exAction(name, { ...refundFields(before.id), attest: 'yes' })).toBe('REDIRECT:/login?error=forbidden')
      H.denyAdmin = false
      expect(await exceptionFor(token)).toEqual(before)
      expect((await exceptionAudit()).length).toBe(audit)
    })

    it.each(ACTIONS)('%s refuses on a deployment that may not act on this database', async (name) => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const before = await exceptionFor(token)
      const audit = (await asSuper(`select count(*)::int as n from public.audit_log`))[0].n
      await setEnvironment('live')
      expect(await exAction(name, { ...refundFields(before.id), attest: 'yes' })).toBe('environment_refused')
      await setEnvironment('sandbox')
      expect(await exceptionFor(token)).toEqual(before)
      expect((await asSuper(`select count(*)::int as n from public.audit_log`))[0].n).toBe(audit)
    })

    it('a report is not even attempted on such a deployment', async () => {
      H.contract = null
      const { id } = await closedAttempt('expired')
      await setEnvironment('live')
      const { reportPaymentException, sendPendingExceptionAlerts } = await import('@/lib/payments/payment-exceptions')
      expect(await reportPaymentException({ paymentId: id, signal: 'paid_hint', source: 'ipn' }))
        .toEqual({ recorded: false, reason: 'environment_refused' })
      expect(await sendPendingExceptionAlerts()).toBe(0)
      await setEnvironment('sandbox')
      expect(await asSuper(`select count(*)::int as n from public.payment_exceptions`)).toEqual([{ n: 0 }])
    })
  })

  describe('XP-PAYTECH-05 — the administrator alert', () => {
    it('reaches every allowlisted administrator, naming only the reference', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const reference = (await rowFor(token)).reference
      expect(H.emails).toEqual(OWNERS.map(to => ({ to, reference })))
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()
    })

    it('a failed alert loses nothing: it stays due and the sweep delivers it once', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      expect((await ipn(token)).status).toBe(200)     // The report itself is safe.
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()

      H.emailMode = 'ok'
      H.emails = []
      const first = await sweep()
      expect(first.body.alertsSent).toBe(1)
      expect(H.emails).toHaveLength(OWNERS.length)
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()

      H.emails = []
      expect((await sweep()).body.alertsSent).toBe(0)
      expect(H.emails).toEqual([])
    })

    it('an alert every address refused stays due', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail'
      await ipn(token)
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()
    })

    it('a dry run is not a delivery', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'dry'
      await ipn(token)
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()
    })

    it('no administrator configured: it stays due and says so in the log', async () => {
      H.contract = null
      vi.stubEnv('ADMIN_OWNER_EMAILS', '')
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(H.emails).toEqual([])
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()
      expect(JSON.stringify(H.logs)).toContain('no administrator address is configured')
    })

    it('new evidence alerts again; a replay does not', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await ipn(token)
      expect(H.emails).toHaveLength(OWNERS.length)
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect(H.emails).toHaveLength(OWNERS.length * 2)
    })

    it('a recent watching record does not alert', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      const res = await sweep()
      expect(res.body.escalated).toBe(0)
      expect(res.body.alertsSent).toBe(0)
      expect(H.emails).toEqual([])
    })

    it('a report that sits for a day reaches an administrator, and moves nothing', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 25)
      const before = await counts()

      const res = await sweep()

      expect(res.body.escalated).toBe(1)
      expect(res.body.alertsSent).toBe(1)
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported' })
      expect((await exceptionFor(token)).escalated_at).not.toBeNull()
      expect((await rowFor(token)).status).toBe('processing')
      expect(await counts()).toEqual(before)
      expect((await exceptionAudit()).map(a => a.event_type)).toContain('payment.exception_escalated')
    })

    it('an escalated report still settles itself if the payment later completes', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 25)
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')

      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally', payment_received: 'confirmed_by_provider' })
    })

    it('a notification\'s conflict on the same payment is flagged when it completes, with no refund on offer', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe('open')
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.post_settlement_report_at).not.toBeNull()
    })
  })

  describe('XP-PAYTECH-05 — the sweep finds what no notification reported', () => {
    it('with a contract: paid after closure, with no notification at all', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      const before = await counts()
      const res = await sweep()
      expect(res.status).toBe(200)
      expect(res.body.closedChecked).toBe(1)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', first_signal: 'provider_paid', payment_received: 'confirmed_by_provider' })
      expect(await counts()).toEqual(before)
    })

    it('with a contract: closed here but still payable there', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'pending')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', first_signal: 'provider_pending', payment_received: 'not_established' })
    })

    it('with a contract: closed and confirmed unpaid is not an exception', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'failed')
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
    })

    it('with no contract: it does not even look, and asks nothing', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      const res = await sweep()
      expect(res.body.closedChecked).toBeUndefined()
      expect(P.statusCalls).toEqual([])
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a closed attempt older than the lookback is left alone', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await age(token, 31 * 24 * 60)
      const res = await sweep()
      expect(res.body.closedChecked).toBe(0)
      expect(await exceptionFor(token)).toBeNull()
    })

    it('asks about a random window of closed attempts, so none is starved', async () => {
      const tokens: string[] = []
      for (let i = 0; i < 12; i++) {
        const { token } = await closedAttempt('expired')
        says(token, 'failed')
        await age(token, i + 1)   // tokens[0] is the newest, tokens[11] the oldest
        tokens.push(token)
      }
      const random = vi.spyOn(Math, 'random')
      try {
        random.mockReturnValue(0)
        expect((await sweep()).body.closedChecked).toBe(10)
        expect(P.statusCalls).toEqual(tokens.slice(0, 10))

        P.statusCalls = []
        random.mockReturnValue(0.99)
        expect((await sweep()).body.closedChecked).toBe(10)
        expect(P.statusCalls).toEqual([tokens[11], ...tokens.slice(0, 9)])
      } finally {
        random.mockRestore()
      }
    })

    it('stops asking at its time budget, and has already done what needs no provider', async () => {
      H.contract = null
      const { token: late } = await closedAttempt('expired', user(L2), C2)
      H.emailMode = 'fail'
      await ipn(late)
      H.emailMode = 'ok'
      H.emails = []
      H.contract = FIXTURE_CONTRACT

      const a = (await closedAttempt('expired')).token
      const b = (await closedAttempt('expired')).token
      says(a, 'failed')
      says(b, 'failed')
      const real = Date.now()
      const clock = vi.spyOn(Date, 'now')
      P.duringStatus = async () => { clock.mockReturnValue(real + 60_000) }
      try {
        const res = await sweep()
        expect(res.status).toBe(200)
        expect(res.body.alertsSent).toBe(1)
        expect(res.body.closedChecked).toBe(1)
      } finally {
        clock.mockRestore()
      }
    })

    it('answers with counts only', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      const res = await sweep()
      const reference = (await rowFor(token)).reference
      expect(JSON.stringify(res.body)).not.toContain(reference)
      expect(JSON.stringify(res.body)).not.toContain(token)
      for (const [k, v] of Object.entries(res.body)) {
        if (k !== 'ok') expect(typeof v, k).toBe('number')
      }
    })
  })

  describe('XP-PAYTECH-05 — the admin queue reader', () => {
    it('reports an unreadable queue as unreadable, never as empty', async () => {
      const { listPaymentExceptions, countOpenPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      expect(await listPaymentExceptions()).toEqual([])
      expect(await countOpenPaymentExceptions()).toBe(0)
      await asSuper(`revoke select on public.payment_exceptions from service_role`)
      try {
        expect(await listPaymentExceptions()).toBeNull()
        expect(await countOpenPaymentExceptions()).toBeNull()
      } finally {
        await asSuper(`grant select on public.payment_exceptions to service_role`)
      }
    })

    it('reports the queue as unreadable if a fact behind it cannot be read', async () => {
      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(await listPaymentExceptions()).toHaveLength(1)
      await asSuper(`revoke select on public.entitlements from service_role`)
      try {
        expect(await listPaymentExceptions()).toBeNull()
      } finally {
        await asSuper(`grant select on public.entitlements to service_role`)
      }
    })

    it('lists every open record first, however many newer resolved ones exist', async () => {
      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      H.contract = null
      const { token: older } = await closedAttempt('expired', user(L1), C1)
      await ipn(older)
      const { token: newer } = await closedAttempt('expired', user(L2), C1)
      await ipn(newer)
      await exAction('dismissException', { exceptionId: (await exceptionFor(newer)).id, note: NOTE, attest: 'yes', attestAll: 'yes' })

      const queue = (await paymentExceptionQueue())!
      expect(queue.map(e => e.state)).toEqual(['open', 'resolved'])
      expect(queue[0].payment?.reference).toBe((await rowFor(older)).reference)
    })

    it('counts open exceptions and leaves out watching and resolved ones', async () => {
      const { countOpenPaymentExceptions, watchedPaymentIds } = await import('@/lib/payments/payment-exceptions')
      H.contract = null
      const watching = await startAndToken(user(L1))
      // A failed signature is not a paid notification, so it raises no warning.
      await ipn(watching, {}, { secret: 'sk_wrong' })
      expect([...await watchedPaymentIds()]).toEqual([])
      await ipn(watching)
      expect(await countOpenPaymentExceptions()).toBe(0)
      expect([...await watchedPaymentIds()]).toEqual([(await rowFor(watching)).id])

      const { token: open } = await closedAttempt('expired', user(L2), C1)
      await ipn(open)
      expect(await countOpenPaymentExceptions()).toBe(1)
      await exAction('dismissException', { exceptionId: (await exceptionFor(open)).id, note: NOTE, attest: 'yes', attestAll: 'yes' })
      expect(await countOpenPaymentExceptions()).toBe(0)
    })
  })

  describe('XP-PAYTECH-06B — what the provider says after a decision, and who hears of it', () => {
    const reviewed = reviewedForm
    const blocking = async () => (await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r as string | null
    const raw = (token: string, status: unknown, amount: unknown, currency: unknown) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency, ref_command: P.refs.get(token) ?? 'X' } })
    const weekPasses = async () => db.exec(`alter table public.payment_exceptions disable trigger payment_exceptions_guard;
      update public.payment_exceptions set alert_sent_at = alert_sent_at - interval '8 days',
         repeat_alerted_at = repeat_alerted_at - interval '8 days',
         repeat_alert_due_at = repeat_alert_due_at - interval '8 days';
      alter table public.payment_exceptions enable trigger payment_exceptions_guard;`)
    const refundAll = async (token: string) => {
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e) })).toMatch(/exception_refund_recorded/)
    }
    const page = async () => {
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      const { default: ExceptionQueue } = await import('@/app/(admin)/admin/payments/ExceptionQueue')
      return renderToStaticMarkup(ExceptionQueue({ exceptions: await listPaymentExceptions() } as never))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    }
    beforeEach(() => { H.contract = FIXTURE_CONTRACT })

    // ── after a refund ──
    it('paid after "not paid" on a refunded attempt flags it and blocks a new attempt, from the sweep as from a re-check', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      await refundAll(token)
      H.emails = []
      says(token, 'failed')
      await sweep()
      const afterFailed = await exceptionFor(token)
      expect(afterFailed).toMatchObject({ state: 'resolved', resolution: 'refund_confirmed', provider_answer: 'provider_not_paid' })
      expect(afterFailed.post_settlement_report_at).toBeNull()
      expect(H.emails).toHaveLength(0)
      expect(await blocking()).toBeNull()

      says(token, 'completed')
      await sweep()
      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.provider_answers).toEqual(expect.arrayContaining(['provider_not_paid', 'provider_paid']))
      expect(await blocking()).not.toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('the same after a refund on money an administrator confirmed', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(await exAction('confirmExceptionReceipt', reviewed(await exceptionFor(token)))).toBe('exception_confirm_received_done')
      await refundAll(token)
      H.emails = []
      says(token, 'failed')
      await sweep()
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      expect(await blocking()).not.toBeNull()
    })

    it('the same after a refund on a payment that had completed', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', 60000)
      await sweep()
      says(token, 'completed')
      await sweep()
      await refundAll(token)
      expect((await rowFor(token)).status).toBe('refunded')
      says(token, 'failed')
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).toBeNull()
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
      expect(await blocking()).not.toBeNull()
    })

    it('"not paid" on a refunded attempt is written once, flags nothing and tells nobody', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      await refundAll(token)
      H.emails = []
      says(token, 'failed')
      await sweep()
      const once = await exceptionFor(token)
      await sweep()
      await sweep()
      expect(await exceptionFor(token)).toEqual(once)
      expect(H.emails).toHaveLength(0)
    })

    // ── a completed payment the provider stops questioning ──
    it('the page says so when the provider takes back what it questioned on a completed payment', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      expect(await page()).toContain('PayTech contredit l’état enregistré')
      const before = (await exceptionFor(token)).evidence_version
      H.emails = []
      says(token, 'completed')
      await sweep()
      const e = await exceptionFor(token)
      expect(e.evidence_version).toBeGreaterThan(before)
      expect(e.provider_answer).toBeNull()
      expect(e.provider_answers).toEqual(['provider_not_paid', 'provider_paid_at_ours'])
      const after = await page()
      expect(after).toContain('Dernière réponse de PayTech : paiement confirmé au montant enregistré')
      expect(after).not.toContain('PayTech contredit l’état enregistré')
      expect(H.emails).toHaveLength(0)
    })

    it('a payment completing after the provider refused it at another amount no longer reads as refused', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      expect(await page()).toContain('n’a pas pu honorer')
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', provider_answer: null, provider_amount: null })
      expect(e.provider_answers).toEqual(['settlement_amount_mismatch', 'provider_paid_at_ours'])
      const after = await page()
      expect(after).not.toContain('n’a pas pu honorer')
      expect(after).toContain('Dernière réponse de PayTech : paiement confirmé au montant enregistré')
    })

    // ── a dismissal ──
    it('paid after "pending" on a dismissal reopens and blocks, as it does after "not paid"', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      says(token, 'pending')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
      H.emails = []
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await blocking()).not.toBeNull()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('a provider going between "pending" and "paid" reopens a dismissal once, not every time', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      says(token, 'pending')
      await sweep()
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      says(token, 'completed')
      await sweep()
      says(token, 'pending')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
      expect(await blocking()).toBeNull()
    })

    it.each([
      ['paid at nothing', (t: string) => says(t, 'completed', 0)],
      ['paid with no readable amount', (t: string) => raw(t, 'completed', 'n/a', 'XOF')],
      ['a word the contract does not list', (t: string) => raw(t, 'chargeback', PRICE_C1, 'XOF')],
    ])('money the provider confirmed can be dismissed when its last word is %s, and what it confirmed stays', async (_name, last) => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      last(token)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.payment_received).toBe('confirmed_by_provider')
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_dismiss_done')
      expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_provider')
      expect(await blocking()).toBeNull()
    })

    it('money the provider confirmed cannot be dismissed while its last word names an amount', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      says(token, 'completed', 60000)
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
    })

    // ── a refund below what the provider named ──
    it('the amount charged can be recorded under a further attestation when the provider named more', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 46350)
      await sweep()
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      const attempt = (extra: Record<string, string>) => exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e), ...extra })
      expect(await attempt({ amount: String(PRICE_C1) })).toBe('exception_refused_refund_charged_attestation_required')
      expect(await attempt({ amount: '46000', attestCharged: 'yes' })).toBe('exception_refused_refund_amount_invalid')
      expect(await attempt({ amount: '5000', attestCharged: 'yes' })).toBe('exception_refused_refund_partial_not_supported')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await attempt({ amount: String(PRICE_C1), attestCharged: 'yes' })).toBe('exception_refund_recorded')
      expect((await exceptionFor(token)).refund_amount).toBe(PRICE_C1)
      const row = (await exceptionAudit()).filter(a => a.event_type === 'payment.exception_refund_confirmed').pop()
      expect(row?.metadata).toMatchObject({ chargedAttested: true, providerAmount: 46350 })
    })

    // ── who hears of it ──
    it('a different report on a settled record is alerted on again each week until someone reviews it', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { extra: 'second payment?' })
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      await weekPasses()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect(await exAction('acknowledgeExceptionReport', reviewed(await exceptionFor(token)))).toBe('exception_acknowledge_report_done')
      await weekPasses()
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('the same on a dismissed attempt whose notifications have used up their limit', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      for (const k of ['a', 'b', 'c']) {
        await exAction('dismissException', reviewed(await exceptionFor(token)))
        await ipn(token, { extra: k })
      }
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await ipn(token, { extra: 'd' })
      expect(await blocking()).toBeNull()
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await weekPasses()
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
    })

    it('an identical notification on a reviewed record reminds nobody once its own alert has gone', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      await exAction('dismissException', reviewed(await exceptionFor(token)))
      await ipn(token)
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await weekPasses()
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a different notification arriving while an alert goes out is still alerted on', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { extra: 'A' })
      H.emails = []
      let once = true
      H.emailDuring = async () => {
        if (!once) return
        once = false
        await ipn(token, { extra: 'B' })
      }
      await sweep()
      H.emailDuring = null
      H.emails = []
      await sweep()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('the same notification arriving while an alert goes out mails nobody again', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, { extra: 'A' })
      H.emails = []
      let once = true
      H.emailDuring = async () => {
        if (!once) return
        once = false
        await ipn(token, { extra: 'A' })
      }
      await sweep()
      H.emailDuring = null
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
    })

    it('a notification a completion left unreviewed, sent again, is not a plain repeat', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'pending')
      await ipn(token, { extra: 'A' })
      await ipn(token, { extra: 'B' })
      expect((await exceptionFor(token)).evidence_fingerprints).toHaveLength(2)
      await age(token, 20)
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).different_report_at).toBeNull()
      await ipn(token, { extra: 'B' })
      expect((await exceptionFor(token)).different_report_at).not.toBeNull()
    })

    // ── an unlisted word ──
    it('an unlisted status on a closed attempt opens a record for a person, once', async () => {
      const { token } = await closedAttempt('expired')
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      H.emails = []
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_status_unrecognised' })
      expect(e.provider_amount).toBeNull()
      expect(H.emails.map(m => m.to)).toEqual(OWNERS)
      H.emails = []
      await sweep()
      const again = await exceptionFor(token)
      expect(again.evidence_version).toBe(e.evidence_version)
      expect(again.provider_answers).toEqual(['settlement_status_unrecognised'])
      expect(H.emails).toHaveLength(0)
      expect(await exAction('dismissException', reviewed(again))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
    })

    it('an unlisted status reaches the person deciding an open record, and keeps a notification what it said', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const v = (await exceptionFor(token)).evidence_version
      raw(token, 'paid_out', PRICE_C1, 'XOF')
      await sweep()
      const e = await exceptionFor(token)
      expect(e.evidence_version).toBeGreaterThan(v)
      expect(e.provider_answers).toEqual(['settlement_status_unrecognised'])
      expect(await page()).toContain('un état de paiement que le contrat ne connaît pas')
      await ipn(token, { extra: 'again' })
      expect((await exceptionFor(token)).evidence_fingerprints).toHaveLength(2)
    })

    it('the headline does not call an unlisted status or an unreadable amount a different amount', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      const html = await page()
      expect(html).toContain('PayTech donne un état de paiement que le contrat ne connaît pas')
      expect(html).not.toContain('Montant signalé différent du montant enregistré')
    })

    // ── a manual close ──
    it('an attempt a person closed is still asked about after 30 days, so a late payment comes back', async () => {
      const token = await startAndToken(user(L1))
      const { id } = await rowFor(token)
      await age(token, 40 * 24 * 60)
      says(token, 'pending')
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      says(token, 'completed')
      P.statusCalls = []
      await sweep()
      expect(P.statusCalls).toContain(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      expect(await blocking()).not.toBeNull()
    })

    it('any other closed attempt past 30 days is left alone', async () => {
      const { token } = await closedAttempt('expired')
      await age(token, 40 * 24 * 60)
      says(token, 'completed')
      P.statusCalls = []
      await sweep()
      expect(P.statusCalls).toHaveLength(0)
      expect(await exceptionFor(token)).toBeNull()
    })

    it('a status check in progress cannot overwrite the mark of a manual close', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 8 * 24 * 60)
      says(token, 'pending')
      const { id } = await rowFor(token)
      P.duringStatus = async () => {
        expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      }
      await sweep()
      expect(await rowFor(token)).toMatchObject({ status: 'expired', failure_reason: 'manual_reconciliation_unpaid' })
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
      expect(await blocking()).toBeNull()
    })

    // ── the sweep's budget ──
    it('the alert run keeps to its share of the budget, so the provider is still asked', async () => {
      for (let i = 0; i < 30; i++) {
        const cid = `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        await asSuper(`insert into public.courses (id, slug, title, price, currency, is_published) values ($1, $2, 't', 45000, 'XOF', true)`, [cid, `budget-${i}`])
        const { token } = await closedAttempt('expired', user(L1), cid)
        await ipn(token)
      }
      await asSuper(`alter table public.payment_exceptions disable trigger payment_exceptions_guard`)
      await asSuper(`update public.payment_exceptions set alert_sent_at = null`)
      await asSuper(`alter table public.payment_exceptions enable trigger payment_exceptions_guard`)
      const stale = await startAndToken(user(L2), C2)
      await age(stale, 60)
      P.status.set(stale, { success: 1, payment: { status: 'completed', amount: 30000, currency: 'XOF', ref_command: P.refs.get(stale) } })
      const real = Date.now.bind(Date)
      let offset = 0
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
      H.emailDuring = async () => { offset += 1_000 }
      H.emails = []
      const r = await sweep()
      spy.mockRestore()
      H.emailDuring = null
      expect(H.emails.length).toBeLessThan(30)
      expect(r.body.stoppedAtBudget).toBe(1)
      expect(r.body.checked).toBeGreaterThan(0)
      expect((await rowFor(stale)).status).toBe('completed')
    })
  })

  describe('XP-PAYTECH-06B — a word that proves nothing, a close that stays a close, a sweep that did not finish', () => {
    const reviewed = reviewedForm
    const blocking = async () => (await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r as string | null
    const raw = (token: string, status: unknown, amount: unknown, currency: unknown) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency, ref_command: P.refs.get(token) ?? 'X' } })
    const page = async () => {
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      const { default: ExceptionQueue } = await import('@/app/(admin)/admin/payments/ExceptionQueue')
      return renderToStaticMarkup(ExceptionQueue({ exceptions: await listPaymentExceptions() } as never))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    }
    const finishedAt = async () => (await (await import('@/lib/payments/payment-exceptions')).lastSweepFinishedAt()).at
    const refundAll = async (token: string) => {
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e) })).toMatch(/exception_refund_recorded/)
    }
    const personCloses = async (token: string) => {
      const { id } = await rowFor(token)
      says(token, 'pending')
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_done')
      expect((await rowFor(token)).failure_reason).toBe('manual_reconciliation_unpaid')
    }
    beforeEach(() => { H.contract = FIXTURE_CONTRACT })

    // ── a person reporting another payment on a completed one ──
    it('a completed payment the provider has re-confirmed is flagged by that report, and no refund can follow', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      says(token, 'completed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await exAction('reopenExceptionAfterReview', reviewed(await exceptionFor(token)))).toBe('exception_reopen_after_review_done')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'nothing_to_return' })
      expect(e.administrator_flagged_at).not.toBeNull()
      expect(await page()).not.toContain('Un remboursement est nécessaire')
      expect(await exAction('requireExceptionRefund', reviewed(e))).not.toBe('exception_require_refund_done')
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('so is one where the provider only ever named another amount before it completed at ours', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await exAction('reopenExceptionAfterReview', reviewed(await exceptionFor(token)))).toBe('exception_reopen_after_review_done')
      const e = await exceptionFor(token)
      expect(e.state).toBe('resolved')
      expect(e.administrator_flagged_at).not.toBeNull()
    })

    it('while the provider\'s last word still questions it, that report opens the record again', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await exAction('reopenExceptionAfterReview', reviewed(await exceptionFor(token)))).toBe('exception_reopen_after_review_done')
      expect((await exceptionFor(token)).state).toBe('open')
    })

    // ── "can still be paid" on an attempt in flight ──
    it('"pending" after "paid at another amount" in flight reaches the record, once, and a person can act on it', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      const before = await exceptionFor(token)
      expect(before).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch', payment_received: 'confirmed_by_provider' })
      await sweep()
      H.emails = []
      says(token, 'pending')
      await sweep()
      const told = await exceptionFor(token)
      expect(told.provider_answer).toBe('provider_pending')
      expect(told.provider_answers).toContain('provider_pending')
      expect(told.last_signal).toBe(before.last_signal)
      expect(told.evidence_version).toBeGreaterThan(before.evidence_version)
      expect((await rowFor(token)).status).toBe('processing')
      expect(await page()).toContain('que ce paiement peut encore être réglé')

      await sweep()
      expect(H.emails.map(m => m.to).sort()).toEqual([...OWNERS].sort())
      const again = await exceptionFor(token)
      expect(again.evidence_version).toBe(told.evidence_version)
      expect(again.report_count).toBe(told.report_count)
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)

      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('"pending" in flight with nothing more on record writes nothing, and a completion still settles normally', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'pending')
      await sweep()
      expect(await exceptionFor(token)).toBeNull()

      const next = await startAndToken(user(L2))
      await age(next, 20)
      says(next, 'pending')
      await ipn(next)
      const watched = await exceptionFor(next)
      expect(watched).toMatchObject({ state: 'watching', provider_answer: null })
      await sweep()
      expect(await exceptionFor(next)).toMatchObject({ state: 'watching', provider_answer: null, report_count: watched.report_count })
      expect((await exceptionFor(next)).provider_answers).toEqual([])
      says(next, 'completed')
      await sweep()
      expect(await exceptionFor(next)).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
    })

    // ── a person's close ──
    it('a notification that fails a check does not rewrite a person\'s close, and the sweep goes on asking', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60 * 24 * 40)
      await personCloses(token)
      await ipn(token, { item_price: '1' })
      const after = await rowFor(token)
      expect(after.failure_reason).toBe('manual_reconciliation_unpaid')
      expect(after.last_ipn_at).not.toBeNull()
      await ipn(token, { hmac_compute: 'deadbeef' })
      expect((await rowFor(token)).failure_reason).toBe('manual_reconciliation_unpaid')

      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      P.statusCalls = []
      says(token, 'completed')
      await sweep()
      expect(P.statusCalls.filter(t => t === token).length).toBeGreaterThan(0)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
    })

    it('in flight, a notification that fails a check is still noted on the attempt', async () => {
      const token = await startAndToken(user(L1))
      await ipn(token, { item_price: '1' })
      expect((await rowFor(token)).failure_reason).toBe('ipn_amount_mismatch')
    })

    // ── dismissing what the provider confirmed ──
    it.each([
      ['it was not paid', (t: string) => says(t, 'failed'), 'exception_dismiss_done'],
      ['it can still be paid', (t: string) => says(t, 'pending'), 'exception_dismiss_done'],
      ['paid, at no amount it can read', (t: string) => raw(t, 'completed', 'n/a', 'XOF'), 'exception_refused_payment_confirmed_cannot_dismiss'],
      ['a word the contract does not list', (t: string) => raw(t, 'chargeback', 60000, 'XOF'), 'exception_refused_payment_confirmed_cannot_dismiss'],
    ] as [string, (_t: string) => void, string][])('with a named amount standing and its last word that %s, the dismissal is decided on that', async (_name, say, notice) => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 60000)
      await sweep()
      say(token)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.provider_amount).toBe(60000)
      expect(await exAction('dismissException', reviewed(e))).toBe(notice)
    })

    it.each([
      ['no amount it can read', (t: string) => raw(t, 'completed', 'n/a', 'XOF')],
      ['a word the contract does not list', (t: string) => raw(t, 'chargeback', PRICE_C1, 'XOF')],
    ] as [string, (_t: string) => void][])('with no amount standing and its last word %s, money it confirmed can be dismissed', async (_name, say) => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      say(token)
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ payment_received: 'confirmed_by_provider', provider_amount: null })
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_dismiss_done')
    })

    // ── a word nobody has defined ──
    it('in flight it opens a record for a person, which blocks a new attempt until they have read it, and alerts once', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      H.emails = []
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_status_unrecognised' })
      expect((await rowFor(token)).status).toBe('processing')
      expect(await blocking()).not.toBeNull()
      await sweep()
      expect(H.emails.map(m => m.to).sort()).toEqual([...OWNERS].sort())
      H.emails = []
      await sweep()
      expect(H.emails).toHaveLength(0)
      expect(await page()).toContain('PayTech donne un état de paiement que le contrat ne connaît pas')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
    })

    it('in flight, on a record that already exists, it becomes the last word and blocks as that record did', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      raw(token, 'chargeback', 60000, 'XOF')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised', payment_received: 'confirmed_by_provider' })
      expect(await blocking()).not.toBeNull()
    })

    it('that the record could not be written is what the run reports', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      const res = await sweep()
      H.rpcFaultFor = null
      expect(res.body.exception_unrecorded).toBe(1)
    })

    it('after a recorded refund it flags the record, blocks a new attempt, and the page says what it is', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      await refundAll(token)
      raw(token, 'refunded', PRICE_C1, 'XOF')
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', resolution: 'refund_confirmed', provider_answer: 'settlement_status_unrecognised' })
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(await blocking()).not.toBeNull()
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      const { default: ExceptionQueue } = await import('@/app/(admin)/admin/payments/ExceptionQueue')
      const text = renderToStaticMarkup(ExceptionQueue({ exceptions: await listPaymentExceptions({ states: ['resolved'], flaggedOnly: true }) } as never))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      expect(text).toContain('PayTech a donné après ce règlement un état de paiement que le contrat ne connaît pas')
      expect(text).not.toContain('Un paiement a été signalé après ce règlement')
    })

    it('after a completed payment was refunded it does the same', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      await refundAll(token)
      expect((await rowFor(token)).status).toBe('refunded')
      raw(token, 'refunded', PRICE_C1, 'XOF')
      await sweep()
      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.provider_answer).toBe('settlement_status_unrecognised')
      expect(await blocking()).not.toBeNull()
    })

    it('on an attempt a person closed it opens a record, and a person can clear it', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60 * 24 * 8)
      await personCloses(token)
      raw(token, 'expired', PRICE_C1, 'XOF')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_status_unrecognised' })
      expect(await blocking()).not.toBeNull()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeDefined()
    })

    it('on a closed attempt a person dismissed it reopens the record once, and said again it does not', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised' })
      expect(await blocking()).not.toBeNull()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('resolved')
      expect(await blocking()).toBeNull()
    })

    it('it does not lift a block that something else holds', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'reported', provider_answer: 'settlement_status_unrecognised' })
      expect(await blocking()).not.toBeNull()
    })

    it('it does not lift the block "can still be paid" set', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'pending')
      await sweep()
      expect(await blocking()).not.toBeNull()
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('settlement_status_unrecognised')
      expect(await blocking()).not.toBeNull()
    })

    it('on a completed payment a person dismissed, it opens the record again: the provider no longer says what it said', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised' })
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('a signed paid notification on a closed attempt keeps its claim when the provider answers that word', async () => {
      const { token } = await closedAttempt('expired')
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', payment_received: 'reported', last_signal: 'paid_hint' })
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect(await blocking()).not.toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
      // The next status check keeps the word as what the provider last said.
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('settlement_status_unrecognised')
      expect(await blocking()).not.toBeNull()
    })

    it('after a dismissal, a different signed paid notification with that word reopens the record', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token, { extra: 'A' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint' })
      expect(await blocking()).not.toBeNull()
    })

    it('after a recorded refund, a different signed paid notification with that word flags the record', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      await refundAll(token)
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token, { extra: 'A' })
      const e = await exceptionFor(token)
      expect(e.post_settlement_report_at).not.toBeNull()
      expect(e.last_signal).toBe('paid_hint')
      expect(await blocking()).not.toBeNull()
      expect((await checkout(user(L1), C1)).redirectUrl).toBeUndefined()
    })

    it('a reviewed notification replayed while the provider answers that word: the replay counts, the word reopens, once', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_answer: 'settlement_status_unrecognised' })
      expect(e.evidence_fingerprints).toHaveLength(1)
      expect(await blocking()).not.toBeNull()
      await ipn(token)
      const again = await exceptionFor(token)
      expect(again.evidence_version).toBe(e.evidence_version)
      expect(again.state).toBe('open')
    })

    it('a notification on an attempt in flight stays watched, and the sweep then keeps the word and opens it', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', last_signal: 'paid_hint', payment_received: 'reported', provider_answer: null })
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised' })
    })

    it.each([['0', 0], ['a negative amount', -5]] as [string, number][])('the provider saying a completed payment was paid at %s still leaves a record, naming no amount', async (_name, amount) => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', amount)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch', provider_amount: null })
    })

    // ── paid, and completion keeps failing ──
    it('a refusal a retry can clear opens no record, however old the attempt, and the retry completes it', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60 * 25)
      says(token, 'completed')
      H.rpcFaultFor = { fn: 'complete_payment', error: { message: 'relation does not exist', details: null, code: '42P01' } }
      H.emails = []
      await sweep()
      await sweep()
      expect(await exceptionFor(token)).toBeNull()
      expect(H.emails).toHaveLength(0)
      expect(await blocking()).toBeNull()
      H.rpcFaultFor = null
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toBeNull()
    })

    // ── what the provider last said ──
    const refuseCompletion = () => asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason) values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])

    it('"paid", refused, after "pending" is its last word, so the money it confirmed cannot be dismissed', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      says(token, 'pending')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('provider_pending')
      await refuseCompletion()
      says(token, 'completed')
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ payment_received: 'confirmed_by_provider', provider_answer: null, provider_amount: null })
      expect(await exAction('dismissException', reviewed(e))).toBe('exception_refused_payment_confirmed_cannot_dismiss')
      expect(await page()).not.toContain('Classer : rien à rembourser')
    })

    it('"pending" after "paid", refused, is kept as its last word, and going back and forth reaches a person', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      await refuseCompletion()
      says(token, 'completed')
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ payment_received: 'confirmed_by_provider', provider_answer: null })
      says(token, 'pending')
      await sweep()
      expect((await exceptionFor(token)).provider_answer).toBe('provider_pending')
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).provider_answers).toContain('provider_paid')
      says(token, 'pending')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      const dismissed = await exceptionFor(token)
      says(token, 'completed')
      await sweep()
      const third = await exceptionFor(token)
      expect(third.provider_answer).toBeNull()
      expect(third.evidence_version).toBeGreaterThan(dismissed.evidence_version)
      expect(third.repeat_alert_due_at).not.toBeNull()
    })

    it.each([
      ['a word the contract does not list', (t: string) => raw(t, 'chargeback', PRICE_C1, 'XOF')],
      ['paid at no amount it can read', (t: string) => raw(t, 'completed', 'n/a', 'XOF')],
      ['paid at nothing', (t: string) => says(t, 'completed', 0)],
    ] as [string, (_t: string) => void][])('"paid" after %s and a dismissal is news: it reopens the record and blocks a new attempt', async (_name, say) => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      say(token)
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      expect(await blocking()).toBeNull()
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await blocking()).not.toBeNull()
    })

    it('a cancellation that cannot be kept on a closed attempt is retried, with no contract', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'simulated', code: 'XX000' } }
      const res = await ipn(token, { type_event: 'sale_canceled' })
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
    })

    // ── who gets the alert ──
    it('with one address failing the others are told once, not on every run, and the failure is logged', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail_second'
      H.emails = []
      H.logs = []
      await ipn(token)
      const counts = [H.emails.length]
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()
      expect(H.logs.some(l => l.level === 'error' && JSON.stringify(l.args).includes('alert'))).toBe(true)
      for (let i = 0; i < 3; i++) {
        H.emails = []
        await sweep()
        counts.push(H.emails.length)
      }
      expect(counts).toEqual([OWNERS.length, 0, 0, 0])
    })

    it('a stamp the database refused is not counted as sent', async () => {
      const { token } = await closedAttempt('expired')
      H.contract = null
      H.emailMode = 'fail'
      await ipn(token)
      H.emailMode = 'ok'
      H.emailDuring = async () => {
        H.emailDuring = null
        await asRole('service_role', null, `select public.payment_exception_report($1, 'paid_hint', 'ipn', null, $2)`, [(await rowFor(token)).id, 'd'.repeat(64)])
      }
      const res = await sweep()
      expect(H.emails.length).toBeGreaterThan(0)
      expect(res.body.alertsSent ?? 0).toBe(0)
      expect((await exceptionFor(token)).alert_sent_at).toBeNull()
    })

    // ── a run that left work undone ──
    it('a run whose escalation failed is not a finished sweep', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await ageException(token, 48)
      H.rpcFaultFor = { fn: 'payment_exception_escalate_watching', error: { message: 'boom', details: null } }
      const res = await sweep()
      H.rpcFaultFor = null
      expect(res.status).toBe(200)
      expect(res.body.escalationFailed).toBe(1)
      expect(await finishedAt()).toBeNull()
      await sweep()
      expect(await finishedAt()).not.toBeNull()
    })

    it('a run that could not write a report is not a finished sweep', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      H.rpcFaultFor = { fn: 'payment_exception_report', error: { message: 'storage down', details: null } }
      const res = await sweep()
      H.rpcFaultFor = null
      expect(res.body.exception_unrecorded).toBe(1)
      expect(await finishedAt()).toBeNull()
    })

    // ── a refund below the provider's last amount ──
    it('a figure below the provider\'s last amount needs the attestation that it is all that was received, even one it named', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 5000)
      await sweep()
      says(token, 'completed', 60000)
      await sweep()
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      const fields = { ...refundFields(e.id), ...reviewed(e), amount: '5000' }
      expect(await exAction('recordExceptionRefund', fields)).toBe('exception_refused_refund_charged_attestation_required')
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await exAction('recordExceptionRefund', { ...fields, attestCharged: 'yes' })).toMatch(/exception_refund_recorded/)
    })

    it('the provider\'s last amount itself needs no such attestation', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed', 5000)
      await sweep()
      says(token, 'completed', 60000)
      await sweep()
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e), amount: '60000' })).toMatch(/exception_refund_recorded/)
    })
  })

  describe('XP-PAYTECH-06B — the provider\'s last word beside a notification, and a refusal a completion settles', () => {
    const reviewed = reviewedForm
    const blocking = async () => (await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r as string | null
    const raw = (token: string, status: unknown, amount: unknown, currency: unknown) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency, ref_command: P.refs.get(token) ?? 'X' } })
    const page = async () => {
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { listPaymentExceptions } = await import('@/lib/payments/payment-exceptions')
      const { default: ExceptionQueue } = await import('@/app/(admin)/admin/payments/ExceptionQueue')
      return renderToStaticMarkup(ExceptionQueue({ exceptions: await listPaymentExceptions() } as never))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    }
    const refuseCompletion = () => asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason) values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
    beforeEach(() => { H.contract = FIXTURE_CONTRACT })

    it('an unlisted word beside a replayed notification becomes the provider\'s last word and moves the version; the claim stays the notification\'s', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      const before = await exceptionFor(token)
      expect(before).toMatchObject({ state: 'open', provider_answer: 'provider_not_paid', last_signal: 'paid_hint', payment_received: 'reported' })
      const form = reviewed(before)
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      expect((await ipn(token)).status).toBe(200)
      const after = await exceptionFor(token)
      expect(after).toMatchObject({ state: 'open', provider_answer: 'settlement_status_unrecognised', last_signal: 'paid_hint', payment_received: 'reported' })
      expect(after.provider_answers).toEqual(expect.arrayContaining(['provider_not_paid', 'settlement_status_unrecognised']))
      expect(after.evidence_version).toBeGreaterThan(before.evidence_version)
      expect(await exAction('dismissException', form)).toBe('exception_refused_evidence_changed')
      expect(await blocking()).not.toBeNull()
      expect(await page()).toContain('un état de paiement que le contrat ne connaît pas')
    })

    it('after a dismissal, a different notification beside that word reopens the record with the notification\'s claim and the provider\'s word', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      says(token, 'failed')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      await ipn(token, { extra: 'A' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_answer: 'settlement_status_unrecognised' })
      expect(await blocking()).not.toBeNull()
    })

    it('if the word beside a notification cannot be written, the notification is retried, and the claim it made is kept', async () => {
      const { token } = await closedAttempt('expired')
      raw(token, 'processing_at_bank', PRICE_C1, 'XOF')
      H.rpcFaultFor = { fn: 'payment_exception_report', when: a => a.p_detail === 'settlement_status_unrecognised', error: { message: 'storage down', details: null } }
      const res = await ipn(token)
      H.rpcFaultFor = null
      expect(res.status).toBe(503)
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'paid_hint', provider_answer: null })
    })

    it('a refusal 062 later honours, with nothing else on the record, is settled by that completion', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      await refuseCompletion()
      says(token, 'completed')
      await sweep()
      const refused = await exceptionFor(token)
      expect(refused).toMatchObject({ state: 'open', first_signal: 'completion_refused', last_signal: 'completion_refused', payment_received: 'confirmed_by_provider', provider_answer: null })
      expect((await rowFor(token)).status).toBe('processing')
      await asSuper(`delete from public.entitlements where user_id = $1 and course_id = $2`, [L1, C1])
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      const settled = await exceptionFor(token)
      expect(settled).toMatchObject({ state: 'resolved', resolution: 'settled_normally', refund_state: 'not_required', payment_received: 'confirmed_by_provider' })
      expect(settled.post_settlement_report_at).toBeNull()
      const [{ n }] = await asSuper(`select count(*)::int as n from public.audit_log where event_type = 'payment.exception_settled' and metadata ->> 'exceptionId' = $1`, [settled.id])
      expect(n).toBe(1)
      expect(await page()).not.toContain('n’a pas pu honorer')
    })

    it('a refusal a person has acted on stays open through a completion', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      await refuseCompletion()
      says(token, 'completed')
      await sweep()
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      await asSuper(`delete from public.entitlements where user_id = $1 and course_id = $2`, [L1, C1])
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).state).toBe('open')
    })
  })

  describe('XP-PAYTECH-06B — what the mutation run found untested', () => {
    const reviewed = reviewedForm
    const blocking = async () => (await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r as string | null
    const raw = (token: string, status: unknown, amount: unknown, currency: unknown) =>
      P.status.set(token, { success: 1, payment: { status, amount, currency, ref_command: P.refs.get(token) ?? 'X' } })
    const refundAll = async (token: string) => {
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e) })).toMatch(/exception_refund_recorded/)
    }
    beforeEach(() => { H.contract = FIXTURE_CONTRACT })

    // ── the version ──
    it('a record cannot start with a version', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      const { id } = await rowFor(token)
      await expect(asSuper(`insert into public.payment_exceptions (payment_id, state, first_signal, last_signal, payment_received, evidence_version)
                            values ($1, 'open', 'paid_hint', 'paid_hint', 'reported', 1)`, [id])).rejects.toThrow(/must_start_clean/)
    })

    it('a report escalating from watching to open moves the version, and nothing else about it', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      const watched = await exceptionFor(token)
      expect(watched.state).toBe('watching')
      const stale = reviewed(watched)
      await ageException(token, 48)
      await sweep()
      const opened = await exceptionFor(token)
      expect(opened.state).toBe('open')
      expect(opened.evidence_version).toBe(watched.evidence_version + 1)
      expect(await exAction('dismissException', stale)).toBe('exception_refused_evidence_changed')
    })

    it('the provider going back to a word it gave before moves the version, though the list of its words does not change', async () => {
      const { token } = await closedAttempt('expired')
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      raw(token, 'completed', 'n/a', 'XOF')
      await sweep()
      const before = await exceptionFor(token)
      expect(before.provider_answer).toBe('settlement_amount_unreadable')
      const stale = reviewed(before)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      const after = await exceptionFor(token)
      expect(after.provider_answer).toBe('settlement_status_unrecognised')
      expect(after.provider_answers).toEqual(before.provider_answers)
      expect(after.evidence_version).toBe(before.evidence_version + 1)
      expect(await exAction('dismissException', stale)).toBe('exception_refused_evidence_changed')
    })

    it('a refund decision moves the version, so a form from before it cannot withdraw it', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      const before = await exceptionFor(token)
      expect(await exAction('requireExceptionRefund', reviewed(before))).toBe('exception_require_refund_done')
      expect(await exAction('withdrawExceptionRefund', reviewed(before))).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).refund_state).toBe('required')
    })

    it('a confirmation of receipt moves the version, so a form from before it cannot withdraw it', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      await ipn(token)
      const before = await exceptionFor(token)
      expect(await exAction('confirmExceptionReceipt', reviewed(before))).toBe('exception_confirm_received_done')
      expect(await exAction('withdrawExceptionReceipt', reviewed(before))).toBe('exception_refused_evidence_changed')
      expect((await exceptionFor(token)).payment_received).toBe('confirmed_by_operator')
    })

    it('a stored notification said again changes the headline and not the version', async () => {
      const { token } = await closedAttempt('expired')
      await ipn(token)
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      const before = await exceptionFor(token)
      expect(before.last_signal).toBe('amount_mismatch')
      const form = reviewed(before)
      await ipn(token)
      const after = await exceptionFor(token)
      expect(after.last_signal).toBe('paid_hint')
      expect(after.evidence_version).toBe(before.evidence_version)
      expect(await exAction('dismissException', form)).toBe('exception_dismiss_done')
    })

    // ── a completion ──
    it('a completion at our amount takes back the amount the provider named, and its last word', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 60000)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch', provider_amount: 60000 })
      // Completed by a person's check, not by the sweep: the sweep would ask the provider again at once and hide what the completion itself does.
      says(token, 'completed')
      expect(await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })).toBe('verify_completed')
      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', provider_answer: null, provider_amount: null })
      expect(e.provider_answers).toContain('provider_paid_at_ours')
      expect(e.provider_amounts.map(Number)).toEqual(expect.arrayContaining([60000, PRICE_C1]))
    })

    it('a completion at our amount after "paid at nothing" takes that word back too', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'completed', 0)
      await sweep()
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', provider_answer: 'settlement_amount_mismatch', provider_amount: null })
      says(token, 'completed')
      expect(await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })).toBe('verify_completed')
      expect((await rowFor(token)).status).toBe('completed')
      const e = await exceptionFor(token)
      expect(e.provider_answer).toBeNull()
      expect(e.provider_answers).toContain('provider_paid_at_ours')
    })

    it('an open record whose money an administrator confirmed is alerted on again when the payment completes', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token)
      await age(token, 20)
      await ageException(token, 48)
      await sweep()
      const e = await exceptionFor(token)
      expect(e.state).toBe('open')
      expect(await exAction('confirmExceptionReceipt', reviewed(e))).toBe('exception_confirm_received_done')
      await sweep()
      expect((await exceptionFor(token)).alert_sent_at).not.toBeNull()
      H.contract = FIXTURE_CONTRACT
      H.emails = []
      says(token, 'completed')
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
      expect(H.emails.map(m => m.to).sort()).toEqual([...OWNERS].sort())
    })

    it('"not paid" after a dismissal on a word that proved nothing is kept, so that "paid" after it is seen', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      raw(token, 'chargeback', PRICE_C1, 'XOF')
      await sweep()
      expect(await exAction('dismissException', reviewed(await exceptionFor(token)))).toBe('exception_dismiss_done')
      says(token, 'failed')
      await sweep()
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'resolved', provider_answer: 'provider_not_paid' })
      expect(e.provider_answers).toContain('provider_not_paid')
      says(token, 'completed')
      await sweep()
      expect((await exceptionFor(token)).state).toBe('open')
      expect(await blocking()).not.toBeNull()
    })

    it('the provider\'s "failed" is kept when another path completes the payment while it answers', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 20)
      says(token, 'failed')
      P.duringStatus = async () => {
        says(token, 'completed')
        expect((await ipn(token)).status).toBe(200)
        says(token, 'failed')
      }
      // Through a person's check, not the sweep: the sweep would ask the provider again and write the answer that way.
      expect(await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })).toBe('verify_already_completed')
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid', payment_received: 'confirmed_by_provider' })
    })

    // ── a refund ──
    it('on a completed payment an amount the provider named earlier, between the charge and its last amount, is still partial', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      says(token, 'completed', 60000)
      await sweep()
      says(token, 'completed', 90000)
      await sweep()
      const e0 = await exceptionFor(token)
      expect(e0).toMatchObject({ state: 'open', provider_amount: 90000 })
      expect(e0.provider_amounts.map(Number)).toEqual(expect.arrayContaining([60000, 90000]))
      expect(await exAction('requireExceptionRefund', reviewed(e0))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e), amount: '60000', attestCharged: 'yes' })).toBe('exception_refused_refund_partial_not_supported')
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('a refund form that does not say which version it showed is refused', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await sweep()
      expect(await exAction('requireExceptionRefund', reviewed(await exceptionFor(token)))).toBe('exception_require_refund_done')
      const e = await exceptionFor(token)
      // An empty value is a form that does not say; the helper fills in a missing one.
      expect(await exAction('recordExceptionRefund', { ...refundFields(e.id), ...reviewed(e), evidenceVersion: '' })).toBe('exception_refused_evidence_version_required')
      expect((await exceptionFor(token)).state).toBe('open')
    })
  })

  describe('XP-PAYTECH-06C — a transient refusal after « Vérifier »', () => {
    const fault = () => { H.rpcFaultFor = { fn: 'complete_payment', error: { message: 'relation does not exist', details: null, code: '42P01' } } }
    const queue = async () => (await (await import('@/lib/payments/payment-exceptions')).listPaymentExceptions()) ?? []
    beforeEach(() => { H.contract = FIXTURE_CONTRACT })
    afterEach(() => { H.rpcFaultFor = null })

    it('says a technical error happened and nothing was decided: no record, no block, nothing to refund', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      says(token, 'completed')
      const { id } = await rowFor(token)
      fault()
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_retry')
      expect((await rowFor(token)).status).toBe('processing')
      expect(await exceptionFor(token)).toBeNull()
      expect(await queue()).toEqual([])
      expect((await asSuper(`select public.payment_exception_blocking_reference($1, $2) as r`, [L1, C1]))[0].r).toBeNull()
      // The only money action on an attempt with no record is a close, and the provider's "paid" refuses it.
      expect(await adminAction('closeUnpaidPaytechPayment', { paymentId: id, reason: NOTE, attest: 'yes' })).toBe('close_refused_provider_says_paid')
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('a retry completes it, and nothing is left behind', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      says(token, 'completed')
      const { id } = await rowFor(token)
      fault()
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_retry')
      H.rpcFaultFor = null
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_completed')
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toBeNull()
    })

    it('the daily sweep completes it too, with nobody told of a refusal in between', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      says(token, 'completed')
      fault()
      H.emails = []
      await sweep()
      expect((await rowFor(token)).status).toBe('processing')
      expect(await exceptionFor(token)).toBeNull()
      expect(H.emails).toHaveLength(0)
      H.rpcFaultFor = null
      await sweep()
      expect((await rowFor(token)).status).toBe('completed')
    })

    it('a refusal that is final is a record and a decision, and the notice says so', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status, revoked_at, revoked_reason) values ($1, $2, 'MANUAL_ADMIN', 'REVOKED', now(), 'test')`, [L1, C1])
      says(token, 'completed')
      const { id } = await rowFor(token)
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_refused')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'completion_refused', payment_received: 'confirmed_by_provider' })
    })

    it('a paid notification during the fault is watched and retried, and the retry settles it', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      says(token, 'completed')
      fault()
      expect((await ipn(token)).status).toBe(503)
      expect(await exceptionFor(token)).toMatchObject({ state: 'watching', last_signal: 'paid_hint', payment_received: 'reported' })
      H.rpcFaultFor = null
      expect((await ipn(token)).status).toBe(200)
      expect((await rowFor(token)).status).toBe('completed')
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
    })

    it('a notification that fails its check during the fault is watched, and the completion flags it rather than settling it away', async () => {
      const token = await startAndToken(user(L1))
      await age(token, 60)
      says(token, 'completed')
      fault()
      await ipn(token, { item_price: '46000' }, { signAmount: 46000 })
      const opened = await exceptionFor(token)
      // A different amount fails the signature check against the stored amount: watched, proving nothing, blocking nobody.
      expect(opened).toMatchObject({ state: 'watching', last_signal: 'unverified_report', payment_received: 'not_established' })
      H.rpcFaultFor = null
      const { id } = await rowFor(token)
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_completed')
      const after = await exceptionFor(token)
      expect(after).toMatchObject({ state: 'resolved', resolution: 'settled_normally' })
      expect(after.post_settlement_report_at).not.toBeNull()
    })

    it('a late paid answer on a closed attempt opens a record whatever the fault, and the notice points at it', async () => {
      const { token, id } = await closedAttempt('expired')
      says(token, 'completed')
      fault()
      expect(await adminAction('verifyPaytechPayment', { paymentId: id })).toBe('verify_already_terminal')
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', payment_received: 'confirmed_by_provider' })
    })
  })

  describe('XP-PAYTECH-05 — no secret, token or phone number leaves the record', () => {
    it('across a late report, an alert, a decision and a refund', async () => {
      const { token } = await closedAttempt('expired')
      says(token, 'completed')
      await ipn(token)
      const e = await exceptionFor(token)
      await exAction('requireExceptionRefund', { exceptionId: e.id, note: NOTE })
      await exAction('recordExceptionRefund', refundFields(e.id))
      const stored = JSON.stringify(await exceptionAudit()) + JSON.stringify(await exceptionFor(token)) + JSON.stringify(H.emails)
      const logged = JSON.stringify(H.logs)
      for (const s of [API_KEY, API_SECRET, sha256(API_KEY), sha256(API_SECRET), token, '770000000']) {
        expect(stored, `the record contains ${s.slice(0, 6)}…`).not.toContain(s)
        expect(logged, `the log contains ${s.slice(0, 6)}…`).not.toContain(s)
      }
      expect(JSON.stringify(H.emails)).not.toContain('l1@example.test')
    })
  })

  describe('LOGGING — no secret, hash, token or phone number is ever logged', () => {
    it('across checkout, refusals, completion, the sweep and admin actions', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token, {}, { secret: 'sk_wrong' })
      await ipn(token, { api_key_sha256: 'x' })
      await age(token, 20)
      await sweep()
      await ipn(token)
      await adminAction('verifyPaytechPayment', { paymentId: (await rowFor(token)).id })
      const all = JSON.stringify(H.logs)
      expect(H.logs.length).toBeGreaterThan(3)
      for (const s of [API_KEY, API_SECRET, sha256(API_KEY), sha256(API_SECRET), token, '770000000', CRON]) {
        expect(all, `log contains ${s.slice(0, 6)}…`).not.toContain(s)
      }
    })
  })
  // ═══ XP-LAUNCH-FINAL-08 — six months, packs, renewal (migration 065) ═══════
  //
  // Marième's confirmed commercial conditions, on the real engine: every price is the
  // database's, a purchase opens six calendar months from the validation of the
  // payment, a pack is ONE payment that opens its courses together, a lapsed purchase
  // can be bought again, administrative grants are never re-dated, and one learner
  // never holds two payable attempts that would open the same course.
  describe('XP-LAUNCH-FINAL-08 — six months, packs and renewal (migration 065)', () => {
    const PACKS_V4 = [
      ['PACK-CONSEILLER', 'C1-F1', 1], ['PACK-CONSEILLER', 'C1-F2', 2], ['PACK-CONSEILLER', 'C1-F3', 3],
      ['PACK-CONSEILLER', 'C2-F4', 4],
      ['PACK-MANAGER', 'C2-F1', 1], ['PACK-MANAGER', 'C2-F2', 2], ['PACK-MANAGER', 'C2-F5', 3],
    ] as const
    let ids: Record<string, string>

    beforeEach(async () => {
      H.contract = FIXTURE_CONTRACT
      // beforeEach above emptied the catalogue, which cascades to the packs' courses.
      await seedCatalogueCodes()
      for (const [pack, code, position] of PACKS_V4) {
        await asSuper(`insert into public.course_pack_courses (pack_id, course_id, position)
          select p.id, c.id, $3 from public.course_packs p, public.courses c where p.code = $1 and c.code = $2
          on conflict do nothing`, [pack, code, position])
      }
      ids = Object.fromEntries((await asSuper(`select code, id from public.courses where code is not null`)).map(r => [r.code, r.id]))
    })

    async function packCheckout(u: U | null, packCode: string, acknowledgedCourseIds?: string[]) {
      H.user = u
      const { startPaytechPackCheckout } = await import('@/app/actions/paytech-checkout')
      return startPaytechPackCheckout({ packCode, consent: tickedCheckoutConsent(), ...(acknowledgedCourseIds ? { acknowledgedCourseIds } : {}) })
    }
    async function packToken(u: U, packCode: string, ack?: string[]) {
      const r = await packCheckout(u, packCode, ack)
      expect(r.error, `pack checkout refused: ${r.error}`).toBeUndefined()
      return r.redirectUrl!.split('/').pop()!
    }
    const packId = async (code: string) => (await asSuper(`select id from public.course_packs where code = $1`, [code]))[0].id as string
    const windows = (userId: string) => asSuper(`select course_id, source, status, starts_at, expires_at,
        (expires_at = starts_at + interval '6 months') as six_months,
        (abs(extract(epoch from (starts_at - now()))) < 120) as opened_now
      from public.entitlements where user_id = $1 order by created_at, course_id`, [userId])

    it('065 ran WHOLE: two published packs at the decided prices, and nothing a browser may write', async () => {
      expect(await asSuper(`select code, price::int as price, is_published from public.course_packs order by position`)).toEqual([
        { code: 'PACK-CONSEILLER', price: 37900, is_published: true },
        { code: 'PACK-MANAGER', price: 38000, is_published: true },
      ])
      expect((await asRole('anon', null, `select code from public.course_packs order by position`)).map(r => r.code))
        .toEqual(['PACK-CONSEILLER', 'PACK-MANAGER'])
      expect((await asRole('anon', null, `select count(*)::int as n from public.course_pack_courses`))[0].n).toBe(7)
      for (const sql of [
        `insert into public.course_packs (code, title, price) values ('PACK-X', 'Pack X', 1)`,
        `update public.course_packs set price = 1`,
        `delete from public.course_pack_courses`,
        `select * from public.payment_entitlements`,
        `select pack_id from public.payments`,
      ]) {
        await expect(asRole('authenticated', L1, sql), sql).rejects.toThrow(/permission denied/)
      }
    })

    it.each([
      ['C1-F1', 9900], ['C1-F2', 9900], ['C1-F3', 9900], ['C2-F4', 14900],
      ['C2-F1', 14900], ['C2-F2', 14900], ['C2-F5', 14900],
    ] as const)('%s is charged its database price, %d XOF: the payment row and PayTech agree', async (code, price) => {
      const r = await checkout(user(L1), ids[code])
      expect(r.redirectUrl).toBeDefined()
      expect(await asSuper(`select amount::int as amount, currency, course_id, pack_id from public.payments where user_id = $1`, [L1]))
        .toEqual([{ amount: price, currency: 'XOF', course_id: ids[code], pack_id: null }])
      expect(P.requests.at(-1)).toMatchObject({ item_price: price, currency: 'XOF' })
    })

    it('C1-F4, the free course, is never sold: nothing is opened, PayTech is not called', async () => {
      await asSuper(`insert into public.courses (slug, title, code, price, currency, is_published, is_free)
        values ('seed-c1-f4', 'Formation gratuite', 'C1-F4', 0, 'XOF', true, true)`)
      const free = (await asSuper(`select id from public.courses where code = 'C1-F4'`))[0].id
      const r = await checkout(user(L1), free)
      expect(r.redirectUrl).toBeUndefined()
      expect(r.error).toMatch(/réglable/)
      expect(P.requests).toEqual([])
    })

    it('a course purchase opens SIX MONTHS from the validation of the payment, and records what it granted', async () => {
      const token = await startAndToken(user(L1), ids['C1-F1'])
      says(token, 'completed', 9900)
      expect((await ipn(token)).status).toBe(200)
      expect(await windows(L1)).toMatchObject([
        { course_id: ids['C1-F1'], source: 'INDIVIDUAL_PURCHASE', status: 'ACTIVE', six_months: true, opened_now: true },
      ])
      const row = await rowFor(token)
      expect(row.status).toBe('completed')
      expect(await asSuper(`select course_id, preexisting from public.payment_entitlements where payment_id = $1`, [row.id]))
        .toEqual([{ course_id: ids['C1-F1'], preexisting: false }])
      expect(await dbHasAccess(L1, ids['C1-F1'])).toBe(true)
    })

    it('Pack Conseiller: ONE payment of 37 900 XOF opens its four courses at the same instant, for six months', async () => {
      const token = await packToken(user(L1), 'PACK-CONSEILLER')
      const row = await rowFor(token)
      expect(row).toMatchObject({ course_id: null, pack_id: await packId('PACK-CONSEILLER'), status: 'processing' })
      expect(Number(row.amount)).toBe(37900)
      expect(P.requests.at(-1)).toMatchObject({ item_price: 37900, currency: 'XOF', item_name: 'Pack Conseiller' })

      says(token, 'completed', 37900)
      expect((await ipn(token)).status).toBe(200)
      const ents = await windows(L1)
      expect(ents).toHaveLength(4)
      expect(new Set(ents.map(e => e.course_id))).toEqual(new Set(['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4'].map(c => ids[c])))
      expect(new Set(ents.map(e => String(e.starts_at))).size).toBe(1)
      expect(new Set(ents.map(e => String(e.expires_at))).size).toBe(1)
      expect(ents.every(e => e.six_months && e.opened_now && e.source === 'INDIVIDUAL_PURCHASE' && e.status === 'ACTIVE')).toBe(true)
      for (const c of ['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4']) expect(await dbHasAccess(L1, ids[c])).toBe(true)
      expect(await dbHasAccess(L1, ids['C2-F1'])).toBe(false)
      expect((await asSuper(`select count(*)::int as n from public.enrollments where user_id = $1`, [L1]))[0].n).toBe(4)

      const done = await rowFor(token)
      expect(done.status).toBe('completed')
      expect((await asSuper(`select count(*)::int as n from public.entitlements where id = $1`, [done.entitlement_id]))[0].n).toBe(1)
      const [audit] = await asSuper(`select metadata from public.audit_log where event_type = 'payment.completed'`)
      expect(audit.metadata).toMatchObject({ courseId: null, packId: row.pack_id })
      expect(audit.metadata.items).toHaveLength(4)

      // A replayed notification changes nothing: no second entitlement, enrollment or link.
      expect((await ipn(token)).status).toBe(200)
      expect(await windows(L1)).toHaveLength(4)
      expect((await asSuper(`select count(*)::int as n from public.enrollments where user_id = $1`, [L1]))[0].n).toBe(4)
      expect((await asSuper(`select count(*)::int as n from public.payment_entitlements where payment_id = $1`, [done.id]))[0].n).toBe(4)
    })

    it('Pack Manager: 38 000 XOF for exactly its three courses', async () => {
      const token = await packToken(user(L2), 'PACK-MANAGER')
      expect(P.requests.at(-1)).toMatchObject({ item_price: 38000, currency: 'XOF' })
      says(token, 'completed', 38000)
      await ipn(token)
      expect(new Set((await windows(L2)).map(e => e.course_id))).toEqual(new Set(['C2-F1', 'C2-F2', 'C2-F5'].map(c => ids[c])))
    })

    it('a pack containing an owned course: refused until the warning is acknowledged for exactly that course; the owned course is linked, never re-dated', async () => {
      const first = await startAndToken(user(L1), ids['C1-F1'])
      says(first, 'completed', 9900)
      await ipn(first)
      const [owned] = await asSuper(`select id, expires_at from public.entitlements where user_id = $1 and course_id = $2`, [L1, ids['C1-F1']])

      const unacknowledged = await packCheckout(user(L1), 'PACK-CONSEILLER')
      expect(unacknowledged.error).toMatch(/possédez déjà/)
      expect(unacknowledged.error).toContain('Formation C1-F1')
      expect((await packCheckout(user(L1), 'PACK-CONSEILLER', [ids['C1-F2']])).error).toMatch(/ont changé/)
      expect(await asSuper(`select count(*)::int as n from public.payments where pack_id is not null`)).toEqual([{ n: 0 }])

      const token = await packToken(user(L1), 'PACK-CONSEILLER', [ids['C1-F1']])
      const row = await rowFor(token)
      expect(row.metadata.pack).toMatchObject({ code: 'PACK-CONSEILLER', ownedCourseIds: [ids['C1-F1']] })
      says(token, 'completed', 37900)
      await ipn(token)

      expect(await windows(L1)).toHaveLength(4)
      expect((await asSuper(`select id, expires_at from public.entitlements where user_id = $1 and course_id = $2`, [L1, ids['C1-F1']])))
        .toEqual([owned])
      expect(await asSuper(`select course_id, preexisting from public.payment_entitlements where payment_id = $1 and preexisting`, [row.id]))
        .toEqual([{ course_id: ids['C1-F1'], preexisting: true }])
      const done = await rowFor(token)
      expect(done.status).toBe('completed')
      // An ordinary sale: three courses were opened, nothing waits for a person.
      expect(done.metadata.completionReview).toBeUndefined()
    })

    it('a pack whose courses are all owned is not sold', async () => {
      for (const c of ['C2-F1', 'C2-F2', 'C2-F5']) {
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, ids[c]])
      }
      const r = await packCheckout(user(L1), 'PACK-MANAGER', ['C2-F1', 'C2-F2', 'C2-F5'].map(c => ids[c]))
      expect(r.error).toMatch(/déjà accès à toutes/)
      expect(P.requests).toEqual([])
    })

    it('an administrator\'s grant inside a pack is linked and never re-dated; an EXPIRED one blocks the purchase and is left as it was', async () => {
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, ids['C2-F1']])
      const token = await packToken(user(L1), 'PACK-MANAGER', [ids['C2-F1']])
      says(token, 'completed', 38000)
      await ipn(token)
      expect(await asSuper(`select source, status, expires_at from public.entitlements where user_id = $1 and course_id = $2`, [L1, ids['C2-F1']]))
        .toEqual([{ source: 'MANUAL_ADMIN', status: 'ACTIVE', expires_at: null }])

      await asSuper(`insert into public.entitlements (user_id, course_id, source, status, starts_at, expires_at)
        values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE', now() - interval '2 days', now() - interval '1 day')`, [L2, ids['C1-F2']])
      const r = await checkout(user(L2), ids['C1-F2'])
      expect(r.error).toMatch(/régularisation/)
      expect(await asSuper(`select source, status from public.entitlements where user_id = $1 and course_id = $2`, [L2, ids['C1-F2']]))
        .toEqual([{ source: 'MANUAL_ADMIN', status: 'ACTIVE' }])
    })

    it('six months later the course closes; it can be bought again, and the new purchase opens a new window beside the expired one', async () => {
      const first = await startAndToken(user(L1), ids['C1-F3'])
      says(first, 'completed', 9900)
      await ipn(first)
      expect(await dbHasAccess(L1, ids['C1-F3'])).toBe(true)

      // Six months pass.
      await asSuper(`update public.entitlements set starts_at = starts_at - interval '6 months 1 day', expires_at = expires_at - interval '6 months 1 day'
        where user_id = $1 and course_id = $2`, [L1, ids['C1-F3']])
      expect(await dbHasAccess(L1, ids['C1-F3'])).toBe(false)

      const second = await startAndToken(user(L1), ids['C1-F3'])
      expect(second).not.toBe(first)
      says(second, 'completed', 9900)
      await ipn(second)
      expect((await windows(L1)).map(e => ({ status: e.status, opened_now: e.opened_now })))
        .toEqual([{ status: 'EXPIRED', opened_now: false }, { status: 'ACTIVE', opened_now: true }])
      expect(await dbHasAccess(L1, ids['C1-F3'])).toBe(true)
      // The learner's progress record is not duplicated.
      expect((await asSuper(`select count(*)::int as n from public.enrollments where user_id = $1 and course_id = $2`, [L1, ids['C1-F3']]))[0].n).toBe(1)
    })

    it('one payable attempt per learner and course across packs: an open course attempt blocks the pack, an open pack blocks its courses, and the database refuses the overlap on its own', async () => {
      const course = await startAndToken(user(L1), ids['C1-F2'])
      says(course, 'pending', 9900)
      const blocked = await packCheckout(user(L1), 'PACK-CONSEILLER')
      expect(blocked.error).toMatch(/une formation de ce pack/)
      expect(blocked.reference).toBe((await rowFor(course)).reference)
      expect(await asSuper(`select count(*)::int as n from public.payments where pack_id is not null`)).toEqual([{ n: 0 }])
      await expect(asRole('service_role', null, `insert into public.payments
          (user_id, pack_id, amount, currency, method, status, reference, provider, provider_mode)
          values ($1, $2, 37900, 'XOF', 'card', 'pending', 'SCX-OVERLAP-0001', 'paytech', 'test')`, [L1, await packId('PACK-CONSEILLER')]))
        .rejects.toMatchObject({ detail: expect.stringContaining('inflight_overlap') })

      const pack = await packToken(user(L2), 'PACK-CONSEILLER')
      says(pack, 'pending', 37900)
      const refused = await checkout(user(L2), ids['C1-F3'])
      expect(refused.error).toMatch(/pack contenant cette formation/)
      expect(refused.reference).toBe((await rowFor(pack)).reference)
      await expect(asRole('service_role', null, `insert into public.payments
          (user_id, course_id, amount, currency, method, status, reference, provider, provider_mode)
          values ($1, $2, 9900, 'XOF', 'card', 'pending', 'SCX-OVERLAP-0002', 'paytech', 'test')`, [L2, ids['C1-F3']]))
        .rejects.toMatchObject({ detail: expect.stringContaining('inflight_overlap') })
      // A course outside the pack is unaffected.
      expect((await checkout(user(L2), ids['C2-F1'])).redirectUrl).toBeDefined()
    })

    it('an open pack attempt is RESUMED: the same hosted page, no second payment', async () => {
      const token = await packToken(user(L1), 'PACK-MANAGER')
      says(token, 'pending', 38000)
      expect(await packCheckout(user(L1), 'PACK-MANAGER'))
        .toMatchObject({ redirectUrl: `https://paytech.sn/payment/checkout/${token}`, resumed: true })
      expect(await asSuper(`select count(*)::int as n from public.payments where user_id = $1`, [L1])).toEqual([{ n: 1 }])
    })

    it('while a pack is being paid its composition is frozen, and a payment never changes what it buys', async () => {
      const token = await packToken(user(L1), 'PACK-MANAGER')
      const row = await rowFor(token)
      await expect(asRole('service_role', null, `delete from public.course_pack_courses where pack_id = $1`, [row.pack_id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('pack_composition_locked') })
      await expect(asRole('service_role', null, `update public.payments set pack_id = $1 where id = $2`, [await packId('PACK-CONSEILLER'), row.id]))
        .rejects.toMatchObject({ detail: expect.stringContaining('payment_pack_immutable') })
      await expect(asRole('service_role', null, `insert into public.payments
          (user_id, course_id, pack_id, amount, currency, method, status, reference)
          values ($1, $2, $3, 1, 'XOF', 'card', 'failed', 'SCX-BOTH-0001')`, [L2, ids['C1-F1'], await packId('PACK-CONSEILLER')]))
        .rejects.toThrow(/payments_one_product/)
    })

    it('an exception on a pack payment concerns every course of the pack, and access is honoured only when all of them are open', async () => {
      H.contract = null
      const token = await packToken(user(L1), 'PACK-MANAGER')
      const { id } = await rowFor(token)
      await asRole('service_role', null, `update public.payments set status = 'expired', failure_reason = 'closed_for_test' where id = $1`, [id])
      await ipn(token)
      const e = await exceptionFor(token)
      expect(e).toMatchObject({ state: 'open', first_signal: 'paid_hint' })

      H.contract = FIXTURE_CONTRACT
      const r = await checkout(user(L1), ids['C2-F2'])
      expect(r.error).toMatch(/en cours de vérification/)
      expect(r.reference).toBe((await rowFor(token)).reference)
      expect((await checkout(user(L1), ids['C1-F1'])).redirectUrl).toBeDefined()

      const decisions = { exceptionId: e.id, note: NOTE, attestAll: 'yes' }
      await exAction('confirmExceptionReceipt', { ...decisions, attest: 'yes' })
      for (const c of ['C2-F1', 'C2-F2']) {
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, ids[c]])
      }
      expect(await exAction('recordExceptionAccess', decisions)).toBe('exception_refused_no_live_entitlement')
      await asSuper(`insert into public.entitlements (user_id, course_id, source, status) values ($1, $2, 'MANUAL_ADMIN', 'ACTIVE')`, [L1, ids['C2-F5']])
      await exAction('recordExceptionAccess', decisions)
      expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', resolution: 'access_honoured', access_state: 'granted' })
    })

    // ═════════════════════════════════════════════════════════════════════════
    describe('XP-LAUNCH-FINAL-11 — the three boxes of CGV art. 4, on the order, and the confirmation e-mail', () => {
      const legalOf = async (token: string) => {
        const row = await rowFor(token)
        return (await asSuper(`select metadata -> 'legal' as legal, (now() - (metadata -> 'legal' ->> 'acceptedAt')::timestamptz) < interval '2 minutes' as recent
          from public.payments where id = $1`, [row.id]))[0] as { legal: Record<string, unknown> | null; recent: boolean }
      }

      it('a box left unticked, or ticked at another version, opens nothing and asks PayTech nothing', async () => {
        H.user = user(L1)
        const { startPaytechCheckout, startPaytechPackCheckout } = await import('@/app/actions/paytech-checkout')
        const ticked = tickedCheckoutConsent()
        for (const consent of [null, undefined, {}, { ...ticked, adultOrGuardian: false }, { ...ticked, immediateAccess: 'true' }, { ...ticked, terms: false }]) {
          const r = await startPaytechCheckout({ courseId: ids['C1-F1'], consent } as Parameters<typeof startPaytechCheckout>[0])
          expect(r.error).toMatch(/Cochez les trois cases/)
          const p = await startPaytechPackCheckout({ packCode: 'PACK-MANAGER', consent } as Parameters<typeof startPaytechPackCheckout>[0])
          expect(p.error).toMatch(/Cochez les trois cases/)
        }
        const stale = await startPaytechCheckout({ courseId: ids['C1-F1'], consent: { ...ticked, version: '0.9+0.9' } })
        expect(stale.error).toMatch(/Rechargez-la/)
        expect(P.requests).toEqual([])
        expect((await asSuper(`select count(*)::int as n from public.payments where user_id = $1`, [L1]))[0].n).toBe(0)
      })

      it('a course order records CGU 1.0 and CGV 1.0, the two requests, and the SERVER time of acceptance', async () => {
        const token = await startAndToken(user(L1), ids['C1-F1'])
        const { legal, recent } = await legalOf(token)
        expect(legal).toEqual({
          cgu: '1.0', cgv: '1.0', acceptedAt: expect.any(String),
          immediateAccessRequested: true, adultOrGuardianCertified: true,
        })
        expect(recent).toBe(true)
      })

      it('a pack order records them too, beside the pack it bought', async () => {
        const token = await packToken(user(L1), 'PACK-MANAGER')
        const { legal } = await legalOf(token)
        expect(legal).toMatchObject({ cgu: '1.0', cgv: '1.0', immediateAccessRequested: true, adultOrGuardianCertified: true })
        const row = await rowFor(token)
        expect((await asSuper(`select metadata -> 'pack' ->> 'code' as code from public.payments where id = $1`, [row.id]))[0].code).toBe('PACK-MANAGER')
      })

      it('the learner gets ONE confirmation e-mail on completion: what, how much, the reference, six months, the conditions', async () => {
        const token = await startAndToken(user(L1), ids['C1-F1'])
        says(token, 'completed', 9900)
        expect((await ipn(token)).status).toBe(200)
        expect(H.confirmations).toHaveLength(1)
        const [mail] = H.confirmations
        const row = await rowFor(token)
        const title = (await asSuper(`select title from public.courses where id = $1`, [ids['C1-F1']]))[0].title
        expect(mail.to).toBe('l1@example.test')
        expect(mail.data).toMatchObject({ productTitle: title, packCourses: [], reference: row.reference, acceptedTerms: 'CGU 1.0 et CGV 1.0' })
        expect(String(mail.data.amount).replace(/\D/g, '')).toBe('9900')
        expect(mail.data.accessEndsOn).toMatch(/\d{4}$/)
        expect(String(mail.data.dashboardUrl)).toMatch(/\/dashboard$/)

        // A replayed notification completes nothing new and announces nothing new.
        expect((await ipn(token)).status).toBe(200)
        expect(H.confirmations).toHaveLength(1)
      })

      it('a pack confirmation lists its courses, and says which ones were already owned and keep their own dates', async () => {
        await asSuper(`insert into public.entitlements (user_id, course_id, source, status, starts_at, expires_at)
          values ($1, $2, 'INDIVIDUAL_PURCHASE', 'ACTIVE', now() - interval '1 month', now() + interval '5 months')`, [L1, ids['C1-F1']])
        const token = await packToken(user(L1), 'PACK-CONSEILLER', [ids['C1-F1']])
        says(token, 'completed', 37900)
        expect((await ipn(token)).status).toBe(200)
        expect(H.confirmations).toHaveLength(1)
        const { data } = H.confirmations[0]
        expect(data.productTitle).toBe('Pack Conseiller')
        const courses = data.packCourses as { title: string; preexisting: boolean }[]
        expect(courses).toHaveLength(4)
        expect(courses.filter(c => c.preexisting)).toHaveLength(1)
        expect(String(data.amount).replace(/\D/g, '')).toBe('37900')
      })

      it('a failed send changes nothing: the payment stays completed and the access open', async () => {
        H.confirmationMode = 'fail'
        const token = await startAndToken(user(L1), ids['C1-F1'])
        says(token, 'completed', 9900)
        expect((await ipn(token)).status).toBe(200)
        expect((await rowFor(token)).status).toBe('completed')
        expect(await dbHasAccess(L1, ids['C1-F1'])).toBe(true)
        expect(H.logs.some(l => l.module === 'payments/confirmation' && l.level === 'error')).toBe(true)
      })
    })
  })
})
