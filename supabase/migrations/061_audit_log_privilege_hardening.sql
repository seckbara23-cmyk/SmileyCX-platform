-- ============================================================================
-- Migration 061 — AUDIT-SEC-01: close the audit_log grant layer.
--
-- Run as a SINGLE TRANSACTION. Forward-only: no earlier migration is edited.
-- PRIVILEGES ONLY. No schema change, no policy change, no column added or
-- dropped, no index touched, no table recreated, and NOT ONE audit row written.
--
-- ⚠ NOT APPLIED AT AUTHORING TIME. Operator step at the foot of this file.
--
-- ── THE ROOT CAUSE, IN MIGRATION 027'S OWN WORDS ───────────────────────────
--
-- 027 created audit_log, enabled RLS, added one SELECT policy for admins, and
-- then wrote:
--
--   "RLS: platform admins may read. No INSERT/UPDATE/DELETE policies exist, so
--    anon and authenticated cannot write at all"
--   "Append-only at the grant layer as well: even with a future policy mistake,
--    application roles cannot rewrite or erase history."
--     revoke update, delete on public.audit_log from anon, authenticated;
--
-- Both sentences are true. Together they are not sufficient, and the gap
-- between them is this migration.
--
-- Supabase applies ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated, so the table was BORN holding all seven privileges for both
-- browser roles. 027 took back two. The reasoning for leaving the rest was that
-- RLS governs writes — and for INSERT, UPDATE and DELETE it does.
--
-- TRUNCATE IS NOT GOVERNED BY RLS. Row level security filters and checks ROWS;
-- TRUNCATE is a table-level operation and never consults a policy. So the one
-- privilege that can erase the entire audit trail in a single statement was the
-- one privilege neither layer stopped: the policy could not see it, and the
-- revoke did not name it.
--
-- Production inspection confirmed it: `anon` and `authenticated` both hold
-- effective TRUNCATE, INSERT, REFERENCES and TRIGGER on a table holding 19
-- records. UPDATE and DELETE were already denied, exactly as 027 intended.
--
-- TRIGGER is worth naming separately. It permits creating a trigger ON this
-- table, and a trigger runs as its own definer — so it is a write primitive on
-- an append-only log, reachable without any policy ever being consulted.
--
-- ── WHY THE FIX IS TWO STATEMENTS ──────────────────────────────────────────
--
--   revoke all on public.audit_log from public, anon, authenticated;
--   grant select on public.audit_log to authenticated;
--
-- REVOKE ALL rather than naming the four privileges, for a reason measured
-- during 059 rather than assumed: a table-level REVOKE of a privilege DOES
-- cascade to that privilege's COLUMN-level grants. Naming privileges one by one
-- would leave any column-level grant on `metadata` or `actor_email` untouched,
-- and a column grant is invisible to has_table_privilege. `all` reaches every
-- privilege at both layers in one statement.
--
-- FROM PUBLIC as well as the two roles, because a grant to PUBLIC applies to
-- every role and no revoke aimed at `authenticated` would reach it. Section 0
-- refuses if service_role's own privileges turn out to arrive via PUBLIC, since
-- this statement would then strip the one role that must keep them.
--
-- The single grant restores SELECT to `authenticated` and nothing else.
--
-- ── WHAT authenticated's SELECT IS FOR ─────────────────────────────────────
--
-- Stated plainly, because it is the one judgement call here: NO CODE READS
-- audit_log. `lib/audit/log.ts:106` is the only `from('audit_log')` in the
-- repository and it is an INSERT through the service-role client. No admin page
-- reads the table. Revoking SELECT from `authenticated` too would therefore
-- break nothing today and would be strictly safer.
--
-- It is preserved deliberately, as the AUDIT-SEC-01 brief requires, so that
-- `audit_log_admin_read` remains a live contract rather than a policy guarding
-- a privilege nobody holds. An administrator audit viewer is a plausible next
-- slice, and when it arrives the policy — not a new grant — will be what
-- governs it. `anon` gets nothing: it can never satisfy
-- is_platform_admin(), so its SELECT only ever returned an empty array, and an
-- empty array is not a workflow.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
--
--   * NO policy created, altered or dropped. 027's audit_log_admin_read is
--     pinned byte-for-byte by section 2. The existing policy does not prevent
--     the security contract — it was never the problem — so it is not touched.
--   * NO change to service_role. It is ASSERTED to retain SELECT and INSERT,
--     never re-granted. Narrowing service_role's own TRUNCATE is a separate
--     judgement and a separate slice; it is the trusted role, and this slice is
--     about the untrusted ones.
--   * NO schema change. Not one column, index, constraint or default.
--   * NO audit row inserted, updated, deleted or truncated. Section 3 proves it
--     by fingerprint, not by intention.
--   * NO privilege statement naming any table other than public.audit_log.
--   * NO payment-completion function. That is PAY-2C, and it now lands as 062
--     rather than 061 because this slice took the number.
-- ============================================================================

