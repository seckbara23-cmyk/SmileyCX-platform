-- ============================================================================
-- Migration 067 — XP-PAYTECH-P7: commercial price audit and confirmation.
--
-- Run as a SINGLE TRANSACTION. Forward-only. Writes no data row.
-- ⚠ NOT APPLIED AT AUTHORING TIME. Apply only with the owner's authorization.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- Checkout charges public.courses.price and public.course_packs.price. Before
-- this migration a price could change with no trace at all: no trigger watched
-- the column, and the course editor audited publication only. A published price
-- could therefore change, and be charged, without anyone being able to say who
-- changed it or why.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--
--   1. public.commercial_price_changes — an APPEND-ONLY record of every price,
--      currency or free-flag change of a course or a pack, written by the
--      database itself. Old and new values, the item, the time, the actor as far
--      as the database can establish it, and the database session that wrote it.
--      No role may update, delete or truncate it (a trigger refuses even the
--      owner); browser roles cannot read it; service_role may only read it.
--
--   2. A GUARD on published items. A change of price, currency or free flag on a
--      course or pack that is published (before or after the change) is REFUSED
--      unless it is made through public.admin_change_commercial_price() in the
--      same statement. Unpublished drafts stay freely editable, and audited.
--
--   3. public.admin_change_commercial_price() — the ONE way to change a
--      published price. service_role only. It checks IN THE DATABASE that the
--      actor is an active platform administrator, that the price is still the
--      one the operator saw (no lost update), that the new price is a valid
--      whole FCFA amount and that a reason is given. It confirms exactly one
--      item at exactly one price, and clears the confirmation afterwards.
--
-- ── WHO IS RECORDED, AND WHY IT CANNOT BE FORGED FROM A BROWSER ────────────
--
--   * admin_rpc     the server action passes the administrator from its own
--                   verified session, and the database re-checks that identity
--                   against profiles; nothing comes from the form.
--   * jwt           a change made through PostgREST with a user token.
--   * unattributed  anything else, for instance the SQL editor.
-- In every case db_session_user and jwt_role are read by the database from the
-- connection, so a change made outside the application is visible as such.
-- ============================================================================

begin;

-- ══ 0. PREFLIGHT ═══════════════════════════════════════════════════════════
do $pre$
begin
  if to_regclass('public.courses') is null or to_regclass('public.course_packs') is null
     or to_regclass('public.profiles') is null then
    raise exception '067 preflight: courses, course_packs and profiles must exist';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'courses'
         and column_name in ('id', 'code', 'price', 'currency', 'is_free', 'is_published', 'updated_at')) <> 7 then
    raise exception '067 preflight: public.courses is missing a pricing column';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'course_packs'
         and column_name in ('id', 'code', 'price', 'currency', 'is_published', 'updated_at')) <> 6 then
    raise exception '067 preflight: public.course_packs is missing a pricing column';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name in ('id', 'platform_role', 'account_status')) <> 3 then
    raise exception '067 preflight: public.profiles is missing platform_role or account_status';
  end if;
  if to_regclass('public.commercial_price_changes') is not null then
    raise exception '067 preflight: public.commercial_price_changes already exists';
  end if;
end
$pre$;


-- ══ 1. THE APPEND-ONLY RECORD ═══════════════════════════════════════════════
create table public.commercial_price_changes (
  id               bigint      generated always as identity primary key,
  occurred_at      timestamptz not null default clock_timestamp(),
  item_kind        text        not null check (item_kind in ('course', 'pack')),
  item_id          uuid        not null,                -- no FK: the record outlives a deleted item
  item_code        text,
  operation        text        not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  old_price        numeric(10,2),
  new_price        numeric(10,2),
  old_currency     text,
  new_currency     text,
  old_is_free      boolean,
  new_is_free      boolean,
  was_published    boolean,
  is_published     boolean,
  confirmed        boolean     not null,
  actor_id         uuid,
  actor_email      text,
  actor_source     text        not null check (actor_source in ('admin_rpc', 'jwt', 'unattributed')),
  reason           text,
  db_session_user  text        not null,
  jwt_role         text,
  application_name text,
  txid             text        not null
);

