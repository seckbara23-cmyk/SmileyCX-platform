-- ============================================================================
-- Migration 065 — XP-LAUNCH-FINAL-08: commercial offers and the six-month access.
--
-- Run as a SINGLE TRANSACTION, AFTER 064. Forward-only: 062 and 064 are not
-- edited; four of their functions are REPLACED here (CREATE OR REPLACE keeps
-- their owner and privileges, re-asserted in section 7).
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Apply under its own gate, after the night's
-- backup, once 063 and 064 are in. Changes no existing payment, entitlement,
-- enrollment or audit row: section 8 proves it.
--
-- ── WHAT WAS DECIDED (Marième, in writing, 2026-11-08; requirements V4) ─────
--
--   * A paid course gives access for SIX calendar months from the validation of
--     the payment, activated automatically. 062 granted a perpetual purchase.
--   * Two fixed packs, each ONE payment: Pack Conseiller (C1-F1, C1-F2, C1-F3,
--     C2-F4) at 37 900 FCFA and Pack Manager (C2-F1, C2-F2, C2-F5) at 38 000 FCFA.
--     Every course of a pack opens at the same instant and closes with the others.
--   * A course already owned inside a pack is neither refunded nor replaced: it is
--     linked and keeps its own window (the learner is warned before paying).
--   * A purchase whose window has closed may be bought again.
--   * The free course, administrative, corporate, promotional and evaluation
--     grants are untouched. Certificates do not depend on access and are untouched.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--
--   1. public.course_packs, public.course_pack_courses: published packs readable by
--      anyone, writes for service_role only. Seeded with the two packs by course code.
--   2. payments.pack_id: a payment buys ONE course or ONE pack, never both.
--   3. ONE PAYABLE ATTEMPT PER LEARNER AND COURSE, across packs and single courses:
--      a unique index per (learner, pack) in flight, beside 058's per course, and
--      payments_offer_guard, which refuses an in-flight attempt that overlaps another
--      one of the same learner (serialised per learner with an advisory lock).
--      course_pack_courses_guard freezes a pack's composition while it is being paid.
--   4. public.payment_entitlements: per completed payment, per course, the
--      entitlement it granted or linked. service_role only.
--   5. complete_payment() replaced: 062's steps 1 to 6 verbatim (one edit: a pack
--      payment carries no course), then per course: roll an expired PURCHASE over to
--      EXPIRED, link an accessible entitlement (never re-dated), or grant one for
--      six months; verify delivery; ensure the enrollment; record the link.
--   6. payment_exception_decide, payment_exception_record_refund and
--      payment_exception_blocking_reference replaced, each by ONE edit, so that an
--      exception on a pack payment concerns the pack's courses.
-- ============================================================================

begin;

lock table public.payments, public.entitlements in share row exclusive mode;

-- ══ 0. PREFLIGHT ═══════════════════════════════════════════════════════════
do $pre$
declare
  v_code text;
  v_n    integer;
begin
  if to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)') is null then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: public.complete_payment does not exist; apply 062 first';
  end if;
  if exists (select 1 from pg_proc
              where oid = to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)')
                and prosecdef) then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: complete_payment is SECURITY DEFINER; 062 created it INVOKER';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.payments'::regclass
                    and tgname = 'payments_transition_guard' and not tgisinternal) then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: 063 is not applied (no payments_transition_guard)';
  end if;
  if to_regclass('public.payment_exceptions') is null then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: 064 is not applied (no payment_exceptions)';
  end if;
  if to_regclass('public.course_packs') is not null then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: public.course_packs already exists';
  end if;
  if exists (select 1 from pg_attribute
              where attrelid = 'public.payments'::regclass and attname = 'pack_id' and not attisdropped) then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: public.payments already has pack_id';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.courses'::regclass and attname = 'code' and not attisdropped) then
    raise exception 'XP-LAUNCH-FINAL-08 065 preflight: public.courses has no code column (028)';
  end if;
  -- The seven paid courses the two packs are made of, each exactly once.
  foreach v_code in array array['C1-F1', 'C1-F2', 'C1-F3', 'C2-F4', 'C2-F1', 'C2-F2', 'C2-F5'] loop
    select count(*) into v_n from public.courses where code = v_code;
    if v_n <> 1 then
      raise exception 'XP-LAUNCH-FINAL-08 065 preflight: course % found % time(s); the packs cannot be seeded', v_code, v_n;
    end if;
  end loop;
end
$pre$;


-- ══ 1. THE PACKS ═══════════════════════════════════════════════════════════
create table public.course_packs (
  id           uuid        primary key default gen_random_uuid(),
  code         text        not null unique check (code ~ '^[A-Z][A-Z0-9-]{2,39}$'),
  title        text        not null check (length(btrim(title)) between 3 and 120),
  description  text        not null default '',
  price        numeric(10,2) not null check (price > 0 and price = trunc(price)),
  currency     text        not null default 'XOF' check (currency = 'XOF'),
  is_published boolean     not null default false,
  position     integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.course_packs is
  'XP-LAUNCH-FINAL-08. A fixed commercial bundle: ONE payment that opens every course of the pack for six months, together. Prices are whole FCFA. Writes are service_role only.';

create table public.course_pack_courses (
  pack_id   uuid    not null references public.course_packs(id) on delete restrict,
  course_id uuid    not null references public.courses(id) on delete restrict,
  position  integer not null default 0,
  primary key (pack_id, course_id)
);

comment on table public.course_pack_courses is
  'XP-LAUNCH-FINAL-08. The courses of a pack. Frozen while a payment for the pack is in flight (course_pack_courses_guard).';

create index course_pack_courses_course_idx on public.course_pack_courses (course_id);

alter table public.course_packs        enable row level security;
alter table public.course_pack_courses enable row level security;

create policy "course_packs_public_read" on public.course_packs
  for select using (is_published);

create policy "course_pack_courses_public_read" on public.course_pack_courses
  for select using (exists (select 1 from public.course_packs p where p.id = pack_id and p.is_published));

-- D-GRANT: Supabase's default privileges gave anon and authenticated ALL on both.
revoke all on public.course_packs        from public, anon, authenticated;
revoke all on public.course_pack_courses from public, anon, authenticated;
grant select on public.course_packs        to anon, authenticated;
grant select on public.course_pack_courses to anon, authenticated;
grant select, insert, update, delete on public.course_packs        to service_role;
grant select, insert, update, delete on public.course_pack_courses to service_role;

insert into public.course_packs (code, title, description, price, currency, is_published, position) values
  ('PACK-CONSEILLER', 'Pack Conseiller',
   'Les quatre formations du conseiller clientèle : expérience client, service client, canaux digitaux et réclamations.',
   37900, 'XOF', true, 1),
  ('PACK-MANAGER', 'Pack Manager',
   'Les trois formations du manager : piloter une équipe orientée client, mesurer l''expérience client et développer une culture client.',
   38000, 'XOF', true, 2);

insert into public.course_pack_courses (pack_id, course_id, position)
select p.id, c.id, x.position
  from (values
          ('PACK-CONSEILLER', 'C1-F1', 1), ('PACK-CONSEILLER', 'C1-F2', 2),
          ('PACK-CONSEILLER', 'C1-F3', 3), ('PACK-CONSEILLER', 'C2-F4', 4),
          ('PACK-MANAGER',    'C2-F1', 1), ('PACK-MANAGER',    'C2-F2', 2),
          ('PACK-MANAGER',    'C2-F5', 3)
       ) as x(pack_code, course_code, position)
  join public.course_packs p on p.code = x.pack_code
  join public.courses      c on c.code = x.course_code;


-- ══ 2. A PAYMENT BUYS ONE COURSE OR ONE PACK ═══════════════════════════════
alter table public.payments
  add column pack_id uuid references public.course_packs(id) on delete restrict;

alter table public.payments
  add constraint payments_one_product check (course_id is null or pack_id is null);

create unique index payments_one_inflight_intent_per_pack
  on public.payments (user_id, pack_id)
  where status in ('pending', 'processing') and pack_id is not null;

comment on column public.payments.pack_id is
  'XP-LAUNCH-FINAL-08. The pack this payment buys, when it buys a pack; course_id is then NULL. Write-once (payments_offer_guard). Not granted to any browser role.';


-- ══ 3. ONE PAYABLE ATTEMPT PER LEARNER AND COURSE, ACROSS PACKS ═══════════
create function public.payments_offer_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_hit text;
begin
  if tg_op = 'UPDATE' then
    if new.pack_id is distinct from old.pack_id then
      raise exception 'payments: the pack of payment % cannot change', old.id
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'payment_pack_immutable', 'paymentId', old.id)::text;
    end if;
    return new;
  end if;

  -- INSERT. Only an attempt that can still be paid can overlap.
  if new.status in ('pending', 'processing') and new.user_id is not null
     and (new.course_id is not null or new.pack_id is not null) then
    -- Serialise this learner's new attempts, so that two concurrent clicks (a pack
    -- and one of its courses) cannot both pass the check below.
    perform pg_advisory_xact_lock(hashtextextended('payments-inflight:' || new.user_id::text, 0));

    if new.pack_id is not null then
      select p.reference into v_hit
        from public.payments p
       where p.user_id = new.user_id
         and p.id <> new.id
         and p.status in ('pending', 'processing')
         and (p.course_id in (select pc.course_id from public.course_pack_courses pc where pc.pack_id = new.pack_id)
              or (p.pack_id is not null and exists (
                    select 1
                      from public.course_pack_courses a
                      join public.course_pack_courses b on b.course_id = a.course_id
                     where a.pack_id = new.pack_id and b.pack_id = p.pack_id)))
       limit 1;
    else
      select p.reference into v_hit
        from public.payments p
       where p.user_id = new.user_id
         and p.id <> new.id
         and p.status in ('pending', 'processing')
         and p.pack_id in (select pc.pack_id from public.course_pack_courses pc where pc.course_id = new.course_id)
       limit 1;
    end if;

    if v_hit is not null then
      raise exception 'payments: another attempt of this learner is in flight for a course this one would open'
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'inflight_overlap', 'reference', v_hit)::text;
    end if;
  end if;
  return new;