-- REPEATABLE READ: the before/after row fingerprint is read as ONE snapshot,
-- so "no audit record changed" compares like with like.
begin isolation level repeatable read;

-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $do$
declare
  v_cols  text;
  v_txt   text;
  v_role  text;
  v_priv  text;
  v_n     integer;
begin
  if to_regclass('public.audit_log') is null then
    raise exception 'AUDIT-SEC-01 061 preflight: public.audit_log does not exist';
  end if;

  -- 027's fifteen columns. A different shape means a different table from the
  -- one whose privileges this migration was written against.
  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from 'actor_email,actor_id,actor_type,created_at,event_type,id,invitation_id,ip,metadata,method,outcome,reason,subject_email,subject_user_id,user_agent' then
    raise exception 'AUDIT-SEC-01 061 preflight: public.audit_log has columns [%]; expected the fifteen migration 027 created', v_cols;
  end if;

  if not exists (select 1 from pg_class
                  where oid = 'public.audit_log'::regclass and relrowsecurity) then
    raise exception 'AUDIT-SEC-01 061 preflight: row level security is NOT enabled on public.audit_log';
  end if;

  -- 027's policy must be present and unchanged BEFORE the revoke, because
  -- section 2 pins it afterwards and a pin only means something if the thing
  -- pinned was already correct.
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.audit_log'::regclass
       and polname = 'audit_log_admin_read' and polcmd = 'r'
  ) then
    raise exception 'AUDIT-SEC-01 061 preflight: policy audit_log_admin_read is missing or is not a SELECT policy';
  end if;
  select count(*) into v_n from pg_policy where polrelid = 'public.audit_log'::regclass;
  if v_n <> 1 then
    raise exception 'AUDIT-SEC-01 061 preflight: public.audit_log carries % policies; 027 left exactly one and this migration adds none', v_n;
  end if;

  -- ── THE ONE EXPOSURE NO REVOKE CAN REACH ──────────────────────────────
  --
  -- A privilege held through ROLE MEMBERSHIP survives any revoke aimed at the
  -- member. If TRUNCATE reaches a browser role that way, the two statements
  -- below would appear to succeed and change nothing, so this refuses instead
  -- and names where to look.
  foreach v_role in array array['anon', 'authenticated'] loop
    select string_agg(r.rolname, ', ' order by r.rolname) into v_txt
      from pg_roles r
     where r.rolname <> v_role
       and pg_has_role(v_role, r.oid, 'USAGE')
       and (has_table_privilege(r.rolname, 'public.audit_log', 'TRUNCATE')
         or has_table_privilege(r.rolname, 'public.audit_log', 'INSERT')
         or has_table_privilege(r.rolname, 'public.audit_log', 'TRIGGER'));
    if v_txt is not null then
      raise exception 'AUDIT-SEC-01 061 preflight: % reaches TRUNCATE/INSERT/TRIGGER on public.audit_log through membership of role(s): %. A revoke cannot remove an inherited privilege — revoke at that role, or drop the membership, then re-run.',
        v_role, v_txt;
    end if;
  end loop;

  -- ── service_role's privileges must be ITS OWN ─────────────────────────
  --
  -- The revoke below names PUBLIC. If service_role held audit_log privileges
  -- only by virtue of being a role (i.e. via PUBLIC) rather than by direct
  -- grant, that statement would strip the one role that must keep them. Refuse
  -- rather than discover it in section 2.
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT'] loop
      if not has_table_privilege('service_role', 'public.audit_log', v_priv) then
        raise exception 'AUDIT-SEC-01 061 preflight: service_role lacks % on public.audit_log; audit writing is already broken and this migration is not the fix', v_priv;
      end if;
    end loop;
    if not exists (
      select 1 from pg_class c, aclexplode(c.relacl) acl
       where c.oid = 'public.audit_log'::regclass
         and acl.grantee = to_regrole('service_role')::oid
         and acl.privilege_type in ('SELECT', 'INSERT')
    ) then
      raise exception 'AUDIT-SEC-01 061 preflight: service_role holds SELECT/INSERT on public.audit_log but NOT by direct grant — it must be arriving via PUBLIC or a membership, and the revoke below would strip it. Grant service_role directly first, then re-run.';
    end if;
  end if;