comment on table public.commercial_price_changes is
  'XP-PAYTECH-P7 (067). Every change of a course or pack price, currency or free flag, written by trigger. Append-only for every role.';

create index commercial_price_changes_item_idx on public.commercial_price_changes (item_kind, item_id, occurred_at desc);
create index commercial_price_changes_time_idx on public.commercial_price_changes (occurred_at desc);

create or replace function public.commercial_price_changes_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'commercial_price_changes is append-only' using errcode = '42501';
end
$fn$;

create trigger commercial_price_changes_no_rewrite
  before update or delete on public.commercial_price_changes
  for each row execute function public.commercial_price_changes_append_only();

create trigger commercial_price_changes_no_truncate
  before truncate on public.commercial_price_changes
  for each statement execute function public.commercial_price_changes_append_only();

alter table public.commercial_price_changes enable row level security;
-- No policy: browser roles read nothing. service_role bypasses RLS and may only SELECT.
revoke all on table public.commercial_price_changes from public, anon, authenticated, service_role;
grant select on table public.commercial_price_changes to service_role;
revoke all on sequence public.commercial_price_changes_id_seq from public, anon, authenticated, service_role;


-- ══ 2. THE WITNESS: every commercial change is written down ═══════════════
create or replace function public.audit_commercial_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old       jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new       jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row       jsonb;
  v_kind      text  := case tg_table_name when 'courses' then 'course' else 'pack' end;
  v_claims    jsonb;
  v_jwt_actor uuid;
  v_jwt_email text;
  v_jwt_role  text;
  v_actor     uuid;
  v_email     text;
  v_reason    text;
  v_source    text  := 'unattributed';
  v_confirmed boolean;
