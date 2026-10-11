-- ============================================================================
-- Migration 062 — PAY-2C: the atomic payment completion authority.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- Creates ONE function and sets its privileges. Writes NO payment, entitlement,
-- enrollment or audit row of its own.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT THIS FUNCTION IS, AND WHAT IT IS NOT ──────────────────────────────
--
-- public.complete_payment() is a PRIVILEGED PERSISTENCE OPERATION. It makes the
-- consequences of a confirmed payment atomic and non-replayable. It is NOT a
-- PayDunya verification mechanism and cannot be one.
--
-- Every argument is caller-supplied. Passing a token and an amount to SQL is an
-- assertion, not evidence. PayDunya's IPN carries a `hash` that is SHA-512 of
-- the MASTER KEY — a constant, not a signature over the payload — so a replayed
-- or forged notification satisfies that check. A browser redirect is worth even
-- less. The ONLY thing that establishes that money moved is a server-to-server
-- confirm the trusted caller performs ITSELF, against PayDunya's API, over a
-- channel the learner cannot influence.
--
-- What this function therefore proves, and all it proves:
--
--   * exactly one payment row carries this provider token;
--   * the amount, currency, reference, provider and provider mode the caller
--     verified AGREE with that stored row;
--   * the learner and course are coherent and non-NULL;
--   * the state transition is legal;
--   * exactly ONE live entitlement results — or none, and nothing is written;
--   * all four writes land together or not at all.
--
-- ── THE TRUST BOUNDARY ─────────────────────────────────────────────────────
--
-- SECURITY INVOKER, EXECUTE to service_role only. Not DEFINER, deliberately:
-- service_role already has BYPASSRLS and every privilege the body needs, so
-- DEFINER would add no capability and would only create an escalation
-- primitive. INVOKER also means a mis-grant FAILS CLOSED at every write —
-- 058 withdrew all browser writes on payments, 037 grants browsers nothing on
-- entitlements, and 061 left audit_log with no browser write at either layer.
-- Three independent refusals, none of which depends on this function's EXECUTE
-- list being correct.
--
-- The residual risk is stated rather than hidden: service_role is reachable
-- from ~89 call sites across 63 files, 17 of which contain no admin gate. Any
-- of them could call this function. That is tolerable only because service_role
-- can ALREADY insert an ACTIVE INDIVIDUAL_PURCHASE entitlement directly — this
-- function confers no capability a service-key holder lacks. It exists to make
-- the four writes atomic, not to hold a privilege nobody else has. The guard
-- against ACCIDENTAL internal misuse is that completing a payment requires a
-- valid provider_token, a column 059 withholds from every browser role and of
-- which production holds zero; that does not happen by accident.
--
-- ── WHY REFUSALS RAISE RATHER THAN RETURN ──────────────────────────────────
--
-- Every refusal raises, with a machine-readable `reason` in the exception
-- DETAIL as JSON. Nothing is persisted on any failure path — which is what
-- "the entire transaction must roll back" requires, and what makes "a completed
-- payment without entitlement delivery" structurally impossible rather than
-- merely unlikely.
--
-- That DETAIL is the structured error a reconciliation workflow consumes. The
-- caller holds service_role and can record its own forensics (failure_reason,
-- last_ipn_at) outside this function; keeping those writes out of here is what
-- lets the function be all-or-nothing.
--
-- The ONE non-raising non-happy path is idempotency: a second call for an
-- already-completed payment returns `already_completed` and writes nothing.
-- That is a success, not an error — it is the contract a provider that retries
-- notifications requires.
--
-- ── THE CONTRACT THE PAYDUNYA INTEGRATION MUST SATISFY ─────────────────────
--
-- This function is only half of a correct completion. The trusted caller owes
-- all eight of the following. None of them can be enforced from inside the
-- database, which is why they are written down here rather than assumed.
--
--   1. CONFIRM SERVER-TO-SERVER. Before calling, the caller must itself GET
--      PayDunya's confirm endpoint for the invoice token and read the status
--      from that RESPONSE. It must never call this function on the strength of
--      an IPN body, a redirect query string, or any value a browser supplied.
--   2. NEVER TREAT THE IPN HASH AS A SIGNATURE. PayDunya's `hash` is SHA-512
--      of the MASTER KEY — a constant. It proves the sender knows a shared
--      secret, not that this payload is authentic or fresh. Use the IPN only
--      as a hint that a confirm is worth performing.
--   3. PASS WHAT IT VERIFIED, NOT WHAT IT WAS SENT. p_amount, p_currency,
--      p_reference, p_provider and p_provider_mode must come from the confirm
--      response. This function compares them against the stored row; passing
--      the row's own values back would make that comparison vacuous.
--   4. CALL ONLY FOR A CONFIRMED-COMPLETE INVOICE. A pending or cancelled
--      provider status must not reach this function at all.
--   5. ONE CHOKEPOINT. Exactly one module may call this RPC, and a repo-wide
--      test must assert that — the technique PAY-2C-0 proved works for payment
--      writers. Every other module reaches completion through that module.
--   6. OWN THE FORENSICS. This function persists nothing on a refusal. The
--      caller records last_ipn_at on every notification and failure_reason on
--      every refusal, reading the `reason` from the exception DETAIL.
--   7. TREAT EVERY REFUSAL AS A RECONCILIATION EVENT, never as a retry signal
--      on its own. `entitlement_conflict`,
--      `entitlement_revoked_requires_decision` and every *_mismatch need a
--      human; only `entitlement_race` is safely retryable.
--   8. BE IDEMPOTENT ITSELF. Providers retry. `already_completed` is a SUCCESS
--      and must be reported to PayDunya as acknowledged, or it will keep
--      redelivering.
--
-- ── LOCK ORDER — DO NOT REORDER THESE STATEMENTS ───────────────────────────
--
-- The function acquires row locks in one fixed order:
--
--      payments  ->  entitlements  ->  enrollments  ->  audit_log
--
-- A deadlock needs two transactions taking the same two locks in OPPOSITE
-- orders. Two concurrent calls to this function cannot, because the order is
-- fixed. Nor can it deadlock against the other writers in this codebase:
-- grantEntitlement() takes entitlements -> enrollments -> audit_log, the
-- entitlement transitions take entitlements alone, and ensureAcademicEnrollment
-- reads entitlements with a plain SELECT (no row lock) before touching
-- enrollments. Every one of them is a prefix or a sub-order of the chain above.
--
-- So reordering the statements below — in particular taking the enrollment
-- before the entitlement — would introduce the cycle that does not currently
-- exist. If a future slice adds a writer, it must take these tables in this
-- order or not take more than one of them.
--
-- The enrollment lookup deliberately has NO `for update`: the insert that
-- follows is an untargeted `on conflict do nothing`, so two transactions that
-- both see no enrollment both attempt the insert and the loser simply does
-- nothing. A lock there would add blocking without changing the outcome.
--
-- ── ACCESS IS JUDGED BY THE PLATFORM'S OWN DEFINITION ──────────────────────
--
-- After granting, the function asserts the resulting entitlement is accessible
-- using public.entitlement_accessible() — migration 037's single definition of
-- "this entitlement currently grants access" — rather than re-implementing it.
-- That one call also collapses three edge cases into one rule: a PENDING
-- entitlement, a SUSPENDED one, and an ACTIVE one whose window has not opened
-- or has already closed are all simply NOT ACCESSIBLE, and none of them may be
-- treated as delivery.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO PayDunya API call, client, credential, webhook or IPN handler.
--   * NO refund and NO expiry automation. 062 owns exactly one transition,
--     pending|processing -> completed. failed, refunded, cancelled and expired
--     are reserved for the reconciliation and refund slices.
--   * NO schema change. Not one column, index, constraint or policy.
--   * NO second completion authority: section 0 refuses if any routine whose
--     name matches %complete%payment% already exists.
--   * NO row written by the migration itself. Section 4 proves it.
--   * NO change to 058's, 059's, 060's, 061's or 037's privilege contracts.
--     Section 3 asserts each of them is exactly as it was found.
-- ============================================================================

