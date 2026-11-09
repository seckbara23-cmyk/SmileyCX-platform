-- ============================================================================
-- Migration 063 — XP-PAYTECH-04: the payment state machine, and the guard that
-- keeps a TEST payment from ever becoming a sale in a LIVE database.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Creates ONE table (one row), ONE trigger function and ONE trigger. Changes no
-- existing payment, entitlement, enrollment or audit row — section 5 proves it.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- A completed payment is final and a provider token is write-once. A payment's
-- provider mode must match the kind of money this database records. The
-- application enforces both; this migration makes the DATABASE enforce them too,
-- so a future code path, a misconfigured deployment or a hand-written UPDATE
-- cannot get round them.
--
-- ── WHAT THE GUARD ENFORCES (BEFORE UPDATE OR DELETE ON public.payments) ───
--
--   STATUS     pending    → processing | completed | failed | cancelled | expired
--              processing → completed | failed | cancelled | expired
--              completed  → refunded
--              failed, cancelled, expired, refunded → nothing (final)
--   IDENTITY   id, reference, amount, currency, method, created_at never change.
--              user_id / course_id may only become NULL (their FKs are
--              ON DELETE SET NULL); they are never reassigned.
--   PROVIDER   provider and provider_mode are write-once.
--              provider_token is write-once, and only onto a 'pending' row.
--              provider_reference changes only while the payment is in flight.
--   COMPLETION completed_at and a non-NULL entitlement_id are written only in
--              the transition INTO 'completed' — which is exactly what 062's
--              final UPDATE does.
--   ENVIRONMENT entering 'completed' requires provider_mode to match the
--              database: 'live' in a live database, 'test' in a sandbox one.
--              The marker is public.payment_environment, created here as
--              'live'. A sandbox database must be switched explicitly by its
--              owner (operator step 5). Absent or unreadable ⇒ 'live'.
--   DELETE     a payment that carries a provider token, or is completed or
--              refunded, is never deleted.
--
--   forensics  failure_reason, last_ipn_at and metadata stay freely writable:
--              they record what happened and grant nothing.
--
-- Every refusal raises P0001 with a JSON `reason` in DETAIL — the convention
-- 062 established — so `reasonFromError()` reads it and the application
-- records it in `failure_reason`.
--
-- ── COMPATIBILITY WITH 062 ─────────────────────────────────────────────────
--
-- 062's only write to public.payments is its final UPDATE: status → completed,
-- completed_at, entitlement_id, provider_reference (coalesced), metadata
-- (merged on the duplicate-purchase branch), from a row 062 has already
-- required to be 'pending' or 'processing'. Every column of that UPDATE is
-- permitted above in exactly that transition, so a legitimate completion is
-- unaffected. The guard can refuse a 062 completion in ONE case only — a
-- provider_mode that does not belong to this database — and then 062's whole
-- transaction rolls back, granting nothing, with reason
-- 'test_payment_in_live_database'. 062 itself is not edited, replaced or
-- re-granted; section 5 asserts it is exactly as 062 left it.
--
-- The guard adds no column, so 062's `public.payments` row type is unchanged.
--
-- ── PRODUCTION-SCHEMA ASSUMPTIONS (each one asserted in section 0) ─────────
--
--   A1  062 is applied: complete_payment(text×5, numeric, text) exists and is
--       SECURITY INVOKER.
--   A2  public.payments has exactly the nineteen columns 060/062 expect.
--   A3  060's seven-value status vocabulary and 058's mode vocabulary exist.
--   A4  060's replay key and 058's in-flight index exist.
--   A5  No foreign key into public.payments is ON DELETE CASCADE. (schema.sql
--       declares user_id and course_id ON DELETE SET NULL; 058 declares
--       entitlement_id ON DELETE SET NULL. A CASCADE would make the delete
--       guard block deleting a profile or course.)
--   A6  No non-internal trigger exists on public.payments yet. None was ever
--       created by a migration in this repository; one present would be
--       unexplained drift and must be understood before a guard is layered on.
--   A7  Roles service_role, anon and authenticated exist.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
--   * It does not decide whether a payment SHOULD complete. That is 062's
--     business and, before it, the provider's.
--   * It does not constrain INSERT. Creating an intent is the checkout's job
--     and 058's in-flight index already bounds it.
--   * It does not bind the environment marker to a hostname. The owner of each
--     database states what it is; the default is the safe one.
-- ============================================================================

