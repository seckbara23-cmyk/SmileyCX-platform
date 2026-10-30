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
 *   * `public.complete_payment()`                    extracted VERBATIM from 062
 *   * migration 063                                  executed WHOLE — preflight,
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
 *     `next/navigation` and `next/cache`.
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
  requirePlatformAdmin: async () => ({ id: '10000000-0000-4000-8000-0000000000ad', email: 'owner@example.test' }),
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
    try { return { data: await asRole(this.role, this.sub, text, params), error: null } }
    catch (e) { return { data: null, error: pgError(e) } }
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

// ── lifecycle ──────────────────────────────────────────────────────────────
describe('XP-PAYTECH-04 — PayTech journey on a real PostgreSQL engine', () => {
  beforeAll(async () => {
    db = new PGlite({
      parsers: { [types.NUMERIC]: (v: string) => Number(v), [types.TIMESTAMPTZ]: (v: string) => v },
    })
    await db.exec(SCHEMA)
    // Migration 063, WHOLE: preflight, objects, self-test, assertions.
    await db.exec(M063)
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
  })

  // ═══ migration 063 itself ═══════════════════════════════════════════════
  describe('M063 the state machine migration', () => {
    it('ran WHOLE on top of the verbatim 062 — preflight, self-test and assertions all passed', async () => {
      const t = await asSuper(`select tgname, tgenabled from pg_trigger where tgrelid = 'public.payments'::regclass and not tgisinternal`)
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
      await db.exec(ROLLBACK_063)
      expect(await asSuper(`select count(*)::int as n from pg_trigger where tgname = 'payments_transition_guard'`)).toEqual([{ n: 0 }])
      expect(await asSuper(`select to_regclass('public.payment_environment') as t`)).toEqual([{ t: null }])
      expect(await counts()).toEqual(before)
      expect((await rowFor(token)).status).toBe('processing')
      // …and re-applying 063 restores it (its preflight accepts the rolled-back state).
      await db.exec(M063)
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