begin
  v_row := coalesce(v_new, v_old);

  -- Attribution is best effort and must never suppress the record (053's rule).
  begin
    v_claims    := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_jwt_actor := nullif(v_claims ->> 'sub', '')::uuid;
    v_jwt_email := nullif(v_claims ->> 'email', '');
    v_jwt_role  := nullif(v_claims ->> 'role', '');
  exception
    when query_canceled or admin_shutdown then raise;
    when others then v_jwt_role := 'unparseable';
  end;

  v_confirmed := current_setting('xp.price_confirm_kind', true) is not distinct from v_kind
             and current_setting('xp.price_confirm_id', true) is not distinct from (v_row ->> 'id');

  if v_confirmed then
    begin
      v_actor := nullif(current_setting('xp.price_actor_id', true), '')::uuid;
    exception
      when query_canceled or admin_shutdown then raise;
      when others then v_actor := null;
    end;
    v_email  := nullif(current_setting('xp.price_actor_email', true), '');
    v_reason := nullif(current_setting('xp.price_reason', true), '');
    v_source := 'admin_rpc';
  elsif v_jwt_actor is not null then
    v_actor  := v_jwt_actor;
    v_email  := v_jwt_email;
    v_source := 'jwt';
  end if;

  -- Deliberately NOT guarded: a failed witness fails the change.
  insert into public.commercial_price_changes (
    item_kind, item_id, item_code, operation,
    old_price, new_price, old_currency, new_currency, old_is_free, new_is_free,
    was_published, is_published, confirmed,
    actor_id, actor_email, actor_source, reason,
    db_session_user, jwt_role, application_name, txid
  ) values (
    v_kind, (v_row ->> 'id')::uuid, v_row ->> 'code', tg_op,
    (v_old ->> 'price')::numeric, (v_new ->> 'price')::numeric,
    v_old ->> 'currency', v_new ->> 'currency',
    (v_old ->> 'is_free')::boolean, (v_new ->> 'is_free')::boolean,
    (v_old ->> 'is_published')::boolean, (v_new ->> 'is_published')::boolean,
    v_confirmed,
    v_actor, v_email, v_source, v_reason,
    session_user::text, v_jwt_role, nullif(current_setting('application_name', true), ''), txid_current()::text
  );
  return null;  -- AFTER trigger
end
$fn$;

create trigger courses_audit_commercial_price_insert_delete
  after insert or delete on public.courses
  for each row execute function public.audit_commercial_price();
create trigger courses_audit_commercial_price_update
  after update on public.courses
  for each row
  when (old.price is distinct from new.price or old.currency is distinct from new.currency
        or old.is_free is distinct from new.is_free)
  execute function public.audit_commercial_price();

create trigger course_packs_audit_commercial_price_insert_delete
  after insert or delete on public.course_packs
  for each row execute function public.audit_commercial_price();
create trigger course_packs_audit_commercial_price_update
  after update on public.course_packs
  for each row
  when (old.price is distinct from new.price or old.currency is distinct from new.currency)
  execute function public.audit_commercial_price();


-- ══ 3. THE GUARD: no silent change of a published price ═══════════════════
create or replace function public.guard_commercial_price()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_kind text  := case tg_table_name when 'courses' then 'course' else 'pack' end;
  v_old  jsonb := to_jsonb(old);
  v_new  jsonb := to_jsonb(new);
begin
  if (v_old -> 'price')   is not distinct from (v_new -> 'price')
     and (v_old -> 'currency') is not distinct from (v_new -> 'currency')
     and (v_old -> 'is_free')  is not distinct from (v_new -> 'is_free') then
    return new;
  end if;
  if not (coalesce((v_old ->> 'is_published')::boolean, false)
          or coalesce((v_new ->> 'is_published')::boolean, false)) then
    return new;  -- an unpublished draft: free to edit, and audited
  end if;
  if current_setting('xp.price_confirm_kind', true) is not distinct from v_kind
     and current_setting('xp.price_confirm_id', true) is not distinct from (v_new ->> 'id')
     and nullif(current_setting('xp.price_confirm_value', true), '')::numeric = (v_new ->> 'price')::numeric then
    return new;
  end if;
  raise exception 'commercial_price_unconfirmed'
    using errcode = 'P0001',
          detail  = 'A published price changes only through public.admin_change_commercial_price().';
end
$fn$;

create trigger courses_guard_commercial_price
  before update on public.courses
  for each row execute function public.guard_commercial_price();
create trigger course_packs_guard_commercial_price
  before update on public.course_packs
  for each row execute function public.guard_commercial_price();


-- ══ 4. THE ONE CONFIRMED WAY TO CHANGE A PRICE ════════════════════════════
create or replace function public.admin_change_commercial_price(
  p_kind           text,
  p_item_id        uuid,
  p_expected_price numeric,
  p_new_price      numeric,
  p_new_is_free    boolean,
  p_reason         text,
  p_actor_id       uuid,
  p_actor_email    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old_price numeric;
  v_old_free  boolean;
  v_code      text;
  v_published boolean;
  v_change    bigint;
begin
  if p_kind is null or p_kind not in ('course', 'pack') then
    raise exception 'commercial_kind_invalid' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300 then
    raise exception 'commercial_reason_required' using errcode = '22023';
  end if;
  if p_new_price is null or p_new_price < 0 or p_new_price <> trunc(p_new_price) or p_new_price > 10000000 then
    raise exception 'commercial_price_invalid' using errcode = '22023';
  end if;
  if p_actor_id is null or not exists (
       select 1 from public.profiles
        where id = p_actor_id and platform_role = 'super_admin' and account_status = 'active') then
    raise exception 'commercial_actor_not_admin' using errcode = '42501';
  end if;

  if p_kind = 'course' then
    select price, is_free, code, is_published into v_old_price, v_old_free, v_code, v_published
      from public.courses where id = p_item_id for update;
    if not found then
      raise exception 'commercial_item_not_found' using errcode = 'P0002';
    end if;
    if p_new_is_free is null or (p_new_is_free and p_new_price <> 0) or (not p_new_is_free and p_new_price = 0) then
      raise exception 'commercial_price_invalid' using errcode = '22023';
    end if;
  else
    select price, code, is_published into v_old_price, v_code, v_published
      from public.course_packs where id = p_item_id for update;
    if not found then
      raise exception 'commercial_item_not_found' using errcode = 'P0002';
    end if;
    if coalesce(p_new_is_free, false) or p_new_price = 0 then
      raise exception 'commercial_price_invalid' using errcode = '22023';
    end if;
  end if;

  -- The price the operator saw must still be the price: no lost update.
  if p_expected_price is null or v_old_price is distinct from p_expected_price then
    raise exception 'commercial_price_stale' using errcode = '40001';
  end if;
  if v_old_price = p_new_price and (p_kind = 'pack' or v_old_free is not distinct from p_new_is_free) then
    raise exception 'commercial_price_unchanged' using errcode = '22023';
  end if;

  perform set_config('xp.price_confirm_kind',  p_kind, true);
  perform set_config('xp.price_confirm_id',    p_item_id::text, true);
  perform set_config('xp.price_confirm_value', p_new_price::text, true);
  perform set_config('xp.price_actor_id',      p_actor_id::text, true);
  perform set_config('xp.price_actor_email',   coalesce(p_actor_email, ''), true);
  perform set_config('xp.price_reason',        btrim(p_reason), true);

  if p_kind = 'course' then
    update public.courses set price = p_new_price, is_free = p_new_is_free, updated_at = now() where id = p_item_id;
  else
    update public.course_packs set price = p_new_price, updated_at = now() where id = p_item_id;
  end if;

  select max(id) into v_change from public.commercial_price_changes
   where item_id = p_item_id and txid = txid_current()::text;

  -- The confirmation covers this one statement. Nothing later in the transaction may reuse it.
  perform set_config('xp.price_confirm_kind',  '', true);
  perform set_config('xp.price_confirm_id',    '', true);
  perform set_config('xp.price_confirm_value', '', true);
  perform set_config('xp.price_actor_id',      '', true);
  perform set_config('xp.price_actor_email',   '', true);
  perform set_config('xp.price_reason',        '', true);

  return jsonb_build_object('kind', p_kind, 'id', p_item_id, 'code', v_code, 'published', v_published,
                            'oldPrice', v_old_price, 'newPrice', p_new_price, 'changeId', v_change);
end
$fn$;

revoke all on function public.admin_change_commercial_price(text, uuid, numeric, numeric, boolean, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_change_commercial_price(text, uuid, numeric, numeric, boolean, text, uuid, text)
  to service_role;
revoke all on function public.audit_commercial_price() from public, anon, authenticated, service_role;
revoke all on function public.guard_commercial_price() from public, anon, authenticated, service_role;
revoke all on function public.commercial_price_changes_append_only() from public, anon, authenticated, service_role;


-- ══ 5. POSTFLIGHT ══════════════════════════════════════════════════════════
do $post$
begin
  if has_table_privilege('anon', 'public.commercial_price_changes', 'select')
     or has_table_privilege('authenticated', 'public.commercial_price_changes', 'select')
     or has_table_privilege('service_role', 'public.commercial_price_changes', 'insert')
     or has_table_privilege('service_role', 'public.commercial_price_changes', 'update')
     or has_table_privilege('service_role', 'public.commercial_price_changes', 'delete')
     or has_table_privilege('service_role', 'public.commercial_price_changes', 'truncate') then
    raise exception '067 postflight: commercial_price_changes privileges are wider than intended';
  end if;
  if has_function_privilege('anon', 'public.admin_change_commercial_price(text, uuid, numeric, numeric, boolean, text, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.admin_change_commercial_price(text, uuid, numeric, numeric, boolean, text, uuid, text)', 'execute') then
    raise exception '067 postflight: a browser role can execute admin_change_commercial_price';
  end if;
  if (select count(*) from pg_trigger
       where not tgisinternal and tgname in (
         'courses_audit_commercial_price_insert_delete', 'courses_audit_commercial_price_update',
         'course_packs_audit_commercial_price_insert_delete', 'course_packs_audit_commercial_price_update',
         'courses_guard_commercial_price', 'course_packs_guard_commercial_price',
         'commercial_price_changes_no_rewrite', 'commercial_price_changes_no_truncate')) <> 8 then
    raise exception '067 postflight: a trigger is missing';
  end if;
end
$post$;

commit;

-- ── OPERATOR STEP ──────────────────────────────────────────────────────────
-- Apply in the Supabase SQL editor (or the approved channel) as one script.
-- Verify: select count(*) from public.commercial_price_changes;  -- 0 right after
-- From then on, the course editor changes a published price only with the
-- typed confirmation and a reason; any other path is refused.