end
$fn$;

comment on function public.payments_offer_guard() is
  'XP-LAUNCH-FINAL-08. At most one payable attempt per learner and course across packs and single courses; pack_id write-once. Raises P0001 with a JSON reason in DETAIL.';

create trigger payments_offer_guard
  before insert or update of pack_id on public.payments
  for each row execute function public.payments_offer_guard();

create function public.course_pack_courses_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if exists (select 1 from public.payments p
              where p.status in ('pending', 'processing')
                and (p.pack_id = new.pack_id or p.pack_id = old.pack_id)) then
    raise exception 'course_pack_courses: a payment for this pack is in flight; its composition cannot change now'
      using errcode = 'P0001',
            detail  = jsonb_build_object('reason', 'pack_composition_locked',
                                         'packId', coalesce(new.pack_id, old.pack_id))::text;
  end if;
  return coalesce(new, old);
end
$fn$;

comment on function public.course_pack_courses_guard() is
  'XP-LAUNCH-FINAL-08. A pack''s composition cannot change while one of its payments is in flight: what complete_payment() delivers is what was sold.';

create trigger course_pack_courses_guard
  before insert or update or delete on public.course_pack_courses
  for each row execute function public.course_pack_courses_guard();


-- ══ 4. WHAT EACH COMPLETED PAYMENT DELIVERED ═══════════════════════════════
create table public.payment_entitlements (
  id             uuid        primary key default gen_random_uuid(),
  payment_id     uuid        not null references public.payments(id) on delete cascade,
  course_id      uuid        references public.courses(id) on delete set null,
  entitlement_id uuid        references public.entitlements(id) on delete set null,
  preexisting    boolean     not null,
  created_at     timestamptz not null default now(),
  unique (payment_id, course_id)
);

comment on table public.payment_entitlements is
  'XP-LAUNCH-FINAL-08. Per completed payment and course: the entitlement complete_payment() granted (preexisting = false) or linked (true). service_role only.';

alter table public.payment_entitlements enable row level security;
revoke all on public.payment_entitlements from public, anon, authenticated;
grant select, insert on public.payment_entitlements to service_role;


-- ══ 5. complete_payment(): six months, packs, rollover ═════════════════════
create or replace function public.complete_payment(
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
  -- 065: what the payment buys, and the access window it opens.
  v_now        timestamptz := now();
  v_until      timestamptz;
  v_courses    uuid[];
  v_course     uuid;
  v_course_pre boolean;
  v_first_ent  uuid;
  v_first_pre  jsonb   := null;
  v_new        integer := 0;
  v_enr_new    integer := 0;
  v_items      jsonb   := '[]'::jsonb;
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
  -- 065: a payment buys ONE course or ONE pack (payments_one_product), so it
  -- needs a learner and one of the two.
  if v_pay.user_id is null or (v_pay.course_id is null and v_pay.pack_id is null) then
    raise exception 'complete_payment: payment % has no learner or nothing to deliver', v_pay.id
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

  -- ── 7. WHAT THIS PAYMENT BUYS (065) ──────────────────────────────────
  -- One course, or every course of one pack. A pack's composition cannot change
  -- while one of its payments is in flight (course_pack_courses_guard), so what is
  -- read here is what was sold.
  if v_pay.pack_id is not null then
    select array_agg(pc.course_id order by pc.position, pc.course_id)
      into v_courses
      from public.course_pack_courses pc
     where pc.pack_id = v_pay.pack_id;
    if v_courses is null or cardinality(v_courses) = 0 then
      raise exception 'complete_payment: pack % of payment % has no course', v_pay.pack_id, v_pay.id
        using errcode = 'P0001',
              detail  = jsonb_build_object('reason', 'pack_empty',
                                           'paymentId', v_pay.id,
                                           'packId', v_pay.pack_id)::text;
    end if;
  else
    v_courses := array[v_pay.course_id];
  end if;

  -- ── 8. THE ACCESS WINDOW (065) ────────────────────────────────────────
  -- Six calendar months from the validation of the payment, which is now: this
  -- function runs only on a provider-confirmed settlement. now() is fixed for the
  -- whole transaction, so every course of a pack opens and closes at the same
  -- instant. Postgres adds calendar months and clamps the day (31 August + 6
  -- months = 28 or 29 February).
  v_until := v_now + interval '6 months';

  -- ── 9. PER COURSE: rollover, the live state, then grant or link ───────
  foreach v_course in array v_courses loop
    -- A PURCHASE whose window has closed leaves the live set, so that it can be
    -- bought again. Only a purchase: an administrative, corporate, promotional or
    -- evaluation grant keeps exactly the state an administrator gave it.
    update public.entitlements
       set status = 'EXPIRED'
     where user_id    = v_pay.user_id
       and course_id  = v_course
       and source     = 'INDIVIDUAL_PURCHASE'
       and status     = 'ACTIVE'
       and expires_at is not null
       and expires_at <= v_now;

    -- At most one entitlement can be live for a (learner, course) pair (037's
    -- live index). Lock it so a concurrent admin transition cannot move it under
    -- this transaction.
    select * into v_live
      from public.entitlements
     where user_id = v_pay.user_id
       and course_id = v_course
       and status in ('PENDING', 'ACTIVE', 'SUSPENDED')
     for update;

    if found then
      v_ent_ok := public.entitlement_accessible(
        v_live.status, v_live.starts_at, v_live.expires_at, v_live.revoked_at);
      if not v_ent_ok then
        -- FAIL CLOSED, as 062: charged for access the learner does not have, and the
        -- live index forbids a second entitlement beside it. A person resolves it.
        raise exception 'complete_payment: learner already holds a % entitlement for course % that does not grant access', v_live.status, v_course
          using errcode = 'P0001',
                detail  = jsonb_build_object('reason', 'entitlement_conflict',
                                             'paymentId', v_pay.id,
                                             'courseId', v_course,
                                             'existingEntitlementId', v_live.id,
                                             'existingStatus', v_live.status,
                                             'existingSource', v_live.source)::text;
      end if;
      -- Already accessible: LINKED, never replaced, reactivated or re-dated, whatever
      -- its source (062's duplicate-purchase policy). For a pack, the learner was
      -- warned before paying that a course already owned is neither refunded nor
      -- replaced; it keeps its own window.
      v_ent_id     := v_live.id;
      v_course_pre := true;
      if v_first_pre is null then
        v_first_pre := jsonb_build_object(
          'reason',                'preexisting_entitlement',
          'existingEntitlementId', v_live.id,
          'existingSource',        v_live.source,
          'existingStatus',        v_live.status,
          'requiresReview',        true);
      end if;
    else
      -- A REVOKED entitlement sits outside the live index; re-selling access that
      -- was deliberately revoked needs a decision (062). EXPIRED and CANCELLED,
      -- including the purchase just rolled over, fall through to a new grant.
      if exists (
        select 1 from public.entitlements
         where user_id = v_pay.user_id and course_id = v_course
           and status = 'REVOKED'
      ) then
        raise exception 'complete_payment: this learner''s access to course % was REVOKED; automatic repurchase is not authorised', v_course
          using errcode = 'P0001',
                detail  = jsonb_build_object('reason', 'entitlement_revoked_requires_decision',
                                             'paymentId', v_pay.id,
                                             'courseId', v_course)::text;
      end if;

      -- ONE entitlement, six months. No granted_by: there is no human actor.
      -- external_ref carries OUR reference, never the provider token.
      begin
        insert into public.entitlements (
          user_id, course_id, source, status,
          starts_at, expires_at, revoked_at,
          granted_by, granted_reason, external_ref, organization_id
        ) values (
          v_pay.user_id, v_course, 'INDIVIDUAL_PURCHASE', 'ACTIVE',
          v_now, v_until, null,
          null, 'INDIVIDUAL_PURCHASE ' || v_pay.reference, v_pay.reference, null
        )
        returning id into v_ent_id;
      exception
        when unique_violation then
          raise exception 'complete_payment: a live entitlement for this learner and course % appeared concurrently', v_course
            using errcode = 'P0001',
                  detail  = jsonb_build_object('reason', 'entitlement_race',
                                               'paymentId', v_pay.id,
                                               'courseId', v_course)::text;
      end;
      v_course_pre := false;
      v_new        := v_new + 1;
    end if;

    -- DELIVERY IS VERIFIED, NOT ASSUMED (062 step 8), for every course.
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

    -- The academic record, WITHOUT disturbing existing progress (062 step 9).
    v_enr := null;
    select id into v_enr
      from public.enrollments
     where user_id = v_pay.user_id and course_id = v_course;
    if v_enr is null then
      insert into public.enrollments (user_id, course_id, payment_id, status)
      values (v_pay.user_id, v_course, v_pay.id, 'active')
      on conflict do nothing;
      v_enr_new := v_enr_new + 1;
    end if;

    -- What this payment granted or linked, per course.
    insert into public.payment_entitlements (payment_id, course_id, entitlement_id, preexisting)
    values (v_pay.id, v_course, v_ent_id, v_course_pre);

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'courseId', v_course, 'entitlementId', v_ent_id, 'preExisting', v_course_pre));
    if v_first_ent is null then
      v_first_ent := v_ent_id;
    end if;
  end loop;

  -- Nothing new was opened: the learner paid for access already held. The payment
  -- IS completed (the provider has the money) and marked for a person, exactly as
  -- 062 did for a single course. A pack that opened at least one course is an
  -- ordinary sale: the owned ones were disclosed before payment.
  v_preexist := (v_new = 0);
  if v_preexist then
    v_review  := v_first_pre;
    v_outcome := 'completed_preexisting_entitlement';
  else
    v_outcome := 'completed';
  end if;

  -- ── 10. mark the payment completed and LINK the (first) entitlement ───
  -- `metadata` is merged, never replaced, and ONLY on the duplicate branch.
  update public.payments
     set status             = 'completed',
         completed_at       = now(),
         entitlement_id     = v_first_ent,
         provider_reference = coalesce(p_provider_reference, provider_reference),
         metadata           = case
                                when v_review is null then metadata
                                else coalesce(metadata, '{}'::jsonb)
                                     || jsonb_build_object('completionReview', v_review)
                              end
   where id = v_pay.id;

  -- ── 11. AUDIT EVIDENCE — no handler, so a failure here rolls back all
  -- NEVER the provider token, never a credential, never a provider payload.
  insert into public.audit_log (
    event_type, actor_type, outcome, method, subject_user_id, metadata
  ) values (
    'payment.completed', 'system', 'success', 'provider_confirm', v_pay.user_id,
    jsonb_build_object(
      'paymentId',              v_pay.id,
      'courseId',               v_pay.course_id,
      'packId',                 v_pay.pack_id,
      'entitlementId',          v_first_ent,
      'items',                  v_items,
      'accessStartsAt',         v_now,
      'accessExpiresAt',        v_until,
      'reference',              v_pay.reference,
      'provider',               v_pay.provider,
      'providerMode',           v_pay.provider_mode,
      'amount',                 v_pay.amount,
      'currency',               v_pay.currency,
      'preExistingEntitlement', v_preexist,
      'requiresReview',         v_preexist,
      'completionReview',       v_review,
      'enrollmentCreated',      (v_enr_new > 0),
      'enrollmentsCreated',     v_enr_new,
      'source',                 'complete_payment',
      'txid',                   txid_current()::text)
  );

  return jsonb_build_object(
    'outcome',                v_outcome,
    'paymentId',              v_pay.id,
    'courseId',               v_pay.course_id,
    'packId',                 v_pay.pack_id,
    'entitlementId',          v_first_ent,
    'items',                  v_items,
    'accessExpiresAt',        v_until,
    'preExistingEntitlement', v_preexist);
