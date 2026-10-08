-- ============================================================================
-- Migration 059 — PAY-1B(b): the browser roles stop being able to READ the
-- payment reconciliation columns.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- It writes NO payment row and changes no policy. SELECT privileges only.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── THE FINDING THIS CLOSES ────────────────────────────────────────────────
--
-- RLS decides ROWS, not COLUMNS. `payments_own` confines a learner to their own
-- payment rows, and 058 withdrew every browser WRITE privilege — but both
-- browser roles kept table-wide SELECT. So a learner issuing
--
--     GET /rest/v1/payments?select=*
--
-- received EVERY column of their own rows: all 17 after 058, including the
-- free-form `metadata` jsonb and `provider_token`, which PAY-2 will begin
-- writing. Verified against production: 17/17 columns readable by the browser
-- roles today, and `select=*` returns 200.
--
-- `provider_token` is not a credential — it is PayDunya's invoice identifier,
-- useless without the server-held master key, and PayDunya puts that same token
-- in the checkout URL the learner's own browser visits. But it is server
-- reconciliation data with no reason to be in a browser response, and
-- `metadata` is an unbounded jsonb that PAY-2 will fill with provider payloads.
-- Neither belongs in an allowlist built from what the application renders.
--
-- ── WHY THE APPLICATION HAD TO CHANGE FIRST ────────────────────────────────
--
-- Under column-level grants `select('*')` FAILS with 42501 rather than
-- narrowing — 055 says so in its own section 1. The one browser-role reader,
-- app/(platform)/checkout/confirm/page.tsx, used to read
-- `select('*', courses(title, slug))`, so applying this migration then would
-- have broken that page. PAY-1B(a) (merged, deployed) replaced it with
--
--     .select('id, reference, amount, currency, status, courses(title)')
--
-- which is why 059 can be applied now and not before. Section 0 refuses unless
-- the privileges 058 left behind are still exactly what this was written
-- against, so an out-of-order apply stops rather than half-lands.
--
-- ── THE ALLOWLIST WAS MEASURED, NOT GUESSED ────────────────────────────────
--
--   granted to `authenticated` (6):
--     id, course_id, reference, amount, currency, status
--
--   withheld (11):
--     user_id, company_id, method, provider_reference, metadata, created_at,
--     completed_at, provider, provider_mode, provider_token, entitlement_id
--
-- Five of the six are the fields the confirmation page renders. The sixth,
-- `course_id`, is NOT in the page's select string — and is nonetheless
-- REQUIRED. PostgREST resolves the `courses(title)` embed by joining on
-- payments.course_id, so the role must be able to read that column. Measured
-- on PostgreSQL 17 rather than assumed: with the other five granted and
-- `course_id` withheld, the embed join fails with 42501; with `course_id`
-- granted it returns the title. Leaving it out would have broken the
-- confirmation page in exactly the way this slice exists to prevent.
--
-- `user_id` is deliberately NOT granted, and that is safe for a reason also
-- measured rather than assumed: an RLS policy expression is not subject to the
-- CALLER's column privileges. With `user_id` withheld, `select reference from
-- payments` still returns only the caller's own row — RLS filtered on a column
-- the caller cannot read. So the learner loses the ability to read `user_id`
-- while row ownership stays enforced. (Section 2 asserts both halves.)
--
-- ── anon LOSES PAYMENT SELECT ENTIRELY ─────────────────────────────────────
--
-- `anon` can never see a payment row — `payments_own` requires
-- `user_id = auth.uid()` — so its table-wide SELECT only ever returned an empty
-- array. Withdrawing it is a free reduction, not a behaviour change, and it is
-- unreachable besides: middleware.ts gates `/checkout` (and therefore
-- `/checkout/confirm`) behind `AUTH_REQUIRED`, so the confirmation query only
-- ever runs as `authenticated`. Before: 0 rows. After: 42501, which the page
-- already handles identically because it ignores the error and renders the
-- pending state with no receipt block.
--
-- ── HOW FAR ONE REVOKE REACHES, MEASURED ──────────────────────────────────
--
-- A table-level REVOKE of a privilege also removes that privilege's COLUMN
-- grants. Measured on PostgreSQL 17 rather than assumed, because the first
-- draft of this migration asserted the opposite and carried a redundant
-- per-column revoke on the strength of it:
--
--   grant select (secret) on t to r;  revoke all    on t from r;  -> cleared
--   grant select (secret) on t to r;  revoke select on t from r;  -> cleared
--   grant select (secret) on t to r;  revoke update on t from r;  -> NOT cleared
--
-- So `revoke all on public.payments` is sufficient to clear every pre-existing
-- per-column SELECT as well as the table-level one, and the last line is the
-- reason it must stay `all` (or at least `select`): a revoke of some OTHER
-- privilege would leave a column SELECT grant untouched.
--
-- PUBLIC is named explicitly because revoking from `anon, authenticated` does
-- not reach it, and a grant to PUBLIC applies to every role that exists now or
-- later.
--
-- One thing NO revoke can reach is a privilege INHERITED through role
-- membership: a revoke removes grants made TO the named role, not grants held
-- by a role it is a member of. That case cannot be fixed here, so section 2
-- DETECTS it and refuses, naming the roles the privilege is coming from.
--
-- Section 2 asserts EFFECTIVE privilege throughout, with
-- `has_column_privilege`/`has_table_privilege`, which account for inheritance.
-- The guarantee is the assertion, not the GRANT statement: if a browser role
-- can still read a withheld column by any route, this migration refuses and
-- names the column rather than reporting success.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO policy is created, altered or dropped. Row ownership, the INSERT
--     denial and 058's two RESTRICTIVE write denials are left exactly as they
--     are, and section 2 asserts all four still stand.
--   * NO write privilege is granted or revoked. SELECT only.
--   * NO payment row is inserted, updated or deleted. Section 3 proves it.
--   * NO change to service_role, which keeps full reconciliation access
--     including provider_token and metadata — the admin screens and the PAY-2
--     webhook act through it.
--   * NO entitlement, enrollment, certificate or course price is touched: this
--     file contains no statement that could, which the test suite proves by
--     scanning it rather than by fingerprinting rows it cannot have written.
--   * NO PayDunya API, client, credential, webhook or IPN. PAY-2 is unstarted,
--     and `complete_payment()` still does not exist.
-- ============================================================================

-- REPEATABLE READ: the before/after payment fingerprint is read as ONE
-- snapshot, so "no row was rewritten" compares like with like.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT — 058's schema and security state, or nothing happens ════
do $do$
declare
  v_missing text;
  v_cols    text;
  v_n       integer;
  v_role    text;
  v_priv    text;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array['public.payments', 'public.courses']) as t
   where to_regclass(t) is null;
  if v_missing is not null then
    raise exception 'PAY-1B 059 preflight: required table(s) missing: %', v_missing;
  end if;

  -- RLS must be on: this migration narrows COLUMN access and relies entirely
  -- on `payments_own` to keep confining ROWS.
  if not exists (select 1 from pg_class where oid = 'public.payments'::regclass and relrowsecurity) then
    raise exception 'PAY-1B 059 preflight: row level security is NOT enabled on public.payments';
  end if;

  -- EXACTLY the seventeen columns migration 058 produced.
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'amount,company_id,completed_at,course_id,created_at,currency,entitlement_id,id,metadata,method,provider,provider_mode,provider_reference,provider_token,reference,status,user_id' then
    raise exception 'PAY-1B 059 preflight: public.payments has columns [%]; this migration was written against the seventeen columns migration 058 produced', v_cols;
  end if;

  -- 058's SECURITY state, not merely its schema. Both browser roles must still
  -- hold table-wide SELECT (what 059 withdraws) and no write privilege at all
  -- (what 058 withdrew, and 059 must not disturb).
  foreach v_role in array array['anon', 'authenticated'] loop
    if not has_table_privilege(v_role, 'public.payments', 'SELECT') then
      raise exception 'PAY-1B 059 preflight: % does not hold table-level SELECT on public.payments; the privilege state is not the one 058 left behind (is 059 already applied?)', v_role;
    end if;
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-1B 059 preflight: % holds % on public.payments — 058''s write withdrawal is not in place; fix that before narrowing SELECT', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- 058's four policies. 059 changes none of them and must not run against a
  -- policy set it does not recognise.
  select string_agg(c, ', ') into v_missing
    from unnest(array['payments_own', 'payments_insert_service',
                      'payments_no_browser_update', 'payments_no_browser_delete']) as c
   where not exists (select 1 from pg_policy p
                      where p.polrelid = 'public.payments'::regclass and p.polname = c);
  if v_missing is not null then
    raise exception 'PAY-1B 059 preflight: policy/policies % are missing; this is not the policy set 058 left behind', v_missing;
  end if;

  -- service_role must already be whole, or narrowing the browser roles would
  -- leave nothing able to reconcile.
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.payments', v_priv) then
        raise exception 'PAY-1B 059 preflight: service_role lacks % on public.payments', v_priv;
      end if;
    end loop;
  end if;

  -- THE SEQUENCING GATE. This turns "narrow the browser read before PAY-2
  -- writes its first token" from a sentence in a document into something the
  -- database enforces: if PAY-2 landed first, 059 refuses and says why.
  select count(*) into v_n from public.payments where provider_token is not null;
  if v_n <> 0 then
    raise exception 'PAY-1B 059 preflight: % payment row(s) already carry a provider_token. PAY-2 has written tokens before the browser read was narrowed, so this migration would be closing the door after the fact. Re-plan the sequence rather than applying 059 now.', v_n;
  end if;
end
$do$;

-- The two facts section 3 needs, and nothing else. Dropped at COMMIT.
create temp table pay_1b_059_before on commit drop as
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
     from public.payments p)                    as payments_md5,
  (select count(*) from public.payments)        as n_payments;


-- ══ 1. THE PRIVILEGE CHANGE ═══════════════════════════════════════════════
--
-- `all`, not `select`, and from PUBLIC as well as the two browser roles. This
-- single statement clears the table-level privilege AND every pre-existing
-- per-column grant, including any column SELECT somebody added by hand — see
-- the measurement in the header. It is deliberately not narrowed to `select`:
-- `all` also sweeps up a stray column INSERT/UPDATE/REFERENCES, which section 2
-- then asserts is gone.

revoke all on public.payments from public, anon, authenticated;

-- The six the application actually needs, enumerated EXPLICITLY and never
-- computed: a column added to public.payments after this migration is
-- unreadable by the browser roles until somebody grants it deliberately —
-- fail-closed by construction, which is the 038/055 pattern.
--
-- `course_id` is here because
-- PostgREST joins the `courses(title)` embed through it — measured, not
-- assumed. `user_id` is NOT here: RLS filters on it without the caller needing
-- to read it.
grant select (
  id,
  course_id,
  reference,
  amount,
  currency,
  status
) on public.payments to authenticated;


-- ══ 2. THE EFFECTIVE AUTHORITY THAT RESULTED ══════════════════════════════
--
-- `has_column_privilege` is the effective test: it accounts for privileges
-- reaching a role through role membership, which a reading of the GRANT
-- statements would miss. If a withheld column is still readable by any route,
-- this raises and names it.
do $do$
declare
  v_allow constant text[] := array['id', 'course_id', 'reference', 'amount', 'currency', 'status'];
  v_deny  constant text[] := array['user_id', 'company_id', 'method', 'provider_reference',
                                   'metadata', 'created_at', 'completed_at', 'provider',
                                   'provider_mode', 'provider_token', 'entitlement_id'];
  v_role  text;
  v_priv  text;
  v_col   text;
  v_txt   text;
  v_n     integer;
begin
  -- The two lists together must account for every column of the table: a
  -- column this migration never classified is a column nobody decided about.
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_n <> array_length(v_allow, 1) + array_length(v_deny, 1) then
    raise exception 'PAY-1B 059: public.payments has % column(s) but this migration classified %', v_n, array_length(v_allow, 1) + array_length(v_deny, 1);
  end if;
  select string_agg(c, ', ') into v_txt
    from unnest(v_allow || v_deny) as c
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = 'public.payments'::regclass
                        and a.attname = c and not a.attisdropped);
  if v_txt is not null then
    raise exception 'PAY-1B 059: the classification names column(s) that do not exist: %', v_txt;
  end if;

  -- ── anon: NO payment read at all ────────────────────────────────────────
  if has_table_privilege('anon', 'public.payments', 'SELECT') then
    select string_agg(r.rolname, ', ' order by r.rolname) into v_txt
      from pg_roles r
     where r.rolname <> 'anon'
       and pg_has_role('anon', r.oid, 'USAGE')
       and has_table_privilege(r.rolname, 'public.payments', 'SELECT');
    raise exception 'PAY-1B 059: anon still holds table-level SELECT on public.payments. Role(s) granting it via membership: %',
      coalesce(v_txt, '(none — the grant is direct)');
  end if;
  if has_any_column_privilege('anon', 'public.payments', 'SELECT') then
    select string_agg(a.attname, ', ' order by a.attname) into v_txt
      from pg_attribute a
     where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('anon', 'public.payments', a.attname, 'SELECT');
    raise exception 'PAY-1B 059: anon can still read payment column(s): %', v_txt;
  end if;

  -- ── authenticated: the allowlist, and nothing else ──────────────────────
  --
  -- If this fires, the privilege is almost certainly INHERITED: a revoke can
  -- only remove a grant made TO the named role, so a grant held by a role that
  -- `authenticated` is a member of survives untouched. The message therefore
  -- names the roles it could be coming from — otherwise the operator is told
  -- the apply failed but not where to look.
  if has_table_privilege('authenticated', 'public.payments', 'SELECT') then
    select string_agg(r.rolname, ', ' order by r.rolname) into v_txt
      from pg_roles r
     where r.rolname <> 'authenticated'
       and pg_has_role('authenticated', r.oid, 'USAGE')
       and has_table_privilege(r.rolname, 'public.payments', 'SELECT');
    raise exception 'PAY-1B 059: authenticated still holds TABLE-level SELECT on public.payments, so select(*) would still succeed. A revoke cannot remove an INHERITED privilege; role(s) granting it via membership: %. Revoke there, or remove the membership, then re-run.',
      coalesce(v_txt, '(none found — the grant is direct and this is a bug in this migration)');
  end if;
  foreach v_col in array v_allow loop
    if not has_column_privilege('authenticated', 'public.payments', v_col, 'SELECT') then
      raise exception 'PAY-1B 059: authenticated cannot read payments.%, which the confirmation page needs', v_col;
    end if;
  end loop;
  foreach v_col in array v_deny loop
    if has_column_privilege('authenticated', 'public.payments', v_col, 'SELECT') then
      raise exception 'PAY-1B 059: authenticated can still read payments.% — effective privilege, so check role membership as well as direct grants', v_col;
    end if;
  end loop;
  -- Said once more as a set, so a future edit to either list cannot drift:
  -- exactly the allowlist is readable, and the two forbidden columns are not.
  select string_agg(a.attname, ', ' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT')
     and not (a.attname = any (v_allow));
  if v_txt is not null then
    raise exception 'PAY-1B 059: authenticated can read column(s) outside the allowlist: %', v_txt;
  end if;
  if has_column_privilege('authenticated', 'public.payments', 'provider_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.payments', 'metadata', 'SELECT') then
    raise exception 'PAY-1B 059: provider_token or metadata is still readable by authenticated — the whole point of this migration';
  end if;
  -- The embed dependency, stated as an invariant rather than left implicit.
  if not has_column_privilege('authenticated', 'public.payments', 'course_id', 'SELECT') then
    raise exception 'PAY-1B 059: authenticated cannot read payments.course_id, so PostgREST cannot resolve the courses(title) embed the confirmation page renders';
  end if;

  -- ── PUBLIC holds nothing, at either layer ───────────────────────────────
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
    raise exception 'PAY-1B 059: public.payments grants privilege(s) to PUBLIC: %', v_txt;
  end if;

  -- ── 058's write withdrawal is untouched ─────────────────────────────────
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-1B 059: % gained % on public.payments', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.payments', v_priv) then
        raise exception 'PAY-1B 059: % holds % on some COLUMN of public.payments', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- ── the trusted path keeps everything, columns included ─────────────────
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.payments', v_priv) then
        raise exception 'PAY-1B 059: service_role lost % on public.payments', v_priv;
      end if;
    end loop;
    foreach v_col in array v_allow || v_deny loop
      if not has_column_privilege('service_role', 'public.payments', v_col, 'SELECT') then
        raise exception 'PAY-1B 059: service_role lost SELECT on payments.% — reconciliation needs every column', v_col;
      end if;
    end loop;
  end if;

  -- ── the policy set is EXACTLY as 058 left it ────────────────────────────
  select string_agg(p.polname || '/' || p.polcmd::text || '/' ||
           case when p.polpermissive then 'P' else 'R' end, ' ' order by p.polname) into v_txt
    from pg_policy p where p.polrelid = 'public.payments'::regclass;
  if v_txt is distinct from 'payments_insert_service/a/P payments_no_browser_delete/d/R payments_no_browser_update/w/R payments_own/r/P' then
    raise exception 'PAY-1B 059: the policy set on public.payments changed; it reads [%]', v_txt;
  end if;
  -- Row ownership is still what confines a learner to their own rows, and it
  -- is still allowed to filter on `user_id` even though no browser role may
  -- read that column.
  if not exists (select 1 from pg_policy
                  where polrelid = 'public.payments'::regclass and polname = 'payments_own'
                    and polcmd = 'r' and pg_get_expr(polqual, polrelid) like '%user_id%') then
    raise exception 'PAY-1B 059: payments_own no longer scopes SELECT by user_id';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.payments'::regclass and relrowsecurity) then
    raise exception 'PAY-1B 059: row level security was disabled';
  end if;
end
$do$;


-- ══ 3. NOT ONE PAYMENT ROW WAS WRITTEN ════════════════════════════════════
--
-- The LAST block before COMMIT: an assertion proves nothing about statements
-- that run after it.
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
begin
  select * into b from pay_1b_059_before;

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
    raise exception 'PAY-1B 059: payment row data changed — this migration grants and revokes, it must not write';
  end if;
  select count(*) into v_n from public.payments;
  if v_n <> b.n_payments then
    raise exception 'PAY-1B 059: the payment count changed from % to %', b.n_payments, v_n;
  end if;

  -- The sequencing gate, restated at the end: still no token anywhere.
  select count(*) into v_n from public.payments where provider_token is not null;
  if v_n <> 0 then
    raise exception 'PAY-1B 059: % row(s) acquired a provider_token during this transaction', v_n;
  end if;

  -- Still seventeen columns: 059 adds and drops nothing.
  select count(*) into v_n
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_n <> 17 then
    raise exception 'PAY-1B 059: public.payments has % columns, expected the 17 that 058 produced', v_n;
  end if;

  -- PAY-2 is still unstarted.
  if to_regprocedure('public.complete_payment(text,text)') is not null then
    raise exception 'PAY-1B 059: complete_payment() exists; the completion authority is PAY-2 and must not appear in a SELECT-privilege migration';
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. PRECONDITION, already satisfied: the PAY-1B(a) reader must be LIVE in
--    production before this is applied. It is — merge commit 9308938, Vercel
--    production READY, and the deployed page reads
--      .select('id, reference, amount, currency, status, courses(title)')
--    If that is ever rolled back, roll 059 back with it or the confirmation
--    page returns 42501.
-- 2. Apply only after the owner authorises it and after the branch carrying
--    this file is merged. Paste the WHOLE file into the Supabase SQL editor and
--    run it once. "Success. No rows returned." means every section passed: the
--    file is one transaction and any failed assertion raises and rolls
--    everything back. It emits no RAISE NOTICE, because the SQL editor does not
--    display NOTICE output — anything worth knowing is an exception that stops
--    the apply.
--
--    GRANT and REVOKE take a brief ACCESS EXCLUSIVE lock on the table and write
--    no row. It completes in milliseconds.
-- 3. Immediately afterwards, GET-only:
--      as the ANON key
--        /rest/v1/payments?select=id              -> 401/403 with code 42501
--      as a LEARNER (authenticated)
--        /rest/v1/payments?select=id,reference,amount,currency,status,courses(title)
--                                                 -> 200
--        /rest/v1/payments?select=provider_token  -> 42501
--        /rest/v1/payments?select=metadata        -> 42501
--        /rest/v1/payments?select=*               -> 42501
--      as the SERVICE key
--        /rest/v1/payments?select=provider_token,metadata
--                                                 -> 200
--    and confirm /checkout, /checkout/confirm and /dashboard still render.
--
-- ── WHAT REMAINS AFTER THIS SLICE ─────────────────────────────────────────
--
--   * PAY-2 — the PayDunya completion authority and IPN. Everything 058's
--     operator note records still applies: complete_payment() must be CREATED,
--     a new SECURITY DEFINER function must explicitly revoke EXECUTE from
--     PUBLIC, there is no webhook_id, payments.method cannot represent
--     'paydunya', abandoned pending intents need handling, and `company_id`
--     is unexplained drift. With 059 applied, PAY-2 may now write
--     provider_token: no browser role can read it.
--   * SEC-4 — certificate hardening, still a PAID-LAUNCH BLOCKER and still
--     untouched by any payment slice. See 058's operator note.
--   * N-3 enrollments_update — still non-blocking.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores 058's privilege state, re-opening the browser column
-- read. Only safe while the PAY-1B(a) reader is deployed (it is: an explicit
-- projection works under both the narrow and the wide grant). Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- do $rb$
-- declare v_n integer;
-- begin
--   select count(*) into v_n from public.payments where provider_token is not null;
--   if v_n <> 0 then
--     raise exception 'PAY-1B 059 rollback: % row(s) carry a provider_token; re-opening the browser column read would disclose it', v_n;
--   end if;
-- end
-- $rb$;
--
-- revoke select (
--   id, user_id, course_id, company_id, amount, currency, method, status,
--   reference, provider_reference, metadata, created_at, completed_at,
--   provider, provider_mode, provider_token, entitlement_id
-- ) on public.payments from authenticated;
--
-- grant select on public.payments to anon, authenticated;
--
-- commit;