end
$do$;

-- The facts section 3 needs, and nothing else. Dropped at COMMIT.
-- Fingerprinted by an EXPLICIT column list: to_jsonb would mask a column being
-- added or retyped mid-transaction, and the whole point is that nothing moves.
create temp table audit_sec_01_before on commit drop as
select
  (select md5(coalesce(string_agg(
            a.id::text || '|' || a.event_type || '|' || a.actor_type
              || '|' || coalesce(a.actor_id::text, '') || '|' || coalesce(a.actor_email, '')
              || '|' || coalesce(a.subject_user_id::text, '') || '|' || coalesce(a.subject_email, '')
              || '|' || coalesce(a.method, '') || '|' || coalesce(a.invitation_id::text, '')
              || '|' || a.outcome || '|' || coalesce(a.reason, '')
              || '|' || coalesce(a.ip, '') || '|' || coalesce(a.user_agent, '')
              || '|' || a.metadata::text || '|' || a.created_at::text,
            E'\n' order by a.id), ''))
     from public.audit_log a)                                   as rows_md5,
  (select count(*) from public.audit_log)                       as n_rows,
  (select md5(coalesce(string_agg(p.polname || '/' || p.polcmd::text || '/' ||
            p.polpermissive::text || '/' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
            || '/' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), ''))
     from pg_policy p where p.polrelid = 'public.audit_log'::regclass) as policy_md5,
  (select count(*) from pg_index where indrelid = 'public.audit_log'::regclass) as n_indexes,
  -- What the browser roles held on the way in, so the report can state the
  -- before-state from the database rather than from a human's notes.
  (select string_agg(x.rolname || ':' || x.priv, ' ' order by x.rolname, x.priv)
     from (
       select r.rolname, p.priv
         from (values ('anon'), ('authenticated')) r(rolname)
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                           ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
        where has_table_privilege(r.rolname, 'public.audit_log', p.priv)
     ) x)                                                       as browser_before;


-- ══ 1. THE CORRECTION — EXACTLY TWO PRIVILEGE STATEMENTS ══════════════════

revoke all on public.audit_log from public, anon, authenticated;

grant select on public.audit_log to authenticated;


-- ══ 2. THE RESULTING EFFECTIVE PRIVILEGES ═════════════════════════════════
--
-- EFFECTIVE, not "what the GRANT said". has_table_privilege and
-- has_any_column_privilege account for role membership, for PUBLIC and for
-- column-level grants; reading the two statements above proves none of that.
do $do$
declare
  v_role  text;
  v_priv  text;
  v_txt   text;
  v_n     integer;
