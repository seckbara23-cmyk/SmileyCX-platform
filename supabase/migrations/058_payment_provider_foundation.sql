-- ============================================================================
-- Migration 058 — PAY-1: the payment provider foundation, and the end of
-- browser-role write authority over public.payments.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- It writes NO payment row. It changes no entitlement, enrollment, course
-- price, certificate or authentication object.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT THIS CLOSES: T1 ───────────────────────────────────────────────────
--
-- The PAY-LAUNCH-01 audit, and before it SEC-3 finding N-1 and the Release-1
-- audit finding H-1, recorded the same latent hole:
--
--   CREATE POLICY "payments_update_own" ON payments FOR UPDATE
--     USING (user_id = auth.uid() OR is_platform_admin());   -- no WITH CHECK
--
-- PostgreSQL reuses USING as WITH CHECK. USING constrains ROW OWNERSHIP, not
-- COLUMN VALUES, so the owner of the row may rewrite any column in it — and
-- `status` is CHECK-constrained to a list that includes 'completed'. A learner
-- holding a pending payment could therefore mark it paid from the browser with
-- one PATCH. Harmless while payments are inactive; a direct payment bypass the
-- day they are switched on, which is the day PAY-2 is for.
--
-- Dropping the policy is NOT sufficient, and that is the part the earlier
-- write-ups understated. `anon` and `authenticated` hold Supabase's default
-- table-wide privileges on public.payments, including UPDATE, INSERT, DELETE
-- and TRUNCATE. A policy is a row filter layered on top of a privilege; remove
-- the policy and the privilege is still there, waiting for the next permissive
-- policy anyone adds. So this migration closes BOTH layers:
--
--   privilege   revoke everything except SELECT from anon and authenticated
--   policy      drop payments_update_own, drop the FOR ALL admin policy, and
--               add RESTRICTIVE deny policies for UPDATE and DELETE
--
-- RESTRICTIVE is deliberate. A permissive policy can be out-voted — policies
-- of the same kind are OR-ed, so one careless `FOR ALL USING (true)` added
-- later re-opens everything. Restrictive policies are AND-ed: while these two
-- exist, no permissive policy can grant a browser role UPDATE or DELETE on a
-- payment. The invariant stops depending on nobody making a mistake.
--
-- Trusted authority is untouched. `service_role` keeps every privilege and
-- bypasses RLS, which is what the admin payment screen and the PAY-2 webhook
-- act through — both surfaces already use the service-role client
-- (app/(admin)/admin/payments/actions.ts, app/actions/payment.ts). Platform
-- admins keep exactly the authority the architecture actually uses: they still
-- READ every payment through `payments_own`, and they have never written one
-- from the browser.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
--   + payments.provider        text  nullable   which gateway took the money
--   + payments.provider_mode   text  nullable   'test' | 'live', never guessed
--   + payments.provider_token  text  nullable   the gateway's own invoice id
--   + payments.entitlement_id  uuid  nullable   FK -> entitlements(id)
--   + constraint payments_provider_mode_valid
--   + constraint payments_provider_mode_required
--   + unique index payments_one_inflight_intent_per_course
--                              UNIQUE (user_id, course_id)
--                              WHERE status IN ('pending','processing')
--   + index payments_entitlement_idx
--
-- Every column is NULLABLE with no default, so every existing and legacy row
-- stays valid exactly as it stands and NO row is rewritten. `provider_mode` is
-- the reason PAY-LAUNCH-02A exists: a payment that cannot say whether it was
-- taken in TEST or LIVE is unauditable, and a reconciliation that cannot tell
-- the two apart is worse than none. Hence the second constraint — a row that
-- names a provider MUST name its mode. Legacy rows name neither.
--
-- `entitlement_id` is ON DELETE SET NULL, matching the posture `user_id` and
-- `course_id` already have. A payment is a financial record that must outlive
-- the access it bought: RESTRICT would make deleting a learner's account fail
-- (entitlements cascade from auth.users), and CASCADE would delete the money.
--
-- ── IN-FLIGHT IDEMPOTENCY ──────────────────────────────────────────────────
--
-- One learner, one course, at most one live purchase intent. Expressed as a
-- PARTIAL unique index rather than a constraint because a constraint cannot
-- carry a WHERE clause — the contract is identical, the catalogue entry is an
-- index. Terminal rows ('completed', 'failed', 'refunded') are outside the
-- predicate, so a learner may buy again after a failure and the history of
-- every past attempt is retained.
--
-- The predicate is not guessed. Section 0 reads the live `status` CHECK
-- constraint and refuses to proceed unless its vocabulary is exactly
-- {pending, processing, completed, failed, refunded} — the five values
-- supabase/schema.sql declares, `types/index.ts` PaymentStatus narrows to, the
-- admin screen renders, and migration 003's completable test used. If
-- production's vocabulary is anything else, this migration does not run.
--
-- NULLs are left DISTINCT. A row orphaned by ON DELETE SET NULL has no owner
-- and must not collide with another orphan.
--
-- ── WHAT THIS FILE VERIFIES, AND WHAT THE TEST SUITE VERIFIES ─────────────
--
-- An assertion belongs HERE only if its outcome depends on the PRODUCTION
-- DATABASE at apply time. Anything that depends only on this file's own text
-- is verified by __tests__/payments/pay-launch-02b-payment-foundation.test.ts.
--
-- The reason is that the file is frozen and reviewed before it is applied. A
-- migration asserting that its own `create unique index … where status in (…)`
-- produced a unique partial index is only asking the database to confirm that
-- the file is the file: it cannot fail, and it cost 165 lines in the first
-- draft of this migration. Those assertions existed to kill mutants, and a
-- mutant is a hypothetical edit to the SOURCE — a test's concern, not a
-- deployment's.
--
-- So this file checks what it cannot know: the live column list, the live
-- status vocabulary, the data already present, and the ACL and policy set that
-- `revoke` and `drop policy if exists` actually leave behind. Those genuinely
-- depend on production — notably, a table-level `revoke` does NOT remove
-- column-level ACLs, and `drop policy if exists` succeeds whether or not the
-- policy was ever there.
--
-- The split is load-bearing in one direction the SQL cannot cover at all: a
-- statement placed AFTER the last verification block but still inside this
-- transaction is invisible to it, because that block has already run. The test
-- suite pins the file's shape for exactly that reason.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO PayDunya API, client, URL, credential, webhook or IPN route.
--   * NO change to complete_payment(). Section 6 asserts that function STILL
--     DOES NOT EXIST in this database — see the DISCOVERY note below.
--   * NO change to entitlements, enrollments, has_course_access(),
--     my_course_access, course prices, certificates, authentication, the
--     payment feature flag, or lib/payments/index.ts. It contains no statement
--     that could touch any of them, which the test suite proves by scanning
--     this file rather than by fingerprinting rows it cannot have written.
--   * NO payment row is inserted, updated or deleted. Section 6 proves it.
--   * NO column-level SELECT restriction — that is PAY-1B, below.
--   * 046 stays withdrawn; 051 stays reserved; 052–057 untouched.
--
-- ── DISCOVERY: MIGRATION 003 WAS NEVER APPLIED ─────────────────────────────
--
-- Read-only probing of production (PostgREST, GET only) found public.payments
-- with THIRTEEN columns and no `complete_payment` RPC:
--
--   id, user_id, course_id, company_id, amount, currency, method, status,
--   reference, provider_reference, metadata, created_at, completed_at
--
-- So migration 003 — `webhook_id`, `payment_intent_id`, `failure_reason`, four
-- indexes and complete_payment() — is NOT in this database. 001 and 011 ARE
-- (their policies, `rate_limits` and `check_rate_limit` are live). Production
-- also carries `company_id`, which appears in no migration and in neither
-- supabase/schema.sql nor the `Payment` interface in types/index.ts.
--
-- This migration is written against the THIRTEEN columns that actually exist
-- and section 0 refuses to run against anything else. It does not back-fill
-- 003: creating complete_payment() is PAY-2's atomic completion authority, and
-- 003's text would not even run here (it sets `updated_at`, a column this
-- table does not have). The consequences for PAY-2 are in the operator note.
-- ============================================================================