end
$fn$;

comment on function public.complete_payment(text, text, text, text, text, numeric, text) is
  'PAY-2C, replaced by XP-LAUNCH-FINAL-08 (065). The ONLY authority that may complete a payment. Atomic: per course of what the payment buys (one course or every course of one pack), it rolls an expired purchase over to EXPIRED, links an accessible entitlement or grants one INDIVIDUAL_PURCHASE for six months from now, verifies delivery, ensures the enrollment and records the link; then marks the payment completed and writes a payment.completed audit row — all in one transaction, or none of it. SECURITY INVOKER; EXECUTE granted only to service_role. It is a PERSISTENCE operation, not a verification mechanism. Idempotent. Every refusal raises with a machine-readable reason in the exception DETAIL and persists nothing.';


-- ══ 6. THE EXCEPTION WORKFLOW SEES A PACK'S COURSES ════════════════════════
create or replace function public.payment_exception_decide(
  p_exception_id uuid,
  p_action       text,
  p_actor_id     uuid,
  p_actor_email  text,
  p_note         text,
  p_ip           text default null,
  p_user_agent   text default null,
  -- The version of the record the administrator was shown. Without it nothing says what
  -- this decision covers, so it is refused.
  p_seen_version integer default null
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
                                          'withdraw_refund', 'record_access', 'acknowledge_report',
                                          'reopen_after_review') then
    perform public.payment_exception_refuse('invalid_action');
  end if;
  if p_actor_id is null then
    perform public.payment_exception_refuse('actor_required');
  end if;
  if p_note is null or length(trim(p_note)) not between 10 and 500 then
    perform public.payment_exception_refuse('note_required');
  end if;
  if p_seen_version is null then
    perform public.payment_exception_refuse('evidence_version_required');
  end if;

  select e.payment_id into v_payment_id from public.payment_exceptions e where e.id = p_exception_id;
  if v_payment_id is null then
    perform public.payment_exception_refuse('exception_not_found');
  end if;
  select * into v_pay from public.payments where id = v_payment_id for update;
  select * into v_exc from public.payment_exceptions where id = p_exception_id for update;

  -- The two decisions a resolved record can take. Neither changes a settled fact.
  if p_action = 'acknowledge_report' then
    if v_exc.post_settlement_report_at is null and v_exc.repeat_count = 0 then
      perform public.payment_exception_refuse('no_report_to_review');
    end if;
  elsif p_action = 'reopen_after_review' then
    if v_exc.state <> 'resolved' then
      perform public.payment_exception_refuse('exception_not_resolved');
    end if;
  elsif v_exc.state <> 'open' then
    perform public.payment_exception_refuse('exception_not_open');
  end if;
  -- A decision covers what the administrator was shown. Whatever has changed since must be
  -- read first, or it would pass unseen.
  if p_seen_version <> v_exc.evidence_version then
    perform public.payment_exception_refuse('evidence_changed');
  end if;
  v_confirmed := v_exc.payment_received in ('confirmed_by_operator', 'confirmed_by_provider');

  case p_action
    when 'acknowledge_report' then
      update public.payment_exceptions
         set post_settlement_report_at = null, repeat_count = 0,
             administrator_flagged_at = null,
             repeat_alert_due_at = null,
             different_report_at = null, different_signal = null,
             evidence_overflow_at = null,
             reviewed_fingerprints = evidence_fingerprints
       where id = v_exc.id;
      v_event := 'payment.exception_settlement_report_reviewed';

    -- An administrator found money this record does not cover, on a dashboard or a
    -- statement, whether or not any notification came again. A record holding no
    -- settled fact opens again. Settled facts stay final, so it is flagged instead. So
    -- is a completed payment: the money found is a different payment, and opening this
    -- record would invite a refund that closes the legitimate one as refunded. The
    -- exception is a completed payment the provider's last word still questions, where a
    -- dismissal may have been the mistake. What it took back does not count.
    when 'reopen_after_review' then
      if v_exc.resolution in ('nothing_to_return', 'settled_normally')
         and (v_pay.status <> 'completed' or v_exc.provider_answer is not null or v_exc.provider_amount is not null) then
        update public.payment_exceptions
           set state = 'open', resolution = null, resolved_at = null, resolved_by = null,
               refund_state = 'not_assessed', escalated_at = null, alert_sent_at = null,
               administrator_reopened_at = now(),
               payment_received = case when payment_received in ('not_received', 'not_established') then 'reported' else payment_received end,
               repeat_count = 0, repeat_alert_due_at = null, different_report_at = null, different_signal = null,
               reviewed_fingerprints = '{}'
         where id = v_exc.id;
      else
        update public.payment_exceptions
           set post_settlement_report_at = now(), alert_sent_at = null,
               administrator_flagged_at = now(),
               -- A flag raised again changes no value a clock can be trusted to tell apart.
               evidence_version = evidence_version + 1,
               repeat_count = 0, repeat_alert_due_at = null, different_report_at = null, different_signal = null
         where id = v_exc.id;
      end if;
      v_event := 'payment.exception_reopened_by_administrator';

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
      -- recorded as not received: an in-flight one may still settle. The exception is money
      -- the provider confirmed, when its last word is that it was not paid or can still be
      -- paid, or proves nothing while no amount it named stands. What it confirmed stays on
      -- the record, and a person who checked the dashboard may decide between the two.
      if v_pay.status <> 'completed' and v_confirmed
         and not (v_exc.payment_received = 'confirmed_by_provider'
                  and coalesce(v_exc.provider_answer in ('provider_not_paid', 'provider_pending')
                               or (v_exc.provider_answer in ('settlement_amount_mismatch', 'settlement_amount_unreadable', 'settlement_status_unrecognised')
                                   and v_exc.provider_amount is null), false)) then
        perform public.payment_exception_refuse('payment_confirmed_cannot_dismiss');
      end if;
      update public.payment_exceptions
         set state = 'resolved', resolution = 'nothing_to_return', resolved_at = now(), resolved_by = p_actor_id,
             refund_state = 'not_required',
             repeat_alert_due_at = null,
             evidence_overflow_at = null,
             reviewed_fingerprints = evidence_fingerprints,
             payment_received = case when v_pay.status in ('completed', 'pending', 'processing')
                                       or payment_received = 'confirmed_by_provider' then payment_received
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
      -- 065: a pack payment's access is honoured only when EVERY course of the
      -- pack has an accessible entitlement; the newest of them is recorded.
      select en.id into v_ent from public.entitlements en
       where en.user_id = v_pay.user_id
         and (en.course_id = v_pay.course_id
              or en.course_id in (select pc.course_id from public.course_pack_courses pc
                                   where pc.pack_id = v_pay.pack_id))
         and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
         and (v_pay.pack_id is null or not exists (
               select 1 from public.course_pack_courses pc
                where pc.pack_id = v_pay.pack_id
                  and not exists (
                        select 1 from public.entitlements e2
                         where e2.user_id = v_pay.user_id and e2.course_id = pc.course_id
                           and public.entitlement_accessible(e2.status, e2.starts_at, e2.expires_at, e2.revoked_at))))
       order by en.created_at desc limit 1;
      if v_ent is null then
        perform public.payment_exception_refuse('no_live_entitlement');
      end if;
      update public.payment_exceptions
         set state = 'resolved', resolution = 'access_honoured', resolved_at = now(), resolved_by = p_actor_id,
             access_state = 'granted', access_entitlement_id = v_ent, refund_state = 'not_required',
             repeat_alert_due_at = null,
             evidence_overflow_at = null,
             reviewed_fingerprints = evidence_fingerprints
       where id = v_exc.id;
      v_event := 'payment.exception_access_recorded';
  end case;

  update public.payment_exceptions
     set last_decision_note = trim(p_note), last_decision_at = now()
   where id = p_exception_id
  returning * into v_exc;

  perform public.payment_exception_audit(
    v_event, 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel', trim(p_note), p_ip, p_user_agent,
    jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
                       'action', p_action, 'seenVersion', p_seen_version, 'notifications', cardinality(v_exc.evidence_fingerprints),
                       'state', v_exc.state, 'paymentReceived', v_exc.payment_received,
                       'refundState', v_exc.refund_state, 'accessState', v_exc.access_state));

  return jsonb_build_object('outcome', p_action, 'exceptionId', v_exc.id, 'state', v_exc.state,
                            'paymentReceived', v_exc.payment_received, 'refundState', v_exc.refund_state,
                            'accessState', v_exc.access_state);