begin
  -- ── the headline: no browser role can erase the audit trail ───────────
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_role, 'public.audit_log', 'TRUNCATE') then
      select string_agg(r.rolname, ', ' order by r.rolname) into v_txt
        from pg_roles r
       where r.rolname <> v_role and pg_has_role(v_role, r.oid, 'USAGE')
         and has_table_privilege(r.rolname, 'public.audit_log', 'TRUNCATE');
      raise exception 'AUDIT-SEC-01 061: % STILL holds TRUNCATE on public.audit_log — the exposure this migration exists to close. Source: %',
        v_role, coalesce('inherited from ' || v_txt, 'a direct grant that the revoke failed to reach');
    end if;
  end loop;

  -- ── and cannot write by any other means, at either layer ──────────────
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.audit_log', v_priv) then
        raise exception 'AUDIT-SEC-01 061: % still holds % on public.audit_log', v_role, v_priv;
      end if;
    end loop;
    -- A column-level grant is invisible to has_table_privilege, which is why
    -- the revoke was `all` and why this is checked separately.
    foreach v_priv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.audit_log', v_priv) then
        raise exception 'AUDIT-SEC-01 061: % holds % on some COLUMN of public.audit_log', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- ── anon loses the read entirely ──────────────────────────────────────
  if has_table_privilege('anon', 'public.audit_log', 'SELECT')
     or has_any_column_privilege('anon', 'public.audit_log', 'SELECT') then
    raise exception 'AUDIT-SEC-01 061: anon can still read public.audit_log';
  end if;

  -- ── authenticated keeps SELECT, and ONLY SELECT ───────────────────────
  if not has_table_privilege('authenticated', 'public.audit_log', 'SELECT') then
    raise exception 'AUDIT-SEC-01 061: authenticated lost SELECT on public.audit_log, so audit_log_admin_read now guards a privilege nobody holds';
  end if;

  -- ── nothing reaches PUBLIC, at either layer ───────────────────────────
  select string_agg(x.privilege_type, ', ' order by x.privilege_type) into v_txt
    from (
      select (aclexplode(c.relacl)).grantee as grantee,
             (aclexplode(c.relacl)).privilege_type
        from pg_class c where c.oid = 'public.audit_log'::regclass and c.relacl is not null
      union all
      select (aclexplode(a.attacl)).grantee, (aclexplode(a.attacl)).privilege_type
        from pg_attribute a
       where a.attrelid = 'public.audit_log'::regclass and a.attacl is not null
    ) x
   where x.grantee = 0;
  if v_txt is not null then
    raise exception 'AUDIT-SEC-01 061: public.audit_log still grants privilege(s) to PUBLIC: %', v_txt;
  end if;

  -- ── the trusted writer is intact ──────────────────────────────────────
  if to_regrole('service_role') is not null then
    foreach v_priv in array array['SELECT', 'INSERT'] loop
      if not has_table_privilege('service_role', 'public.audit_log', v_priv) then
        raise exception 'AUDIT-SEC-01 061: service_role lost % on public.audit_log — logAuditEvent would stop recording, silently, because it swallows its own errors', v_priv;
      end if;
    end loop;
  end if;

  -- ── RLS and the policy are exactly as 027 left them ───────────────────
  if not exists (select 1 from pg_class
                  where oid = 'public.audit_log'::regclass and relrowsecurity) then
    raise exception 'AUDIT-SEC-01 061: row level security was disabled';
  end if;
  select count(*) into v_n from pg_policy where polrelid = 'public.audit_log'::regclass;
  if v_n <> 1 then
    raise exception 'AUDIT-SEC-01 061: public.audit_log now carries % policies, expected exactly 1', v_n;
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.audit_log'::regclass
       and polname = 'audit_log_admin_read' and polcmd = 'r' and polpermissive
       and pg_get_expr(polqual, polrelid) like '%is_platform_admin%'
  ) then
    raise exception 'AUDIT-SEC-01 061: audit_log_admin_read no longer reads as a permissive SELECT policy on is_platform_admin()';
  end if;

  -- ── no table other than audit_log was touched ─────────────────────────
  --
  -- The two statements name only public.audit_log, so this cannot fail by
  -- construction — which is exactly why it is cheap to prove rather than
  -- assert in prose. payments carries the privilege contract 059 and 060
  -- established and is the most consequential neighbour.
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('authenticated', 'public.payments', v_priv)
       or has_table_privilege('anon', 'public.payments', v_priv) then
      raise exception 'AUDIT-SEC-01 061: a browser role holds % on public.payments; this migration must not have changed that', v_priv;
    end if;
  end loop;
  select string_agg(a.attname, ',' order by a.attname) into v_txt
    from pg_attribute a
   where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.payments', a.attname, 'SELECT');
  if v_txt is distinct from 'amount,course_id,currency,id,reference,status' then
    raise exception 'AUDIT-SEC-01 061: 059''s six-column payment allowlist now reads [%]; this migration must not have changed it', v_txt;
  end if;
  if to_regclass('public.entitlements') is not null
     and (has_any_column_privilege('anon', 'public.entitlements', 'SELECT')
       or has_any_column_privilege('authenticated', 'public.entitlements', 'SELECT')) then
    raise exception 'AUDIT-SEC-01 061: a browser role can read public.entitlements; 037 withdrew that and this migration must not have changed it';
  end if;