begin isolation level repeatable read;

-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $do$
declare
  v_txt  text;
  v_cols text;
  v_word text;
begin
  -- A1 — 062 is in effect, and is the function 062 created.
  if to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)') is null then
    raise exception 'XP-PAYTECH-04 063 preflight: public.complete_payment(...) does not exist; 062 is not in effect and this guard has nothing to stay compatible with';
  end if;
  if (select p.prosecdef from pg_proc p
       where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')) then
    raise exception 'XP-PAYTECH-04 063 preflight: complete_payment is SECURITY DEFINER; 062 created it INVOKER. Refusing to build on a function that is not 062''s';
  end if;

  -- A2 — the nineteen columns.
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,failure_reason,id,last_ipn_at,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'XP-PAYTECH-04 063 preflight: public.payments has columns [%]; expected the nineteen 060/062 produced', v_cols;
  end if;

  -- A3 — the vocabularies.
  select pg_get_constraintdef(c.oid) into v_txt from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.conname = 'payments_status_valid';
  if v_txt is null then
    raise exception 'XP-PAYTECH-04 063 preflight: payments_status_valid is missing; 060 is not in effect';
  end if;
  foreach v_word in array array['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled', 'expired'] loop
    if position(quote_literal(v_word) in v_txt) = 0 then
      raise exception 'XP-PAYTECH-04 063 preflight: payments_status_valid does not admit %. It reads %', v_word, v_txt;
    end if;
  end loop;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.payments'::regclass and c.conname = 'payments_provider_mode_valid') then
    raise exception 'XP-PAYTECH-04 063 preflight: payments_provider_mode_valid is missing; 058 is not in effect';
  end if;

  -- A4 — the replay key and the in-flight index.
  if to_regclass('public.payments_provider_token_unique') is null then
    raise exception 'XP-PAYTECH-04 063 preflight: payments_provider_token_unique is missing; 060 is not in effect';
  end if;
  if to_regclass('public.payments_one_inflight_intent_per_course') is null then
    raise exception 'XP-PAYTECH-04 063 preflight: payments_one_inflight_intent_per_course is missing; 058 is not in effect';
  end if;

  -- A5 — no cascading delete into payments.
  select string_agg(c.conname, ', ') into v_txt from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'f' and c.confdeltype = 'c';
  if v_txt is not null then
    raise exception 'XP-PAYTECH-04 063 preflight: foreign key(s) % on public.payments are ON DELETE CASCADE; the delete guard would block deleting their parents. Resolve before applying', v_txt;
  end if;

  -- A6 — no trigger on payments yet.
  select string_agg(t.tgname, ', ') into v_txt from pg_trigger t
   where t.tgrelid = 'public.payments'::regclass and not t.tgisinternal;
  if v_txt is not null then
    raise exception 'XP-PAYTECH-04 063 preflight: public.payments already has trigger(s) %; no migration in this repository created one. Investigate before layering a guard on it', v_txt;
  end if;

  -- A7 — the roles.
  foreach v_word in array array['service_role', 'anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = v_word) then
      raise exception 'XP-PAYTECH-04 063 preflight: role % does not exist', v_word;
    end if;
  end loop;

  -- What this migration creates must not exist yet.
  if to_regclass('public.payment_environment') is not null then
    raise exception 'XP-PAYTECH-04 063 preflight: public.payment_environment already exists';
  end if;
  if to_regprocedure('public.payments_transition_guard()') is not null then
    raise exception 'XP-PAYTECH-04 063 preflight: public.payments_transition_guard() already exists';
  end if;
end
$do$;

-- The facts section 5 needs. Dropped at COMMIT. (Kept in a temp table so no
-- provider token outlives this transaction.)
create temp table xp_paytech_04_063_before on commit drop as
select
  (select count(*) from public.payments) as n_payments,
  (select coalesce(md5(string_agg(p.id::text || '|' || p.status || '|' || coalesce(p.provider_token, '')
                                  || '|' || coalesce(p.completed_at::text, ''), E'\n' order by p.id)), '')
     from public.payments p) as payments_md5,
  (select count(*) from public.entitlements) as n_entitlements,
  (select count(*) from public.enrollments)  as n_enrollments,
  (select count(*) from public.audit_log)    as n_audit,
  (select coalesce(array_to_string(p.proacl, ','), '') from pg_proc p
    where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')) as complete_payment_acl,
  (select md5(pg_get_functiondef(to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')))) as complete_payment_md5;


-- ══ 1. THE ENVIRONMENT MARKER ═════════════════════════════════════════════
--
-- One row, stating what kind of money this database records. 'live' by
-- default: a database must be told it is a sandbox, never the reverse. The
-- application cannot change it — service_role may only read it — so no
-- deployment, preview or credential can turn a live database into one that
-- accepts test payments.
create table public.payment_environment (
  singleton boolean     primary key default true check (singleton),
  mode      text        not null check (mode in ('live', 'sandbox')),
  set_at    timestamptz not null default now(),
  note      text
);

insert into public.payment_environment (mode, note)
values ('live', 'Set by migration 063. A live database refuses to complete a test-mode payment.');

alter table public.payment_environment enable row level security;
revoke all on public.payment_environment from public, anon, authenticated, service_role;
grant select on public.payment_environment to service_role;

comment on table public.payment_environment is
  'XP-PAYTECH-04. What kind of money this database records: live (default) or sandbox. Read by payments_transition_guard: entering completed requires provider_mode to match. Changed only by the database owner (migration 063 operator step 5).';


-- ══ 2. THE TRANSITION GUARD ═══════════════════════════════════════════════
create function public.payments_transition_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_env      text;
  v_required text;
  v_entering boolean;
begin
  if tg_op = 'DELETE' then
    if old.status in ('completed', 'refunded') or old.provider_token is not null then
      raise exception 'payments: payment % (%) carries a provider transaction and cannot be deleted', old.id, old.status
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'payment_delete_refused', 'paymentId', old.id)::text;
    end if;
    return old;
  end if;

  -- ── identity: never changes ──
  if new.id         is distinct from old.id
  or new.reference  is distinct from old.reference
  or new.amount     is distinct from old.amount
  or new.currency   is distinct from old.currency
  or new.method     is distinct from old.method
  or new.created_at is distinct from old.created_at then
    raise exception 'payments: the identity of payment % is immutable', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'payment_identity_immutable', 'paymentId', old.id)::text;
  end if;

  -- ── ownership: may be cleared by ON DELETE SET NULL, never reassigned ──
  if new.user_id is distinct from old.user_id and new.user_id is not null then
    raise exception 'payments: the learner of payment % cannot be reassigned', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'payment_owner_immutable', 'paymentId', old.id)::text;
  end if;
  if new.course_id is distinct from old.course_id and new.course_id is not null then
    raise exception 'payments: the course of payment % cannot be reassigned', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'payment_course_immutable', 'paymentId', old.id)::text;
  end if;

  -- ── provider identity: write-once ──
  if old.provider is not null and new.provider is distinct from old.provider then
    raise exception 'payments: the provider of payment % is write-once', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'provider_write_once', 'paymentId', old.id)::text;
  end if;
  if old.provider_mode is not null and new.provider_mode is distinct from old.provider_mode then
    raise exception 'payments: the provider mode of payment % is write-once', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'provider_mode_write_once', 'paymentId', old.id)::text;
  end if;

  -- ── the replay key: write-once, and only onto an unopened intent ──
  if new.provider_token is distinct from old.provider_token then
    if old.provider_token is not null then
      raise exception 'payments: the provider token of payment % is write-once', old.id
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'provider_token_write_once', 'paymentId', old.id)::text;
    end if;
    if old.status <> 'pending' then
      raise exception 'payments: payment % is % and cannot be given a provider token', old.id, old.status
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'provider_token_late', 'paymentId', old.id)::text;
    end if;
  end if;

  if new.provider_reference is distinct from old.provider_reference
     and old.status not in ('pending', 'processing') then
    raise exception 'payments: the provider reference of payment % is fixed once it is %', old.id, old.status
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'provider_reference_immutable', 'paymentId', old.id)::text;
  end if;

  -- ── status ──
  if new.status is distinct from old.status then
    if not (
         (old.status = 'pending'    and new.status in ('processing', 'completed', 'failed', 'cancelled', 'expired'))
      or (old.status = 'processing' and new.status in ('completed', 'failed', 'cancelled', 'expired'))
      or (old.status = 'completed'  and new.status = 'refunded')
    ) then
      raise exception 'payments: payment % cannot move from % to %', old.id, old.status, new.status
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'illegal_status_transition', 'paymentId', old.id,
                                           'from', old.status, 'to', new.status)::text;
    end if;
  end if;

  -- ── completion bookkeeping travels only with the transition into completed ──
  v_entering := new.status = 'completed' and old.status is distinct from 'completed';

  if new.completed_at is distinct from old.completed_at and not v_entering then
    raise exception 'payments: completed_at of payment % changes only on completion', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'completed_at_immutable', 'paymentId', old.id)::text;
  end if;
  if new.entitlement_id is distinct from old.entitlement_id
     and new.entitlement_id is not null and not v_entering then
    raise exception 'payments: the entitlement of payment % is linked only on completion', old.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'entitlement_link_immutable', 'paymentId', old.id)::text;
  end if;

  -- ── a sale must belong to this database's kind of money ──
  if v_entering then
    select e.mode into v_env from public.payment_environment e where e.singleton;
    v_required := case coalesce(v_env, 'live') when 'sandbox' then 'test' else 'live' end;
    if new.provider_mode is distinct from v_required then
      raise exception 'payments: a % payment cannot be completed in a % database', coalesce(new.provider_mode, 'mode-less'), coalesce(v_env, 'live')
        using errcode = 'P0001',
              detail  = jsonb_build_object(
                          'reason', case when v_required = 'live'
                                         then 'test_payment_in_live_database'
                                         else 'live_payment_in_sandbox_database' end,
                          'paymentId', old.id)::text;
    end if;
  end if;

  return new;
