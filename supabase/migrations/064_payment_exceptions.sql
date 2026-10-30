-- ============================================================================
-- Migration 064 — XP-PAYTECH-05: payment exceptions. A durable record for a
-- payment report that the state machine cannot act on.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Creates ONE table, TEN functions and TWO triggers. Changes no existing
-- payment, entitlement, enrollment or audit row — section 8 proves it.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Migration 063 makes `cancelled`, `failed` and `expired` final, and it allows
-- `refunded` only from `completed`. Those rules are right, and this migration
-- does not weaken them. But a payment can be closed here and still be paid at
-- PayTech, and a report of that fact must not be lost. It is recorded here,
-- beside the payment, without moving the payment.
--
-- ── FOUR FACTS, KEPT APART ─────────────────────────────────────────────────
--
--   payment_received   not_established | reported | confirmed_by_operator
--                      | confirmed_by_provider | not_received
--   access_state       not_granted | granted
--   refund_state       not_assessed | required | not_required | confirmed
--   state              watching | open | resolved
--
-- `reported` means PayTech sent a notification suggesting payment. It is NOT
-- proof: the IPN signature covers the amount and the reference, never the
-- outcome. Only the settlement contract (`confirmed_by_provider`) or an
-- administrator's check of the PayTech dashboard (`confirmed_by_operator`) can
-- establish that money moved. Neither of them completes the payment.
--
-- `watching` is a report on a payment still in flight. It raises no alert,
-- because the payment may yet settle normally. If the payment completes, the
-- record resolves itself. If the payment closes instead, the record opens, in the
-- same transaction as the closure, whichever path closed it. If neither happens,
-- the next sweep after a day escalates it, so it cannot sit unseen.
--
-- ── WHAT THIS CANNOT DO ────────────────────────────────────────────────────
--
--   * It never completes a payment and never calls complete_payment().
--   * It never writes to entitlements or enrollments. `record_access` only
--     records that an administrator's separately audited grant exists, and
--     refuses when none does.
--   * It never issues a refund. `payment_exception_record_refund` records a
--     FULL refund already confirmed outside this system. Whether PayTech offers
--     a refund call at all is not assumed. A partial refund is refused until the
--     owner decides a policy for it.
--   * A refund on a closed payment leaves `payments.status` as it is. An
--     in-flight payment moves to `failed` and a completed one to `refunded`,
--     the two moves 063 already permits.
--
-- ── TRUST BOUNDARY ─────────────────────────────────────────────────────────
--
-- service_role may only READ this table. Every write goes through a function, so
-- no state can change without its checks and its audit row. That is why the write
-- functions are SECURITY DEFINER, unlike 062. 062 is INVOKER because DEFINER would
-- add no capability there. Here DEFINER is what lets the application hold no write
-- privilege on this table at all. EXECUTE goes to service_role only, and each
-- function does one narrow thing. search_path is pg_catalog then pg_temp, so no
-- schema anyone can write to is ever searched, and every object here is named with
-- its schema. Browser roles hold nothing.
--
-- The guard trigger also binds the table owner, so a hand-written UPDATE cannot
-- rewrite what happened without the owner's runbook.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
--
-- Always the payment row, then the exception row. 062 and every status write
-- already hold the payment row when the follow trigger fires, so the order
-- cannot invert. Stamping an alert locks only the exception row.
--
-- ── PRODUCTION-SCHEMA ASSUMPTIONS (each one asserted in section 0) ─────────
--
--   E1  063 is applied: payments_transition_guard and payment_environment exist.
--   E2  062 is applied: complete_payment(text×5, numeric, text) is INVOKER.
--   E3  037 is applied, and the role running this can read entitlements and
--       EXECUTE entitlement_accessible(), the one definition of "grants access".
--   E4  audit_log has the columns 027 created, and the role running this can
--       INSERT into it and UPDATE payments.
--   E5  063's guard is the only non-internal trigger on public.payments.
--   E6  Roles service_role, anon and authenticated exist.
--   E7  Nothing this migration creates exists yet.
-- ============================================================================

begin isolation level repeatable read;

-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $do$
declare
  v_txt  text;
  v_n    integer;