begin isolation level repeatable read;

-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $do$
declare
  v_txt   text;
  v_cols  text;
  v_role  text;
  v_priv  text;
  v_n     integer;
  v_allow constant text[] := array['id', 'course_id', 'reference', 'amount', 'currency', 'status'];
  v_col   text;
begin
  -- ── the tables and routines this function reads and writes ────────────
  foreach v_txt in array array['public.payments', 'public.entitlements',
                               'public.enrollments', 'public.audit_log',
                               'public.courses'] loop
    if to_regclass(v_txt) is null then
      raise exception 'PAY-2C 062 preflight: % does not exist', v_txt;
    end if;
  end loop;
  if to_regprocedure('public.entitlement_accessible(text,timestamptz,timestamptz,timestamptz)') is null then
    raise exception 'PAY-2C 062 preflight: public.entitlement_accessible(...) is missing; 037 is not in effect and this function delegates its access definition to it';
  end if;

  -- ── NO SECOND COMPLETION AUTHORITY ────────────────────────────────────
  -- Any signature, any name shape. Re-applying, or applying after a different
  -- completion function landed, must refuse rather than create an overload.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_txt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%complete%payment%';
  if v_txt is not null then
    raise exception 'PAY-2C 062 preflight: a payment-completion routine already exists: %. Refusing to add a second authority or an overload.', v_txt;
  end if;

  -- ── 060's PAYMENT CONTRACT ────────────────────────────────────────────
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,failure_reason,id,last_ipn_at,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-2C 062 preflight: public.payments has columns [%]; expected the nineteen 060 produced', v_cols;
  end if;
  select pg_get_constraintdef(oid) into v_txt from pg_constraint
   where conrelid = 'public.payments'::regclass and conname = 'payments_status_valid';
  if v_txt is null then
    raise exception 'PAY-2C 062 preflight: payments_status_valid is missing; 060 is not in effect';
  end if;
  foreach v_col in array array['pending', 'processing', 'completed', 'failed',
                               'refunded', 'cancelled', 'expired'] loop
    if position('''' || v_col || '''' in v_txt) = 0 then
      raise exception 'PAY-2C 062 preflight: payments_status_valid does not admit ''%''. It reads %', v_col, v_txt;
    end if;
  end loop;
  -- The replay key. Without it one token could be attached to two payment rows
  -- and the lookup below would not identify a single payment.
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.payments_provider_token_unique')
       and i.indrelid = 'public.payments'::regclass
       and i.indisunique and i.indpred is not null and i.indnatts = 1
  ) then
    raise exception 'PAY-2C 062 preflight: payments_provider_token_unique is missing or not a partial unique index; the provider token would not identify exactly one payment';
  end if;
  if to_regclass('public.payments_one_inflight_intent_per_course') is null then
    raise exception 'PAY-2C 062 preflight: 058''s in-flight unique index is missing';
  end if;

  -- ── 037's ENTITLEMENT CONTRACT — the idempotency anchor ───────────────
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.entitlements_one_live_per_course_idx')
       and i.indrelid = 'public.entitlements'::regclass
       and i.indisunique and i.indpred is not null and i.indnatts = 2
  ) then
    raise exception 'PAY-2C 062 preflight: entitlements_one_live_per_course_idx is missing or not a 2-column partial unique index; concurrent completions could create two live entitlements';
  end if;
  select pg_get_expr(i.indpred, i.indrelid) into v_txt
    from pg_index i where i.indexrelid = 'public.entitlements_one_live_per_course_idx'::regclass;
  foreach v_col in array array['PENDING', 'ACTIVE', 'SUSPENDED'] loop
    if position('''' || v_col || '''' in v_txt) = 0 then
      raise exception 'PAY-2C 062 preflight: the live-entitlement predicate does not cover ''%''. It reads %', v_col, v_txt;
    end if;
  end loop;
  select pg_get_constraintdef(oid) into v_txt from pg_constraint
   where conrelid = 'public.entitlements'::regclass
     and conname = 'entitlements_revocation_consistent';
  if v_txt is null then
    raise exception 'PAY-2C 062 preflight: entitlements_revocation_consistent is missing; this function relies on REVOKED and revoked_at travelling together';
  end if;
  -- INDIVIDUAL_PURCHASE must be an accepted source, and must NOT require an
  -- expiry: a purchase is perpetual, so expires_at stays NULL.
  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'public.entitlements'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%INDIVIDUAL_PURCHASE%'
     and pg_get_constraintdef(c.oid) like '%source%';
  if v_txt is null then
    raise exception 'PAY-2C 062 preflight: entitlements.source does not admit INDIVIDUAL_PURCHASE';
  end if;
  select pg_get_constraintdef(oid) into v_txt from pg_constraint
   where conrelid = 'public.entitlements'::regclass and conname = 'entitlements_expiry_required';
  if v_txt is not null and position('INDIVIDUAL_PURCHASE' in v_txt) <> 0 then
    raise exception 'PAY-2C 062 preflight: entitlements_expiry_required now names INDIVIDUAL_PURCHASE, so a perpetual purchase would be rejected. It reads %', v_txt;
  end if;

  -- ── ENROLLMENT UNIQUENESS — discovered, not assumed ───────────────────
  -- The enrollments table is created by NO migration in this repository, so its
  -- index names are not this repository's to assume. The function uses the
  -- UNTARGETED `on conflict do nothing`, which is correct whether the index is
  -- total or partial — but an index must exist, or the enrollment insert is not
  -- idempotent under concurrency at all.
  select count(*) into v_n
    from pg_index i
   where i.indrelid = 'public.enrollments'::regclass and i.indisunique
     and i.indnkeyatts = 2
     and (select array_agg(a.attname::text order by a.attname)
            from unnest(i.indkey) kk(attnum)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = kk.attnum)
         = array['course_id', 'user_id'];
  if v_n = 0 then
    raise exception 'PAY-2C 062 preflight: public.enrollments has NO unique index on (user_id, course_id); the enrollment insert would not be idempotent under concurrency. Resolve before applying.';
  end if;

  -- ── 061's AUDIT PRIVILEGE CONTRACT ────────────────────────────────────
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'actor_email,actor_id,actor_type,created_at,event_type,id,invitation_id,ip,metadata,method,outcome,reason,subject_email,subject_user_id,user_agent' then
    raise exception 'PAY-2C 062 preflight: public.audit_log has columns [%]; expected the fifteen 027 created', v_cols;
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.audit_log', v_priv) then
        raise exception 'PAY-2C 062 preflight: % holds % on public.audit_log — 061 is not in effect, and this function is about to make that table load-bearing for payment forensics', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if has_table_privilege('anon', 'public.audit_log', 'SELECT') then
    raise exception 'PAY-2C 062 preflight: anon can read public.audit_log; 061 is not in effect';
  end if;

  -- ── 059's PAYMENT READ CONTRACT ───────────────────────────────────────
  if has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    raise exception 'PAY-2C 062 preflight: authenticated holds TABLE-level SELECT on public.payments; 059 is not in effect, and provider_token would be readable by a learner';
  end if;
  select string_agg(a.attname, ',' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT');
  if v_txt is distinct from 'amount,course_id,currency,id,reference,status' then
    raise exception 'PAY-2C 062 preflight: 059''s six-column allowlist now reads [%]', v_txt;
  end if;
  if has_any_column_privilege('anon', 'public.payments', 'SELECT') then
    raise exception 'PAY-2C 062 preflight: anon can read public.payments; 059 is not in effect';
  end if;
  -- 058's write withdrawal is what makes SECURITY INVOKER fail closed.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-2C 062 preflight: % holds % on public.payments; 058''s write withdrawal is not in place and INVOKER would not fail closed', v_role, v_priv;
      end if;
    end loop;
    if has_any_column_privilege(v_role, 'public.entitlements', 'SELECT') then
      raise exception 'PAY-2C 062 preflight: % can read public.entitlements; 037 withdrew that', v_role;
    end if;
  end loop;

  -- ── RLS and the policy sets ───────────────────────────────────────────
  foreach v_txt in array array['public.payments', 'public.entitlements', 'public.audit_log'] loop
    if not exists (select 1 from pg_class where oid = v_txt::regclass and relrowsecurity) then
      raise exception 'PAY-2C 062 preflight: row level security is NOT enabled on %', v_txt;
    end if;
  end loop;
  select string_agg(p.polname, ' ' order by p.polname) into v_txt
    from pg_policy p where p.polrelid = 'public.payments'::regclass;
  if v_txt is distinct from 'payments_insert_service payments_no_browser_delete payments_no_browser_update payments_own' then
    raise exception 'PAY-2C 062 preflight: the payment policy set reads [%]; expected the four 058 left', v_txt;
  end if;

  -- ── THE TRUSTED WRITER must be able to perform all four writes ────────
  -- SECURITY INVOKER means the function runs with the CALLER's privileges, so
  -- service_role must hold them directly. Asserted, because an INVOKER function
  -- whose caller lacks a privilege fails at runtime, not at apply time.
  if to_regrole('service_role') is null then
    raise exception 'PAY-2C 062 preflight: role service_role does not exist; there would be nobody to grant EXECUTE to';
  end if;
  foreach v_txt in array array['public.payments', 'public.entitlements',
                               'public.enrollments', 'public.audit_log'] loop
    foreach v_priv in array array['SELECT', 'INSERT'] loop
      if not has_table_privilege('service_role', v_txt, v_priv) then
        raise exception 'PAY-2C 062 preflight: service_role lacks % on %; a SECURITY INVOKER function could not perform its writes', v_priv, v_txt;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.payments', 'UPDATE') then
    raise exception 'PAY-2C 062 preflight: service_role lacks UPDATE on public.payments; the completion could not be recorded';
  end if;
end
$do$;

-- The facts section 4 needs. Dropped at COMMIT.
create temp table pay_2c_062_before on commit drop as
select
  (select count(*) from public.payments)                                     as n_payments,
  (select count(*) from public.payments where status = 'completed')          as n_completed,
  (select count(*) from public.entitlements)                                 as n_entitlements,
  (select count(*) from public.enrollments)                                  as n_enrollments,
  (select count(*) from public.audit_log)                                    as n_audit,
  (select coalesce(md5(string_agg(a.id::text || '|' || a.event_type, E'\n' order by a.id)), '')
     from public.audit_log a)                                                as audit_md5,
  (select coalesce(md5(string_agg(e.id::text || '|' || e.source || '|' || e.status,
            E'\n' order by e.id)), '')
     from public.entitlements e)                                             as ent_md5;


-- ══ 1. THE COMPLETION AUTHORITY ═══════════════════════════════════════════
create function public.complete_payment(
  p_provider           text,
  p_provider_mode      text,
  p_provider_token     text,
  p_provider_reference text,
  p_reference          text,
  p_amount             numeric,
  p_currency           text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_pay       public.payments;
  v_live      public.entitlements;
  v_ent_id    uuid;
  v_ent_ok    boolean;
  v_preexist  boolean := false;
  v_review    jsonb   := null;   -- set ONLY on the duplicate-purchase branch
  v_outcome   text;
  v_enr       uuid;
begin
  -- ── 1. the caller must supply a complete verified result ─────────────
  if p_provider is null or p_provider_mode is null or p_provider_token is null
     or p_reference is null or p_amount is null or p_currency is null then
    raise exception 'complete_payment: every verified field is required'
      using errcode = 'P0001',
            detail  = '{"reason":"missing_argument"}';
  end if;
  if btrim(p_provider_token) = '' then
    raise exception 'complete_payment: provider_token must not be blank'
      using errcode = 'P0001', detail = '{"reason":"blank_provider_token"}';
  end if;
  if p_provider_mode not in ('test', 'live') then
    raise exception 'complete_payment: provider_mode must be test or live, got %', p_provider_mode
      using errcode = 'P0001', detail = '{"reason":"bad_provider_mode"}';
  end if;
  if p_amount <= 0 then
    raise exception 'complete_payment: a payment of % is not a payment', p_amount
      using errcode = 'P0001', detail = '{"reason":"amount_not_positive"}';
  end if;
  if p_currency <> 'XOF' then
    raise exception 'complete_payment: only XOF is supported, got %', p_currency
      using errcode = 'P0001', detail = '{"reason":"currency_unsupported"}';
  end if;

  -- ── 2. LOCK the payment, identified by the replay key ────────────────
  --
  -- provider_token is UNIQUE (060), so this locks exactly one row and
  -- serialises concurrent notifications for the same invoice: the second
  -- waits here, then observes 'completed' below and returns idempotently.
  --
  -- A token that matches nothing surfaces as payment_not_found, which is the
  -- stronger statement than a token mismatch: NO payment carries it. There is
  -- deliberately no separate token-equality check — the lookup IS the match.
  select * into v_pay
    from public.payments
   where provider_token = p_provider_token
   for update;
  if not found then
    raise exception 'complete_payment: no payment carries that provider token'
      using errcode = 'P0001', detail = '{"reason":"payment_not_found"}';
  end if;

  -- ── 3. IDEMPOTENCY — a retried notification is a success, not an error
  if v_pay.status = 'completed' then
    if v_pay.entitlement_id is null then
      raise exception 'complete_payment: payment % is completed but carries no entitlement', v_pay.id
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'completed_without_entitlement',
                                           'paymentId', v_pay.id)::text;
    end if;
    return jsonb_build_object(
      'outcome',       'already_completed',
      'paymentId',     v_pay.id,
      'courseId',      v_pay.course_id,
      'entitlementId', v_pay.entitlement_id);
  end if;

  -- ── 4. only an in-flight intent may be completed ─────────────────────
  -- failed, refunded, cancelled and expired are terminal and belong to the
  -- reconciliation and refund slices. A late confirmation after expiry lands
  -- here and is refused rather than silently granted.
  if v_pay.status not in ('pending', 'processing') then
    raise exception 'complete_payment: payment % is %, which is not completable', v_pay.id, v_pay.status
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'status_not_completable',
                                         'paymentId', v_pay.id,
                                         'status', v_pay.status)::text;
  end if;

  -- ── 5. the stored row must be coherent ───────────────────────────────
  -- user_id and course_id are NULLABLE on payments, so this is a real case.
  if v_pay.user_id is null or v_pay.course_id is null then
    raise exception 'complete_payment: payment % has no learner or no course', v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'payment_identity_incomplete',
                                         'paymentId', v_pay.id)::text;
  end if;
  if v_pay.provider is null or v_pay.provider_mode is null then
    raise exception 'complete_payment: payment % carries no provider identity', v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'payment_provider_incomplete',
                                         'paymentId', v_pay.id)::text;
  end if;
  if v_pay.amount <= 0 then
    raise exception 'complete_payment: payment % is recorded as %', v_pay.id, v_pay.amount
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'stored_amount_not_positive',
                                         'paymentId', v_pay.id)::text;
  end if;

  -- ── 6. the caller's verified result must AGREE with the stored row ───
  -- This is the whole of what the database can check: internal consistency
  -- between what the provider reported and what we recorded when we created
  -- the intent. It establishes nothing about whether money moved.
  if v_pay.provider is distinct from p_provider then
    raise exception 'complete_payment: provider mismatch on payment %', v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'provider_mismatch',
                                         'paymentId', v_pay.id)::text;
  end if;
  if v_pay.provider_mode is distinct from p_provider_mode then
    raise exception 'complete_payment: provider mode mismatch on payment % (stored %, verified %)',
      v_pay.id, v_pay.provider_mode, p_provider_mode
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'provider_mode_mismatch',
                                         'paymentId', v_pay.id,
                                         'stored', v_pay.provider_mode,
                                         'verified', p_provider_mode)::text;
  end if;
  if v_pay.reference is distinct from p_reference then
    raise exception 'complete_payment: reference mismatch on payment %', v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'reference_mismatch',
                                         'paymentId', v_pay.id)::text;
  end if;
  if v_pay.amount is distinct from p_amount then
    raise exception 'complete_payment: amount mismatch on payment % (stored %, verified %)',
      v_pay.id, v_pay.amount, p_amount
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'amount_mismatch',
                                         'paymentId', v_pay.id,
                                         'stored', v_pay.amount,
                                         'verified', p_amount)::text;
  end if;
  if v_pay.currency is distinct from p_currency then
    raise exception 'complete_payment: currency mismatch on payment %', v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'currency_mismatch',
                                         'paymentId', v_pay.id,
                                         'stored', v_pay.currency,
                                         'verified', p_currency)::text;
  end if;

  -- ── 7. THE ENTITLEMENT STATE ─────────────────────────────────────────
  --
  -- At most one entitlement can be live for a (learner, course) pair —
  -- entitlements_one_live_per_course_idx enforces it over PENDING, ACTIVE and
  -- SUSPENDED. Lock it so a concurrent admin transition cannot move it under
  -- this transaction.
  select * into v_live
    from public.entitlements
   where user_id = v_pay.user_id
     and course_id = v_pay.course_id
     and status in ('PENDING', 'ACTIVE', 'SUSPENDED')
   for update;

  if found then
    -- Judged by 037's own definition, which collapses three cases into one:
    -- PENDING and SUSPENDED are not accessible, and neither is an ACTIVE
    -- entitlement whose window has not opened or has already closed.
    v_ent_ok := public.entitlement_accessible(
      v_live.status, v_live.starts_at, v_live.expires_at, v_live.revoked_at);

    if not v_ent_ok then
      -- FAIL CLOSED. The learner would be charged for access they do not have,
      -- and the live index forbids granting a second entitlement alongside it.
      -- A human must resolve this; nothing is written.
      raise exception 'complete_payment: learner already holds a % entitlement for this course that does not grant access', v_live.status
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'entitlement_conflict',
                                           'paymentId', v_pay.id,
                                           'courseId', v_pay.course_id,
                                           'existingEntitlementId', v_live.id,
                                           'existingStatus', v_live.status,
                                           'existingSource', v_live.source)::text;
    end if;

    -- ── A DUPLICATE PURCHASE. The policy, in full ────────────────────
    --
    -- An accessible entitlement already exists — typically a MANUAL_ADMIN or
    -- CORPORATE_LICENSE grant. The learner has paid for access they already
    -- hold. Five things follow, each deliberate:
    --
    --   1. The payment IS completed. The provider has the money; recording it
    --      as anything else would make our ledger disagree with PayDunya's,
    --      which is the worst outcome for reconciliation. Refusing would leave
    --      a 'pending' row against a real collection.
    --   2. NO second entitlement is created. The live partial unique index
    --      forbids it, and a second grant would confer nothing anyway.
    --   3. The existing entitlement is LINKED, never replaced, reactivated or
    --      re-dated. Its source, window and provenance are untouched.
    --   4. NO automatic refund. Whether to refund is commercial, and a
    --      database function is the wrong place to decide it.
    --   5. It is NOT presented as an ordinary sale. This is the part that
    --      needed correcting: marking it only in the audit row and the return
    --      value left `payments` indistinguishable from a normal purchase, and
    --      the admin dashboard computes revenue as
    --      `sum(amount) where status = 'completed'` — so a double-sale would
    --      have been silently counted as new revenue. The marker below lands
    --      on the payment row itself, in `metadata`: a jsonb column 059
    --      withholds from every browser role, so it needs no schema change and
    --      cannot leak to a learner.
    --
    -- Prevention belongs upstream: the checkout slice must refuse to create an
    -- intent for a course the learner already has live access to. This branch
    -- is the safety net for the race that remains — access granted between
    -- intent and confirmation — not the intended path.
    v_preexist := true;
    v_ent_id   := v_live.id;
    v_outcome  := 'completed_preexisting_entitlement';
    -- Built HERE, where v_live is assigned. Referencing v_live from the UPDATE
    -- below would evaluate it on the ordinary branch too, where the record is
    -- unassigned and would raise.
    v_review := jsonb_build_object(
      'reason',                'preexisting_entitlement',
      'existingEntitlementId', v_live.id,
      'existingSource',        v_live.source,
      'existingStatus',        v_live.status,
      'requiresReview',        true);
  else
    -- A REVOKED entitlement is terminal and sits OUTSIDE the live index, so a
    -- new grant would succeed. It is refused anyway: re-selling access to a
    -- learner whose access was deliberately revoked needs an explicit business
    -- rule, and there is none. EXPIRED and CANCELLED are benign and fall
    -- through to the normal grant below.
    if exists (
      select 1 from public.entitlements
       where user_id = v_pay.user_id and course_id = v_pay.course_id
         and status = 'REVOKED'
    ) then
      raise exception 'complete_payment: this learner''s access to this course was REVOKED; automatic repurchase is not authorised'
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'entitlement_revoked_requires_decision',
                                           'paymentId', v_pay.id,
                                           'courseId', v_pay.course_id)::text;
    end if;

    -- ── grant exactly ONE entitlement ──────────────────────────────────
    -- No expires_at: a purchase is perpetual, and entitlements_expiry_required
    -- does not name INDIVIDUAL_PURCHASE. No granted_by: there is no human
    -- actor, and inventing one would corrupt the audit trail. external_ref
    -- carries OUR reference, never the provider token.
    begin
      insert into public.entitlements (
        user_id, course_id, source, status,
        starts_at, expires_at, revoked_at,
        granted_by, granted_reason, external_ref, organization_id
      ) values (
        v_pay.user_id, v_pay.course_id, 'INDIVIDUAL_PURCHASE', 'ACTIVE',
        now(), null, null,
        null, 'INDIVIDUAL_PURCHASE ' || v_pay.reference, v_pay.reference, null
      )
      returning id into v_ent_id;
    exception
      when unique_violation then
        -- entitlements_one_live_per_course_idx fired: another transaction
        -- granted a live entitlement for this pair between the SELECT above and
        -- this INSERT. Re-raised, so everything rolls back; the caller retries
        -- and the retry takes the pre-existing-entitlement branch.
        raise exception 'complete_payment: a live entitlement for this learner and course appeared concurrently'
          using errcode = 'P0001',
                detail  = jsonb_build_object('reason', 'entitlement_race',
                                             'paymentId', v_pay.id,
                                             'courseId', v_pay.course_id)::text;
    end;
    v_outcome := 'completed';
  end if;

  -- ── 8. DELIVERY IS VERIFIED, NOT ASSUMED ─────────────────────────────
  -- Re-read the entitlement that will be linked and assert it actually grants
  -- access, by 037's definition. This is what makes "a completed payment
  -- without entitlement delivery" impossible rather than merely unintended.
  select public.entitlement_accessible(e.status, e.starts_at, e.expires_at, e.revoked_at)
    into v_ent_ok
    from public.entitlements e where e.id = v_ent_id;
  if v_ent_ok is distinct from true then
    raise exception 'complete_payment: entitlement % does not grant access; refusing to complete payment %', v_ent_id, v_pay.id
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'entitlement_not_accessible',
                                         'paymentId', v_pay.id,
                                         'entitlementId', v_ent_id)::text;
  end if;

  -- ── 9. the academic record, WITHOUT disturbing existing progress ─────
  -- An existing enrollment carries the learner's participation history, so it
  -- is never overwritten — not even its payment_id. The untargeted
  -- `on conflict do nothing` is correct whether the unique index on
  -- (user_id, course_id) is total or partial; a targeted one would raise 42P10
  -- against a partial index.
  select id into v_enr
    from public.enrollments
   where user_id = v_pay.user_id and course_id = v_pay.course_id;
  if v_enr is null then
    insert into public.enrollments (user_id, course_id, payment_id, status)
    values (v_pay.user_id, v_pay.course_id, v_pay.id, 'active')
    on conflict do nothing;
  end if;

  -- ── 10. mark the payment completed and LINK the entitlement ──────────
  -- `metadata` is merged, never replaced, and ONLY on the duplicate branch: an
  -- ordinary completion leaves it exactly as the intent left it. v_review is
  -- NULL on every other path, so the CASE never evaluates v_live.
  update public.payments
     set status             = 'completed',
         completed_at       = now(),
         entitlement_id     = v_ent_id,
         provider_reference = coalesce(p_provider_reference, provider_reference),
         metadata           = case
                                when v_review is null then metadata
                                else coalesce(metadata, '{}'::jsonb)
                                     || jsonb_build_object('completionReview', v_review)
                              end
   where id = v_pay.id;

  -- ── 11. AUDIT EVIDENCE — no handler, so a failure here rolls back all
  -- NEVER the provider token, never a credential, never a provider payload.
  -- 059 withholds provider_token from every browser role; copying it into a
  -- table an administrator can read would defeat that.
  insert into public.audit_log (
    event_type, actor_type, outcome, method, subject_user_id, metadata
  ) values (
    'payment.completed', 'system', 'success', 'provider_confirm', v_pay.user_id,
    jsonb_build_object(
      'paymentId',              v_pay.id,
      'courseId',               v_pay.course_id,
      'entitlementId',          v_ent_id,
      'reference',              v_pay.reference,
      'provider',               v_pay.provider,
      'providerMode',           v_pay.provider_mode,
      'amount',                 v_pay.amount,
      'currency',               v_pay.currency,
      'preExistingEntitlement', v_preexist,
      'requiresReview',         v_preexist,
      'completionReview',       v_review,
      'enrollmentCreated',      (v_enr is null),
      'source',                 'complete_payment',
      'txid',                   txid_current()::text)
  );

  return jsonb_build_object(
    'outcome',                v_outcome,
    'paymentId',              v_pay.id,
    'courseId',               v_pay.course_id,
    'entitlementId',          v_ent_id,
    'preExistingEntitlement', v_preexist);