-- REPEATABLE READ: the before/after payment fingerprint is read as ONE
-- snapshot, so "no row was rewritten" compares like with like.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — what this migration cannot know, and must not assume ═══
--
-- Every check here reads PRODUCTION STATE: the live table shape, the live
-- status vocabulary, and the data already present. None of it can be answered
-- by reading this file, which is why none of it lives in the test suite.
do $do$
declare
  v_missing text;
  v_n       integer;
  v_cols    text;
  v_def     text;
  v_val     text;
begin
  -- public.payments is the subject; public.entitlements is the FK target.
  select string_agg(t, ', ') into v_missing
    from unnest(array['public.payments', 'public.entitlements']) as t
   where to_regclass(t) is null;
  if v_missing is not null then
    raise exception 'PAY-1 058 preflight: required table(s) missing: %', v_missing;
  end if;

  -- RLS must already be on. Enabling it here would silently change who can
  -- read this table, which is not a side effect a payment migration may have.
  if not exists (select 1 from pg_class where oid = 'public.payments'::regclass and relrowsecurity) then
    raise exception 'PAY-1 058 preflight: row level security is NOT enabled on public.payments; refusing to add columns to an unprotected payment table';
  end if;

  -- EXACTLY the thirteen columns production has. Not a superset: if 003 or
  -- anything else has since been applied, the author has not seen this table
  -- and must look again before changing its authority.
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,id,metadata,method,provider_reference,reference,status,user_id' then
    raise exception 'PAY-1 058 preflight: public.payments has columns [%]; this migration was written against the thirteen columns production held at authoring time. Re-read the table before re-running.', v_cols;
  end if;

  -- Refuse a second apply rather than reporting success for work already done.
  select string_agg(c, ', ') into v_missing
    from unnest(array['provider', 'provider_mode', 'provider_token', 'entitlement_id']) as c
   where exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.payments'::regclass and a.attname = c and not a.attisdropped);
  if v_missing is not null then
    raise exception 'PAY-1 058 preflight: column(s) % already exist; refusing to re-apply', v_missing;
  end if;
  -- SCHEMA-QUALIFIED. A bare `pg_class.relname = …` lookup matches an
  -- identically named relation in ANY schema — another schema's unrelated
  -- table would have produced a false "refusing to re-apply" and blocked a
  -- legitimate first apply. to_regclass resolves one name in one schema.
  if to_regclass('public.payments_one_inflight_intent_per_course') is not null then
    raise exception 'PAY-1 058 preflight: public.payments_one_inflight_intent_per_course already exists; refusing to re-apply';
  end if;

  -- THE STATUS VOCABULARY. The partial index predicate is only correct if
  -- 'pending' and 'processing' are the in-flight states and the terminal ones
  -- sit outside it, so the live CHECK is read rather than trusted.
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
     and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.payments'::regclass and a.attname = 'status')];
  if v_def is null then
    raise exception 'PAY-1 058 preflight: public.payments.status has no single-column CHECK constraint; the in-flight predicate cannot be verified against a vocabulary that does not exist';
  end if;
  foreach v_val in array array['pending', 'processing', 'completed', 'failed', 'refunded'] loop
    if position('''' || v_val || '''' in v_def) = 0 then
      raise exception 'PAY-1 058 preflight: payments.status CHECK does not admit ''%''. Found: %', v_val, v_def;
    end if;
  end loop;
  select count(distinct parts[1]) into v_n
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m(parts);
  if v_n <> 5 then
    raise exception 'PAY-1 058 preflight: payments.status CHECK names % distinct value(s), expected exactly 5. Found: %', v_n, v_def;
  end if;

  -- No existing in-flight duplicate, or the unique index below would fail with
  -- a bare index violation instead of a legible message. The migration refuses;
  -- it does not silently repair.
  select count(*) into v_n from (
    select user_id, course_id
      from public.payments
     where status in ('pending', 'processing')
       and user_id is not null and course_id is not null
     group by user_id, course_id
    having count(*) > 1
  ) d;
  if v_n <> 0 then
    raise exception 'PAY-1 058 preflight: % learner/course pair(s) already hold more than one in-flight payment. Resolve them (mark the superseded attempts ''failed'') before constraining in-flight intents.', v_n;
  end if;
end
$do$;

-- The two facts section 6 needs, and nothing else. Dropped at COMMIT.
--
-- The payment rows are fingerprinted by an EXPLICIT column list: to_jsonb()
-- would change shape when the four columns are added and could hide a rewrite
-- behind that change.
create temp table pay_1_058_before on commit drop as
select
  (select md5(coalesce(string_agg(
            p.id::text || '|' || coalesce(p.user_id::text, '') || '|' || coalesce(p.course_id::text, '')
              || '|' || coalesce(p.company_id::text, '') || '|' || p.amount::text || '|' || p.currency
              || '|' || p.method || '|' || p.status || '|' || p.reference
              || '|' || coalesce(p.provider_reference, '') || '|' || coalesce(p.metadata::text, '')
              || '|' || p.created_at::text || '|' || coalesce(p.completed_at::text, ''),
            E'\n' order by p.id), ''))
     from public.payments p)                                       as payments_md5,
  (select count(*) from public.payments)                           as n_payments,
  -- complete_payment() is absent in this database (see the DISCOVERY note).
  -- PAY-1 must not be what creates it, and must not run where it already is.
  (to_regprocedure('public.complete_payment(text,text)') is null)  as complete_payment_absent;


-- ══ 1. THE FOUR COLUMNS ═══════════════════════════════════════════════════
--
-- Nullable, no default, no backfill. Every legacy row remains valid exactly as
-- it stands, and section 6 proves not one of them was rewritten.

alter table public.payments
  add column if not exists provider       text,
  add column if not exists provider_mode  text,
  add column if not exists provider_token text,
  add column if not exists entitlement_id uuid
    references public.entitlements(id) on delete set null;

comment on column public.payments.provider is
  'PAY-1. Which payment provider handled this transaction (e.g. ''paydunya''). NULL on legacy rows and on any payment taken before a provider was recorded. Deliberately unconstrained text: after 058 only trusted server/service-role code can write this column, so the value is set by the application and never by an untrusted caller.';
comment on column public.payments.provider_mode is
  'PAY-1. The provider environment this transaction was taken in: ''test'' or ''live''. NULL only when `provider` is also NULL (payments_provider_mode_required). A payment that cannot say whether it moved real money is unauditable, which is the whole point of the PAY-LAUNCH-02A TEST/LIVE boundary.';
comment on column public.payments.provider_token is
  'PAY-1. The provider''s own identifier for this transaction (for PayDunya, the invoice token). Server reconciliation data, not a credential: it is useless without the server-held master key. Still not something a learner needs — PAY-1B withdraws it from the browser column allowlist before PAY-2 writes the first one. See the operator note at the foot of 058.';
comment on column public.payments.entitlement_id is
  'PAY-1. The entitlement this payment produced, once one exists. NULL until a completion grants access, and NULL again if that entitlement is ever deleted (ON DELETE SET NULL) — a payment is a financial record that must outlive the access it bought. Nothing reads this column yet: `entitlements` remains the sole authority on access (XPA-6B), and this is a reference FROM the money TO the grant, never the reverse.';


-- ══ 2. THE TWO CONSTRAINTS ════════════════════════════════════════════════
--
-- Both are satisfied by every NULL-provider legacy row, so neither validates
-- anything away. Checked, not merely documented: 'TEST', ' live ', 'sandbox'
-- and '' are refused by the database, exactly as resolvePaydunyaConfig()
-- refuses them in the application (lib/payments/paydunya-config.ts).
--
-- A CHECK constraint enforces itself for the life of the table, which is
-- strictly stronger than reading it back once at apply time.

alter table public.payments
  add constraint payments_provider_mode_valid
  check (provider_mode is null or provider_mode in ('test', 'live'));

alter table public.payments
  add constraint payments_provider_mode_required
  check (provider is null or provider_mode is not null);

comment on constraint payments_provider_mode_valid on public.payments is
  'PAY-1. provider_mode is exactly ''test'' or ''live'', or NULL for a legacy row. No coercion and no default: there is no safe way to guess whether a payment was real.';
comment on constraint payments_provider_mode_required on public.payments is
  'PAY-1. A payment that names a provider must name the mode it was taken in. Legacy rows name neither and are unaffected.';


-- ══ 3. ONE LIVE PURCHASE INTENT PER LEARNER PER COURSE ════════════════════
--
-- PARTIAL, so only the in-flight states are constrained; a learner whose
-- payment failed may try again, and every terminal attempt is kept. A partial
-- index is the only form this contract can take — a UNIQUE constraint cannot
-- carry a WHERE clause — so it is an index in the catalogue and a constraint
-- in meaning. Violations surface as 23505, like any unique.

create unique index payments_one_inflight_intent_per_course
  on public.payments (user_id, course_id)
  where status in ('pending', 'processing');

comment on index public.payments_one_inflight_intent_per_course is
  'PAY-1 in-flight idempotency: at most one pending/processing payment per (user_id, course_id). Terminal rows (completed, failed, refunded) sit outside the predicate, so retry after failure is allowed and history is retained. NULLs stay DISTINCT: rows orphaned by ON DELETE SET NULL have no owner and must not collide.';

-- ON DELETE SET NULL has to find the referencing rows; a partial index keeps
-- that off a sequential scan without costing anything for legacy NULL rows.
create index payments_entitlement_idx
  on public.payments (entitlement_id)
  where entitlement_id is not null;


-- ══ 4. THE AUTHORITY CHANGE — T1 ══════════════════════════════════════════

-- The hole itself.
drop policy if exists "payments_update_own" on public.payments;

-- The FOR ALL admin policy goes with it. It granted platform admins INSERT,
-- UPDATE and DELETE on every payment through the BROWSER role, which no code
-- path has ever used: both admin surfaces act through the service-role client.
-- Admin READ is unaffected — `payments_own` already admits is_platform_admin().
drop policy if exists "payments_admin_all" on public.payments;

-- AND-ed with everything else, for the browser roles only. While these exist,
-- no permissive policy added later can hand a learner UPDATE or DELETE.
create policy "payments_no_browser_update" on public.payments
  as restrictive for update to anon, authenticated
  using (false) with check (false);

create policy "payments_no_browser_delete" on public.payments
  as restrictive for delete to anon, authenticated
  using (false);

-- THE PRIVILEGE LAYER. Supabase's default grants gave both browser roles
-- table-wide INSERT/UPDATE/DELETE/TRUNCATE; a dropped policy does not take a
-- privilege away. SELECT is re-granted exactly as it was: learner read access
-- is governed by `payments_own` and is deliberately NOT changed here.
revoke all on public.payments from anon, authenticated;
grant select on public.payments to anon, authenticated;


-- ══ 5. THE AUTHORITY THAT RESULTED IS THE AUTHORITY INTENDED ══════════════
--
-- None of this is a read-back of the statements above. Each check asks a
-- question whose answer depends on what production ALREADY had:
--
--   * `revoke all` on a TABLE does not remove COLUMN-level ACLs, and says
--     nothing about privileges reaching a role through role membership;
--   * `revoke … from anon, authenticated` does not touch a grant to PUBLIC;
--   * `drop policy if exists` succeeds whether or not the policy was there;
--   * the policy set may contain policies this migration has never heard of.
do $do$
declare
  v_role text;
  v_txt  text;
  v_name text;
  v_priv text;
begin
  -- The thirteen production held plus the four this migration adds, and not
  -- one more: the drift check of section 0, re-stated against the result.
  select string_agg(a.attname, ',' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_txt is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,id,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-1 058: public.payments now has columns [%], which is not the thirteen it held plus the four this migration adds', v_txt;
  end if;

  -- ── NO BROWSER-ROLE WRITE AUTHORITY, AT EITHER LAYER ────────────────────
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-1 058: % still holds % on public.payments', v_role, v_priv;
      end if;
    end loop;
    -- Column privileges are a separate ACL that a table-level revoke leaves
    -- behind. Only these three kinds can exist per column alongside SELECT.
    foreach v_priv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-1 058: % still holds % on some COLUMN of public.payments', v_role, v_priv;
      end if;
    end loop;
    -- The learner's legitimate read is preserved, unchanged.
    if not has_table_privilege(v_role, 'public.payments', 'SELECT') then
      raise exception 'PAY-1 058: % lost SELECT on public.payments; PAY-1 withdraws WRITE authority only', v_role;
    end if;
  end loop;

  -- No privilege on this table reaches PUBLIC, which would mean every role
  -- that exists now or later — and which the revoke above would not have
  -- removed.
  select string_agg(x.privilege_type, ', ' order by x.privilege_type) into v_txt
    from (
      select (aclexplode(c.relacl)).grantee as grantee, (aclexplode(c.relacl)).privilege_type
        from pg_class c where c.oid = 'public.payments'::regclass and c.relacl is not null
      union all
      select (aclexplode(a.attacl)).grantee, (aclexplode(a.attacl)).privilege_type
        from pg_attribute a where a.attrelid = 'public.payments'::regclass and a.attacl is not null
    ) x
   where x.grantee = 0;
  if v_txt is not null then
    raise exception 'PAY-1 058: public.payments grants privilege(s) to PUBLIC: %', v_txt;
  end if;

  -- The trusted path PAY-2 will use must be intact.
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.payments', v_priv) then
        raise exception 'PAY-1 058: service_role lost % on public.payments — the admin screen and the PAY-2 webhook act through it', v_priv;
      end if;
    end loop;
  end if;

  -- ── THE POLICY SET THAT ACTUALLY RESULTED ───────────────────────────────
  if exists (select 1 from pg_policy where polrelid = 'public.payments'::regclass
              and polname in ('payments_update_own', 'payments_admin_all')) then
    raise exception 'PAY-1 058: payments_update_own or payments_admin_all survived';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.payments'::regclass
                  and polname = 'payments_own' and polcmd = 'r') then
    raise exception 'PAY-1 058: payments_own (learner/admin SELECT) is missing — PAY-1 must not remove payment visibility';
  end if;
  foreach v_name in array array['payments_no_browser_update', 'payments_no_browser_delete'] loop
    if not exists (select 1 from pg_policy where polrelid = 'public.payments'::regclass
                    and polname = v_name and not polpermissive) then
      raise exception 'PAY-1 058: % is missing or is not RESTRICTIVE', v_name;
    end if;
  end loop;
  -- Not one permissive policy may admit a write — including any this
  -- migration has never heard of.
  select string_agg(polname || '/' || polcmd::text, ', ' order by polname) into v_txt
    from pg_policy
   where polrelid = 'public.payments'::regclass and polpermissive
     and polcmd in ('a', 'w', 'd', '*')
     and coalesce(pg_get_expr(polqual, polrelid), '')
      || coalesce(pg_get_expr(polwithcheck, polrelid), '') <> 'false';
  if v_txt is not null then
    raise exception 'PAY-1 058: permissive policy/policies still admit a write on public.payments: %', v_txt;
  end if;
end
$do$;


-- ══ 6. NOT ONE PAYMENT ROW WAS WRITTEN ════════════════════════════════════
--
-- The LAST block before COMMIT, deliberately: an assertion proves nothing
-- about statements that run after it. complete_payment() is checked here
-- rather than in section 5 for that reason — a draft that created it between
-- the two blocks passed section 5 and shipped.
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
begin
  select * into b from pay_1_058_before;

  select md5(coalesce(string_agg(
           p.id::text || '|' || coalesce(p.user_id::text, '') || '|' || coalesce(p.course_id::text, '')
             || '|' || coalesce(p.company_id::text, '') || '|' || p.amount::text || '|' || p.currency
             || '|' || p.method || '|' || p.status || '|' || p.reference
             || '|' || coalesce(p.provider_reference, '') || '|' || coalesce(p.metadata::text, '')
             || '|' || p.created_at::text || '|' || coalesce(p.completed_at::text, ''),
           E'\n' order by p.id), '')) into v_now
    from public.payments p;
  if v_now is distinct from b.payments_md5 then
    raise exception 'PAY-1 058: payment row data changed — this migration must not rewrite a single payment';
  end if;
  select count(*) into v_n from public.payments;
  if v_n <> b.n_payments then
    raise exception 'PAY-1 058: the payment count changed from % to %', b.n_payments, v_n;
  end if;

  -- Every new column is NULL on every existing row: no implicit backfill, and
  -- no DEFAULT or trigger quietly filling one in.
  select count(*) into v_n from public.payments
   where provider is not null or provider_mode is not null
      or provider_token is not null or entitlement_id is not null;
  if v_n <> 0 then
    raise exception 'PAY-1 058: % row(s) acquired a provider value; the new columns must be NULL everywhere', v_n;
  end if;

  -- complete_payment() was absent before, and must still be absent now.
  if not b.complete_payment_absent then
    raise exception 'PAY-1 058: complete_payment() existed BEFORE this migration; the slice was authored against a database where it does not, so PAY-2 must be re-planned before 058 is applied';
  end if;
  if to_regprocedure('public.complete_payment(text,text)') is not null then
    raise exception 'PAY-1 058: complete_payment() exists at the end of this transaction; creating the completion authority is PAY-2, not PAY-1';
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Apply only after the owner authorises it and after the branch carrying
--    this file is merged. It is safe with the CURRENT application:
--      - the four columns are new and nothing reads or writes them;
--      - the in-flight index matches the data already present (production held
--        ZERO payment rows when this was authored, verified GET-only);
--      - the withdrawn privileges and policies are used by NO code path. Both
--        admin payment surfaces and app/actions/payment.ts already act through
--        the service-role client, which bypasses RLS and keeps every privilege.
--    ADD COLUMN with no default and no NOT NULL is metadata-only in PostgreSQL
--    11+; the brief ACCESS EXCLUSIVE lock is taken against an empty table.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once.
--    "Success" means every section passed, because the file is one transaction
--    and any failed assertion raises and rolls everything back. Note that the
--    editor does not display RAISE NOTICE output, which is why this migration
--    emits none: anything worth knowing is an exception that stops the apply.
-- 3. Immediately afterwards, GET-only:
--      as the ANON key
--        /rest/v1/payments?select=id   -> 200 []   (RLS: no rows)
--      as the SERVICE key
--        /rest/v1/payments?select=provider,provider_mode,provider_token,entitlement_id
--                                      -> 200 [] with the four columns present
--    and confirm /checkout and /dashboard still render.
--
-- ════════════════════════════════════════════════════════════════════════════
-- GATES BEFORE PAYMENTS ARE ENABLED
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── PAY-1B — THE provider_token PREREQUISITE (blocks PAY-2) ───────────────
--
-- THE FINDING. RLS decides ROWS, not COLUMNS. `payments_own` admits
-- `user_id = auth.uid()`, and `authenticated` holds table-wide SELECT, so a
-- learner issuing
--      GET /rest/v1/payments?select=*
-- receives EVERY column of their own payment rows — `provider_token` included
-- from the moment PAY-2 writes one.
--
-- It is not the disclosure of a secret: the token is PayDunya's invoice
-- identifier, useless without the server-held master key, and PayDunya itself
-- puts that same token in the checkout URL the learner's own browser visits.
-- The exposure is to the owner of the row, and RLS already prevents it
-- reaching anyone else. No PayDunya credential is involved: those live only in
-- the server-only module from PAY-LAUNCH-02A.
--
-- WHY IT IS NOT CLOSED HERE. Under column-level grants `select *` FAILS with
-- 42501 rather than narrowing — 055 says exactly that in its own section 1 —
-- and app/(platform)/checkout/confirm/page.tsx still reads
-- `select('*', courses(title, slug))` with the USER's client. The application
-- must name its columns FIRST. That is the sequence WC-2 already used here:
-- 054 prepared, the WC-2B release changed the reader, 055 withdrew the grant.
-- Reversing the order plants a latent 500 that fires the day PLATFORM_MODE
-- leaves 'pilot'.
--
--   PAY-1B(a)  APPLICATION ONLY. Replace `select('*', …)` in
--              app/(platform)/checkout/confirm/page.tsx with an explicit safe
--              projection (reference, amount, currency, status + the course
--              title it renders). Deploy and verify. No database change, and
--              no risk under the current table-wide grant.
--
--   PAY-1B(b)  MIGRATION 059, only after (a) is live:
--                * revoke the browser roles' table-wide SELECT on payments;
--                * grant `authenticated` an EXPLICIT column allowlist;
--                * EXCLUDE provider_token;
--                * EXCLUDE metadata — a free-form jsonb that PAY-2 will fill
--                  with provider payloads, so it must not be learner-readable
--                  by default;
--                * `anon` receives NO payment SELECT at all. It can never see
--                  a row (RLS requires auth.uid()), so this is a free
--                  reduction rather than a behaviour change;
--                * service_role retains full reconciliation access, including
--                  provider_token and metadata;
--                * PREFLIGHT REFUSES if ANY payments.provider_token IS NOT
--                  NULL. That turns "do this before PAY-2 writes a token" from
--                  a sentence in a document into a gate the database enforces:
--                  if PAY-2 ever lands first, 059 refuses and says why.
--              Shape it on 038/055 — enumerate the allowlist explicitly, never
--              compute it, so a column added later is unreadable by the
--              browser roles until someone grants it deliberately.
--
--   ⇒ ONLY AFTER PAY-1B MAY PAY-2 WRITE provider_token.
--
-- ── SEC-4 — CERTIFICATE HARDENING (blocks PAID production launch) ─────────
--
-- NOT a payments defect, NOT touched by this slice, and NOT to be modified by
-- PAY-1, PAY-1B or PAY-2. Recorded here because it gates the same event.
--
-- Three policies are unscoped, and together they form a credential-forgery
-- path that is live today:
--
--   cert_service_insert      storage.objects FOR INSERT WITH CHECK (bucket_id = 'certificates')
--   cert_service_update      storage.objects FOR UPDATE USING      (bucket_id = 'certificates')  -- no WITH CHECK
--   certificates_insert_auth certificates    FOR INSERT WITH CHECK (user_id = auth.uid())
--
-- Any authenticated user may upload into, and overwrite anything in, the
-- certificates bucket — including another learner's folder; the sibling
-- `cert_owner_select` IS correctly scoped to the owner's folder, which shows
-- both the intent and the omission. Certificate eligibility is enforced in the
-- page (resolveCertificateEligibility), not in the policy, so a learner may
-- POST directly to /rest/v1/certificates with any course_id — repeatedly,
-- since (user_id, course_id) carries no unique index. And
-- /verify-certificate/[id] is PUBLIC, reads with the service role, and sets
-- `isValid = !!cert`: it attests whatever row exists.
--
-- Established by reading the policies and the code paths; deliberately NOT
-- executed, because confirming it would require a production write.
--
-- Severity is commercial, not technical: the product sells a VERIFIABLE
-- credential. A forgeable certificate that a public endpoint attests becomes a
-- different kind of problem the moment a customer has paid for it.
--
-- ── N-3 enrollments_update — NON-BLOCKING ────────────────────────────────
--
-- A learner may rewrite their own enrollment row. Enrollments authorize
-- NOTHING (XPA-6B: `entitlements` is the sole authority), and certificate
-- eligibility resolves through the entitlement seam without reading
-- enrollments. Blast radius is cosmetic academic state. Routine RLS cleanup.
--
-- ── WHAT PAY-2 INHERITS, AND MUST NOT ASSUME ──────────────────────────────
--
--   * complete_payment() DOES NOT EXIST in this database. Migration 003 was
--     never applied (no webhook_id, payment_intent_id or failure_reason
--     column; no such RPC). PAY-2 CREATES the completion authority; it does
--     not amend 003's. 003's body would not run here anyway — it sets
--     `updated_at`, which this table does not have.
--   * A new SECURITY DEFINER function MUST explicitly
--       revoke execute on function … from public, anon, authenticated;
--     CREATE FUNCTION grants EXECUTE to PUBLIC by default. Had 003 been
--     applied, a learner who knows their own `reference` — the confirm page
--     prints it — could have called /rest/v1/rpc/complete_payment and
--     completed their own payment. The only reason that is not live today is
--     that 003 never ran.
--   * There is NO webhook_id column, so IPN replay has no idempotency key yet
--     beyond `reference` (UNIQUE) and, once written, `provider_token` (which
--     carries NO unique index — PAY-2 must decide deliberately).
--   * payments.method is NOT NULL and CHECK-constrained to
--     ('orange_money','wave','card'). There is no 'paydunya' value. PAY-2 must
--     either map a PayDunya payment onto the underlying method or widen that
--     CHECK — deliberately, because `method` is what the admin screen renders.
--   * The in-flight index means a learner who abandons a pending payment is
--     BLOCKED from starting another for the same course. The vocabulary has no
--     'cancelled' or 'expired', so PAY-2 must either reuse the existing intent
--     or move it to 'failed' before creating a new one. That is the intended
--     behaviour — it is what stops a learner opening ten invoices — but it is
--     a flow PAY-2 has to handle rather than discover.
--   * `company_id` is UNEXPLAINED SCHEMA DRIFT: present in production, absent
--     from every migration, from supabase/schema.sql and from the `Payment`
--     interface in types/index.ts. Do not guess it away, and do not assume it
--     is unused. (By contrast entitlements.organization_id is NOT drift —
--     migration 040 adds it.)
--   * Grant an entitlement, never an enrollment, for access. `entitlements` is
--     the sole authority (XPA-6B); an enrollment authorizes nothing.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the pre-058 state exactly, including the T1 hole.
-- Run it only if 058 itself must be undone; re-opening a payment bypass is not
-- something to do casually, and never while any provider column holds data.
-- Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- do $rb$
-- declare v_n integer;
-- begin
--   select count(*) into v_n from public.payments
--    where provider is not null or provider_mode is not null
--       or provider_token is not null or entitlement_id is not null;
--   if v_n <> 0 then
--     raise exception 'PAY-1 058 rollback: % payment row(s) carry provider data; dropping these columns would destroy it', v_n;
--   end if;
-- end
-- $rb$;
--
-- drop index if exists public.payments_one_inflight_intent_per_course;
-- drop index if exists public.payments_entitlement_idx;
--
-- alter table public.payments drop constraint if exists payments_provider_mode_required;
-- alter table public.payments drop constraint if exists payments_provider_mode_valid;
--
-- alter table public.payments
--   drop column if exists entitlement_id,
--   drop column if exists provider_token,
--   drop column if exists provider_mode,
--   drop column if exists provider;
--
-- drop policy if exists "payments_no_browser_update" on public.payments;
-- drop policy if exists "payments_no_browser_delete" on public.payments;
--
-- grant select, insert, update, delete, truncate, references, trigger
--   on public.payments to anon, authenticated;
--
-- create policy "payments_update_own" on public.payments for update
--   using (user_id = auth.uid() or is_platform_admin());
-- create policy "payments_admin_all" on public.payments for all
--   using (is_platform_admin()) with check (is_platform_admin());
--
-- commit;