end
$fn$;

comment on function public.payments_transition_guard() is
  'XP-PAYTECH-04. The payment state machine: legal status transitions, write-once provider identity and token, immutable amount and reference, completion bookkeeping only on completion, provider_mode must match public.payment_environment to complete, and no deletion of a payment that carries a provider transaction. Raises P0001 with a JSON reason in DETAIL.';

revoke all on function public.payments_transition_guard() from public, anon, authenticated;

create trigger payments_transition_guard
  before update or delete on public.payments
  for each row execute function public.payments_transition_guard();


-- ══ 3. SELF-TEST — inside this transaction, rolled back, zero net writes ══
--
-- Every rule above is exercised on two scratch rows that never survive: the
-- whole block ends by raising a sentinel that rolls back its own writes, and
-- only the recorded verdicts are compared. A rule that does not hold aborts
-- the migration.
do $do$
declare
  v_a      uuid;
  v_b      uuid;
  v_detail text;
  v_got    text[] := array[]::text[];
  v_want   constant text[] := array[
    'open:ok',
    'retoken:provider_token_write_once',
    'amount:payment_identity_immutable',
    'owner:payment_owner_immutable',
    'test_completion:test_payment_in_live_database',
    'cancel:ok',
    'reopen:illegal_status_transition',
    'delete_opened:payment_delete_refused',
    'live_completion:ok',
    'uncomplete:illegal_status_transition',
    'refund:ok',
    'delete_completed:payment_delete_refused'
  ];