end
$do$;


-- ══ 3. NOT ONE AUDIT RECORD CHANGED ══════════════════════════════════════
--
-- The LAST block before COMMIT: an assertion proves nothing about statements
-- that run after it.
do $do$
declare
  b     record;
  v_now text;
  v_n   integer;
begin
  select * into b from audit_sec_01_before;

  select md5(coalesce(string_agg(
           a.id::text || '|' || a.event_type || '|' || a.actor_type
             || '|' || coalesce(a.actor_id::text, '') || '|' || coalesce(a.actor_email, '')
             || '|' || coalesce(a.subject_user_id::text, '') || '|' || coalesce(a.subject_email, '')
             || '|' || coalesce(a.method, '') || '|' || coalesce(a.invitation_id::text, '')
             || '|' || a.outcome || '|' || coalesce(a.reason, '')
             || '|' || coalesce(a.ip, '') || '|' || coalesce(a.user_agent, '')
             || '|' || a.metadata::text || '|' || a.created_at::text,
           E'\n' order by a.id), '')) into v_now
    from public.audit_log a;
  if v_now is distinct from b.rows_md5 then
    raise exception 'AUDIT-SEC-01 061: audit record data changed — this migration moves privileges, it must never touch the trail it protects';
  end if;

  select count(*) into v_n from public.audit_log;
  if v_n <> b.n_rows then
    raise exception 'AUDIT-SEC-01 061: the audit record count changed from % to %', b.n_rows, v_n;
  end if;

  -- The policy set is byte-identical, not merely still one row.
  select md5(coalesce(string_agg(p.polname || '/' || p.polcmd::text || '/' ||
           p.polpermissive::text || '/' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || '/' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '|' order by p.polname), ''))
    into v_now
    from pg_policy p where p.polrelid = 'public.audit_log'::regclass;
  if v_now is distinct from b.policy_md5 then
    raise exception 'AUDIT-SEC-01 061: the audit_log policy set changed; 027 owns it and this migration does not';
  end if;

  -- 027's four indexes, untouched.
  select count(*) into v_n from pg_index where indrelid = 'public.audit_log'::regclass;
  if v_n <> b.n_indexes then
    raise exception 'AUDIT-SEC-01 061: the audit_log index count changed from % to %', b.n_indexes, v_n;
  end if;

  -- No schema change: still the fifteen columns, and metadata still NOT NULL
  -- with its default, which 053's publication trigger depends on.
  select string_agg(a.attname, ',' order by a.attname) into v_now
    from pg_attribute a
   where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_now is distinct from 'actor_email,actor_id,actor_type,created_at,event_type,id,invitation_id,ip,metadata,method,outcome,reason,subject_email,subject_user_id,user_agent' then
    raise exception 'AUDIT-SEC-01 061: the audit_log column set changed to [%]', v_now;
  end if;
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.audit_log'::regclass and a.attname = 'metadata'
       and a.attnotnull and a.atthasdef
  ) then
    raise exception 'AUDIT-SEC-01 061: audit_log.metadata is no longer NOT NULL with a default';
  end if;

  -- This slice creates no function of any kind, and PAY-2C is still unstarted.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_now
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%complete%payment%';
  if v_now is not null then
    raise exception 'AUDIT-SEC-01 061: a payment-completion routine exists: %. This slice is privileges only.', v_now;
  end if;
