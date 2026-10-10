-- ============================================================================
-- Migration 060 — PAY-2B: the payment contract an atomic completion needs.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- DATABASE CONTRACT ONLY. It creates no function, changes no policy, touches
-- no application code, and writes NO payment row.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── WHAT THIS ADDS, AND WHY EACH PIECE IS NEEDED ───────────────────────────
--
--   status vocabulary  5 -> 7, adding 'cancelled' and 'expired'
--   + failure_reason   text        why a payment did not succeed
--   + last_ipn_at      timestamptz when the provider last notified us
--   + unique index     payments_provider_token_unique (provider_token)
--                      WHERE provider_token IS NOT NULL
--
-- PayDunya's confirm endpoint returns exactly four statuses — `pending`,
-- `completed`, `cancelled`, `failed` — and its IPN returns three of those.
-- `cancelled` has no home in the five values this table admits today, so a
-- cancellation would have to be recorded as `failed`, which is a different
-- fact. `expired` has no provider counterpart at all: it is OURS, for an intent
-- the learner abandoned and no notification will ever resolve.
--
-- `expired` is also what makes retry work. 058's partial unique index allows
-- one `pending`/`processing` intent per learner per course, so an abandoned
-- intent blocks that learner from ever buying that course again. Both new
-- states sit OUTSIDE that predicate, so expiring a dead intent frees the slot
-- without widening the index or weakening the one-live-intent rule. Section 4
-- asserts the predicate still excludes every terminal state, now all five.
--
-- `failure_reason` is what migration 003 wanted and never delivered (003 was
-- never applied — see 058's DISCOVERY note). Without it a `cancelled` row is
-- unexplainable, which makes support impossible and reconciliation guesswork.
--
-- The UNIQUE index on `provider_token` is the replay key. PayDunya's IPN is
-- delivered by POST with a `hash` that is SHA-512 of the MASTER KEY — a
-- constant, not a signature over the body — so a replayed or forged
-- notification passes that check. Fulfilment must therefore come from a
-- server-to-server confirm, and the database must independently refuse to
-- attach two payments to one provider invoice. That refusal is this index.
-- PARTIAL because every existing and legacy row has a NULL token, and NULLs
-- must stay distinct.
--
-- ── THE NEW COLUMNS MUST NOT BECOME READABLE ───────────────────────────────
--
-- This is the subtle part, and it is the first real test of a property 059
-- claimed. After 059 `authenticated` holds no TABLE-level SELECT on
-- public.payments — only six COLUMN-level grants. PostgreSQL extends a
-- table-level grant to a newly added column automatically, but a column-level
-- grant covers only the columns it names. So:
--
--   authenticated  column grants only  -> does NOT receive the new columns
--   service_role   table-level grant   -> DOES receive them, automatically
--   anon / PUBLIC  nothing             -> receive nothing
--
-- That is fail-closed by construction, which is exactly what 059's header
-- promised. Section 4 VERIFIES it with `has_column_privilege` rather than
-- trusting it, because the promise and the behaviour are different things and
-- this migration is the first opportunity to tell them apart. If PostgreSQL
-- ever extended a column grant to a new column, this migration would refuse.
--
-- Both new columns are server reconciliation data. Neither is granted to any
-- browser role. `failure_reason` may one day be worth showing a learner, but
-- that is a product decision and a separate, deliberate grant.
--
-- ── WHY THE STATUS CONSTRAINT IS DISCOVERED, NOT NAMED ─────────────────────
--
-- The CHECK is replaced, not supplemented: CHECK constraints are AND-ed, so
-- leaving the five-value one in place would keep rejecting the two new states.
-- Replacing it means dropping it, and dropping it by name means knowing the
-- name — which this migration deliberately does not assume. production's
-- `payments` carries `company_id`, a column no migration in this repository
-- creates, so the table's provenance is not this repository's and a guessed
-- constraint name is a guess about a table nobody here created.
--
-- Section 2 therefore FINDS the constraint by its shape (a single-column CHECK
-- on `status`), proves its vocabulary is exactly the five values expected,
-- reports the name it found, and only then drops it. The replacement is a plain
-- statement with the seven values written out, so the new vocabulary is read
-- from this file and never computed.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO function. complete_payment() is PAY-2C; section 5 asserts it is still
--     absent, and nothing here is SECURITY DEFINER.
--   * NO policy created, altered or dropped. Section 4 pins the policy set.
--   * NO grant or revoke at all. The six-column allowlist, anon's exclusion and
--     service_role's authority are asserted, never re-issued.
--   * NO payment row inserted, updated or deleted. Section 5 proves it.
--   * NO change to entitlements, enrollments, certificates or course prices:
--     this file contains no statement that could touch them.
--   * NO PayDunya API, client, credential, webhook or IPN handler.
--   * 003 stays withdrawn. Its `webhook_id`, `payment_intent_id` and
--     `updated_at` are NOT added: `provider_token` is the replay key, and
--     nothing in this codebase writes an `updated_at` on payments.
-- ============================================================================

-- REPEATABLE READ: the before/after payment fingerprint is read as ONE
-- snapshot, so "no row was rewritten" compares like with like.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — 059's security state, 058's schema, and the data ═══════
do $do$
declare
  v_missing text;
  v_cols    text;
  v_def     text;
  v_val     text;
  v_n       integer;
  v_allow   constant text[] := array['id', 'course_id', 'reference', 'amount', 'currency', 'status'];
  v_col     text;
begin
  if to_regclass('public.payments') is null then
    raise exception 'PAY-2B 060 preflight: public.payments does not exist';
  end if;

  -- Refuse a second apply rather than reporting success for work already done.
  select string_agg(c, ', ') into v_missing
    from unnest(array['failure_reason', 'last_ipn_at']) as c
   where exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.payments'::regclass
                    and a.attname = c and not a.attisdropped);
  if v_missing is not null then
    raise exception 'PAY-2B 060 preflight: column(s) % already exist; refusing to re-apply', v_missing;
  end if;
  if to_regclass('public.payments_provider_token_unique') is not null then
    raise exception 'PAY-2B 060 preflight: public.payments_provider_token_unique already exists; refusing to re-apply';
  end if;

  -- ── 058's schema: exactly the seventeen columns ────────────────────────
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,id,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-2B 060 preflight: public.payments has columns [%]; this migration was written against the seventeen columns 058 produced', v_cols;
  end if;

  -- ── 059's SECURITY state, verified by EFFECTIVE privilege ─────────────
  --
  -- Not "is 059 in the repository" but "is its outcome in this database".
  -- has_table_privilege / has_column_privilege account for inheritance, so a
  -- privilege reaching a browser role through role membership is caught here
  -- rather than discovered after the new columns exist.
  if has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    -- Where is it coming from? PUBLIC (ACL grantee 0) applies to every role and
    -- is not a membership, so it is reported separately or the operator would
    -- hunt for a direct grant that does not exist.
    if exists (select 1 from pg_class c, aclexplode(c.relacl) acl
                where c.oid = 'public.payments'::regclass and acl.grantee = 0) then
      v_val := 'PUBLIC (granted to every role; revoke from PUBLIC, not from authenticated)';
    else
      select string_agg(r.rolname, ', ' order by r.rolname) into v_val
        from pg_roles r
       where r.rolname <> 'authenticated'
         and pg_has_role('authenticated', r.oid, 'USAGE')
         and has_table_privilege(r.rolname, 'public.payments', 'SELECT');
      v_val := coalesce('INHERITED via role membership from: ' || v_val, 'a DIRECT grant to authenticated');
    end if;
    raise exception 'PAY-2B 060 preflight: authenticated holds TABLE-level SELECT on public.payments, so 059 is not in effect. Source: %. Adding columns now would hand them over automatically.', v_val;
  end if;
  foreach v_col in array v_allow loop
    if not has_column_privilege('authenticated', 'public.payments', v_col, 'SELECT') then
      raise exception 'PAY-2B 060 preflight: authenticated cannot read payments.%, so 059''s six-column allowlist is not in place', v_col;
    end if;
  end loop;
  select string_agg(a.attname, ', ' order by a.attname) into v_val
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT')
     and not (a.attname = any (v_allow));
  if v_val is not null then
    raise exception 'PAY-2B 060 preflight: authenticated can read column(s) outside 059''s allowlist: %', v_val;
  end if;
  if has_table_privilege('anon', 'public.payments', 'SELECT')
     or has_any_column_privilege('anon', 'public.payments', 'SELECT') then
    raise exception 'PAY-2B 060 preflight: anon can still read public.payments; 059 is not in effect';
  end if;
  -- 058's in-flight index: the snapshot below reads its predicate, and section 4
  -- re-asserts that predicate against the widened vocabulary.
  if to_regclass('public.payments_one_inflight_intent_per_course') is null then
    raise exception 'PAY-2B 060 preflight: 058''s in-flight unique index is missing';
  end if;

  -- ── THE STATUS VOCABULARY AS IT STANDS ────────────────────────────────
  --
  -- Counted before it is read. `select ... into` is NOT strict in PL/pgSQL: it
  -- takes the first row and raises nothing, so two single-column CHECKs on
  -- status would make section 2 drop an arbitrary one of them. Refuse instead.
  select count(*) into v_n from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
     and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.payments'::regclass and a.attname = 'status')];
  if v_n <> 1 then
    raise exception 'PAY-2B 060 preflight: public.payments has % single-column CHECK constraint(s) on status; this migration replaces exactly one and will not guess which', v_n;
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
     and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.payments'::regclass and a.attname = 'status')];
  if v_def is null then
    raise exception 'PAY-2B 060 preflight: public.payments.status has no single-column CHECK constraint to replace';
  end if;
  foreach v_val in array array['pending', 'processing', 'completed', 'failed', 'refunded'] loop
    if position('''' || v_val || '''' in v_def) = 0 then
      raise exception 'PAY-2B 060 preflight: payments.status CHECK does not admit ''%''. Found: %', v_val, v_def;
    end if;
  end loop;
  select count(distinct parts[1]) into v_n
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m(parts);
  if v_n <> 5 then
    raise exception 'PAY-2B 060 preflight: payments.status CHECK names % distinct value(s), expected exactly the 5 this migration widens. Found: %', v_n, v_def;
  end if;

  -- ── THE DATA MUST FIT THE NEW CONTRACT ────────────────────────────────
  -- The zero-token rollout contract: PAY-2 has not run, so no row may carry a
  -- provider_token. If one does, the sequence has already gone wrong and the
  -- replay key is being added after the fact.
  select count(*) into v_n from public.payments where provider_token is not null;
  if v_n <> 0 then
    raise exception 'PAY-2B 060 preflight: % payment row(s) already carry a provider_token. The approved rollout contract is zero tokens before PAY-2C; re-plan rather than adding the replay key after tokens exist.', v_n;
  end if;
  -- Belt and braces: even one duplicate would make the new unique index fail
  -- with a bare index violation instead of a legible message.
  select count(*) into v_n from (
    select provider_token from public.payments
     where provider_token is not null
     group by provider_token having count(*) > 1
  ) d;
  if v_n <> 0 then
    raise exception 'PAY-2B 060 preflight: % provider_token value(s) are duplicated; resolve them before constraining the replay key', v_n;
  end if;
  -- No row may sit outside the vocabulary the new CHECK will admit.
  select count(*) into v_n from public.payments
   where status not in ('pending', 'processing', 'completed', 'failed', 'refunded',
                        'cancelled', 'expired');
  if v_n <> 0 then
    raise exception 'PAY-2B 060 preflight: % payment row(s) carry a status outside the seven this migration admits', v_n;
  end if;
end
$do$;

-- The two facts section 5 needs, and nothing else. Dropped at COMMIT.
-- Fingerprinted by an EXPLICIT list of the seventeen pre-060 columns: to_jsonb
-- would change shape when the two columns are added and could hide a rewrite.
create temp table pay_2b_060_before on commit drop as
select
  (select md5(coalesce(string_agg(
            p.id::text || '|' || coalesce(p.user_id::text, '') || '|' || coalesce(p.course_id::text, '')
              || '|' || coalesce(p.company_id::text, '') || '|' || p.amount::text || '|' || p.currency
              || '|' || p.method || '|' || p.status || '|' || p.reference
              || '|' || coalesce(p.provider_reference, '') || '|' || coalesce(p.metadata::text, '')
              || '|' || p.created_at::text || '|' || coalesce(p.completed_at::text, '')
              || '|' || coalesce(p.provider, '') || '|' || coalesce(p.provider_mode, '')
              || '|' || coalesce(p.provider_token, '') || '|' || coalesce(p.entitlement_id::text, ''),
            E'\n' order by p.id), ''))
     from public.payments p)                 as payments_md5,
  (select count(*) from public.payments)     as n_payments,
  (select coalesce(pg_get_expr(i.indpred, i.indrelid), '')
     from pg_index i
    where i.indexrelid = 'public.payments_one_inflight_intent_per_course'::regclass)
                                             as inflight_predicate;


-- ══ 1. THE TWO RECONCILIATION COLUMNS ═════════════════════════════════════
--
-- Nullable, no default, no backfill. Every existing and legacy row stays valid
-- exactly as it stands. Neither is granted to a browser role — section 4
-- verifies that PostgreSQL did not extend 059's column grants to them.

alter table public.payments
  add column if not exists failure_reason text,
  add column if not exists last_ipn_at    timestamptz;

comment on column public.payments.failure_reason is
  'PAY-2B. Why this payment did not succeed, as reported by the provider (PayDunya ''fail_reason'' / errors.message) or by our own expiry sweep. Server reconciliation data: NOT granted to any browser role. Migration 003 wanted this column and was never applied; this is it, on today''s schema.';
comment on column public.payments.last_ipn_at is
  'PAY-2B. When the provider last sent an IPN for this payment. Observability only — it is NEVER evidence of payment: PayDunya''s IPN hash is SHA-512 of the master key, a constant rather than a signature over the body, so fulfilment comes only from a server-to-server confirm. Server reconciliation data: NOT granted to any browser role.';


-- ══ 2. THE STATUS VOCABULARY: FIVE -> SEVEN ═══════════════════════════════
--
-- Discovered, proven, then dropped — see the header for why the name is not
-- assumed. The replacement is written out below so the new vocabulary is read
-- from this file and never computed.
do $do$
declare
  v_name text;
  v_def  text;
begin
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def
    from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
     and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.payments'::regclass and a.attname = 'status')];
  if v_name is null then
    raise exception 'PAY-2B 060: the status CHECK vanished between section 0 and section 2';
  end if;
  -- Proven again immediately before the drop: only a five-value, single-column
  -- CHECK on `status` may be removed by this migration.
  if v_def !~ 'status' or v_def !~ 'pending' or v_def !~ 'refunded' then
    raise exception 'PAY-2B 060: refusing to drop constraint % — it does not read like the status vocabulary: %', v_name, v_def;
  end if;
  execute format('alter table public.payments drop constraint %I', v_name);
  if exists (select 1 from pg_constraint
              where conrelid = 'public.payments'::regclass and conname = v_name) then
    raise exception 'PAY-2B 060: constraint % survived the drop', v_name;
  end if;
end
$do$;

alter table public.payments
  add constraint payments_status_valid
  check (status in ('pending', 'processing', 'completed', 'failed', 'refunded',
                    'cancelled', 'expired'));

comment on constraint payments_status_valid on public.payments is
  'PAY-2B. The seven payment states. ''cancelled'' is PayDunya''s (its confirm endpoint returns pending/completed/cancelled/failed); ''expired'' is ours, for an abandoned intent no notification will ever resolve. Both are TERMINAL and therefore outside 058''s in-flight predicate, which is what makes retry possible without weakening the one-live-intent rule.';


-- ══ 3. THE REPLAY KEY ═════════════════════════════════════════════════════
--
-- One payment per provider invoice, enforced by the database rather than by
-- the correctness of a webhook handler. PARTIAL because every existing row has
-- a NULL token and NULLs must stay distinct.

create unique index payments_provider_token_unique
  on public.payments (provider_token)
  where provider_token is not null;

comment on index public.payments_provider_token_unique is
  'PAY-2B replay protection: at most one payment row per provider invoice token. PayDunya''s IPN carries a `hash` that is SHA-512 of the master key — a constant, not a signature over the payload — so a replayed or forged notification passes that check. This index is the database''s own refusal to attach two payments to one invoice, independent of any handler being written correctly. Violations surface as 23505.';


-- ══ 4. THE RESULTING SHAPE AND THE EFFECTIVE PRIVILEGES ═══════════════════
do $do$
declare
  v_allow constant text[] := array['id', 'course_id', 'reference', 'amount', 'currency', 'status'];
  v_new   constant text[] := array['failure_reason', 'last_ipn_at'];
  v_terminal constant text[] := array['completed', 'failed', 'refunded', 'cancelled', 'expired'];
  v_cols  text;
  v_txt   text;
  v_col   text;
  v_role  text;
  v_priv  text;
  v_n     integer;
begin
  -- ── nineteen columns, and the two new ones correctly shaped ────────────
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,failure_reason,id,last_ipn_at,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-2B 060: public.payments now has columns [%], which is not the seventeen it held plus the two this migration adds', v_cols;
  end if;
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.payments'::regclass and a.attname = 'failure_reason'
       and not a.attisdropped and a.atttypid = 'text'::regtype
       and a.attnotnull = false and a.atthasdef = false and a.attgenerated = ''
  ) then
    raise exception 'PAY-2B 060: payments.failure_reason is not a plain nullable text column with no default';
  end if;
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.payments'::regclass and a.attname = 'last_ipn_at'
       and not a.attisdropped and a.atttypid = 'timestamptz'::regtype
       and a.attnotnull = false and a.atthasdef = false and a.attgenerated = ''
  ) then
    raise exception 'PAY-2B 060: payments.last_ipn_at is not a plain nullable timestamptz column with no default';
  end if;

  -- ── THE NEW-COLUMN GRANT AUDIT ────────────────────────────────────────
  --
  -- The point of this section. A table-level grant extends to a new column
  -- automatically; a column-level grant does not. 059 left the browser roles
  -- with column grants only, so the new columns must be unreadable to them
  -- without anybody revoking anything. Verified, not assumed.
  foreach v_col in array v_new loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_column_privilege(v_role, 'public.payments', v_col, 'SELECT') then
        raise exception 'PAY-2B 060: % can read the NEW column payments.% — a column-level grant was extended to a column added after it, so 059''s fail-closed property does not hold and this column must be revoked explicitly', v_role, v_col;
      end if;
    end loop;
    -- service_role holds a TABLE-level grant, so it SHOULD have picked them up.
    if to_regrole('service_role') is not null
       and not has_column_privilege('service_role', 'public.payments', v_col, 'SELECT') then
      raise exception 'PAY-2B 060: service_role cannot read the new column payments.%, so reconciliation could not read what it writes', v_col;
    end if;
  end loop;

  -- ── 059's allowlist is still EXACTLY six, over nineteen columns ───────
  if has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    raise exception 'PAY-2B 060: authenticated gained TABLE-level SELECT on public.payments';
  end if;
  foreach v_col in array v_allow loop
    if not has_column_privilege('authenticated', 'public.payments', v_col, 'SELECT') then
      raise exception 'PAY-2B 060: authenticated lost SELECT on payments.%, which the confirmation page needs', v_col;
    end if;
  end loop;
  select string_agg(a.attname, ', ' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT')
     and not (a.attname = any (v_allow));
  if v_txt is not null then
    raise exception 'PAY-2B 060: authenticated can read column(s) outside the six-column allowlist: %', v_txt;
  end if;
  if has_table_privilege('anon', 'public.payments', 'SELECT')
     or has_any_column_privilege('anon', 'public.payments', 'SELECT') then
    raise exception 'PAY-2B 060: anon can read public.payments again';
  end if;

  -- ── nothing reaches PUBLIC, at either layer ──────────────────────────
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
    raise exception 'PAY-2B 060: public.payments grants privilege(s) to PUBLIC: %', v_txt;
  end if;

  -- ── 058's write withdrawal, untouched ────────────────────────────────
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-2B 060: % gained % on public.payments', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-2B 060: % holds % on some COLUMN of public.payments', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.payments', v_priv) then
        raise exception 'PAY-2B 060: service_role lost % on public.payments', v_priv;
      end if;
    end loop;
  end if;

  -- ── the new vocabulary: exactly seven, and the right seven ───────────
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.payments'::regclass and contype = 'c'
                    and conname = 'payments_status_valid' and convalidated) then
    raise exception 'PAY-2B 060: payments_status_valid is missing or not validated';
  end if;
  select pg_get_constraintdef(oid) into v_txt from pg_constraint
   where conrelid = 'public.payments'::regclass and conname = 'payments_status_valid';
  foreach v_col in array array['pending', 'processing', 'completed', 'failed', 'refunded',
                               'cancelled', 'expired'] loop
    if position('''' || v_col || '''' in v_txt) = 0 then
      raise exception 'PAY-2B 060: the new status CHECK does not admit ''%''. It reads %', v_col, v_txt;
    end if;
  end loop;
  select count(distinct parts[1]) into v_n
    from regexp_matches(v_txt, '''([a-z_]+)''', 'g') as m(parts);
  if v_n <> 7 then
    raise exception 'PAY-2B 060: the new status CHECK names % distinct value(s), expected exactly 7: %', v_n, v_txt;
  end if;
  -- Exactly ONE single-column CHECK on status: the old one is gone, not merely
  -- joined by a second that would still AND against the new states.
  select count(*) into v_n from pg_constraint c
   where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
     and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.payments'::regclass and a.attname = 'status')];
  if v_n <> 1 then
    raise exception 'PAY-2B 060: public.payments has % single-column CHECK constraint(s) on status, expected exactly 1', v_n;
  end if;

  -- ── the replay key ───────────────────────────────────────────────────
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.payments_provider_token_unique')
       and i.indrelid = 'public.payments'::regclass
       and i.indisunique and i.indpred is not null and i.indnatts = 1
  ) then
    raise exception 'PAY-2B 060: payments_provider_token_unique is not a PARTIAL UNIQUE index on one column';
  end if;
  select pg_get_indexdef('public.payments_provider_token_unique'::regclass) into v_txt;
  if v_txt !~ '\(provider_token\)' or v_txt !~ 'provider_token IS NOT NULL' then
    raise exception 'PAY-2B 060: the replay key is not keyed on provider_token WHERE NOT NULL; it reads %', v_txt;
  end if;

  -- ── 058's in-flight index survives, and still excludes every terminal
  --    state — including the two this migration just created ────────────
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.payments_one_inflight_intent_per_course')
       and i.indrelid = 'public.payments'::regclass
       and i.indisunique and i.indpred is not null and i.indnatts = 2
  ) then
    raise exception 'PAY-2B 060: 058''s in-flight unique index was altered or removed';
  end if;
  select pg_get_expr(i.indpred, i.indrelid) into v_txt
    from pg_index i
   where i.indexrelid = 'public.payments_one_inflight_intent_per_course'::regclass;
  if position('''pending''' in v_txt) = 0 or position('''processing''' in v_txt) = 0 then
    raise exception 'PAY-2B 060: the in-flight predicate no longer covers pending and processing: %', v_txt;
  end if;
  foreach v_col in array v_terminal loop
    if position('''' || v_col || '''' in v_txt) <> 0 then
      raise exception 'PAY-2B 060: the in-flight predicate now includes the TERMINAL state ''%'', which would block retry: %', v_col, v_txt;
    end if;
  end loop;

  -- ── the policy set is EXACTLY as 058 left it ─────────────────────────
  select string_agg(p.polname || '/' || p.polcmd::text || '/' ||
           case when p.polpermissive then 'P' else 'R' end, ' ' order by p.polname) into v_txt
    from pg_policy p where p.polrelid = 'public.payments'::regclass;
  if v_txt is distinct from 'payments_insert_service/a/P payments_no_browser_delete/d/R payments_no_browser_update/w/R payments_own/r/P' then
    raise exception 'PAY-2B 060: the policy set on public.payments changed; it reads [%]', v_txt;
  end if;
  if not exists (select 1 from pg_policy
                  where polrelid = 'public.payments'::regclass and polname = 'payments_own'
                    and polcmd = 'r' and pg_get_expr(polqual, polrelid) like '%user_id%') then
    raise exception 'PAY-2B 060: payments_own no longer scopes SELECT by user_id';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.payments'::regclass and relrowsecurity) then
    raise exception 'PAY-2B 060: row level security was disabled';
  end if;

  -- ── the FK 058 created is untouched ──────────────────────────────────
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.payments'::regclass and c.contype = 'f'
       and c.confrelid = 'public.entitlements'::regclass and c.confdeltype = 'n'
  ) then
    raise exception 'PAY-2B 060: the entitlement_id FK to public.entitlements (ON DELETE SET NULL) is gone';
  end if;
  -- course_id's FK is older than 058 and nothing here touches it, but PostgREST
  -- resolves the confirmation page's courses(title) embed THROUGH it, so its
  -- loss would break that page rather than any query in this file.
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.payments'::regclass and c.contype = 'f'
       and c.confrelid = 'public.courses'::regclass
  ) then
    raise exception 'PAY-2B 060: the course_id FK to public.courses is gone; the confirmation page''s courses(title) embed resolves through it';
  end if;