end
$fn$;

comment on function public.complete_payment(text, text, text, text, text, numeric, text) is
  'PAY-2C. The ONLY authority that may complete a payment. Atomic: it grants one INDIVIDUAL_PURCHASE entitlement, links it to the payment, ensures the enrollment, writes a payment.completed audit row and marks the payment completed — all in one transaction, or none of it. SECURITY INVOKER; EXECUTE granted only to service_role. It is a PERSISTENCE operation, not a verification mechanism: every argument is caller-supplied, and only a server-to-server confirm against the provider establishes that money moved. Idempotent: a retried notification returns already_completed and writes nothing. Every refusal raises with a machine-readable reason in the exception DETAIL and persists nothing.';


-- ══ 2. THE PRIVILEGE CONTRACT ═════════════════════════════════════════════
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and Supabase's default
-- privileges may add the app roles on top. Both are revoked explicitly before
-- anything is granted. Had migration 003 ever been applied, a learner who knew
-- their own `reference` — the confirmation page prints it — could have called
-- /rest/v1/rpc/complete_payment. That is the mistake these two lines prevent.

revoke all on function public.complete_payment(text, text, text, text, text, numeric, text)
  from public, anon, authenticated;

grant execute on function public.complete_payment(text, text, text, text, text, numeric, text)
  to service_role;