end
$fn$;

create or replace function public.payment_exception_record_refund(
  p_exception_id       uuid,
  p_actor_id           uuid,
  p_actor_email        text,
  p_external_reference text,
  p_amount             numeric,
  p_currency           text,
  p_refunded_at        timestamptz,
  p_note               text,
  p_ip                 text default null,
  p_user_agent         text default null,
  p_seen_version       integer default null,
  p_attest_charged     boolean default false
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
  v_named boolean;
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
      perform public.payment_exception_audit(
        'payment.exception_refund_repeated', 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel',
        trim(p_note), p_ip, p_user_agent,
        jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id, 'refundReference', v_ref));
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
  if p_seen_version is null then
    perform public.payment_exception_refuse('evidence_version_required');
  end if;
  if p_seen_version <> v_exc.evidence_version then
    perform public.payment_exception_refuse('evidence_changed');
  end if;

  if p_currency is distinct from v_pay.currency then
    perform public.payment_exception_refuse('refund_currency_mismatch');
  end if;
  if p_amount is null or p_amount <= 0 then
    perform public.payment_exception_refuse('refund_amount_invalid');
  end if;
  -- The whole of an amount the provider named on this record, or the whole of what was
  -- charged. It may have named several, and only the dashboard says which was received, so
  -- a decision on several needs its own attestation. Once it says paid at our amount, those
  -- no longer stand. A completed payment was paid at its amount, so less than that stays
  -- partial, whatever the provider says now.
  v_named := v_exc.provider_amount is not null
    and (p_amount = v_exc.provider_amount or coalesce(p_amount = any(v_exc.provider_amounts), false));
  if not v_named or v_pay.status = 'completed' then
    if p_amount > v_pay.amount and not v_named then
      perform public.payment_exception_refuse('refund_amount_invalid');
    end if;
    -- Recording a partial refund as settled would close a record while money is
    -- still owed. Refused until the owner decides a policy for it.
    if p_amount < v_pay.amount or (p_amount <> v_pay.amount and coalesce(p_amount < v_exc.provider_amount, false)) then
      perform public.payment_exception_refuse('refund_partial_not_supported');
    end if;
  end if;
  -- Less than the provider's last amount, whether the amount charged or one it named earlier.
  -- That figure may include what never reached us, so a person who checked the dashboard can
  -- say this was all of it. Without that the record stays open.
  if coalesce(p_amount < v_exc.provider_amount, false) and not coalesce(p_attest_charged, false) then
    perform public.payment_exception_refuse('refund_charged_attestation_required');
  end if;
  if p_refunded_at is null or p_refunded_at > now() + interval '5 minutes' or p_refunded_at < v_pay.created_at then
    perform public.payment_exception_refuse('refund_date_invalid');
  end if;

  begin
    update public.payment_exceptions
       set refund_state = 'confirmed', refund_external_reference = v_ref, refund_amount = p_amount,
           refund_currency = p_currency, refund_confirmed_at = p_refunded_at,
           refund_recorded_by = p_actor_id, refund_recorded_at = now(),
           state = 'resolved', resolution = 'refund_confirmed', resolved_at = now(), resolved_by = p_actor_id,
           repeat_alert_due_at = null,
           evidence_overflow_at = null,
           reviewed_fingerprints = evidence_fingerprints,
           last_decision_note = trim(p_note), last_decision_at = now()
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
     where en.user_id = v_pay.user_id
       -- 065: for a pack payment, any course of the pack still open is access still live.
       and (en.course_id = v_pay.course_id
            or en.course_id in (select pc.course_id from public.course_pack_courses pc
                                 where pc.pack_id = v_pay.pack_id))
       and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
  ) into v_live;

  perform public.payment_exception_audit(
    'payment.exception_refund_confirmed', 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel',
    trim(p_note), p_ip, p_user_agent,
    jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
                       'seenVersion', p_seen_version, 'notifications', cardinality(v_exc.evidence_fingerprints),
                       'refundReference', v_ref, 'refundAmount', p_amount, 'refundCurrency', p_currency,
                       'providerAmount', v_exc.provider_amount,
                       'chargedAttested', coalesce(p_attest_charged, false) and coalesce(p_amount < v_exc.provider_amount, false),
                       'refundedAt', p_refunded_at, 'paymentStatusBefore', v_pay.status,
                       'paymentStatusAfter', coalesce(v_moved, v_pay.status), 'accessStillLive', v_live));

  return jsonb_build_object('outcome', 'recorded', 'exceptionId', v_exc.id, 'state', 'resolved',
                            'refundState', 'confirmed', 'accessStillLive', v_live,
                            'paymentStatus', coalesce(v_moved, v_pay.status));
end
$fn$;

create or replace function public.payment_exception_blocking_reference(p_user_id uuid, p_course_id uuid)
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
     -- 065: an exception on a pack payment concerns every course of the pack.
     and (p.course_id = p_course_id
          or p.pack_id in (select pc.pack_id from public.course_pack_courses pc
                            where pc.course_id = p_course_id))
     and p.status <> 'completed'
     -- A report that failed its check proves nothing, so on its own it blocks nobody.
     -- It stays in front of an administrator.
     and not (e.payment_received = 'not_established' and e.last_signal = 'unverified_report')
   order by e.first_reported_at
   limit 1;
$fn$;


-- ══ 7. PRIVILEGES — re-asserted, revoke first ══════════════════════════════
revoke all on function public.payments_offer_guard() from public, anon, authenticated;
revoke all on function public.course_pack_courses_guard() from public, anon, authenticated;
revoke all on function public.complete_payment(text, text, text, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.complete_payment(text, text, text, text, text, numeric, text)
  to service_role;
revoke all on function public.payment_exception_decide(uuid, text, uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.payment_exception_blocking_reference(uuid, uuid) from public, anon, authenticated;
grant execute on function public.payment_exception_decide(uuid, text, uuid, text, text, text, text, integer) to service_role;
grant execute on function public.payment_exception_record_refund(uuid, uuid, text, text, numeric, text, timestamptz, text, text, text, integer, boolean) to service_role;
grant execute on function public.payment_exception_blocking_reference(uuid, uuid) to service_role;


-- ══ 8. ASSERTIONS ══════════════════════════════════════════════════════════
do $chk$
declare
  v_fn  oid := to_regprocedure('public.complete_payment(text, text, text, text, text, numeric, text)');
  v_txt text;
  v_n   integer;
begin
  if exists (select 1 from pg_proc where oid = v_fn and prosecdef) then
    raise exception 'XP-LAUNCH-FINAL-08 065: complete_payment became SECURITY DEFINER';
  end if;
  foreach v_txt in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_txt, v_fn, 'execute') then
      raise exception 'XP-LAUNCH-FINAL-08 065: % may execute complete_payment', v_txt;
    end if;
    if has_table_privilege(v_txt, 'public.payment_entitlements', 'select')
       or has_table_privilege(v_txt, 'public.course_packs', 'insert')
       or has_table_privilege(v_txt, 'public.course_pack_courses', 'insert') then
      raise exception 'XP-LAUNCH-FINAL-08 065: % holds a privilege it must not', v_txt;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception 'XP-LAUNCH-FINAL-08 065: service_role lost EXECUTE on complete_payment';
  end if;
  foreach v_txt in array array['public.course_packs', 'public.course_pack_courses', 'public.payment_entitlements'] loop
    if not exists (select 1 from pg_class where oid = v_txt::regclass and relrowsecurity) then
      raise exception 'XP-LAUNCH-FINAL-08 065: row level security is off on %', v_txt;
    end if;
  end loop;
  select count(*) into v_n from public.course_pack_courses pc
    join public.course_packs p on p.id = pc.pack_id where p.code = 'PACK-CONSEILLER';
  if v_n <> 4 then
    raise exception 'XP-LAUNCH-FINAL-08 065: Pack Conseiller has % course(s), expected 4', v_n;
  end if;
  select count(*) into v_n from public.course_pack_courses pc
    join public.course_packs p on p.id = pc.pack_id where p.code = 'PACK-MANAGER';
  if v_n <> 3 then
    raise exception 'XP-LAUNCH-FINAL-08 065: Pack Manager has % course(s), expected 3', v_n;
  end if;
  if (select price from public.course_packs where code = 'PACK-CONSEILLER') <> 37900
     or (select price from public.course_packs where code = 'PACK-MANAGER') <> 38000 then
    raise exception 'XP-LAUNCH-FINAL-08 065: a pack price is not the decided one';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass
                   and tgname = 'payments_offer_guard' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass
                   and tgname = 'payments_transition_guard' and not tgisinternal) then
    raise exception 'XP-LAUNCH-FINAL-08 065: a payments guard is missing';
  end if;
  if to_regclass('public.payments_one_inflight_intent_per_pack') is null
     or to_regclass('public.payments_one_inflight_intent_per_course') is null then
    raise exception 'XP-LAUNCH-FINAL-08 065: an in-flight index is missing';
  end if;
  -- Nothing existing was touched: no payment carries a pack, nothing was delivered yet.
  if exists (select 1 from public.payments where pack_id is not null)
     or exists (select 1 from public.payment_entitlements) then
    raise exception 'XP-LAUNCH-FINAL-08 065: an existing payment row was changed';
  end if;