begin
  begin
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (1, 'XOF', 'card', 'pending', 'XP-PAYTECH-04-063-SELFTEST-A', 'paytech', 'test')
    returning id into v_a;

    update public.payments set provider_token = 'xp-paytech-04-063-selftest-a', status = 'processing' where id = v_a;
    v_got := v_got || 'open:ok'::text;

    begin
      update public.payments set provider_token = 'xp-paytech-04-063-selftest-x' where id = v_a;
      v_got := v_got || 'retoken:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('retoken:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      update public.payments set amount = 2 where id = v_a;
      v_got := v_got || 'amount:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('amount:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      update public.payments set user_id = gen_random_uuid() where id = v_a;
      v_got := v_got || 'owner:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('owner:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      update public.payments set status = 'completed', completed_at = now() where id = v_a;
      v_got := v_got || 'test_completion:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('test_completion:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    update public.payments set status = 'cancelled', failure_reason = 'selftest' where id = v_a;
    v_got := v_got || 'cancel:ok'::text;

    begin
      update public.payments set status = 'processing' where id = v_a;
      v_got := v_got || 'reopen:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('reopen:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      delete from public.payments where id = v_a;
      v_got := v_got || 'delete_opened:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('delete_opened:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (1, 'XOF', 'card', 'pending', 'XP-PAYTECH-04-063-SELFTEST-B', 'paytech', 'live')
    returning id into v_b;
    update public.payments set provider_token = 'xp-paytech-04-063-selftest-b', status = 'processing' where id = v_b;
    update public.payments set status = 'completed', completed_at = now() where id = v_b;
    v_got := v_got || 'live_completion:ok'::text;

    begin
      update public.payments set status = 'processing' where id = v_b;
      v_got := v_got || 'uncomplete:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('uncomplete:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    update public.payments set status = 'refunded' where id = v_b;
    v_got := v_got || 'refund:ok'::text;

    begin
      delete from public.payments where id = v_b;
      v_got := v_got || 'delete_completed:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('delete_completed:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    -- Roll back every write above; keep only the verdicts.
    raise exception 'xp-paytech-04-063-selftest-complete' using errcode = 'XPT63';
  exception when sqlstate 'XPT63' then
    null;
  end;

  if v_got is distinct from v_want then
    raise exception 'XP-PAYTECH-04 063 self-test: the guard does not behave as specified. Expected % got %', v_want, v_got;
  end if;
  if exists (select 1 from public.payments where reference like 'XP-PAYTECH-04-063-SELFTEST-%') then
    raise exception 'XP-PAYTECH-04 063 self-test: a scratch row survived';
  end if;
