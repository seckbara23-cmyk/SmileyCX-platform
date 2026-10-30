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
const H = vi.hoisted(() => ({
  makeClient: null as unknown as (_role: 'service_role' | 'authenticated') => unknown,
  user: null as null | { id: string; email: string; email_confirmed_at: string | null },
  logs: [] as { level: string; module: string; args: unknown[] }[],
  rpcFault: null as null | Record<string, unknown>,
  /** Fails only the named function, leaving every other call working. */
  rpcFaultFor: null as null | { fn: string; error: Record<string, unknown> },
  denyAdmin: false,
  emails: [] as { to: string; reference: string }[],
  emailMode: 'ok' as 'ok' | 'fail' | 'fail_second' | 'dry',
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
    if (H.emailMode === 'fail') return { success: false, error: 'simulated' }
    if (H.emailMode === 'fail_second' && H.emails.length % 2 === 0) return { success: false, error: 'simulated' }
    if (H.emailMode === 'dry') return { success: true, dryRun: true }
    return { success: true }
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
      if (H.rpcFaultFor?.fn === fn) return { data: null, error: H.rpcFaultFor.error }
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
  return startPaytechCheckout({ courseId, ...extra } as { courseId: string })
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
  opts: { signAmount?: number; secret?: string; form?: boolean; ref?: string } = {},
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
    body: opts.form ? new URLSearchParams(payload as Record<string, string>).toString() : JSON.stringify(payload),
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
  exceptionId, note: NOTE, attest: 'yes', externalReference: 'PT-REFUND-0001',
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

type ExName = 'acknowledgeExceptionReport' | 'confirmExceptionReceipt' | 'withdrawExceptionReceipt' | 'dismissException' | 'requireExceptionRefund'
  | 'withdrawExceptionRefund' | 'recordExceptionAccess' | 'recordExceptionRefund' | 'recheckException'

/** Run an exception action; return its notice, or where it sent a refused caller. */
async function exAction(name: ExName, fields: Record<string, string>) {
  const mod = await import('@/app/(admin)/admin/payments/exception-actions')
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  try {
    await mod[name](fd)
  } catch (e) {
    const url = (e as { url?: string }).url
    if (!url) throw e
    return new URL(url, 'https://x.test').searchParams.get('notice') ?? `REDIRECT:${url}`
  }
  throw new Error('the action did not redirect')
}

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
    H.rpcFaultFor = null; H.denyAdmin = false; H.emails = []; H.emailMode = 'ok'
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
      // In reverse order of application: 064 depends on 063, and 063's preflight
      // refuses to re-apply beside 064's trigger.
      await db.exec(ROLLBACK_064)
      await db.exec(ROLLBACK_063)
      expect(await asSuper(`select count(*)::int as n from pg_trigger where tgname = 'payments_transition_guard'`)).toEqual([{ n: 0 }])
      expect(await asSuper(`select to_regclass('public.payment_environment') as t`)).toEqual([{ t: null }])
      expect(await counts()).toEqual(before)
      expect((await rowFor(token)).status).toBe('processing')
      // …and re-applying 063 restores it (its preflight accepts the rolled-back state).
      await db.exec(M063)
      await db.exec(M064)
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
      expect(t.map(r => r.tgname)).toEqual(['payment_exceptions_follow_payment', 'payments_transition_guard'])
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
      await ipn(token)
      await expect(db.exec(ROLLBACK_064)).rejects.toThrow(/settle them first/)
      await db.exec('rollback').catch(() => undefined)
      expect((await exceptionFor(token)).post_settlement_report_at).not.toBeNull()
    })

    it('its ROLLBACK runs once everything is settled, changes no payment, and 064 re-applies; without 063 it refuses', async () => {
      H.contract = null
      const { token: settled } = await closedAttempt('expired', user(L2), C2)
      await ipn(settled)
      await exAction('dismissException', { exceptionId: (await exceptionFor(settled)).id, note: NOTE, attest: 'yes' })
      expect((await exceptionFor(settled)).state).toBe('resolved')
      H.contract = FIXTURE_CONTRACT

      const token = await startAndToken(user(L1))
      const before = await counts()
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

    it('a repeated paid notification on a completed payment is a plain replay', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      expect((await ipn(token)).body.detail).toBe('already_completed')
      expect(await exceptionFor(token)).toBeNull()
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

    it('on a completed payment a bad signature is noise, but a SIGNED unknown event is a conflict', async () => {
      const token = await startAndToken(user(L1))
      says(token, 'completed')
      await ipn(token)
      await ipn(token, {}, { secret: 'sk_wrong' })
      expect(await exceptionFor(token)).toBeNull()
      await ipn(token, { type_event: 'refund_complete' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'unverified_report', detail: 'ipn_unknown_event', payment_received: 'confirmed_by_provider' })
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
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'cancel_hint', payment_received: 'confirmed_by_provider' })
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
      H.contract = null
      await ipn(token, { type_event: 'sale_canceled' })
      expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'cancel_hint', resolution: null })
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
      expect(await adminAction('closeUnpaidPaytechPayment', closeFields((await rowFor(token)).id))).toBe('close_refused_provider_says_paid')
      expect((await rowFor(token)).status).toBe('processing')
    })

    it('a mismatch cleared on an in-flight payment cannot hide a later paid report', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      const e = await exceptionFor(token)
      await exAction('dismissException', { exceptionId: e.id, note: NOTE, attest: 'yes' })
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
      expect(await exAction('dismissException', { exceptionId: exception.id, note: NOTE, attest: 'yes' })).toBe('exception_dismiss_done')
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
    const decisions = (e: { id: string }) => ({ exceptionId: e.id, note: NOTE })

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
          `select public.payment_exception_record_refund($1, $2, null, 'REF-DIRECT-1', 45000, $3, $4::timestamptz, 'a long enough note')`,
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
        H.contract = null
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
      it('records that no funds arrived, and any later paid report reopens it, even a repeat', async () => {
        const { token, exception: e } = await reported()
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_dismiss_done')
        expect(await exceptionFor(token)).toMatchObject({
          state: 'resolved', resolution: 'nothing_to_return', payment_received: 'not_received', refund_state: 'not_required', resolved_by: ADM,
        })
        const emails = H.emails.length

        await ipn(token)

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

      it('a new kind of conflict reopens a settled record and alerts; the same one repeated does not', async () => {
        const token = await startAndToken(user(L1))
        says(token, 'pending')
        await ipn(token)
        says(token, 'completed')
        await ipn(token)
        expect((await exceptionFor(token)).resolution).toBe('settled_normally')

        await ipn(token, { final_item_price: '1' })
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'amount_mismatch', resolution: null })
        expect(H.emails.map(m => m.to)).toEqual(OWNERS)

        const e = await exceptionFor(token)
        await exAction('dismissException', { ...decisions(e), attest: 'yes' })
        await ipn(token, { final_item_price: '1' })
        expect((await exceptionFor(token)).state).toBe('resolved')
      })

      it('"still payable" cannot undo a review, and the sweep keeps working', async () => {
        const { token, exception: e } = await reported()
        await exAction('dismissException', { ...decisions(e), attest: 'yes' })
        H.contract = FIXTURE_CONTRACT
        says(token, 'pending')
        const res = await sweep()
        expect(res.body.exception_unrecorded).toBeUndefined()
        expect(await exceptionFor(token)).toMatchObject({ state: 'resolved', last_signal: 'provider_pending', payment_received: 'not_received' })
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
        H.contract = null
        await ipn(token, { type_event: 'sale_canceled' })
        const e = await exceptionFor(token)
        expect(await exAction('dismissException', { ...decisions(e), attest: 'yes' })).toBe('exception_dismiss_done')
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
        expect(await exceptionFor(token)).toMatchObject({ state: 'open', last_signal: 'provider_not_paid', payment_received: 'reported' })
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

      const res = await ipn(token)

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

    it('repeats while it awaits review only count; a report after a review flags again', async () => {
      const { token, id } = await refunded()
      await ipn(token)
      const audit = (await exceptionAudit()).length
      const emails = H.emails.length
      await ipn(token)
      await ipn(token)
      expect(H.emails).toHaveLength(emails)
      expect((await exceptionAudit()).length).toBe(audit)
      expect((await exceptionFor(token)).report_count).toBe(4)

      await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })
      await ipn(token)
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
      await exAction('recordExceptionAccess', { exceptionId: e.id, note: NOTE })
      const before = await counts()
      await ipn(token)
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

      const res = await ipn(token)

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

    it('a provider answering "paid" with a different amount does not flag it on a sweep or a re-check', async () => {
      const { token, id } = await refunded()
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed', 1)
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
      await exAction('dismissException', { exceptionId: newer.id, note: NOTE, attest: 'yes' })

      const { paymentExceptionQueue } = await import('@/lib/payments/payment-exceptions')
      expect((await paymentExceptionQueue())!.map(e => e.id)).toEqual([id, newer.id])
    })

    it('there is nothing to review on a record with no such report', async () => {
      const { id } = await refunded()
      expect(await exAction('acknowledgeExceptionReport', { exceptionId: id, note: NOTE, attest: 'yes' })).toBe('exception_refused_no_report_to_review')
    })
  })

  describe('XP-PAYTECH-05 — only an authorised administrator', () => {
    const ACTIONS = [
      'acknowledgeExceptionReport', 'confirmExceptionReceipt', 'withdrawExceptionReceipt', 'dismissException', 'requireExceptionRefund',
      'withdrawExceptionRefund', 'recordExceptionAccess', 'recordExceptionRefund', 'recheckException',
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

    it('a partly failed alert stays due', async () => {
      H.contract = null
      const { token } = await closedAttempt('expired')
      H.emailMode = 'fail_second'
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

    it('an escalation does not resolve a real conflict on the same payment', async () => {
      H.contract = null
      const token = await startAndToken(user(L1))
      await ipn(token, { final_item_price: '1' })
      await ipn(token)
      expect((await exceptionFor(token)).state).toBe('open')
      H.contract = FIXTURE_CONTRACT
      says(token, 'completed')
      await ipn(token)
      expect((await rowFor(token)).status).toBe('completed')
      expect((await exceptionFor(token)).state).toBe('open')
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
      await exAction('dismissException', { exceptionId: (await exceptionFor(newer)).id, note: NOTE, attest: 'yes' })

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
      await exAction('dismissException', { exceptionId: (await exceptionFor(open)).id, note: NOTE, attest: 'yes' })
      expect(await countOpenPaymentExceptions()).toBe(0)
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
})