end
$chk$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- Apply AFTER 063 and 064, the morning after a COMPLETED nightly backup, with
-- checkout still off. Read back: the two packs and their courses; the guard
-- triggers; select count(*) from public.payment_entitlements = 0.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — removes the packs and the six-month window; restores 062's and
-- 064's functions VERBATIM. Run it WHOLE, BEFORE rolling back 064 or 063.
--
-- It refuses while any payment carries a pack or any completion was recorded
-- here, because dropping the column and the table would lose what was sold.
-- Purchases already granted for six months KEEP their end date: the rollback
-- re-dates nothing.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- lock table public.payments, public.entitlements in share row exclusive mode;
--
-- do $rb$
-- begin
--   if exists (select 1 from public.payments where pack_id is not null)
--      or exists (select 1 from public.payment_entitlements) then
--     raise exception 'XP-LAUNCH-FINAL-08 065 rollback: pack payments or recorded completions exist; settle them first';
--   end if;
-- end
-- $rb$;
--
-- create or replace function public.complete_payment(
--   p_provider           text,
--   p_provider_mode      text,
--   p_provider_token     text,
--   p_provider_reference text,
--   p_reference          text,
--   p_amount             numeric,
--   p_currency           text
-- )
-- returns jsonb
-- language plpgsql
-- security invoker
-- set search_path = public, pg_temp
-- as $fn$
-- declare
--   v_pay       public.payments;
--   v_live      public.entitlements;
--   v_ent_id    uuid;
--   v_ent_ok    boolean;
--   v_preexist  boolean := false;
--   v_review    jsonb   := null;   -- set ONLY on the duplicate-purchase branch
--   v_outcome   text;
--   v_enr       uuid;
-- begin
--   -- ── 1. the caller must supply a complete verified result ─────────────
--   if p_provider is null or p_provider_mode is null or p_provider_token is null
--      or p_reference is null or p_amount is null or p_currency is null then
--     raise exception 'complete_payment: every verified field is required'
--       using errcode = 'P0001',
--             detail  = '{"reason":"missing_argument"}';
--   end if;
--   if btrim(p_provider_token) = '' then
--     raise exception 'complete_payment: provider_token must not be blank'
--       using errcode = 'P0001', detail = '{"reason":"blank_provider_token"}';
--   end if;
--   if p_provider_mode not in ('test', 'live') then
--     raise exception 'complete_payment: provider_mode must be test or live, got %', p_provider_mode
--       using errcode = 'P0001', detail = '{"reason":"bad_provider_mode"}';
--   end if;
--   if p_amount <= 0 then
--     raise exception 'complete_payment: a payment of % is not a payment', p_amount
--       using errcode = 'P0001', detail = '{"reason":"amount_not_positive"}';
--   end if;
--   if p_currency <> 'XOF' then
--     raise exception 'complete_payment: only XOF is supported, got %', p_currency
--       using errcode = 'P0001', detail = '{"reason":"currency_unsupported"}';
--   end if;
--
--   -- ── 2. LOCK the payment, identified by the replay key ────────────────
--   --
--   -- provider_token is UNIQUE (060), so this locks exactly one row and
--   -- serialises concurrent notifications for the same invoice: the second
--   -- waits here, then observes 'completed' below and returns idempotently.
--   --
--   -- A token that matches nothing surfaces as payment_not_found, which is the
--   -- stronger statement than a token mismatch: NO payment carries it. There is
--   -- deliberately no separate token-equality check — the lookup IS the match.
--   select * into v_pay
--     from public.payments
--    where provider_token = p_provider_token
--    for update;
--   if not found then
--     raise exception 'complete_payment: no payment carries that provider token'
--       using errcode = 'P0001', detail = '{"reason":"payment_not_found"}';
--   end if;
--
--   -- ── 3. IDEMPOTENCY — a retried notification is a success, not an error
--   if v_pay.status = 'completed' then
--     if v_pay.entitlement_id is null then
--       raise exception 'complete_payment: payment % is completed but carries no entitlement', v_pay.id
--         using errcode = 'P0001',
--               detail  = jsonb_build_object('reason', 'completed_without_entitlement',
--                                            'paymentId', v_pay.id)::text;
--     end if;
--     return jsonb_build_object(
--       'outcome',       'already_completed',
--       'paymentId',     v_pay.id,
--       'courseId',      v_pay.course_id,
--       'entitlementId', v_pay.entitlement_id);
--   end if;
--
--   -- ── 4. only an in-flight intent may be completed ─────────────────────
--   -- failed, refunded, cancelled and expired are terminal and belong to the
--   -- reconciliation and refund slices. A late confirmation after expiry lands
--   -- here and is refused rather than silently granted.
--   if v_pay.status not in ('pending', 'processing') then
--     raise exception 'complete_payment: payment % is %, which is not completable', v_pay.id, v_pay.status
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'status_not_completable',
--                                          'paymentId', v_pay.id,
--                                          'status', v_pay.status)::text;
--   end if;
--
--   -- ── 5. the stored row must be coherent ───────────────────────────────
--   -- user_id and course_id are NULLABLE on payments, so this is a real case.
--   if v_pay.user_id is null or v_pay.course_id is null then
--     raise exception 'complete_payment: payment % has no learner or no course', v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'payment_identity_incomplete',
--                                          'paymentId', v_pay.id)::text;
--   end if;
--   if v_pay.provider is null or v_pay.provider_mode is null then
--     raise exception 'complete_payment: payment % carries no provider identity', v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'payment_provider_incomplete',
--                                          'paymentId', v_pay.id)::text;
--   end if;
--   if v_pay.amount <= 0 then
--     raise exception 'complete_payment: payment % is recorded as %', v_pay.id, v_pay.amount
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'stored_amount_not_positive',
--                                          'paymentId', v_pay.id)::text;
--   end if;
--
--   -- ── 6. the caller's verified result must AGREE with the stored row ───
--   -- This is the whole of what the database can check: internal consistency
--   -- between what the provider reported and what we recorded when we created
--   -- the intent. It establishes nothing about whether money moved.
--   if v_pay.provider is distinct from p_provider then
--     raise exception 'complete_payment: provider mismatch on payment %', v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'provider_mismatch',
--                                          'paymentId', v_pay.id)::text;
--   end if;
--   if v_pay.provider_mode is distinct from p_provider_mode then
--     raise exception 'complete_payment: provider mode mismatch on payment % (stored %, verified %)',
--       v_pay.id, v_pay.provider_mode, p_provider_mode
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'provider_mode_mismatch',
--                                          'paymentId', v_pay.id,
--                                          'stored', v_pay.provider_mode,
--                                          'verified', p_provider_mode)::text;
--   end if;
--   if v_pay.reference is distinct from p_reference then
--     raise exception 'complete_payment: reference mismatch on payment %', v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'reference_mismatch',
--                                          'paymentId', v_pay.id)::text;
--   end if;
--   if v_pay.amount is distinct from p_amount then
--     raise exception 'complete_payment: amount mismatch on payment % (stored %, verified %)',
--       v_pay.id, v_pay.amount, p_amount
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'amount_mismatch',
--                                          'paymentId', v_pay.id,
--                                          'stored', v_pay.amount,
--                                          'verified', p_amount)::text;
--   end if;
--   if v_pay.currency is distinct from p_currency then
--     raise exception 'complete_payment: currency mismatch on payment %', v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'currency_mismatch',
--                                          'paymentId', v_pay.id,
--                                          'stored', v_pay.currency,
--                                          'verified', p_currency)::text;
--   end if;
--
--   -- ── 7. THE ENTITLEMENT STATE ─────────────────────────────────────────
--   --
--   -- At most one entitlement can be live for a (learner, course) pair —
--   -- entitlements_one_live_per_course_idx enforces it over PENDING, ACTIVE and
--   -- SUSPENDED. Lock it so a concurrent admin transition cannot move it under
--   -- this transaction.
--   select * into v_live
--     from public.entitlements
--    where user_id = v_pay.user_id
--      and course_id = v_pay.course_id
--      and status in ('PENDING', 'ACTIVE', 'SUSPENDED')
--    for update;
--
--   if found then
--     -- Judged by 037's own definition, which collapses three cases into one:
--     -- PENDING and SUSPENDED are not accessible, and neither is an ACTIVE
--     -- entitlement whose window has not opened or has already closed.
--     v_ent_ok := public.entitlement_accessible(
--       v_live.status, v_live.starts_at, v_live.expires_at, v_live.revoked_at);
--
--     if not v_ent_ok then
--       -- FAIL CLOSED. The learner would be charged for access they do not have,
--       -- and the live index forbids granting a second entitlement alongside it.
--       -- A human must resolve this; nothing is written.
--       raise exception 'complete_payment: learner already holds a % entitlement for this course that does not grant access', v_live.status
--         using errcode = 'P0001',
--               detail  = jsonb_build_object('reason', 'entitlement_conflict',
--                                            'paymentId', v_pay.id,
--                                            'courseId', v_pay.course_id,
--                                            'existingEntitlementId', v_live.id,
--                                            'existingStatus', v_live.status,
--                                            'existingSource', v_live.source)::text;
--     end if;
--
--     -- ── A DUPLICATE PURCHASE. The policy, in full ────────────────────
--     --
--     -- An accessible entitlement already exists — typically a MANUAL_ADMIN or
--     -- CORPORATE_LICENSE grant. The learner has paid for access they already
--     -- hold. Five things follow, each deliberate:
--     --
--     --   1. The payment IS completed. The provider has the money; recording it
--     --      as anything else would make our ledger disagree with PayDunya's,
--     --      which is the worst outcome for reconciliation. Refusing would leave
--     --      a 'pending' row against a real collection.
--     --   2. NO second entitlement is created. The live partial unique index
--     --      forbids it, and a second grant would confer nothing anyway.
--     --   3. The existing entitlement is LINKED, never replaced, reactivated or
--     --      re-dated. Its source, window and provenance are untouched.
--     --   4. NO automatic refund. Whether to refund is commercial, and a
--     --      database function is the wrong place to decide it.
--     --   5. It is NOT presented as an ordinary sale. This is the part that
--     --      needed correcting: marking it only in the audit row and the return
--     --      value left `payments` indistinguishable from a normal purchase, and
--     --      the admin dashboard computes revenue as
--     --      `sum(amount) where status = 'completed'` — so a double-sale would
--     --      have been silently counted as new revenue. The marker below lands
--     --      on the payment row itself, in `metadata`: a jsonb column 059
--     --      withholds from every browser role, so it needs no schema change and
--     --      cannot leak to a learner.
--     --
--     -- Prevention belongs upstream: the checkout slice must refuse to create an
--     -- intent for a course the learner already has live access to. This branch
--     -- is the safety net for the race that remains — access granted between
--     -- intent and confirmation — not the intended path.
--     v_preexist := true;
--     v_ent_id   := v_live.id;
--     v_outcome  := 'completed_preexisting_entitlement';
--     -- Built HERE, where v_live is assigned. Referencing v_live from the UPDATE
--     -- below would evaluate it on the ordinary branch too, where the record is
--     -- unassigned and would raise.
--     v_review := jsonb_build_object(
--       'reason',                'preexisting_entitlement',
--       'existingEntitlementId', v_live.id,
--       'existingSource',        v_live.source,
--       'existingStatus',        v_live.status,
--       'requiresReview',        true);
--   else
--     -- A REVOKED entitlement is terminal and sits OUTSIDE the live index, so a
--     -- new grant would succeed. It is refused anyway: re-selling access to a
--     -- learner whose access was deliberately revoked needs an explicit business
--     -- rule, and there is none. EXPIRED and CANCELLED are benign and fall
--     -- through to the normal grant below.
--     if exists (
--       select 1 from public.entitlements
--        where user_id = v_pay.user_id and course_id = v_pay.course_id
--          and status = 'REVOKED'
--     ) then
--       raise exception 'complete_payment: this learner''s access to this course was REVOKED; automatic repurchase is not authorised'
--         using errcode = 'P0001',
--               detail  = jsonb_build_object('reason', 'entitlement_revoked_requires_decision',
--                                            'paymentId', v_pay.id,
--                                            'courseId', v_pay.course_id)::text;
--     end if;
--
--     -- ── grant exactly ONE entitlement ──────────────────────────────────
--     -- No expires_at: a purchase is perpetual, and entitlements_expiry_required
--     -- does not name INDIVIDUAL_PURCHASE. No granted_by: there is no human
--     -- actor, and inventing one would corrupt the audit trail. external_ref
--     -- carries OUR reference, never the provider token.
--     begin
--       insert into public.entitlements (
--         user_id, course_id, source, status,
--         starts_at, expires_at, revoked_at,
--         granted_by, granted_reason, external_ref, organization_id
--       ) values (
--         v_pay.user_id, v_pay.course_id, 'INDIVIDUAL_PURCHASE', 'ACTIVE',
--         now(), null, null,
--         null, 'INDIVIDUAL_PURCHASE ' || v_pay.reference, v_pay.reference, null
--       )
--       returning id into v_ent_id;
--     exception
--       when unique_violation then
--         -- entitlements_one_live_per_course_idx fired: another transaction
--         -- granted a live entitlement for this pair between the SELECT above and
--         -- this INSERT. Re-raised, so everything rolls back; the caller retries
--         -- and the retry takes the pre-existing-entitlement branch.
--         raise exception 'complete_payment: a live entitlement for this learner and course appeared concurrently'
--           using errcode = 'P0001',
--                 detail  = jsonb_build_object('reason', 'entitlement_race',
--                                              'paymentId', v_pay.id,
--                                              'courseId', v_pay.course_id)::text;
--     end;
--     v_outcome := 'completed';
--   end if;
--
--   -- ── 8. DELIVERY IS VERIFIED, NOT ASSUMED ─────────────────────────────
--   -- Re-read the entitlement that will be linked and assert it actually grants
--   -- access, by 037's definition. This is what makes "a completed payment
--   -- without entitlement delivery" impossible rather than merely unintended.
--   select public.entitlement_accessible(e.status, e.starts_at, e.expires_at, e.revoked_at)
--     into v_ent_ok
--     from public.entitlements e where e.id = v_ent_id;
--   if v_ent_ok is distinct from true then
--     raise exception 'complete_payment: entitlement % does not grant access; refusing to complete payment %', v_ent_id, v_pay.id
--       using errcode = 'P0001',
--             detail  = jsonb_build_object('reason', 'entitlement_not_accessible',
--                                          'paymentId', v_pay.id,
--                                          'entitlementId', v_ent_id)::text;
--   end if;
--
--   -- ── 9. the academic record, WITHOUT disturbing existing progress ─────
--   -- An existing enrollment carries the learner's participation history, so it
--   -- is never overwritten — not even its payment_id. The untargeted
--   -- `on conflict do nothing` is correct whether the unique index on
--   -- (user_id, course_id) is total or partial; a targeted one would raise 42P10
--   -- against a partial index.
--   select id into v_enr
--     from public.enrollments
--    where user_id = v_pay.user_id and course_id = v_pay.course_id;
--   if v_enr is null then
--     insert into public.enrollments (user_id, course_id, payment_id, status)
--     values (v_pay.user_id, v_pay.course_id, v_pay.id, 'active')
--     on conflict do nothing;
--   end if;
--
--   -- ── 10. mark the payment completed and LINK the entitlement ──────────
--   -- `metadata` is merged, never replaced, and ONLY on the duplicate branch: an
--   -- ordinary completion leaves it exactly as the intent left it. v_review is
--   -- NULL on every other path, so the CASE never evaluates v_live.
--   update public.payments
--      set status             = 'completed',
--          completed_at       = now(),
--          entitlement_id     = v_ent_id,
--          provider_reference = coalesce(p_provider_reference, provider_reference),
--          metadata           = case
--                                 when v_review is null then metadata
--                                 else coalesce(metadata, '{}'::jsonb)
--                                      || jsonb_build_object('completionReview', v_review)
--                               end
--    where id = v_pay.id;
--
--   -- ── 11. AUDIT EVIDENCE — no handler, so a failure here rolls back all
--   -- NEVER the provider token, never a credential, never a provider payload.
--   -- 059 withholds provider_token from every browser role; copying it into a
--   -- table an administrator can read would defeat that.
--   insert into public.audit_log (
--     event_type, actor_type, outcome, method, subject_user_id, metadata
--   ) values (
--     'payment.completed', 'system', 'success', 'provider_confirm', v_pay.user_id,
--     jsonb_build_object(
--       'paymentId',              v_pay.id,
--       'courseId',               v_pay.course_id,
--       'entitlementId',          v_ent_id,
--       'reference',              v_pay.reference,
--       'provider',               v_pay.provider,
--       'providerMode',           v_pay.provider_mode,
--       'amount',                 v_pay.amount,
--       'currency',               v_pay.currency,
--       'preExistingEntitlement', v_preexist,
--       'requiresReview',         v_preexist,
--       'completionReview',       v_review,
--       'enrollmentCreated',      (v_enr is null),
--       'source',                 'complete_payment',
--       'txid',                   txid_current()::text)
--   );
--
--   return jsonb_build_object(
--     'outcome',                v_outcome,
--     'paymentId',              v_pay.id,
--     'courseId',               v_pay.course_id,
--     'entitlementId',          v_ent_id,
--     'preExistingEntitlement', v_preexist);
-- end
-- $fn$;
--
-- create or replace function public.payment_exception_decide(
--   p_exception_id uuid,
--   p_action       text,
--   p_actor_id     uuid,
--   p_actor_email  text,
--   p_note         text,
--   p_ip           text default null,
--   p_user_agent   text default null,
--   -- The version of the record the administrator was shown. Without it nothing says what
--   -- this decision covers, so it is refused.
--   p_seen_version integer default null
-- )
-- returns jsonb
-- language plpgsql
-- security definer
-- set search_path = pg_catalog, pg_temp
-- as $fn$
-- declare
--   v_payment_id uuid;
--   v_pay   public.payments%rowtype;
--   v_exc   public.payment_exceptions%rowtype;
--   v_ent   uuid;
--   v_event text;
--   v_confirmed boolean;
-- begin
--   if p_action is null or p_action not in ('confirm_received', 'withdraw_receipt', 'dismiss', 'require_refund',
--                                           'withdraw_refund', 'record_access', 'acknowledge_report',
--                                           'reopen_after_review') then
--     perform public.payment_exception_refuse('invalid_action');
--   end if;
--   if p_actor_id is null then
--     perform public.payment_exception_refuse('actor_required');
--   end if;
--   if p_note is null or length(trim(p_note)) not between 10 and 500 then
--     perform public.payment_exception_refuse('note_required');
--   end if;
--   if p_seen_version is null then
--     perform public.payment_exception_refuse('evidence_version_required');
--   end if;
--
--   select e.payment_id into v_payment_id from public.payment_exceptions e where e.id = p_exception_id;
--   if v_payment_id is null then
--     perform public.payment_exception_refuse('exception_not_found');
--   end if;
--   select * into v_pay from public.payments where id = v_payment_id for update;
--   select * into v_exc from public.payment_exceptions where id = p_exception_id for update;
--
--   -- The two decisions a resolved record can take. Neither changes a settled fact.
--   if p_action = 'acknowledge_report' then
--     if v_exc.post_settlement_report_at is null and v_exc.repeat_count = 0 then
--       perform public.payment_exception_refuse('no_report_to_review');
--     end if;
--   elsif p_action = 'reopen_after_review' then
--     if v_exc.state <> 'resolved' then
--       perform public.payment_exception_refuse('exception_not_resolved');
--     end if;
--   elsif v_exc.state <> 'open' then
--     perform public.payment_exception_refuse('exception_not_open');
--   end if;
--   -- A decision covers what the administrator was shown. Whatever has changed since must be
--   -- read first, or it would pass unseen.
--   if p_seen_version <> v_exc.evidence_version then
--     perform public.payment_exception_refuse('evidence_changed');
--   end if;
--   v_confirmed := v_exc.payment_received in ('confirmed_by_operator', 'confirmed_by_provider');
--
--   case p_action
--     when 'acknowledge_report' then
--       update public.payment_exceptions
--          set post_settlement_report_at = null, repeat_count = 0,
--              administrator_flagged_at = null,
--              repeat_alert_due_at = null,
--              different_report_at = null, different_signal = null,
--              evidence_overflow_at = null,
--              reviewed_fingerprints = evidence_fingerprints
--        where id = v_exc.id;
--       v_event := 'payment.exception_settlement_report_reviewed';
--
--     -- An administrator found money this record does not cover, on a dashboard or a
--     -- statement, whether or not any notification came again. A record holding no
--     -- settled fact opens again. Settled facts stay final, so it is flagged instead. So
--     -- is a completed payment: the money found is a different payment, and opening this
--     -- record would invite a refund that closes the legitimate one as refunded. The
--     -- exception is a completed payment the provider's last word still questions, where a
--     -- dismissal may have been the mistake. What it took back does not count.
--     when 'reopen_after_review' then
--       if v_exc.resolution in ('nothing_to_return', 'settled_normally')
--          and (v_pay.status <> 'completed' or v_exc.provider_answer is not null or v_exc.provider_amount is not null) then
--         update public.payment_exceptions
--            set state = 'open', resolution = null, resolved_at = null, resolved_by = null,
--                refund_state = 'not_assessed', escalated_at = null, alert_sent_at = null,
--                administrator_reopened_at = now(),
--                payment_received = case when payment_received in ('not_received', 'not_established') then 'reported' else payment_received end,
--                repeat_count = 0, repeat_alert_due_at = null, different_report_at = null, different_signal = null,
--                reviewed_fingerprints = '{}'
--          where id = v_exc.id;
--       else
--         update public.payment_exceptions
--            set post_settlement_report_at = now(), alert_sent_at = null,
--                administrator_flagged_at = now(),
--                -- A flag raised again changes no value a clock can be trusted to tell apart.
--                evidence_version = evidence_version + 1,
--                repeat_count = 0, repeat_alert_due_at = null, different_report_at = null, different_signal = null
--          where id = v_exc.id;
--       end if;
--       v_event := 'payment.exception_reopened_by_administrator';
--
--     when 'confirm_received' then
--       if v_confirmed then
--         perform public.payment_exception_refuse('receipt_already_confirmed');
--       end if;
--       update public.payment_exceptions
--          set payment_received = 'confirmed_by_operator', evidence_before_confirmation = payment_received
--        where id = v_exc.id;
--       v_event := 'payment.exception_receipt_confirmed';
--
--     -- An administrator's correction of their own statement. What PayTech confirmed
--     -- cannot be withdrawn, and neither can a confirmation a refund decision rests on.
--     when 'withdraw_receipt' then
--       if v_exc.payment_received <> 'confirmed_by_operator' then
--         perform public.payment_exception_refuse('receipt_not_operator_confirmed');
--       end if;
--       if v_exc.refund_state <> 'not_assessed' then
--         perform public.payment_exception_refuse('refund_already_decided');
--       end if;
--       update public.payment_exceptions
--          set payment_received = coalesce(evidence_before_confirmation, 'reported'), evidence_before_confirmation = null
--        where id = v_exc.id;
--       v_event := 'payment.exception_receipt_withdrawn';
--
--     when 'dismiss' then
--       if v_exc.refund_state <> 'not_assessed' then
--         perform public.payment_exception_refuse('refund_already_decided');
--       end if;
--       -- A completed payment is legitimately held, so reviewing it and finding
--       -- nothing wrong says nothing against it. Anywhere else, money that was
--       -- confirmed received cannot be waved away. Only a CLOSED payment can be
--       -- recorded as not received: an in-flight one may still settle. The exception is money
--       -- the provider confirmed, when its last word is that it was not paid or can still be
--       -- paid, or proves nothing while no amount it named stands. What it confirmed stays on
--       -- the record, and a person who checked the dashboard may decide between the two.
--       if v_pay.status <> 'completed' and v_confirmed
--          and not (v_exc.payment_received = 'confirmed_by_provider'
--                   and coalesce(v_exc.provider_answer in ('provider_not_paid', 'provider_pending')
--                                or (v_exc.provider_answer in ('settlement_amount_mismatch', 'settlement_amount_unreadable', 'settlement_status_unrecognised')
--                                    and v_exc.provider_amount is null), false)) then
--         perform public.payment_exception_refuse('payment_confirmed_cannot_dismiss');
--       end if;
--       update public.payment_exceptions
--          set state = 'resolved', resolution = 'nothing_to_return', resolved_at = now(), resolved_by = p_actor_id,
--              refund_state = 'not_required',
--              repeat_alert_due_at = null,
--              evidence_overflow_at = null,
--              reviewed_fingerprints = evidence_fingerprints,
--              payment_received = case when v_pay.status in ('completed', 'pending', 'processing')
--                                        or payment_received = 'confirmed_by_provider' then payment_received
--                                      else 'not_received' end
--        where id = v_exc.id;
--       v_event := 'payment.exception_dismissed';
--
--     when 'require_refund' then
--       if not v_confirmed then
--         perform public.payment_exception_refuse('receipt_not_confirmed');
--       end if;
--       if v_exc.refund_state <> 'not_assessed' then
--         perform public.payment_exception_refuse('refund_already_decided');
--       end if;
--       update public.payment_exceptions set refund_state = 'required' where id = v_exc.id;
--       v_event := 'payment.exception_refund_required';
--
--     -- A mistaken decision must not block a learner's checkout for good.
--     when 'withdraw_refund' then
--       if v_exc.refund_state <> 'required' then
--         perform public.payment_exception_refuse('refund_not_required');
--       end if;
--       update public.payment_exceptions set refund_state = 'not_assessed' where id = v_exc.id;
--       v_event := 'payment.exception_refund_withdrawn';
--
--     when 'record_access' then
--       if not v_confirmed then
--         perform public.payment_exception_refuse('receipt_not_confirmed');
--       end if;
--       if v_exc.refund_state <> 'not_assessed' then
--         perform public.payment_exception_refuse('refund_already_decided');
--       end if;
--       -- Records an access decision. It grants nothing: an entitlement must
--       -- already exist, created through Admin > Accès under its own audit.
--       select en.id into v_ent from public.entitlements en
--        where en.user_id = v_pay.user_id and en.course_id = v_pay.course_id
--          and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
--        order by en.created_at desc limit 1;
--       if v_ent is null then
--         perform public.payment_exception_refuse('no_live_entitlement');
--       end if;
--       update public.payment_exceptions
--          set state = 'resolved', resolution = 'access_honoured', resolved_at = now(), resolved_by = p_actor_id,
--              access_state = 'granted', access_entitlement_id = v_ent, refund_state = 'not_required',
--              repeat_alert_due_at = null,
--              evidence_overflow_at = null,
--              reviewed_fingerprints = evidence_fingerprints
--        where id = v_exc.id;
--       v_event := 'payment.exception_access_recorded';
--   end case;
--
--   update public.payment_exceptions
--      set last_decision_note = trim(p_note), last_decision_at = now()
--    where id = p_exception_id
--   returning * into v_exc;
--
--   perform public.payment_exception_audit(
--     v_event, 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel', trim(p_note), p_ip, p_user_agent,
--     jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
--                        'action', p_action, 'seenVersion', p_seen_version, 'notifications', cardinality(v_exc.evidence_fingerprints),
--                        'state', v_exc.state, 'paymentReceived', v_exc.payment_received,
--                        'refundState', v_exc.refund_state, 'accessState', v_exc.access_state));
--
--   return jsonb_build_object('outcome', p_action, 'exceptionId', v_exc.id, 'state', v_exc.state,
--                             'paymentReceived', v_exc.payment_received, 'refundState', v_exc.refund_state,
--                             'accessState', v_exc.access_state);
-- end
-- $fn$;
--
-- create or replace function public.payment_exception_record_refund(
--   p_exception_id       uuid,
--   p_actor_id           uuid,
--   p_actor_email        text,
--   p_external_reference text,
--   p_amount             numeric,
--   p_currency           text,
--   p_refunded_at        timestamptz,
--   p_note               text,
--   p_ip                 text default null,
--   p_user_agent         text default null,
--   p_seen_version       integer default null,
--   p_attest_charged     boolean default false
-- )
-- returns jsonb
-- language plpgsql
-- security definer
-- set search_path = pg_catalog, pg_temp
-- as $fn$
-- declare
--   v_payment_id uuid;
--   v_ref   text := trim(coalesce(p_external_reference, ''));
--   v_pay   public.payments%rowtype;
--   v_exc   public.payment_exceptions%rowtype;
--   v_live  boolean;
--   v_moved text;
--   v_named boolean;
-- begin
--   if p_actor_id is null then
--     perform public.payment_exception_refuse('actor_required');
--   end if;
--   if p_note is null or length(trim(p_note)) not between 10 and 500 then
--     perform public.payment_exception_refuse('note_required');
--   end if;
--   if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{2,119}$' then
--     perform public.payment_exception_refuse('refund_reference_invalid');
--   end if;
--
--   select e.payment_id into v_payment_id from public.payment_exceptions e where e.id = p_exception_id;
--   if v_payment_id is null then
--     perform public.payment_exception_refuse('exception_not_found');
--   end if;
--   select * into v_pay from public.payments where id = v_payment_id for update;
--   select * into v_exc from public.payment_exceptions where id = p_exception_id for update;
--
--   -- The same refund recorded twice is not a second refund.
--   if v_exc.refund_state = 'confirmed' then
--     if v_exc.refund_external_reference = v_ref then
--       perform public.payment_exception_audit(
--         'payment.exception_refund_repeated', 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel',
--         trim(p_note), p_ip, p_user_agent,
--         jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id, 'refundReference', v_ref));
--       return jsonb_build_object('outcome', 'already_recorded', 'exceptionId', v_exc.id, 'state', v_exc.state,
--                                 'refundState', v_exc.refund_state);
--     end if;
--     perform public.payment_exception_refuse('refund_already_recorded');
--   end if;
--
--   if v_exc.state <> 'open' then
--     perform public.payment_exception_refuse('exception_not_open');
--   end if;
--   if v_exc.refund_state <> 'required' then
--     perform public.payment_exception_refuse('refund_not_required');
--   end if;
--   if p_seen_version is null then
--     perform public.payment_exception_refuse('evidence_version_required');
--   end if;
--   if p_seen_version <> v_exc.evidence_version then
--     perform public.payment_exception_refuse('evidence_changed');
--   end if;
--
--   if p_currency is distinct from v_pay.currency then
--     perform public.payment_exception_refuse('refund_currency_mismatch');
--   end if;
--   if p_amount is null or p_amount <= 0 then
--     perform public.payment_exception_refuse('refund_amount_invalid');
--   end if;
--   -- The whole of an amount the provider named on this record, or the whole of what was
--   -- charged. It may have named several, and only the dashboard says which was received, so
--   -- a decision on several needs its own attestation. Once it says paid at our amount, those
--   -- no longer stand. A completed payment was paid at its amount, so less than that stays
--   -- partial, whatever the provider says now.
--   v_named := v_exc.provider_amount is not null
--     and (p_amount = v_exc.provider_amount or coalesce(p_amount = any(v_exc.provider_amounts), false));
--   if not v_named or v_pay.status = 'completed' then
--     if p_amount > v_pay.amount and not v_named then
--       perform public.payment_exception_refuse('refund_amount_invalid');
--     end if;
--     -- Recording a partial refund as settled would close a record while money is
--     -- still owed. Refused until the owner decides a policy for it.
--     if p_amount < v_pay.amount or (p_amount <> v_pay.amount and coalesce(p_amount < v_exc.provider_amount, false)) then
--       perform public.payment_exception_refuse('refund_partial_not_supported');
--     end if;
--   end if;
--   -- Less than the provider's last amount, whether the amount charged or one it named earlier.
--   -- That figure may include what never reached us, so a person who checked the dashboard can
--   -- say this was all of it. Without that the record stays open.
--   if coalesce(p_amount < v_exc.provider_amount, false) and not coalesce(p_attest_charged, false) then
--     perform public.payment_exception_refuse('refund_charged_attestation_required');
--   end if;
--   if p_refunded_at is null or p_refunded_at > now() + interval '5 minutes' or p_refunded_at < v_pay.created_at then
--     perform public.payment_exception_refuse('refund_date_invalid');
--   end if;
--
--   begin
--     update public.payment_exceptions
--        set refund_state = 'confirmed', refund_external_reference = v_ref, refund_amount = p_amount,
--            refund_currency = p_currency, refund_confirmed_at = p_refunded_at,
--            refund_recorded_by = p_actor_id, refund_recorded_at = now(),
--            state = 'resolved', resolution = 'refund_confirmed', resolved_at = now(), resolved_by = p_actor_id,
--            repeat_alert_due_at = null,
--            evidence_overflow_at = null,
--            reviewed_fingerprints = evidence_fingerprints,
--            last_decision_note = trim(p_note), last_decision_at = now()
--      where id = v_exc.id;
--   exception when unique_violation then
--     perform public.payment_exception_refuse('refund_reference_reused');
--   end;
--
--   -- Only the moves 063 permits. A closed payment stays exactly as it is.
--   if v_pay.status in ('pending', 'processing') then
--     update public.payments set status = 'failed', failure_reason = 'exception_refund_confirmed' where id = v_pay.id;
--     v_moved := 'failed';
--   elsif v_pay.status = 'completed' then
--     update public.payments set status = 'refunded' where id = v_pay.id;
--     v_moved := 'refunded';
--   end if;
--
--   select exists (
--     select 1 from public.entitlements en
--      where en.user_id = v_pay.user_id and en.course_id = v_pay.course_id
--        and public.entitlement_accessible(en.status, en.starts_at, en.expires_at, en.revoked_at)
--   ) into v_live;
--
--   perform public.payment_exception_audit(
--     'payment.exception_refund_confirmed', 'admin', p_actor_id, p_actor_email, v_pay.user_id, 'admin_panel',
--     trim(p_note), p_ip, p_user_agent,
--     jsonb_build_object('paymentId', v_pay.id, 'reference', v_pay.reference, 'exceptionId', v_exc.id,
--                        'seenVersion', p_seen_version, 'notifications', cardinality(v_exc.evidence_fingerprints),
--                        'refundReference', v_ref, 'refundAmount', p_amount, 'refundCurrency', p_currency,
--                        'providerAmount', v_exc.provider_amount,
--                        'chargedAttested', coalesce(p_attest_charged, false) and coalesce(p_amount < v_exc.provider_amount, false),
--                        'refundedAt', p_refunded_at, 'paymentStatusBefore', v_pay.status,
--                        'paymentStatusAfter', coalesce(v_moved, v_pay.status), 'accessStillLive', v_live));
--
--   return jsonb_build_object('outcome', 'recorded', 'exceptionId', v_exc.id, 'state', 'resolved',
--                             'refundState', 'confirmed', 'accessStillLive', v_live,
--                             'paymentStatus', coalesce(v_moved, v_pay.status));
-- end
-- $fn$;
--
-- create or replace function public.payment_exception_blocking_reference(p_user_id uuid, p_course_id uuid)
-- returns text
-- language sql
-- stable
-- security invoker
-- set search_path = pg_catalog, pg_temp
-- as $fn$
--   select p.reference
--     from public.payment_exceptions e
--     join public.payments p on p.id = e.payment_id
--    where (e.state = 'open' or e.post_settlement_report_at is not null)
--      and p.user_id = p_user_id
--      and p.course_id = p_course_id
--      and p.status <> 'completed'
--      -- A report that failed its check proves nothing, so on its own it blocks nobody.
--      -- It stays in front of an administrator.
--      and not (e.payment_received = 'not_established' and e.last_signal = 'unverified_report')
--    order by e.first_reported_at
--    limit 1;
-- $fn$;
--
-- drop trigger if exists payments_offer_guard on public.payments;
-- drop function if exists public.payments_offer_guard();
-- drop trigger if exists course_pack_courses_guard on public.course_pack_courses;
-- drop function if exists public.course_pack_courses_guard();
-- drop table if exists public.payment_entitlements;
-- drop index if exists public.payments_one_inflight_intent_per_pack;
-- alter table public.payments drop constraint if exists payments_one_product;
-- alter table public.payments drop column if exists pack_id;
-- drop table if exists public.course_pack_courses;
-- drop table if exists public.course_packs;
--
-- do $rb$
-- begin
--   if to_regclass('public.course_packs') is not null or to_regclass('public.payment_entitlements') is not null then
--     raise exception 'XP-LAUNCH-FINAL-08 065 rollback: a table survived';
--   end if;
--   if exists (select 1 from pg_trigger where tgrelid = 'public.payments'::regclass and tgname = 'payments_offer_guard') then
--     raise exception 'XP-LAUNCH-FINAL-08 065 rollback: the guard survived';
--   end if;
-- end
-- $rb$;
--
-- commit;