end
$do$;


-- ══ 4. THE RESULTING OBJECTS ══════════════════════════════════════════════
do $do$
declare
  v_n   integer;
  v_txt text;
begin
  -- the trigger: present, enabled, BEFORE, ROW, UPDATE and DELETE, our function
  select count(*) into v_n from pg_trigger t
   where t.tgrelid = 'public.payments'::regclass
     and t.tgname = 'payments_transition_guard'
     and not t.tgisinternal
     and t.tgenabled = 'O'
     and t.tgfoid = to_regprocedure('public.payments_transition_guard()')
     and t.tgtype = (1 | 2 | 8 | 16);   -- ROW | BEFORE | DELETE | UPDATE
  if v_n <> 1 then
    raise exception 'XP-PAYTECH-04 063: payments_transition_guard is not installed as a BEFORE UPDATE OR DELETE row trigger';
  end if;

  -- the function: INVOKER, pinned search_path, not callable by browser roles
  if (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.payments_transition_guard()')) then
    raise exception 'XP-PAYTECH-04 063: payments_transition_guard is SECURITY DEFINER';
  end if;
  select array_to_string(p.proconfig, ',') into v_txt from pg_proc p
   where p.oid = to_regprocedure('public.payments_transition_guard()');
  if v_txt is distinct from 'search_path=public, pg_temp' then
    raise exception 'XP-PAYTECH-04 063: payments_transition_guard search_path is [%]', v_txt;
  end if;
  foreach v_txt in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_txt, 'public.payments_transition_guard()', 'EXECUTE') then
      raise exception 'XP-PAYTECH-04 063: % can EXECUTE payments_transition_guard', v_txt;
    end if;
  end loop;

  -- the marker: one row, live; browsers hold nothing; service_role reads only
  select count(*) into v_n from public.payment_environment;
  if v_n <> 1 or (select mode from public.payment_environment) <> 'live' then
    raise exception 'XP-PAYTECH-04 063: payment_environment must hold exactly one row, ''live''';
  end if;
  foreach v_txt in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_txt, 'public.payment_environment', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 'XP-PAYTECH-04 063: % holds a privilege on payment_environment', v_txt;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.payment_environment', 'SELECT') then
    raise exception 'XP-PAYTECH-04 063: service_role cannot read payment_environment; every completion would be judged ''live''';
  end if;
  if has_table_privilege('service_role', 'public.payment_environment', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'XP-PAYTECH-04 063: service_role can change payment_environment; the application must not be able to make a live database a sandbox';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.payment_environment'::regclass) then
    raise exception 'XP-PAYTECH-04 063: row level security is not enabled on payment_environment';
  end if;
end
$do$;


-- ══ 5. NOTHING ELSE CHANGED ═══════════════════════════════════════════════
do $do$
declare b xp_paytech_04_063_before%rowtype;
begin
  select * into b from xp_paytech_04_063_before;

  if (select count(*) from public.payments) <> b.n_payments then
    raise exception 'XP-PAYTECH-04 063: the payment count changed';
  end if;
  if (select coalesce(md5(string_agg(p.id::text || '|' || p.status || '|' || coalesce(p.provider_token, '')
                                     || '|' || coalesce(p.completed_at::text, ''), E'\n' order by p.id)), '')
        from public.payments p) is distinct from b.payments_md5 then
    raise exception 'XP-PAYTECH-04 063: payment data changed';
  end if;
  if (select count(*) from public.entitlements) <> b.n_entitlements then
    raise exception 'XP-PAYTECH-04 063: the entitlement count changed';
  end if;
  if (select count(*) from public.enrollments) <> b.n_enrollments then
    raise exception 'XP-PAYTECH-04 063: the enrollment count changed';
  end if;
  if (select count(*) from public.audit_log) <> b.n_audit then
    raise exception 'XP-PAYTECH-04 063: the audit record count changed';
  end if;

  -- 062, exactly as 062 left it.
  if (select coalesce(array_to_string(p.proacl, ','), '') from pg_proc p
       where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)'))
     is distinct from b.complete_payment_acl then
    raise exception 'XP-PAYTECH-04 063: complete_payment''s privileges changed';
  end if;
  if md5(pg_get_functiondef(to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')))
     is distinct from b.complete_payment_md5 then
    raise exception 'XP-PAYTECH-04 063: complete_payment''s definition changed';
  end if;
  if has_function_privilege('anon', 'public.complete_payment(text, text, text, text, text, numeric, text)', 'EXECUTE')
  or has_function_privilege('authenticated', 'public.complete_payment(text, text, text, text, text, numeric, text)', 'EXECUTE') then
    raise exception 'XP-PAYTECH-04 063: a browser role can EXECUTE complete_payment';
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Prerequisite: migrations through 062 (assumption A1). This migration
--    refuses otherwise.
-- 2. The guard changes no row and only constrains future writes. Catalog-only
--    plus one ROW EXCLUSIVE lock for the self-test,
--    released at commit. Milliseconds. Prefer an off-peak window anyway.
-- 3. Paste the WHOLE file into the Supabase SQL editor and run it once.
--    "Success. No rows returned." means every assertion passed; any failure
--    raises and rolls back everything, including the self-test.
-- 4. Immediately afterwards, READ-ONLY:
--        select tgname, tgenabled from pg_trigger
--         where tgrelid = 'public.payments'::regclass and not tgisinternal;
--          → payments_transition_guard | O
--        select mode, set_at from public.payment_environment;
--          → live | <now>
--        select status, count(*) from public.payments group by 1 order by 1;
--          → identical to the counts captured before the run
-- 5. SANDBOX DATABASES ONLY — never the production project. On an isolated
--    UAT database that must accept PayTech TEST payments, the database owner
--    runs, once, after this migration:
--        update public.payment_environment
--           set mode = 'sandbox', set_at = now(),
--               note = 'UAT sandbox — <who>, <date>, <ticket>';
--    Production stays 'live'. A non-production deployment refuses all payment
--    work unless its database says 'sandbox' (lib/payments/payment-database-guard.ts).
--
-- ── BREAK-GLASS ───────────────────────────────────────────────────────────
--
--    A reviewed data correction that the guard forbids is done by the database
--    owner, under the owner's runbook, and recorded in the audit log by hand.
--    The application can never do this.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes the guard and the marker. Changes no payment row.
-- Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- create temp table xp_paytech_04_063_rb on commit drop as
-- select status, count(*) as n from public.payments group by status;
--
-- drop trigger if exists payments_transition_guard on public.payments;
-- drop function if exists public.payments_transition_guard();
-- drop table if exists public.payment_environment;
--
-- do $rb$
-- begin
--   if exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass
--                and tgname = 'payments_transition_guard') then
--     raise exception 'XP-PAYTECH-04 063 rollback: the trigger survived';
--   end if;
--   if to_regclass('public.payment_environment') is not null then
--     raise exception 'XP-PAYTECH-04 063 rollback: payment_environment survived';
--   end if;
--   if exists (
--     select 1 from (select status, count(*) as n from public.payments group by status) now
--     full join xp_paytech_04_063_rb was using (status)
--     where now.n is distinct from was.n) then
--     raise exception 'XP-PAYTECH-04 063 rollback: payment counts changed';
--   end if;
-- end
-- $rb$;
--
-- commit;
--
-- After a rollback the application still refuses test mode on production and
-- writes with compare-and-set, but the database no longer enforces either.