end
$do$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- OPERATOR STEP — NOT APPLIED AT AUTHORING TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Safe with the CURRENT application, and the reason is narrow enough to
--    state exactly: `lib/audit/log.ts:106` is the ONLY `from('audit_log')` in
--    the repository, it is an INSERT, and it runs through the service-role
--    client — which this migration does not touch and section 2 asserts is
--    intact. No code reads audit_log at all, so removing anon's SELECT and
--    narrowing authenticated's to SELECT-only changes no running behaviour.
--    Privilege-only, no table rewrite, no lock beyond a brief ACCESS EXCLUSIVE
--    for the catalogue update. Milliseconds.
-- 2. Paste the WHOLE file into the Supabase SQL editor and run it once.
--    "Success. No rows returned." means every assertion passed: the file is one
--    transaction and any failure raises and rolls everything back. It emits no
--    RAISE NOTICE, because the SQL editor does not display NOTICE output.
-- 3. Immediately afterwards, re-run docs/pay-2c-preflight-inspection.sql and
--    confirm section B1 reads, for BOTH anon and authenticated:
--        INSERT      not held
--        UPDATE      not held
--        DELETE      not held
--        TRUNCATE    not held      <- the exposure, closed
--        REFERENCES  not held
--        TRIGGER     not held
--        SELECT      anon: not held | authenticated: HELD
--    and that B6 still shows exactly one policy, audit_log_admin_read.
-- 4. Then, GET-only against the REST API:
--        as the ANON key    /rest/v1/audit_log?select=id   -> 42501
--          (before this migration it returned 200 with [] — the grant existed
--           and only RLS emptied the result. 42501 is the privilege layer now
--           refusing, which is the observable difference.)
--        as the SERVICE key /rest/v1/audit_log?select=id&limit=0 + count
--                                                         -> still 19 rows
--    and confirm an admin action that writes an audit row still records one
--    (grant or revoke an entitlement on a test account, then re-count).
--
-- ── WHAT THIS DOES NOT FIX ────────────────────────────────────────────────
--
--   * service_role retains TRUNCATE, UPDATE and DELETE on audit_log. It is the
--     trusted role and ~89 call sites use it, so an append-only guarantee
--     against service_role is a different slice with a different argument. If
--     that is wanted, the shape is `revoke truncate, update, delete on
--     public.audit_log from service_role` plus a check that logAuditEvent still
--     inserts — but note `logAuditEvent` SWALLOWS its own errors, so breaking it
--     would be silent and must be verified behaviourally, not by absence of
--     complaints.
--   * audit_log has no FK and no tamper-evidence beyond these privileges. A
--     holder of the service key can still rewrite history. That is inherent to
--     a single-database audit trail and is a design question, not a grant one.
--   * PAY-2C's completion function now lands as migration 062.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — restores the pre-061 grant state, INCLUDING THE EXPOSURE.
-- Only for undoing 061 itself. Re-opening TRUNCATE on the audit trail is not
-- something to do casually. Run it WHOLE.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
--
-- grant select, insert, truncate, references, trigger
--   on public.audit_log to anon, authenticated;
--
-- -- 027's two revokes stay in force: UPDATE and DELETE were already denied
-- -- before 061 and must remain denied after a rollback of 061.
-- revoke update, delete on public.audit_log from anon, authenticated;
--
-- commit;