end
$do$;


-- ══ 5. NOT ONE PAYMENT ROW WAS WRITTEN ════════════════════════════════════
--
-- The LAST block before COMMIT: an assertion proves nothing about statements
-- that run after it.
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
begin
  select * into b from pay_2b_060_before;

  select md5(coalesce(string_agg(
           p.id::text || '|' || coalesce(p.user_id::text, '') || '|' || coalesce(p.course_id::text, '')
             || '|' || coalesce(p.company_id::text, '') || '|' || p.amount::text || '|' || p.currency
             || '|' || p.method || '|' || p.status || '|' || p.reference
             || '|' || coalesce(p.provider_reference, '') || '|' || coalesce(p.metadata::text, '')
             || '|' || p.created_at::text || '|' || coalesce(p.completed_at::text, '')
             || '|' || coalesce(p.provider, '') || '|' || coalesce(p.provider_mode, '')
             || '|' || coalesce(p.provider_token, '') || '|' || coalesce(p.entitlement_id::text, ''),
           E'\n' order by p.id), '')) into v_now
    from public.payments p;
  if v_now is distinct from b.payments_md5 then
    raise exception 'PAY-2B 060: payment row data changed — this migration adds a contract, it must not write';
  end if;
  select count(*) into v_n from public.payments;
  if v_n <> b.n_payments then
    raise exception 'PAY-2B 060: the payment count changed from % to %', b.n_payments, v_n;
  end if;

  -- The two new columns are NULL on every existing row: no implicit backfill.
  select count(*) into v_n from public.payments
   where failure_reason is not null or last_ipn_at is not null;
  if v_n <> 0 then
    raise exception 'PAY-2B 060: % row(s) acquired a failure_reason or last_ipn_at; the new columns must be NULL everywhere', v_n;
  end if;

  -- The zero-token contract, restated at the end of the transaction.
  select count(*) into v_n from public.payments where provider_token is not null;
  if v_n <> 0 then
    raise exception 'PAY-2B 060: % row(s) acquired a provider_token during this transaction', v_n;
  end if;

  -- 058's in-flight predicate is byte-identical to what it was on entry.
  select coalesce(pg_get_expr(i.indpred, i.indrelid), '') into v_now
    from pg_index i
   where i.indexrelid = 'public.payments_one_inflight_intent_per_course'::regclass;
  if v_now is distinct from b.inflight_predicate then
    raise exception 'PAY-2B 060: 058''s in-flight predicate changed from [%] to [%]', b.inflight_predicate, v_now;
  end if;

  -- PAY-2C is still unstarted, and nothing here is SECURITY DEFINER.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_now
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%complete%payment%';
  if v_now is not null then
    raise exception 'PAY-2B 060: a payment-completion routine exists at the end of this transaction: %', v_now;
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
--      - the two new columns are new, and NOTHING reads or writes them;
--      - the widened vocabulary only ADMITS more values — no existing row
--        changes, and no code writes 'cancelled' or 'expired' yet;
--      - the replay key matches the data already present (production held ZERO
--        payment rows and ZERO provider_tokens when this was authored,
--        verified GET-only);
--      - no grant, policy or privilege is issued; the browser allowlist is
--        asserted, not re-granted.
--    ADD COLUMN with no default and no NOT NULL is metadata-only in PostgreSQL
--    11+; both index builds and the CHECK validation run against an empty
--    table. It completes in milliseconds.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once.
--    "Success. No rows returned." means every section passed: the file is one
--    transaction and any failed assertion raises and rolls everything back. It
--    emits no RAISE NOTICE, because the SQL editor does not display NOTICE
--    output — anything worth knowing is an exception that stops the apply.
-- 3. Immediately afterwards, GET-only:
--      as the ANON key
--        /rest/v1/payments?select=id                 -> 42501
--      as the SERVICE key
--        /rest/v1/payments?select=failure_reason,last_ipn_at
--                                                    -> 200 [] (both columns)
--        /rest/v1/payments?select=id&limit=0 + count -> still 0 rows
--      and confirm /checkout, /checkout/confirm and /dashboard still render.
--    The learner-side check that MATTERS, with any learner session:
--        /rest/v1/payments?select=failure_reason     -> 42501
--        /rest/v1/payments?select=last_ipn_at        -> 42501
--        /rest/v1/payments?select=id,reference,amount,currency,status,courses(title)
--                                                    -> 200
--
-- ── WHAT THIS UNBLOCKS, AND WHAT STILL GATES IT ───────────────────────────
--
--   PAY-2C may now create the completion authority: a single function that
--   marks a payment completed AND grants the entitlement in one transaction.
--   Recommended shape, from the PAY-2A audit: SECURITY INVOKER (not DEFINER —
--   service_role already bypasses RLS and holds every needed privilege, so
--   DEFINER would add no capability and only create an escalation primitive),
--   owner postgres, `set search_path = public, pg_temp`, and an explicit
--   `revoke execute on function … from public, anon, authenticated` because
--   CREATE FUNCTION grants EXECUTE to PUBLIC by default.
--
--   STILL BLOCKING any PayDunya TEST transaction, neither fixed here:
--     * C1-F4 `donnez-envie-a-vos-clients-de-revenir` is priced 0 XOF, and
--       PayDunya requires invoice.total_amount. A commercial decision
--       (PRICE-LAUNCH-01), not a migration.
--     * /checkout cannot reach a payment path while PLATFORM_MODE=pilot: the
--       PILOT_MODE branch redirects into the lesson player before any payment
--       code runs.
--
--   STILL BLOCKING PAID production launch: SEC-4 certificate hardening.
--   N-3 enrollments_update remains non-blocking.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the pre-060 contract. Safe only while no row uses a new
-- state and no row carries a provider_token or either new column. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- do $rb$
-- declare v_n integer;
-- begin
--   select count(*) into v_n from public.payments
--    where status in ('cancelled', 'expired')
--       or provider_token is not null
--       or failure_reason is not null
--       or last_ipn_at is not null;
--   if v_n <> 0 then
--     raise exception 'PAY-2B 060 rollback: % payment row(s) rely on the new contract; rolling back would destroy data or violate the narrowed CHECK', v_n;
--   end if;
-- end
-- $rb$;
--
-- drop index if exists public.payments_provider_token_unique;
--
-- alter table public.payments drop constraint if exists payments_status_valid;
-- alter table public.payments
--   add constraint payments_status_check
--   check (status in ('pending', 'processing', 'completed', 'failed', 'refunded'));
--
-- alter table public.payments
--   drop column if exists last_ipn_at,
--   drop column if exists failure_reason;
--
-- commit;