begin
  -- E1
  if to_regclass('public.payment_environment') is null
  or to_regprocedure('public.payments_transition_guard()') is null then
    raise exception 'XP-PAYTECH-05 064 preflight: 063 is not in effect; apply migrations through 063 first';
  end if;

  -- E2
  if to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)') is null then
    raise exception 'XP-PAYTECH-05 064 preflight: public.complete_payment(...) does not exist; 062 is not in effect';
  end if;
  if (select p.prosecdef from pg_proc p
       where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')) then
    raise exception 'XP-PAYTECH-05 064 preflight: complete_payment is SECURITY DEFINER; 062 created it INVOKER';
  end if;

  -- E6, first, because the checks below name these roles.
  foreach v_txt in array array['service_role', 'anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles r where r.rolname = v_txt) then
      raise exception 'XP-PAYTECH-05 064 preflight: role % does not exist', v_txt;
    end if;
  end loop;

  -- E3. The write functions run as this role, so it is the one that must be able to.
  if to_regprocedure('public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz)') is null then
    raise exception 'XP-PAYTECH-05 064 preflight: entitlement_accessible() does not exist; 037 is not in effect';
  end if;
  if not has_function_privilege(current_user, 'public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz)', 'EXECUTE') then
    raise exception 'XP-PAYTECH-05 064 preflight: % cannot EXECUTE entitlement_accessible()', current_user;
  end if;
  if not has_table_privilege(current_user, 'public.entitlements', 'SELECT') then
    raise exception 'XP-PAYTECH-05 064 preflight: % cannot read public.entitlements', current_user;
  end if;

  -- E4
  select count(*) into v_n from pg_attribute a
   where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname in ('event_type', 'actor_type', 'actor_id', 'actor_email', 'subject_user_id',
                       'method', 'outcome', 'reason', 'ip', 'user_agent', 'metadata');
  if v_n <> 11 then
    raise exception 'XP-PAYTECH-05 064 preflight: public.audit_log does not have the columns 027 created';
  end if;
  if not has_table_privilege(current_user, 'public.audit_log', 'INSERT') then
    raise exception 'XP-PAYTECH-05 064 preflight: % cannot INSERT into audit_log', current_user;
  end if;
  if not has_table_privilege(current_user, 'public.payments', 'SELECT')
  or not has_table_privilege(current_user, 'public.payments', 'UPDATE') then
    raise exception 'XP-PAYTECH-05 064 preflight: % cannot read and update public.payments', current_user;
  end if;

  -- E5
  select string_agg(t.tgname, ',' order by t.tgname) into v_txt from pg_trigger t
   where t.tgrelid = 'public.payments'::regclass and not t.tgisinternal;
  if v_txt is distinct from 'payments_transition_guard' then
    raise exception 'XP-PAYTECH-05 064 preflight: public.payments has triggers [%]; expected only 063''s guard', v_txt;
  end if;

  -- E7
  if to_regclass('public.payment_exceptions') is not null then
    raise exception 'XP-PAYTECH-05 064 preflight: public.payment_exceptions already exists';
  end if;
  if to_regprocedure('public.payment_exception_report(uuid, text, text, text)') is not null then
    raise exception 'XP-PAYTECH-05 064 preflight: public.payment_exception_report() already exists';
  end if;
end
$do$;

-- The facts section 8 needs. Dropped at COMMIT.
create temp table xp_paytech_05_064_before on commit drop as
select
  (select count(*) from public.payments) as n_payments,
  (select coalesce(md5(string_agg(p.id::text || '|' || p.status || '|' || coalesce(p.provider_token, '')
                                  || '|' || coalesce(p.completed_at::text, ''), E'\n' order by p.id)), '')
     from public.payments p) as payments_md5,
  (select count(*) from public.entitlements) as n_entitlements,
  (select count(*) from public.enrollments)  as n_enrollments,
  (select count(*) from public.audit_log)    as n_audit,
  (select md5(pg_get_functiondef(to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')))) as complete_payment_md5,
  (select coalesce(array_to_string(p.proacl, ','), '') from pg_proc p
    where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')) as complete_payment_acl,
  (select md5(pg_get_functiondef(to_regprocedure('public.payments_transition_guard()')))) as guard_md5;


-- ══ 1. THE RECORD ═════════════════════════════════════════════════════════
create table public.payment_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  -- One record per payment, so repeated notifications cannot multiply it. RESTRICT
  -- because the record must outlive any attempt to remove the payment.
  payment_id         uuid not null unique references public.payments(id) on delete restrict,

  state              text not null,
  first_signal       text not null,
  last_signal        text not null,
  -- A short machine code, such as 062's refusal reason. Never free text from a
  -- notification or a provider response.
  detail             text check (detail is null or detail ~ '^[a-z0-9_:]{1,80}$'),
  report_count       integer not null default 1 check (report_count >= 1),
  first_reported_at  timestamptz not null default now(),
  last_reported_at   timestamptz not null default now(),
  -- Set when a watching record was opened for its age, not because its payment
  -- closed. Such a record still resolves itself if the payment later completes.
  escalated_at       timestamptz,
  -- A paid report that arrived AFTER a refund or an access decision was settled.
  -- The settled facts stay final, but this may be a second real payment, so it must
  -- reach a human. Cleared when an administrator has reviewed it.
  post_settlement_report_at timestamptz,

  payment_received   text not null,
  -- What the evidence was before an administrator confirmed it, so that withdrawing
  -- the confirmation restores the truth rather than guessing it.
  evidence_before_confirmation text
    check (evidence_before_confirmation is null or evidence_before_confirmation in ('not_established', 'reported')),
  access_state       text not null default 'not_granted',
  -- No FK, as with entitlements.granted_by: this record must outlive the row.
  access_entitlement_id uuid,
  refund_state       text not null default 'not_assessed',

  -- Facts about a refund confirmed OUTSIDE this system.
  refund_external_reference text,
  refund_amount      numeric,
  refund_currency    text,
  refund_confirmed_at timestamptz,
  refund_recorded_by uuid,
  refund_recorded_at timestamptz,

  resolution         text,
  resolved_at        timestamptz,
  resolved_by        uuid,

  alert_sent_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint payment_exceptions_state_valid
    check (state in ('watching', 'open', 'resolved')),
  constraint payment_exceptions_signal_valid
    check (first_signal in ('paid_hint', 'unverified_report', 'provider_paid', 'completion_refused', 'provider_pending',
                            'provider_not_paid', 'cancel_hint', 'amount_mismatch', 'currency_mismatch')
       and last_signal  in ('paid_hint', 'unverified_report', 'provider_paid', 'completion_refused', 'provider_pending',
                            'provider_not_paid', 'cancel_hint', 'amount_mismatch', 'currency_mismatch')),
  constraint payment_exceptions_received_valid
    check (payment_received in ('not_established', 'reported', 'confirmed_by_operator',
                                'confirmed_by_provider', 'not_received')),
  constraint payment_exceptions_access_valid
    check (access_state in ('not_granted', 'granted')),
  constraint payment_exceptions_refund_valid
    check (refund_state in ('not_assessed', 'required', 'not_required', 'confirmed')),
  constraint payment_exceptions_resolution_valid
    check (resolution is null or resolution in ('nothing_to_return', 'refund_confirmed',
                                                'access_honoured', 'settled_normally')),
  -- The facts must agree with one another, whoever writes them.
  constraint payment_exceptions_resolved_coherent
    check ((state = 'resolved') = (resolution is not null and resolved_at is not null)),
  constraint payment_exceptions_refund_coherent
    check ((refund_state = 'confirmed') = (
             refund_external_reference is not null and refund_amount is not null and refund_amount > 0
         and refund_currency is not null and refund_confirmed_at is not null
         and refund_recorded_by is not null and refund_recorded_at is not null)),
  constraint payment_exceptions_refund_resolution_coherent
    check ((resolution = 'refund_confirmed') is not true or refund_state = 'confirmed'),
  constraint payment_exceptions_access_coherent
    check ((access_state = 'granted') = (access_entitlement_id is not null)),
  constraint payment_exceptions_access_resolution_coherent
    check ((resolution = 'access_honoured') is not true or access_state = 'granted')
);

create index payment_exceptions_state_idx
  on public.payment_exceptions (state, last_reported_at desc);
-- One external refund can settle only one exception.
create unique index payment_exceptions_refund_reference_unique
  on public.payment_exceptions (refund_external_reference)
  where refund_external_reference is not null;

alter table public.payment_exceptions enable row level security;
revoke all on public.payment_exceptions from public, anon, authenticated, service_role;
grant select on public.payment_exceptions to service_role;

comment on table public.payment_exceptions is
  'XP-PAYTECH-05. A payment report the state machine cannot act on: paid after closure, paid but refused by complete_payment, or conflicting with the record. Holds separate facts for payment received, access granted, refund required and refund confirmed. Grants nothing and moves no money. service_role may only read it; every write goes through a function.';


-- ══ 2. HELPERS ════════════════════════════════════════════════════════════
create function public.payment_exception_refuse(p_reason text)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
begin
  raise exception 'payment exception refused: %', p_reason
    using errcode = 'P0001',
          detail  = jsonb_build_object('reason', p_reason)::text;
end
$fn$;

create function public.payment_exception_audit(
  p_event       text,
  p_actor_type  text,
  p_actor_id    uuid,
  p_actor_email text,
  p_subject     uuid,
  p_method      text,
  p_reason      text,
  p_ip          text,
  p_user_agent  text,
  p_metadata    jsonb
)
returns void
language sql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
  insert into public.audit_log (
    event_type, actor_type, actor_id, actor_email, subject_user_id,
    method, outcome, reason, ip, user_agent, metadata
  ) values (
    p_event, p_actor_type, p_actor_id, p_actor_email, p_subject,
    p_method, 'success', p_reason, p_ip, left(p_user_agent, 256), p_metadata
  );
$fn$;


-- ══ 3. THE GUARD ══════════════════════════════════════════════════════════
--
-- service_role cannot write here at all, so this binds the functions below and
-- the table owner. A correction outside these rules needs the owner's runbook.
create function public.payment_exceptions_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.payment_exception_refuse('exception_delete_refused');
  end if;

  -- A record starts as a report. A refund or an access grant cannot be born on it.
  if tg_op = 'INSERT' then
    if new.state not in ('watching', 'open')
    or new.refund_state <> 'not_assessed'
    or new.access_state <> 'not_granted'
    or new.resolution is not null then
      perform public.payment_exception_refuse('exception_must_start_clean');
    end if;
    return new;
  end if;

  if new.id                is distinct from old.id
  or new.payment_id        is distinct from old.payment_id
  or new.first_signal      is distinct from old.first_signal
  or new.first_reported_at is distinct from old.first_reported_at
  or new.created_at        is distinct from old.created_at then
    perform public.payment_exception_refuse('exception_identity_immutable');
  end if;

  -- ── state ──
  if new.state is distinct from old.state then
    if not (
         (old.state = 'watching' and new.state = 'open')
      or (old.state = 'watching' and new.state = 'resolved' and new.resolution = 'settled_normally')
      or (old.state = 'open'     and new.state = 'resolved')
      or (old.state = 'resolved' and new.state in ('open', 'watching') and old.resolution in ('nothing_to_return', 'settled_normally'))
    ) then
      perform public.payment_exception_refuse('illegal_exception_transition');
    end if;
  elsif old.state = 'resolved'
    and (new.resolution  is distinct from old.resolution
      or new.resolved_at is distinct from old.resolved_at
      or new.resolved_by is distinct from old.resolved_by) then
    perform public.payment_exception_refuse('illegal_exception_transition');
  end if;

  -- ── money ──
  -- What PayTech confirmed is never taken back. An administrator may correct their
  -- own confirmation, but only before any refund decision rests on it.
  if new.payment_received is distinct from old.payment_received then
    if old.payment_received = 'confirmed_by_provider' then
      perform public.payment_exception_refuse('payment_evidence_downgrade');
    end if;
    if old.payment_received = 'confirmed_by_operator'
       and new.payment_received <> 'confirmed_by_provider'
       and not (new.payment_received in ('reported', 'not_established')
                and old.refund_state = 'not_assessed' and new.refund_state = 'not_assessed') then
      perform public.payment_exception_refuse('payment_evidence_downgrade');
    end if;
    if new.payment_received = 'not_established' and old.payment_received <> 'confirmed_by_operator' then
      perform public.payment_exception_refuse('payment_evidence_downgrade');
    end if;
  end if;

  -- ── refund ──
  if new.refund_state is distinct from old.refund_state then
    if not (
         (old.refund_state = 'not_assessed' and new.refund_state in ('required', 'not_required'))
      or (old.refund_state = 'required'     and new.refund_state in ('confirmed', 'not_assessed'))
      or (old.refund_state = 'not_required' and new.refund_state = 'not_assessed' and new.state in ('open', 'watching'))
    ) then
      perform public.payment_exception_refuse('illegal_refund_transition');
    end if;
  end if;
  -- A refund obligation rests on money confirmed received.
  if new.refund_state in ('required', 'confirmed')
     and new.payment_received not in ('confirmed_by_operator', 'confirmed_by_provider') then
    perform public.payment_exception_refuse('receipt_not_confirmed');
  end if;
  if old.refund_state = 'confirmed'
     and (new.refund_external_reference is distinct from old.refund_external_reference
       or new.refund_amount             is distinct from old.refund_amount
       or new.refund_currency           is distinct from old.refund_currency
       or new.refund_confirmed_at       is distinct from old.refund_confirmed_at
       or new.refund_recorded_by        is distinct from old.refund_recorded_by
       or new.refund_recorded_at        is distinct from old.refund_recorded_at) then
    perform public.payment_exception_refuse('refund_facts_final');
  end if;

  -- ── access ──
  if old.access_state = 'granted'
     and (new.access_state is distinct from old.access_state
       or new.access_entitlement_id is distinct from old.access_entitlement_id) then
    perform public.payment_exception_refuse('access_record_final');
  end if;

  new.updated_at := now();
  return new;
end
$fn$;

comment on function public.payment_exceptions_guard() is
  'XP-PAYTECH-05. The exception state machine, binding the table owner too: a clean start, no deletion, immutable identity, legal state and refund transitions, provider evidence never downgraded, a refund only on confirmed receipt, refund and access facts final. Raises P0001 with a JSON reason in DETAIL.';

create trigger payment_exceptions_guard
  before insert or update or delete on public.payment_exceptions
  for each row execute function public.payment_exceptions_guard();


-- ══ 4. FOLLOWING THE PAYMENT ══════════════════════════════════════════════
--
-- Fires in the transaction that moves the payment, so no path that closes or
-- completes a payment can leave a `watching` record behind. DEFINER because it
-- fires as service_role, which holds no write on the table.
create function public.payment_exceptions_follow_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if new.status = 'completed' then
    update public.payment_exceptions
       set state = 'resolved', resolution = 'settled_normally', resolved_at = now(),
           payment_received = 'confirmed_by_provider', refund_state = 'not_required'
     where payment_id = new.id
       and (state = 'watching' or (state = 'open' and escalated_at is not null and refund_state = 'not_assessed'))
    returning id into v_id;
    if v_id is not null then
      perform public.payment_exception_audit(
        'payment.exception_settled', 'system', null, null, new.user_id, 'payment_completed', null, null, null,
        jsonb_build_object('paymentId', new.id, 'reference', new.reference, 'exceptionId', v_id));
    end if;
  elsif new.status in ('failed', 'cancelled', 'expired') then
    update public.payment_exceptions
       set state = 'open', alert_sent_at = null
     where payment_id = new.id and state = 'watching'
    returning id into v_id;
    if v_id is not null then
      perform public.payment_exception_audit(
        'payment.exception_recorded', 'system', null, null, new.user_id, 'payment_closed', null, null, null,
        jsonb_build_object('paymentId', new.id, 'reference', new.reference, 'exceptionId', v_id,
                           'closedAs', new.status));
    end if;
  end if;
  return null;
end
$fn$;

comment on function public.payment_exceptions_follow_payment() is
  'XP-PAYTECH-05. Opens a watching exception when its payment closes and resolves it when its payment completes, in the same transaction.';

create trigger payment_exceptions_follow_payment
  after update of status on public.payments
  for each row
  when (old.status in ('pending', 'processing') and new.status is distinct from old.status)
  execute function public.payment_exceptions_follow_payment();


-- ══ 5. THE ONLY ENTRY POINTS ══════════════════════════════════════════════

-- ── report: idempotent, called by the reconciliation paths ──
create function public.payment_exception_report(
  p_payment_id uuid,
  p_signal     text,
  p_source     text,
  p_detail     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_pay    public.payments%rowtype;
  v_exc    public.payment_exceptions%rowtype;
  v_group  text;
  v_state  text;
  v_money  text;
  v_new    text;
  v_event  text;
  v_outcome text := 'replayed';
  v_flagged boolean;
  v_rank   constant jsonb := '{"not_established":0,"not_received":0,"reported":1,"confirmed_by_operator":2,"confirmed_by_provider":3}';
begin
  if p_signal is null or p_signal not in ('paid_hint', 'unverified_report', 'provider_paid', 'completion_refused', 'provider_pending',
                                          'provider_not_paid', 'cancel_hint', 'amount_mismatch', 'currency_mismatch') then
    perform public.payment_exception_refuse('invalid_signal');
  end if;
  if p_source is null or p_source not in ('ipn', 'sweep', 'admin', 'checkout') then
    perform public.payment_exception_refuse('invalid_source');
  end if;
  if p_detail is not null and p_detail !~ '^[a-z0-9_:]{1,80}$' then
    perform public.payment_exception_refuse('invalid_detail');
  end if;

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    perform public.payment_exception_refuse('payment_not_found');
  end if;

  v_group := case when v_pay.status in ('pending', 'processing') then 'in_flight'
                  when v_pay.status = 'completed' then 'completed'
                  else 'closed' end;

  -- What this signal means for a payment in this condition. NULL means it means
  -- nothing: a repeated paid notification on a completed payment is a replay.
  case
    when p_signal = 'paid_hint' and v_group = 'closed' then
      v_state := 'open';     v_money := 'reported';
    when p_signal = 'paid_hint' and v_group = 'in_flight' then
      v_state := 'watching'; v_money := 'reported';
    -- A notification with the right credentials and a bad signature, or a signed
    -- one with an unknown event. Not evidence of payment, but it must not vanish:
    -- on a closed payment nothing else would ever find it.
    when p_signal = 'unverified_report' and v_group = 'closed' then
      v_state := 'open';     v_money := 'not_established';
    when p_signal = 'unverified_report' and v_group = 'in_flight' then
      v_state := 'watching'; v_money := 'not_established';
    -- Only a SIGNED report of an unknown event can question a completed payment.
    when p_signal = 'unverified_report' and p_detail = 'ipn_unknown_event' then
      v_state := 'open';     v_money := 'confirmed_by_provider';
    when p_signal = 'provider_paid' and v_group = 'closed' then
      v_state := 'open';     v_money := 'confirmed_by_provider';
    when p_signal = 'completion_refused' and v_group <> 'completed' then
      v_state := 'open';     v_money := 'confirmed_by_provider';
    when p_signal = 'provider_pending' and v_group = 'closed' then
      v_state := 'open';     v_money := 'not_established';
    when p_signal in ('provider_not_paid', 'cancel_hint') and v_group = 'completed' then
      v_state := 'open';     v_money := 'confirmed_by_provider';
    when p_signal in ('amount_mismatch', 'currency_mismatch') then
      v_state := 'open';
      v_money := case when v_group = 'completed' then 'confirmed_by_provider' else 'reported' end;
    else
      v_state := null;       v_money := null;
  end case;

  select * into v_exc from public.payment_exceptions where payment_id = p_payment_id for update;

  if v_exc.id is null then
    if v_state is null then
      return jsonb_build_object('outcome', 'ignored', 'needsAlert', false);
    end if;
    insert into public.payment_exceptions (payment_id, state, first_signal, last_signal, detail, payment_received)
    values (p_payment_id, v_state, p_signal, p_signal, p_detail, v_money)
    returning * into v_exc;
    v_outcome := 'created';
    v_event   := 'payment.exception_recorded';

  elsif v_exc.state = 'resolved'
    and v_exc.resolution in ('nothing_to_return', 'settled_normally')
    and v_state is not null
    -- Not evidence that money moved, so it cannot undo a human's review.
    and p_signal not in ('provider_pending', 'unverified_report')
    -- A repeated mismatch is the same fact. A new kind of conflict is not.
    and (p_signal not in ('amount_mismatch', 'currency_mismatch') or p_signal is distinct from v_exc.last_signal) then
    -- A repeated notification cannot be told from a new payment: the signature
    -- carries no nonce. So this fails towards a human.
    update public.payment_exceptions
       set state = v_state, resolution = null, resolved_at = null, resolved_by = null,
           refund_state = 'not_assessed', alert_sent_at = null, escalated_at = null,
           last_signal = p_signal, detail = coalesce(p_detail, detail),
           report_count = report_count + 1, last_reported_at = now(),
           payment_received = case
             when (v_rank ->> v_money)::int >= (v_rank ->> payment_received)::int then v_money
             else payment_received end
     where id = v_exc.id
    returning * into v_exc;
    v_outcome := 'reopened';
    v_event   := 'payment.exception_reopened';

  elsif v_exc.state = 'resolved'
    and v_exc.resolution in ('refund_confirmed', 'access_honoured')
    and p_source = 'ipn'
    and p_signal in ('paid_hint', 'provider_paid', 'completion_refused', 'amount_mismatch', 'currency_mismatch') then
    -- The settled facts stay final, but this could be a second real payment: nothing
    -- proves the checkout can no longer be paid. It reaches a human without touching
    -- them. Only a NOTIFICATION flags, whatever the provider then answers. A status
    -- check from the sweep or an administrator is not an event: after a refund the
    -- provider may well keep answering "paid", and that must not flag on every run.
    v_flagged := v_exc.post_settlement_report_at is not null;
    update public.payment_exceptions
       set post_settlement_report_at = now(),
           alert_sent_at = case when v_flagged then alert_sent_at else null end,
           last_signal = p_signal, detail = coalesce(p_detail, detail),
           report_count = report_count + 1, last_reported_at = now()
     where id = v_exc.id
    returning * into v_exc;
    if not v_flagged then
      v_outcome := 'flagged';
      v_event   := 'payment.exception_reported_after_settlement';
    end if;

  else
    v_new := v_exc.payment_received;
    if v_money is not null and v_exc.state <> 'resolved'
       and (v_rank ->> v_money)::int > (v_rank ->> v_exc.payment_received)::int then
      v_new := v_money;
      v_outcome := 'evidence_raised';
      v_event   := 'payment.exception_evidence_raised';
    end if;
    if v_exc.state = 'watching' and v_state = 'open' then
      v_outcome := 'opened';
      v_event   := 'payment.exception_recorded';
    end if;
    update public.payment_exceptions
       set state = case when state = 'watching' and v_state = 'open' then 'open' else state end,
           payment_received = v_new,
           alert_sent_at = case when v_outcome in ('evidence_raised', 'opened') then null else alert_sent_at end,
           -- A notification during an operator's confirmation must survive a withdrawal.
           evidence_before_confirmation = case
             when payment_received = 'confirmed_by_operator' and v_money = 'reported' then 'reported'
             else evidence_before_confirmation end,
           -- An unproven report never displaces what is already known.
           last_signal = case when p_signal = 'unverified_report' then last_signal else p_signal end,
           detail = case when p_signal = 'unverified_report' then detail else coalesce(p_detail, detail) end,
           report_count = report_count + 1, last_reported_at = now()
     where id = v_exc.id
    returning * into v_exc;
  end if;

  -- A replay writes no audit row, so retries cannot flood the log.
  if v_event is not null then
    perform public.payment_exception_audit(
      v_event, 'system', null, null, v_pay.user_id, p_source, null, null, null,
      jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
                         'signal', p_signal, 'detail', p_detail, 'state', v_exc.state,
                         'paymentReceived', v_exc.payment_received, 'paymentStatus', v_pay.status));
  end if;

  return jsonb_build_object(
    'outcome',         v_outcome,
    'exceptionId',     v_exc.id,
    'state',           v_exc.state,
    'paymentReceived', v_exc.payment_received,
    'reportCount',     v_exc.report_count,
    'needsAlert',      (v_exc.state = 'open' or v_exc.post_settlement_report_at is not null) and v_exc.alert_sent_at is null
  );
end
$fn$;

comment on function public.payment_exception_report(uuid, text, text, text) is
  'XP-PAYTECH-05. Record a signal about a payment. Idempotent per payment. Moves no payment, grants nothing. A replay only counts.';


-- ── decide: an administrator's decision ──
create function public.payment_exception_decide(
  p_exception_id uuid,
  p_action       text,
  p_actor_id     uuid,
  p_actor_email  text,
  p_note         text,
  p_ip           text default null,
  p_user_agent   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_payment_id uuid;
  v_pay   public.payments%rowtype;
  v_exc   public.payment_exceptions%rowtype;
  v_ent   uuid;
  v_event text;
  v_confirmed boolean;
begin
  if p_action is null or p_action not in ('confirm_received', 'withdraw_receipt', 'dismiss', 'require_refund',
                                          'withdraw_refund', 'record_access', 'acknowledge_report') then
    perform public.payment_exception_refuse('invalid_action');
  end if;
  if p_actor_id is null then
    perform public.payment_exception_refuse('actor_required');
  end if;
  if p_note is null or length(trim(p_note)) not between 10 and 500 then
    perform public.payment_exception_refuse('note_required');
  end if;

  select e.payment_id into v_payment_id from public.payment_exceptions e where e.id = p_exception_id;
  if v_payment_id is null then
    perform public.payment_exception_refuse('exception_not_found');
  end if;
  select * into v_pay from public.payments where id = v_payment_id for update;
  select * into v_exc from public.payment_exceptions where id = p_exception_id for update;

  -- The one decision a settled record can take. It changes no settled fact.
  if p_action = 'acknowledge_report' then
    if v_exc.post_settlement_report_at is null then
      perform public.payment_exception_refuse('no_report_to_review');
    end if;
  elsif v_exc.state <> 'open' then
    perform public.payment_exception_refuse('exception_not_open');
  end if;
  v_confirmed := v_exc.payment_received in ('confirmed_by_operator', 'confirmed_by_provider');

  case p_action
    when 'acknowledge_report' then
      update public.payment_exceptions set post_settlement_report_at = null where id = v_exc.id;
      v_event := 'payment.exception_settlement_report_reviewed';

    when 'confirm_received' then
      if v_confirmed then
        perform public.payment_exception_refuse('receipt_already_confirmed');
      end if;
      update public.payment_exceptions
         set payment_received = 'confirmed_by_operator', evidence_before_confirmation = payment_received
       where id = v_exc.id;
      v_event := 'payment.exception_receipt_confirmed';

    -- An administrator's correction of their own statement. What PayTech confirmed
    -- cannot be withdrawn, and neither can a confirmation a refund decision rests on.
    when 'withdraw_receipt' then
      if v_exc.payment_received <> 'confirmed_by_operator' then
        perform public.payment_exception_refuse('receipt_not_operator_confirmed');
      end if;
      if v_exc.refund_state <> 'not_assessed' then
        perform public.payment_exception_refuse('refund_already_decided');
      end if;
      update public.payment_exceptions
         set payment_received = coalesce(evidence_before_confirmation, 'reported'), evidence_before_confirmation = null
       where id = v_exc.id;
      v_event := 'payment.exception_receipt_withdrawn';

    when 'dismiss' then
      if v_exc.refund_state <> 'not_assessed' then
        perform public.payment_exception_refuse('refund_already_decided');
      end if;
      -- A completed payment is legitimately held, so reviewing it and finding
      -- nothing wrong says nothing against it. Anywhere else, money that was
      -- confirmed received cannot be waved away. Only a CLOSED payment can be
      -- recorded as not received: an in-flight one may still settle.
      if v_pay.status <> 'completed' and v_confirmed then
        perform public.payment_exception_refuse('payment_confirmed_cannot_dismiss');
      end if;
      update public.payment_exceptions
         set state = 'resolved', resolution = 'nothing_to_return', resolved_at = now(), resolved_by = p_actor_id,
             refund_state = 'not_required',
             payment_received = case when v_pay.status in ('completed', 'pending', 'processing') then payment_received
                                     else 'not_received' end
       where id = v_exc.id;
      v_event := 'payment.exception_dismissed';

    when 'require_refund' then
      if not v_confirmed then
        perform public.payment_exception_refuse('receipt_not_confirmed');
      end if;
      if v_exc.refund_state <> 'not_assessed' then
        perform public.payment_exception_refuse('refund_already_decided');
      end if;
      update public.payment_exceptions set refund_state = 'required' where id = v_exc.id;
      v_event := 'payment.exception_refund_required';

    -- A mistaken decision must not block a learner's checkout for good.
    when 'withdraw_refund' then
      if v_exc.refund_state <> 'required' then
        perform public.payment_exception_refuse('refund_not_required');
      end if;
      update public.payment_exceptions set refund_state = 'not_assessed' where id = v_exc.id;
      v_event := 'payment.exception_refund_withdrawn';

    when 'record_access' then
      if not v_confirmed then
        perform public.payment_exception_refuse('receipt_not_confirmed');
      end if;
      if v_exc.refund_state <> 'not_assessed' then
        perform public.payment_exception_refuse('refund_already_decided');
      end if;
      -- Records an access decision. It grants nothing: an entitlement must
      -- already exist, created through Admin > Accès under its own audit.
      select en.id into v_ent from public.entitlements en
       where en.user_id = v_pay.user_id and en.course_id = v_pay.course_id
         and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
       order by en.created_at desc limit 1;
      if v_ent is null then
        perform public.payment_exception_refuse('no_live_entitlement');
      end if;
      update public.payment_exceptions
         set state = 'resolved', resolution = 'access_honoured', resolved_at = now(), resolved_by = p_actor_id,
             access_state = 'granted', access_entitlement_id = v_ent, refund_state = 'not_required'
       where id = v_exc.id;
      v_event := 'payment.exception_access_recorded';
  end case;

  select * into v_exc from public.payment_exceptions where id = p_exception_id;

  perform public.payment_exception_audit(
    v_event, 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel', trim(p_note), p_ip, p_user_agent,
    jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
                       'action', p_action, 'state', v_exc.state, 'paymentReceived', v_exc.payment_received,
                       'refundState', v_exc.refund_state, 'accessState', v_exc.access_state));

  return jsonb_build_object('outcome', p_action, 'exceptionId', v_exc.id, 'state', v_exc.state,
                            'paymentReceived', v_exc.payment_received, 'refundState', v_exc.refund_state,
                            'accessState', v_exc.access_state);
end
$fn$;

comment on function public.payment_exception_decide(uuid, text, uuid, text, text, text, text) is
  'XP-PAYTECH-05. An administrator''s decision on an open exception. Never completes a payment and never writes an entitlement. Every decision is audited in the same transaction.';


-- ── record_refund: a full refund already confirmed outside this system ──
create function public.payment_exception_record_refund(
  p_exception_id       uuid,
  p_actor_id           uuid,
  p_actor_email        text,
  p_external_reference text,
  p_amount             numeric,
  p_currency           text,
  p_refunded_at        timestamptz,
  p_note               text,
  p_ip                 text default null,
  p_user_agent         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_payment_id uuid;
  v_ref   text := trim(coalesce(p_external_reference, ''));
  v_pay   public.payments%rowtype;
  v_exc   public.payment_exceptions%rowtype;
  v_live  boolean;
  v_moved text;
begin
  if p_actor_id is null then
    perform public.payment_exception_refuse('actor_required');
  end if;
  if p_note is null or length(trim(p_note)) not between 10 and 500 then
    perform public.payment_exception_refuse('note_required');
  end if;
  if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{2,119}$' then
    perform public.payment_exception_refuse('refund_reference_invalid');
  end if;

  select e.payment_id into v_payment_id from public.payment_exceptions e where e.id = p_exception_id;
  if v_payment_id is null then
    perform public.payment_exception_refuse('exception_not_found');
  end if;
  select * into v_pay from public.payments where id = v_payment_id for update;
  select * into v_exc from public.payment_exceptions where id = p_exception_id for update;

  -- The same refund recorded twice is not a second refund.
  if v_exc.refund_state = 'confirmed' then
    if v_exc.refund_external_reference = v_ref then
      return jsonb_build_object('outcome', 'already_recorded', 'exceptionId', v_exc.id, 'state', v_exc.state,
                                'refundState', v_exc.refund_state);
    end if;
    perform public.payment_exception_refuse('refund_already_recorded');
  end if;

  if v_exc.state <> 'open' then
    perform public.payment_exception_refuse('exception_not_open');
  end if;
  if v_exc.refund_state <> 'required' then
    perform public.payment_exception_refuse('refund_not_required');
  end if;

  if p_currency is distinct from v_pay.currency then
    perform public.payment_exception_refuse('refund_currency_mismatch');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_pay.amount then
    perform public.payment_exception_refuse('refund_amount_invalid');
  end if;
  -- Recording a partial refund as settled would close a record while money is
  -- still owed. Refused until the owner decides a policy for it.
  if p_amount < v_pay.amount then
    perform public.payment_exception_refuse('refund_partial_not_supported');
  end if;
  if p_refunded_at is null or p_refunded_at > now() + interval '5 minutes' or p_refunded_at < v_pay.created_at then
    perform public.payment_exception_refuse('refund_date_invalid');
  end if;

  begin
    update public.payment_exceptions
       set refund_state = 'confirmed', refund_external_reference = v_ref, refund_amount = p_amount,
           refund_currency = p_currency, refund_confirmed_at = p_refunded_at,
           refund_recorded_by = p_actor_id, refund_recorded_at = now(),
           state = 'resolved', resolution = 'refund_confirmed', resolved_at = now(), resolved_by = p_actor_id
     where id = v_exc.id;
  exception when unique_violation then
    perform public.payment_exception_refuse('refund_reference_reused');
  end;

  -- Only the moves 063 permits. A closed payment stays exactly as it is.
  if v_pay.status in ('pending', 'processing') then
    update public.payments set status = 'failed', failure_reason = 'exception_refund_confirmed' where id = v_pay.id;
    v_moved := 'failed';
  elsif v_pay.status = 'completed' then
    update public.payments set status = 'refunded' where id = v_pay.id;
    v_moved := 'refunded';
  end if;

  select exists (
    select 1 from public.entitlements en
     where en.user_id = v_pay.user_id and en.course_id = v_pay.course_id
       and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
  ) into v_live;

  perform public.payment_exception_audit(
    'payment.exception_refund_confirmed', 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel',
    trim(p_note), p_ip, p_user_agent,
    jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
                       'refundReference', v_ref, 'refundAmount', p_amount, 'refundCurrency', p_currency,
                       'refundedAt', p_refunded_at, 'paymentStatusBefore', v_pay.status,
                       'paymentStatusAfter', coalesce(v_moved, v_pay.status), 'accessStillLive', v_live));

  return jsonb_build_object('outcome', 'recorded', 'exceptionId', v_exc.id, 'state', 'resolved',
                            'refundState', 'confirmed', 'accessStillLive', v_live,
                            'paymentStatus', coalesce(v_moved, v_pay.status));
end
$fn$;

comment on function public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text) is
  'XP-PAYTECH-05. Record a full refund confirmed outside this system. Issues nothing and changes no access. Moves the payment only where 063 permits it.';


-- ── mark_alerted: every recipient accepted the alert ──
create function public.payment_exception_mark_alerted(p_exception_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  update public.payment_exceptions
     set alert_sent_at = now()
   where id = p_exception_id and alert_sent_at is null
     and (state = 'open' or post_settlement_report_at is not null);
  return found;
end
$fn$;

comment on function public.payment_exception_mark_alerted(uuid) is
  'XP-PAYTECH-05. Stamp an exception as alerted. The only thing it can change is alert_sent_at.';


-- ── escalate_watching: a report on an in-flight payment must not sit unseen ──
create function public.payment_exception_escalate_watching(p_older_than_hours integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_row record;
  v_n   integer := 0;
begin
  if p_older_than_hours is null or p_older_than_hours < 0 then
    perform public.payment_exception_refuse('invalid_age');
  end if;

  for v_row in
    select e.id, e.payment_id
      from public.payment_exceptions e
     where e.state = 'watching'
       and e.first_reported_at <= now() - make_interval(hours => p_older_than_hours)
     order by e.first_reported_at
     limit 100
  loop
    -- The lock order every other path uses.
    perform 1 from public.payments p where p.id = v_row.payment_id for update;
    update public.payment_exceptions
       set state = 'open', escalated_at = now(), alert_sent_at = null
     where id = v_row.id and state = 'watching';
    if found then
      v_n := v_n + 1;
      perform public.payment_exception_audit(
        'payment.exception_escalated', 'system', null, null,
        (select p.user_id from public.payments p where p.id = v_row.payment_id), 'sweep', null, null, null,
        jsonb_build_object('paymentId', v_row.payment_id, 'exceptionId', v_row.id,
                           'reference', (select p.reference from public.payments p where p.id = v_row.payment_id)));
    end if;
  end loop;
  return v_n;
end
$fn$;

comment on function public.payment_exception_escalate_watching(integer) is
  'XP-PAYTECH-05. Open watching exceptions older than the given age, so an unresolved report reaches an administrator. Moves no payment.';


-- ── blocking reference: checkout must not take money twice ──
create function public.payment_exception_blocking_reference(p_user_id uuid, p_course_id uuid)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
  select p.reference
    from public.payment_exceptions e
    join public.payments p on p.id = e.payment_id
   where (e.state = 'open' or e.post_settlement_report_at is not null)
     and p.user_id = p_user_id
     and p.course_id = p_course_id
     and p.status <> 'completed'
   order by e.first_reported_at
   limit 1;
$fn$;

comment on function public.payment_exception_blocking_reference(uuid, uuid) is
  'XP-PAYTECH-05. The reference of an open exception that must stop this learner opening another chargeable attempt for this course, or NULL. Read-only.';


-- ── privileges ──
revoke all on function public.payment_exception_refuse(text) from public, anon, authenticated, service_role;
revoke all on function public.payment_exception_audit(text, text, uuid, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.payment_exceptions_guard() from public, anon, authenticated, service_role;
revoke all on function public.payment_exceptions_follow_payment() from public, anon, authenticated, service_role;
revoke all on function public.payment_exception_report(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.payment_exception_decide(uuid, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.payment_exception_mark_alerted(uuid) from public, anon, authenticated;
revoke all on function public.payment_exception_escalate_watching(integer) from public, anon, authenticated;
revoke all on function public.payment_exception_blocking_reference(uuid, uuid) from public, anon, authenticated;

grant execute on function public.payment_exception_report(uuid, text, text, text) to service_role;
grant execute on function public.payment_exception_decide(uuid, text, uuid, text, text, text, text) to service_role;
grant execute on function public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text) to service_role;
grant execute on function public.payment_exception_mark_alerted(uuid) to service_role;
grant execute on function public.payment_exception_escalate_watching(integer) to service_role;
grant execute on function public.payment_exception_blocking_reference(uuid, uuid) to service_role;


-- ══ 6. SELF-TEST — inside this transaction, rolled back, zero net writes ══
do $do$
declare
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
  v_e      uuid;
  v_actor  uuid := gen_random_uuid();
  v_detail text;
  v_mode   text;
  v_n      integer;
  v_r      jsonb;
  v_got    text[] := array[]::text[];
  v_want   constant text[] := array[
    'hint_in_flight:watching',
    'closure_opens:open',
    'replay:2:replayed',
    'refund_too_soon:refund_not_required',
    'refund_decision_too_soon:receipt_not_confirmed',
    'confirm:confirmed_by_operator',
    'withdraw_receipt:reported',
    'confirm_again:confirmed_by_operator',
    'dismiss_confirmed:payment_confirmed_cannot_dismiss',
    'require:required',
    'withdraw_refund:not_assessed',
    'require_again:required',
    'overpaid:refund_amount_invalid',
    'partial:refund_partial_not_supported',
    'refund:resolved',
    'payment_untouched:expired',
    'refund_replay:already_recorded',
    'paid_after_refund:flagged:resolved',
    'paid_again_after_refund:replayed',
    'facts_stay_final:refund_confirmed:confirmed',
    'reviewed:cleared',
    'nothing_more_to_review:no_report_to_review',
    'delete:exception_delete_refused',
    'rewrite:refund_facts_final',
    'hint_then_completion:resolved:settled_normally',
    'hint_on_completed:ignored',
    'dismiss:not_received',
    'pending_cannot_reopen:resolved:replayed',
    'new_evidence:reopened',
    'downgrade:payment_evidence_downgrade',
    'mismatch_dismissed:resolved',
    'hint_reopens_to_watching:watching',
    'then_closed:open',
    'unverified_on_closed:open:not_established',
    'escalated:1:open',
    'escalated_then_completed:resolved:settled_normally'
  ];
begin
  select case e.mode when 'sandbox' then 'test' else 'live' end into v_mode
    from public.payment_environment e where e.singleton;

  begin
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-A', 'paytech', 'test')
    returning id into v_a;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-a', status = 'processing' where id = v_a;

    v_r := public.payment_exception_report(v_a, 'paid_hint', 'ipn');
    v_e := (v_r ->> 'exceptionId')::uuid;
    v_got := v_got || ('hint_in_flight:' || (v_r ->> 'state'));

    update public.payments set status = 'expired', failure_reason = 'selftest' where id = v_a;
    v_got := v_got || ('closure_opens:' || (select state from public.payment_exceptions where id = v_e));

    v_r := public.payment_exception_report(v_a, 'paid_hint', 'ipn');
    v_got := v_got || ('replay:' || (v_r ->> 'reportCount') || ':' || (v_r ->> 'outcome'));

    begin
      perform public.payment_exception_record_refund(v_e, v_actor, null, 'SELFTEST-REF-1', 100, 'XOF', now(), 'selftest note');
      v_got := v_got || 'refund_too_soon:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('refund_too_soon:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      perform public.payment_exception_decide(v_e, 'require_refund', v_actor, null, 'selftest note');
      v_got := v_got || 'refund_decision_too_soon:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('refund_decision_too_soon:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    v_r := public.payment_exception_decide(v_e, 'confirm_received', v_actor, null, 'selftest note');
    v_got := v_got || ('confirm:' || (v_r ->> 'paymentReceived'));
    v_r := public.payment_exception_decide(v_e, 'withdraw_receipt', v_actor, null, 'selftest note');
    v_got := v_got || ('withdraw_receipt:' || (v_r ->> 'paymentReceived'));
    v_r := public.payment_exception_decide(v_e, 'confirm_received', v_actor, null, 'selftest note');
    v_got := v_got || ('confirm_again:' || (v_r ->> 'paymentReceived'));

    begin
      perform public.payment_exception_decide(v_e, 'dismiss', v_actor, null, 'selftest note');
      v_got := v_got || 'dismiss_confirmed:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('dismiss_confirmed:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    v_r := public.payment_exception_decide(v_e, 'require_refund', v_actor, null, 'selftest note');
    v_got := v_got || ('require:' || (v_r ->> 'refundState'));
    v_r := public.payment_exception_decide(v_e, 'withdraw_refund', v_actor, null, 'selftest note');
    v_got := v_got || ('withdraw_refund:' || (v_r ->> 'refundState'));
    v_r := public.payment_exception_decide(v_e, 'require_refund', v_actor, null, 'selftest note');
    v_got := v_got || ('require_again:' || (v_r ->> 'refundState'));

    begin
      perform public.payment_exception_record_refund(v_e, v_actor, null, 'SELFTEST-REF-1', 101, 'XOF', now(), 'selftest note');
      v_got := v_got || 'overpaid:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('overpaid:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      perform public.payment_exception_record_refund(v_e, v_actor, null, 'SELFTEST-REF-1', 50, 'XOF', now(), 'selftest note');
      v_got := v_got || 'partial:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('partial:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    v_r := public.payment_exception_record_refund(v_e, v_actor, null, 'SELFTEST-REF-1', 100, 'XOF', now(), 'selftest note');
    v_got := v_got || ('refund:' || (v_r ->> 'state'));
    v_got := v_got || ('payment_untouched:' || (select status from public.payments where id = v_a));

    v_r := public.payment_exception_record_refund(v_e, v_actor, null, 'SELFTEST-REF-1', 100, 'XOF', now(), 'selftest note');
    v_got := v_got || ('refund_replay:' || (v_r ->> 'outcome'));

    -- a second paid report after the refund: final facts, and a human hears of it
    v_r := public.payment_exception_report(v_a, 'paid_hint', 'ipn');
    v_got := v_got || ('paid_after_refund:' || (v_r ->> 'outcome') || ':' || (v_r ->> 'state'));
    v_r := public.payment_exception_report(v_a, 'paid_hint', 'ipn');
    v_got := v_got || ('paid_again_after_refund:' || (v_r ->> 'outcome'));
    v_got := v_got || ('facts_stay_final:' || (select resolution || ':' || refund_state from public.payment_exceptions where id = v_e));
    perform public.payment_exception_decide(v_e, 'acknowledge_report', v_actor, null, 'selftest note');
    v_got := v_got || ('reviewed:' || (select case when post_settlement_report_at is null then 'cleared' else 'STILL_FLAGGED' end
                                         from public.payment_exceptions where id = v_e));
    begin
      perform public.payment_exception_decide(v_e, 'acknowledge_report', v_actor, null, 'selftest note');
      v_got := v_got || 'nothing_more_to_review:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('nothing_more_to_review:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      delete from public.payment_exceptions where id = v_e;
      v_got := v_got || 'delete:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('delete:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    begin
      update public.payment_exceptions set refund_amount = 1 where id = v_e;
      v_got := v_got || 'rewrite:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('rewrite:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    -- a paid notification, then a normal completion
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-B', 'paytech', v_mode)
    returning id into v_b;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-b', status = 'processing' where id = v_b;
    perform public.payment_exception_report(v_b, 'paid_hint', 'ipn');
    update public.payments set status = 'completed', completed_at = now() where id = v_b;
    v_got := v_got || ('hint_then_completion:' || (select state || ':' || resolution from public.payment_exceptions where payment_id = v_b));

    -- a completed payment with no record: a repeated paid notification is a replay
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-D', 'paytech', v_mode)
    returning id into v_c;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-d', status = 'processing' where id = v_c;
    update public.payments set status = 'completed', completed_at = now() where id = v_c;
    v_r := public.payment_exception_report(v_c, 'paid_hint', 'ipn');
    v_got := v_got || ('hint_on_completed:' || (v_r ->> 'outcome'));

    -- dismissed, then something that is no evidence, then new evidence
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-C', 'paytech', 'test')
    returning id into v_c;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-c', status = 'processing' where id = v_c;
    update public.payments set status = 'cancelled', failure_reason = 'selftest' where id = v_c;
    v_r := public.payment_exception_report(v_c, 'paid_hint', 'ipn');
    v_e := (v_r ->> 'exceptionId')::uuid;
    v_r := public.payment_exception_decide(v_e, 'dismiss', v_actor, null, 'selftest note');
    v_got := v_got || ('dismiss:' || (v_r ->> 'paymentReceived'));
    v_r := public.payment_exception_report(v_c, 'provider_pending', 'sweep');
    v_got := v_got || ('pending_cannot_reopen:' || (v_r ->> 'state') || ':' || (v_r ->> 'outcome'));
    v_r := public.payment_exception_report(v_c, 'provider_paid', 'sweep');
    v_got := v_got || ('new_evidence:' || (v_r ->> 'outcome'));

    begin
      update public.payment_exceptions set payment_received = 'reported' where id = v_e;
      v_got := v_got || 'downgrade:ALLOWED'::text;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_got := v_got || ('downgrade:' || coalesce(v_detail::jsonb ->> 'reason', '?'));
    end;

    -- a mismatch cleared on an in-flight payment must not hide a later paid report
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-E', 'paytech', 'test')
    returning id into v_c;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-e', status = 'processing' where id = v_c;
    v_r := public.payment_exception_report(v_c, 'amount_mismatch', 'ipn', 'ipn_amount_mismatch');
    v_e := (v_r ->> 'exceptionId')::uuid;
    v_r := public.payment_exception_decide(v_e, 'dismiss', v_actor, null, 'selftest note');
    v_got := v_got || ('mismatch_dismissed:' || (v_r ->> 'state'));
    v_r := public.payment_exception_report(v_c, 'paid_hint', 'ipn');
    v_got := v_got || ('hint_reopens_to_watching:' || (v_r ->> 'state'));
    update public.payments set status = 'expired', failure_reason = 'selftest' where id = v_c;
    v_got := v_got || ('then_closed:' || (select state from public.payment_exceptions where id = v_e));

    -- right credentials, bad signature, on a closed payment
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-F', 'paytech', 'test')
    returning id into v_c;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-f', status = 'processing' where id = v_c;
    update public.payments set status = 'expired', failure_reason = 'selftest' where id = v_c;
    v_r := public.payment_exception_report(v_c, 'unverified_report', 'ipn', 'ipn_signature_mismatch');
    v_got := v_got || ('unverified_on_closed:' || (v_r ->> 'state') || ':' || (v_r ->> 'paymentReceived'));

    -- a report that sits too long is escalated, and still settles normally
    insert into public.payments (amount, currency, method, status, reference, provider, provider_mode)
    values (100, 'XOF', 'card', 'pending', 'XP-PAYTECH-05-064-SELFTEST-G', 'paytech', v_mode)
    returning id into v_c;
    update public.payments set provider_token = 'xp-paytech-05-064-selftest-g', status = 'processing' where id = v_c;
    perform public.payment_exception_report(v_c, 'paid_hint', 'ipn');
    v_n := public.payment_exception_escalate_watching(0);
    v_got := v_got || ('escalated:' || v_n || ':' || (select state from public.payment_exceptions where payment_id = v_c));
    update public.payments set status = 'completed', completed_at = now() where id = v_c;
    v_got := v_got || ('escalated_then_completed:' || (select state || ':' || resolution from public.payment_exceptions where payment_id = v_c));

    -- Roll back every write above; keep only the verdicts.
    raise exception 'xp-paytech-05-064-selftest-complete' using errcode = 'XPT64';
  exception when sqlstate 'XPT64' then
    null;
  end;

  if v_got is distinct from v_want then
    raise exception 'XP-PAYTECH-05 064 self-test: the workflow does not behave as specified. Expected % got %', v_want, v_got;
  end if;
  if exists (select 1 from public.payments where reference like 'XP-PAYTECH-05-064-SELFTEST-%')
  or exists (select 1 from public.payment_exceptions) then
    raise exception 'XP-PAYTECH-05 064 self-test: a scratch row survived';
  end if;
end
$do$;


-- ══ 7. THE RESULTING OBJECTS ══════════════════════════════════════════════
do $do$
declare
  v_txt  text;
  v_fn   text;
  v_role text;
begin
  -- browsers hold nothing on the table; RLS is on with no policy
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_role, 'public.payment_exceptions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'XP-PAYTECH-05 064: % holds a privilege on payment_exceptions', v_role;
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.payment_exceptions'::regclass) then
    raise exception 'XP-PAYTECH-05 064: row level security is not enabled on payment_exceptions';
  end if;
  if exists (select 1 from pg_policy p where p.polrelid = 'public.payment_exceptions'::regclass) then
    raise exception 'XP-PAYTECH-05 064: payment_exceptions must have no policy';
  end if;

  -- the application can read and nothing else, at table or column level
  if not has_table_privilege('service_role', 'public.payment_exceptions', 'SELECT') then
    raise exception 'XP-PAYTECH-05 064: service_role cannot read payment_exceptions';
  end if;
  if has_table_privilege('service_role', 'public.payment_exceptions', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')
  or has_any_column_privilege('service_role', 'public.payment_exceptions', 'INSERT, UPDATE, REFERENCES') then
    raise exception 'XP-PAYTECH-05 064: service_role can write to payment_exceptions directly';
  end if;

  -- every function: a pinned search_path, not callable by browser roles
  foreach v_fn in array array[
    'public.payment_exception_refuse(text)',
    'public.payment_exception_audit(text, text, uuid, text, uuid, text, text, text, text, jsonb)',
    'public.payment_exceptions_guard()',
    'public.payment_exceptions_follow_payment()',
    'public.payment_exception_report(uuid, text, text, text)',
    'public.payment_exception_decide(uuid, text, uuid, text, text, text, text)',
    'public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text)',
    'public.payment_exception_mark_alerted(uuid)',
    'public.payment_exception_escalate_watching(integer)',
    'public.payment_exception_blocking_reference(uuid, uuid)'
  ] loop
    select array_to_string(p.proconfig, ',') into v_txt from pg_proc p where p.oid = to_regprocedure(v_fn);
    if v_txt is distinct from 'search_path=pg_catalog, pg_temp' then
      raise exception 'XP-PAYTECH-05 064: % search_path is [%]', v_fn, v_txt;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'XP-PAYTECH-05 064: % can EXECUTE %', v_role, v_fn;
      end if;
    end loop;
  end loop;

  -- the helpers cannot be reached directly, so an audit row cannot be forged here
  foreach v_fn in array array[
    'public.payment_exception_refuse(text)',
    'public.payment_exception_audit(text, text, uuid, text, uuid, text, text, text, text, jsonb)',
    'public.payment_exceptions_guard()',
    'public.payment_exceptions_follow_payment()'
  ] loop
    if has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'XP-PAYTECH-05 064: service_role can EXECUTE %', v_fn;
    end if;
  end loop;

  -- both triggers, enabled
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.payment_exceptions'::regclass and t.tgname = 'payment_exceptions_guard'
         and not t.tgisinternal and t.tgenabled = 'O') <> 1 then
    raise exception 'XP-PAYTECH-05 064: payment_exceptions_guard is not installed';
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.payments'::regclass and t.tgname = 'payment_exceptions_follow_payment'
         and not t.tgisinternal and t.tgenabled = 'O') <> 1 then
    raise exception 'XP-PAYTECH-05 064: payment_exceptions_follow_payment is not installed';
  end if;
end
$do$;


-- ══ 8. NOTHING ELSE CHANGED ═══════════════════════════════════════════════
do $do$
declare b xp_paytech_05_064_before%rowtype;
begin
  select * into b from xp_paytech_05_064_before;

  if (select count(*) from public.payments) <> b.n_payments then
    raise exception 'XP-PAYTECH-05 064: the payment count changed';
  end if;
  if (select coalesce(md5(string_agg(p.id::text || '|' || p.status || '|' || coalesce(p.provider_token, '')
                                     || '|' || coalesce(p.completed_at::text, ''), E'\n' order by p.id)), '')
        from public.payments p) is distinct from b.payments_md5 then
    raise exception 'XP-PAYTECH-05 064: payment data changed';
  end if;
  if (select count(*) from public.entitlements) <> b.n_entitlements then
    raise exception 'XP-PAYTECH-05 064: the entitlement count changed';
  end if;
  if (select count(*) from public.enrollments) <> b.n_enrollments then
    raise exception 'XP-PAYTECH-05 064: the enrollment count changed';
  end if;
  if (select count(*) from public.audit_log) <> b.n_audit then
    raise exception 'XP-PAYTECH-05 064: the audit record count changed';
  end if;
  if md5(pg_get_functiondef(to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')))
     is distinct from b.complete_payment_md5 then
    raise exception 'XP-PAYTECH-05 064: complete_payment''s definition changed';
  end if;
  if (select coalesce(array_to_string(p.proacl, ','), '') from pg_proc p
       where p.oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)'))
     is distinct from b.complete_payment_acl then
    raise exception 'XP-PAYTECH-05 064: complete_payment''s privileges changed';
  end if;
  if md5(pg_get_functiondef(to_regprocedure('public.payments_transition_guard()'))) is distinct from b.guard_md5 then
    raise exception 'XP-PAYTECH-05 064: 063''s guard changed';
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Prerequisite: migrations through 063. This migration refuses otherwise.
-- 2. Order against deployment: apply this BEFORE the application code that calls
--    it takes real payments. The code fails closed without it: checkout refuses,
--    and the IPN answers 503 rather than losing a report.
-- 3. It changes no row. It adds an AFTER trigger on public.payments, so it takes a
--    brief lock on that table. Prefer an off-peak window.
-- 4. Paste the WHOLE file into the Supabase SQL editor and run it once, as the
--    role that owns public.payments. The write functions run as that role.
--    "Success. No rows returned." means every assertion passed; any failure
--    raises and rolls back everything, including the self-test.
-- 5. Immediately afterwards, READ-ONLY:
--        select tgname, tgenabled from pg_trigger
--         where tgrelid = 'public.payments'::regclass and not tgisinternal order by 1;
--          → payment_exceptions_follow_payment | O
--          → payments_transition_guard         | O
--        select count(*) from public.payment_exceptions;
--          → 0
--        select status, count(*) from public.payments group by 1 order by 1;
--          → identical to the counts captured before the run
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes the workflow. Changes no payment row.
-- Run it WHOLE, and roll back 064 BEFORE 063: 063's own rollback would leave this
-- migration's trigger behind, and 063 then refuses to re-apply beside it.
--
-- It refuses while any exception is watching, open or flagged after settlement,
-- because dropping the table would destroy the record of money that may be owed.
-- Settle those first. Dropping
-- also destroys RESOLVED records, including refund facts. EXPORT THEM FIRST:
--     select * from public.payment_exceptions order by created_at;
-- Each decision stays in audit_log, but the export is the only copy of the record.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- lock table public.payments, public.payment_exceptions in share row exclusive mode;
--
-- do $rb$
-- begin
--   if exists (select 1 from public.payment_exceptions
--               where state <> 'resolved' or post_settlement_report_at is not null) then
--     raise exception 'XP-PAYTECH-05 064 rollback: unsettled exceptions exist; settle them first';
--   end if;
-- end
-- $rb$;
--
-- drop trigger if exists payment_exceptions_follow_payment on public.payments;
-- drop function if exists public.payment_exceptions_follow_payment();
-- drop function if exists public.payment_exception_blocking_reference(uuid, uuid);
-- drop function if exists public.payment_exception_escalate_watching(integer);
-- drop function if exists public.payment_exception_mark_alerted(uuid);
-- drop function if exists public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text);
-- drop function if exists public.payment_exception_decide(uuid, text, uuid, text, text, text, text);
-- drop function if exists public.payment_exception_report(uuid, text, text, text);
-- drop table if exists public.payment_exceptions;
-- drop function if exists public.payment_exceptions_guard();
-- drop function if exists public.payment_exception_audit(text, text, uuid, text, uuid, text, text, text, text, jsonb);
-- drop function if exists public.payment_exception_refuse(text);
--
-- do $rb$
-- begin
--   if to_regclass('public.payment_exceptions') is not null then
--     raise exception 'XP-PAYTECH-05 064 rollback: payment_exceptions survived';
--   end if;
--   if exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass
--                and tgname = 'payment_exceptions_follow_payment') then
--     raise exception 'XP-PAYTECH-05 064 rollback: the trigger survived';
--   end if;
-- end
-- $rb$;
--
-- commit;
--
-- After a rollback the application fails closed: checkout refuses and the IPN
-- answers 503. Roll the application back first if payments must keep flowing.