-- ══ 3. THE RESULTING FUNCTION AND ITS PRIVILEGES ══════════════════════════
do $do$
declare
  v_oid   oid;
  v_txt   text;
  v_role  text;
  v_priv  text;
  v_n     integer;
begin
  -- ── exactly ONE routine, with the expected signature ──────────────────
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%complete%payment%';
  if v_n <> 1 then
    raise exception 'PAY-2C 062: % payment-completion routines exist, expected exactly 1', v_n;
  end if;
  v_oid := to_regprocedure('public.complete_payment(text,text,text,text,text,numeric,text)');
  if v_oid is null then
    raise exception 'PAY-2C 062: complete_payment does not exist with the expected signature';
  end if;

  -- ── SECURITY INVOKER, not DEFINER, and search_path pinned ─────────────
  if (select prosecdef from pg_proc where oid = v_oid) then
    raise exception 'PAY-2C 062: complete_payment is SECURITY DEFINER. It must be INVOKER: service_role already holds every privilege the body needs, so DEFINER would add no capability and would create an escalation primitive.';
  end if;
  select array_to_string(proconfig, ',') into v_txt from pg_proc where oid = v_oid;
  if v_txt is null or position('search_path=' in v_txt) = 0 then
    raise exception 'PAY-2C 062: complete_payment has no pinned search_path (proconfig = %)', coalesce(v_txt, '(null)');
  end if;
  if position('public' in v_txt) = 0 or position('pg_temp' in v_txt) = 0 then
    raise exception 'PAY-2C 062: complete_payment''s search_path is [%]; expected public and pg_temp', v_txt;
  end if;
  if (select provolatile from pg_proc where oid = v_oid) <> 'v' then
    raise exception 'PAY-2C 062: complete_payment must be VOLATILE — it writes';
  end if;

  -- ── EFFECTIVE EXECUTE: service_role only ──────────────────────────────
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, v_oid, 'EXECUTE') then
      select string_agg(r.rolname, ', ' order by r.rolname) into v_txt
        from pg_roles r
       where r.rolname <> v_role and pg_has_role(v_role, r.oid, 'USAGE')
         and has_function_privilege(r.rolname, v_oid, 'EXECUTE');
      raise exception 'PAY-2C 062: % can EXECUTE complete_payment. A learner who knows their own reference could complete their own payment. Source: %',
        v_role, coalesce('inherited from ' || v_txt, 'a direct grant the revoke failed to reach');
    end if;
  end loop;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'PAY-2C 062: complete_payment still grants EXECUTE to PUBLIC';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'PAY-2C 062: service_role cannot EXECUTE complete_payment, so no trusted caller could complete a payment';
  end if;

  -- ── every neighbouring contract is exactly as it was found ────────────
  -- 059's allowlist
  select string_agg(a.attname, ',' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT');
  if v_txt is distinct from 'amount,course_id,currency,id,reference,status' then
    raise exception 'PAY-2C 062: 059''s allowlist now reads [%]; this migration must not have changed it', v_txt;
  end if;
  -- 061's audit privileges, and 058's payment write withdrawal
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.audit_log', v_priv) then
        raise exception 'PAY-2C 062: % gained % on public.audit_log', v_role, v_priv;
      end if;
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-2C 062: % gained % on public.payments', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if has_table_privilege('anon', 'public.audit_log', 'SELECT') then
    raise exception 'PAY-2C 062: anon gained SELECT on public.audit_log';
  end if;
  if not has_table_privilege('authenticated', 'public.audit_log', 'SELECT') then
    raise exception 'PAY-2C 062: authenticated lost SELECT on public.audit_log';
  end if;
  -- policies and RLS
  select string_agg(p.polname, ' ' order by p.polname) into v_txt
    from pg_policy p where p.polrelid = 'public.payments'::regclass;
  if v_txt is distinct from 'payments_insert_service payments_no_browser_delete payments_no_browser_update payments_own' then
    raise exception 'PAY-2C 062: the payment policy set changed; it reads [%]', v_txt;
  end if;
  foreach v_txt in array array['public.payments', 'public.entitlements', 'public.audit_log'] loop
    if not exists (select 1 from pg_class where oid = v_txt::regclass and relrowsecurity) then
      raise exception 'PAY-2C 062: row level security was disabled on %', v_txt;
    end if;
  end loop;
  -- the two indexes the function's correctness rests on
  foreach v_txt in array array['public.payments_provider_token_unique',
                               'public.entitlements_one_live_per_course_idx',
                               'public.payments_one_inflight_intent_per_course'] loop
    if to_regclass(v_txt) is null then
      raise exception 'PAY-2C 062: index % is gone', v_txt;
    end if;
  end loop;
  -- no schema change
  select string_agg(a.attname, ',' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_txt is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,failure_reason,id,last_ipn_at,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-2C 062: public.payments columns changed to [%]', v_txt;
  end if;
end
$do$;


-- ══ 4. THE MIGRATION ITSELF WROTE NOTHING ═════════════════════════════════
--
-- The LAST block before COMMIT: an assertion proves nothing about statements
-- that run after it. Creating the authority must not exercise it.
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
begin
  select * into b from pay_2c_062_before;

  select count(*) into v_n from public.payments;
  if v_n <> b.n_payments then
    raise exception 'PAY-2C 062: the payment count changed from % to %', b.n_payments, v_n;
  end if;
  select count(*) into v_n from public.payments where status = 'completed';
  if v_n <> b.n_completed then
    raise exception 'PAY-2C 062: % payment(s) became completed during this migration (was %)', v_n, b.n_completed;
  end if;
  select count(*) into v_n from public.entitlements;
  if v_n <> b.n_entitlements then
    raise exception 'PAY-2C 062: the entitlement count changed from % to %', b.n_entitlements, v_n;
  end if;
  select count(*) into v_n from public.enrollments;
  if v_n <> b.n_enrollments then
    raise exception 'PAY-2C 062: the enrollment count changed from % to %', b.n_enrollments, v_n;
  end if;
  select count(*) into v_n from public.audit_log;
  if v_n <> b.n_audit then
    raise exception 'PAY-2C 062: the audit record count changed from % to %', b.n_audit, v_n;
  end if;

  select coalesce(md5(string_agg(a.id::text || '|' || a.event_type, E'\n' order by a.id)), '')
    into v_now from public.audit_log a;
  if v_now is distinct from b.audit_md5 then
    raise exception 'PAY-2C 062: audit record data changed';
  end if;
  select coalesce(md5(string_agg(e.id::text || '|' || e.source || '|' || e.status, E'\n' order by e.id)), '')
    into v_now from public.entitlements e;
  if v_now is distinct from b.ent_md5 then
    raise exception 'PAY-2C 062: entitlement data changed';
  end if;

  -- No INDIVIDUAL_PURCHASE entitlement may exist yet: PayDunya is not
  -- operational, so creating the authority must not have granted anything.
  select count(*) into v_n from public.entitlements where source = 'INDIVIDUAL_PURCHASE';
  if v_n <> 0 then
    raise exception 'PAY-2C 062: % INDIVIDUAL_PURCHASE entitlement(s) exist; this migration creates the authority, it must not use it', v_n;
  end if;
  select count(*) into v_n from public.audit_log where event_type = 'payment.completed';
  if v_n <> 0 then
    raise exception 'PAY-2C 062: % payment.completed audit row(s) exist; this migration must not have completed anything', v_n;
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Safe with the CURRENT application: NOTHING calls this function. There is
--    no PayDunya client, no webhook route and no IPN handler in the deployed
--    tree, and PAYMENTS_ENABLED gates payment creation. Creating the authority
--    changes no running behaviour; it becomes reachable only when the IPN slice
--    ships a caller. Privilege-and-function only, no table rewrite, no lock on
--    any data table. Milliseconds.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once.
--    "Success. No rows returned." means every assertion passed: the file is one
--    transaction and any failure raises and rolls everything back. It emits no
--    RAISE NOTICE, because the SQL editor does not display NOTICE output.
-- 3. Immediately afterwards, GET-only:
--        as the ANON key    /rest/v1/rpc/complete_payment  -> 404 PGRST202
--          (PostgREST does not advertise a function the role cannot execute;
--           404 rather than 403 is the expected shape.)
--        as the SERVICE key /rest/v1/  -> complete_payment appears in the
--                                         RPC list, and the RPC count is 19
--        /rest/v1/payments?select=id&limit=0 + count   -> still 0 rows
--        /rest/v1/entitlements?source=eq.INDIVIDUAL_PURCHASE -> 0 rows
--        /rest/v1/audit_log?event_type=eq.payment.completed  -> 0 rows
--    DO NOT call the function to test it. It writes. The first real invocation
--    belongs to a PayDunya TEST transaction under the IPN slice.
-- 4. Then re-run docs/audit-sec-01-postflight-confirmation.sql and confirm all
--    29 rows still read PASS — this migration asserts 061's contract but the
--    independent read is cheap.
--
-- ── WHAT STILL BLOCKS A REAL PAYMENT ──────────────────────────────────────
--
--   * NO CALLER EXISTS. The IPN slice must build: a PayDunya client, a
--     server-to-server confirm, and ONE chokepoint module that is the only
--     place in the repository allowed to call this function — enforced by a
--     repo-wide test asserting exactly one call site, as PAY-2C-0 did for
--     payment completion writers.
--   * C1-F4 `donnez-envie-a-vos-clients-de-revenir` is priced 0 XOF. This
--     function refuses a non-positive amount, so that course cannot be
--     purchased until PRICE-LAUNCH-01 is decided. That is the correct failure.
--   * /checkout cannot reach a payment path while PLATFORM_MODE=pilot.
--   * payments.method is CHECK-constrained to ('orange_money','wave','card')
--     with no 'paydunya' value. 062 does not need it — it completes a row that
--     already has a method — but the checkout-creation slice must map or widen
--     that CHECK deliberately.
--   * SEC-4 certificate hardening remains a PAID-LAUNCH BLOCKER.
--
-- ── WHAT 062 DELIBERATELY DOES NOT DECIDE ─────────────────────────────────
--
--   * A REVOKED entitlement refuses automatic repurchase. If the business rule
--     becomes "a revoked learner may buy again", that is a one-branch change
--     here plus an explicit written rule — not a silent default.
--   * An ACTIVE pre-existing entitlement completes the payment, links the
--     existing entitlement and flags requiresReview. The alternative — refusing
--     — would leave the provider holding money against an uncompleted payment,
--     which is worse for reconciliation. The refund question is commercial.
--   * EXPIRED and CANCELLED entitlements fall through to a normal grant, which
--     is the ordinary repurchase path.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes the completion authority.
-- Safe only while nothing has been completed through it. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- do $rb$
-- declare v_n integer;
-- begin
--   select count(*) into v_n from public.entitlements where source = 'INDIVIDUAL_PURCHASE';
--   if v_n <> 0 then
--     raise exception 'PAY-2C 062 rollback: % INDIVIDUAL_PURCHASE entitlement(s) were granted through this function; dropping it would leave rights no code can account for', v_n;
--   end if;
--   select count(*) into v_n from public.audit_log where event_type = 'payment.completed';
--   if v_n <> 0 then
--     raise exception 'PAY-2C 062 rollback: % payment.completed audit row(s) exist; investigate before dropping the authority', v_n;
--   end if;
-- end
-- $rb$;
--
-- drop function if exists public.complete_payment(text, text, text, text, text, numeric, text);
--
-- commit;
