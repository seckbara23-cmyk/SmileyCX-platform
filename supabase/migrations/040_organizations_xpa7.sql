-- ============================================================================
-- Migration 040 — XPA-7: B2B organizations, membership lifecycle, corporate
-- attribution, and a correction to the legacy organization isolation.
--
-- Runs as a SINGLE TRANSACTION; this file wraps itself.
--
-- ── WHAT THIS IS BUILT ON ─────────────────────────────────────────────────
--
-- `organizations` and `organization_memberships` are ALREADY DEPLOYED in
-- production, empty, applied outside `migrations/` (D-LEDGER drift) and never
-- versioned. `docs/security/sec-1-identity-registration-forensic-audit.md`
-- records them as "not deployed"; that is wrong, and the XPA-7 audit corrected
-- it. This migration therefore RECONCILES rather than creates: every object is
-- guarded so it is a no-op where the deployed state already matches.
--
-- D-Q4 said preserve those tables and build no competing model. This does that.
--
-- ── THE SECURITY FINDING THIS FIXES ───────────────────────────────────────
--
-- Migration 004 replaced the original membership INSERT policy with:
--
--     WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid()
--                 AND (role = 'viewer' OR has_org_role(org_id,'org_admin')
--                      OR is_platform_admin()))
--
-- The `role = 'viewer'` arm places NO constraint on WHICH org_id. Proved
-- against production with a disposable learner:
--
--   learner self-joins an unrelated organization as viewer -> HTTP 201, row created
--   learner then reads that organization -> name, slug, plan, plan_status returned
--   learner then reads its membership list -> visible
--   learner self-promotes to org_admin -> correctly blocked
--
-- So any authenticated user could enrol themselves into any company and read it.
-- That is the D7-5 isolation requirement inverted. It was harmless only because
-- zero organizations exist; XPA-7 is what makes organizations exist.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────────────────
--
-- No seats (D7-6). No contract table. No change to `has_course_access()`, which
-- stays source-agnostic and reads entitlements alone. No backfill of
-- `organization_id` — `external_ref` holds nothing to derive it from, and
-- inventing provenance is worse than leaving it null. `organizations.plan` and
-- `plan_status` are kept, untouched, and are NOT authority (D7-2).
-- ============================================================================

begin;


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regclass('public.organizations') is null then
    raise exception 'XPA-7 040 preflight: public.organizations is missing — the legacy schema is not deployed';
  end if;
  if to_regclass('public.organization_memberships') is null then
    raise exception 'XPA-7 040 preflight: public.organization_memberships is missing';
  end if;
  if to_regclass('public.entitlements') is null then
    raise exception 'XPA-7 040 preflight: public.entitlements is missing — apply 037 first';
  end if;
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'XPA-7 040 preflight: is_platform_admin() is missing';
  end if;
end $$;


-- ══ 1. CORPORATE ATTRIBUTION ON ENTITLEMENTS ══════════════════════════════
--
-- Nullable, forward-only, never backfilled (D7-1 consequent ruling).
--
-- It records WHICH ORGANIZATION a grant was issued for, at the moment it was
-- issued. It is attribution, not authority: `has_course_access()` does not read
-- it and must never read it. Deriving the organization through membership
-- instead would be wrong — a learner can leave a company while the grant they
-- were given remains a historical fact.
--
-- ON DELETE SET NULL, not CASCADE: deleting an organization must never delete a
-- learner's commercial history.

alter table public.entitlements
  add column if not exists organization_id uuid
    references public.organizations(id) on delete set null;

create index if not exists entitlements_org_idx
  on public.entitlements (organization_id, status)
  where organization_id is not null;

comment on column public.entitlements.organization_id is
  'XPA-7 corporate attribution. Which organization a grant was issued for. NOT an access authority — has_course_access() never reads it. Null for individual grants.';


-- ══ 2. MEMBERSHIP LIFECYCLE (D7-4) ════════════════════════════════════════
--
-- PENDING  invited, not yet accepted — grants NOTHING
-- ACTIVE   a real member
-- REMOVED  history preserved; grants NOTHING
--
-- Default ACTIVE so the additive change cannot alter the meaning of any row
-- that already exists. (Zero exist today, but the migration must be correct
-- regardless of when it runs.)

alter table public.organization_memberships
  add column if not exists status text not null default 'ACTIVE';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'organization_memberships_status_check'
      and conrelid = 'public.organization_memberships'::regclass
  ) then
    alter table public.organization_memberships
      add constraint organization_memberships_status_check
      check (status in ('PENDING', 'ACTIVE', 'REMOVED'));
  end if;
end $$;

comment on column public.organization_memberships.status is
  'XPA-7 membership lifecycle. Only ACTIVE confers membership; PENDING and REMOVED confer nothing. REMOVED is retained as history rather than deleted.';


-- ══ 3. MEMBERSHIP HELPERS MUST HONOUR THE LIFECYCLE ═══════════════════════
--
-- Without this, a PENDING invitee or a REMOVED ex-employee would still satisfy
-- `is_org_member()` and keep reading the organization. The lifecycle would be
-- decoration.
--
-- Both remain SECURITY DEFINER with a pinned search_path, as deployed.

create or replace function public.is_org_member(p_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.organization_memberships
    where org_id = p_org_id
      and user_id = auth.uid()
      and status = 'ACTIVE'
  )
$$;

create or replace function public.get_org_role(p_org_id uuid)
returns text language sql security definer stable set search_path = public as $$
  select role from public.organization_memberships
  where org_id = p_org_id
    and user_id = auth.uid()
    and status = 'ACTIVE'
  limit 1
$$;

create or replace function public.has_org_role(p_org_id uuid, p_min_role text)
returns boolean language sql security definer stable set search_path = public as $$
  with rank(name, n) as (
    values ('viewer',1), ('analyst',2), ('team_manager',3), ('cx_manager',4), ('org_admin',5)
  )
  select coalesce(
    (select r.n from public.organization_memberships m
       join rank r on r.name = m.role
      where m.org_id = p_org_id
        and m.user_id = auth.uid()
        and m.status = 'ACTIVE'
      limit 1)
    >= (select n from rank where name = p_min_role),
    false)
$$;


-- ══ 4. THE ISOLATION FIX ══════════════════════════════════════════════════
--
-- The self-service `role = 'viewer'` arm is removed. Membership is created by
-- someone with authority over THAT organization — a platform admin, or an
-- existing ACTIVE org_admin of that same organization — and never by the person
-- being added.
--
-- D7-3: this does not give an org_admin any commercial power. They may shape
-- their own roster; they may not mint entitlements. Those are different tables
-- behind different authority.

drop policy if exists "memberships_insert_admin" on public.organization_memberships;
drop policy if exists "memberships_insert"       on public.organization_memberships;

create policy "memberships_insert" on public.organization_memberships
  for insert with check (
    public.is_platform_admin()
    or public.has_org_role(org_id, 'org_admin')
  );

-- UPDATE gains a WITH CHECK. Without one, the row can be moved to another
-- organization on the way out — the defect class the migration linter flags and
-- the same shape as the XPA-6A platform_role escalation.
drop policy if exists "memberships_update_admin" on public.organization_memberships;

create policy "memberships_update_admin" on public.organization_memberships
  for update
  using       (public.has_org_role(org_id, 'org_admin') or public.is_platform_admin())
  with check  (public.has_org_role(org_id, 'org_admin') or public.is_platform_admin());

-- A member may still remove THEMSELVES; an org_admin may remove anyone in their
-- own organization. Preserved from the deployed policy.
drop policy if exists "memberships_delete_admin" on public.organization_memberships;

create policy "memberships_delete_admin" on public.organization_memberships
  for delete using (
    public.has_org_role(org_id, 'org_admin')
    or user_id = auth.uid()
    or public.is_platform_admin()
  );

-- SELECT: own rows, or rows of an organization you are an ACTIVE member of.
-- Unchanged in shape; restated so the lifecycle-aware helper governs it.
drop policy if exists "memberships_select_own" on public.organization_memberships;

create policy "memberships_select_own" on public.organization_memberships
  for select using (
    user_id = auth.uid()
    or public.is_org_member(org_id)
    or public.is_platform_admin()
  );


-- ══ 5. ORGANIZATIONS — RE-ASSERTED ════════════════════════════════════════
--
-- Creation is platform-admin only. The deployed `orgs_insert_authenticated`
-- policy allowed any authenticated caller; production refuses today because the
-- app roles hold no INSERT privilege, but a policy that says "anyone" must not
-- be the thing standing between a learner and a company record.

drop policy if exists "orgs_insert_authenticated" on public.organizations;
drop policy if exists "orgs_admin_all"            on public.organizations;
drop policy if exists "orgs_member_select"        on public.organizations;
drop policy if exists "orgs_admin_update"         on public.organizations;

create policy "orgs_member_select" on public.organizations
  for select using (public.is_org_member(id) or public.is_platform_admin());

create policy "orgs_platform_admin_all" on public.organizations
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

-- An org_admin may edit their own organization's presentation. WITH CHECK stops
-- the row being retargeted at another organization.
create policy "orgs_admin_update" on public.organizations
  for update
  using      (public.has_org_role(id, 'org_admin'))
  with check (public.has_org_role(id, 'org_admin'));


-- ══ 6. PRIVILEGES (D-GRANT) ═══════════════════════════════════════════════
--
-- Supabase grants ALL on new tables to anon and authenticated by default. These
-- tables predate the entitlement work and were never audited for it. RLS is
-- doing the work today, but a privilege the application never needs should not
-- be there for RLS to have to refuse.

revoke all on public.organizations            from anon;
revoke all on public.organization_memberships from anon;

grant select, insert, update, delete on public.organizations            to authenticated;
grant select, insert, update, delete on public.organization_memberships to authenticated;


-- ══ 7. APPLY-TIME VERIFICATION ════════════════════════════════════════════
--
-- Structural only, and deliberately so. These policies key on `auth.uid()`,
-- which is null under `set role authenticated` inside a migration, so a
-- behavioural probe here would prove nothing about a real caller. Behaviour is
-- proved by `scripts/security/verify-xpa-7.mjs` against production with real
-- JWTs. Asserting structure here and behaviour there is the honest split — the
-- same one migration 038 used.

do $$
declare
  qual text;
  chk  text;
  bad  text;
begin
  -- 7.1 The self-join arm is gone.
  select with_check into chk from pg_policies
  where schemaname = 'public' and tablename = 'organization_memberships'
    and policyname = 'memberships_insert';
  if chk is null then
    raise exception 'memberships_insert is missing';
  end if;
  if chk like '%viewer%' then
    raise exception 'memberships_insert still allows a self-service viewer join: %', chk;
  end if;
  if chk not like '%has_org_role%' or chk not like '%is_platform_admin%' then
    raise exception 'memberships_insert does not require org_admin or platform admin: %', chk;
  end if;

  -- 7.2 Every mutating membership policy has a WITH CHECK where one applies.
  select string_agg(policyname, ', ') into bad
  from pg_policies
  where schemaname = 'public' and tablename = 'organization_memberships'
    and cmd = 'UPDATE' and with_check is null;
  if bad is not null then
    raise exception 'membership UPDATE policy without WITH CHECK: %', bad;
  end if;

  select string_agg(policyname, ', ') into bad
  from pg_policies
  where schemaname = 'public' and tablename = 'organizations'
    and cmd in ('UPDATE', 'ALL') and with_check is null;
  if bad is not null then
    raise exception 'organizations policy without WITH CHECK: %', bad;
  end if;

  -- 7.3 Nobody may create an organization except a platform admin.
  select with_check into chk from pg_policies
  where schemaname = 'public' and tablename = 'organizations'
    and cmd in ('INSERT', 'ALL') and with_check is not null
  limit 1;
  if chk is null or chk not like '%is_platform_admin%' then
    raise exception 'organization creation is not restricted to platform admins: %', coalesce(chk, '(none)');
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'organizations'
      and policyname = 'orgs_insert_authenticated'
  ) then
    raise exception 'the permissive orgs_insert_authenticated policy still exists';
  end if;

  -- 7.4 The lifecycle is honoured by the helpers, not merely stored.
  for qual in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('is_org_member', 'get_org_role', 'has_org_role')
  loop
    if qual not like '%ACTIVE%' then
      raise exception 'a membership helper ignores the status lifecycle: %', left(qual, 120);
    end if;
  end loop;

  -- 7.5 Attribution exists and is nullable — no historical row was forced.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements'
      and column_name = 'organization_id' and is_nullable = 'YES'
  ) then
    raise exception 'entitlements.organization_id is missing or NOT NULL';
  end if;

  select count(*)::text into bad from public.entitlements where organization_id is not null;
  if bad <> '0' then
    raise exception 'organization_id was backfilled — % row(s) populated, expected 0', bad;
  end if;

  -- 7.6 The access seam is untouched. XPA-7 must not have taught it about
  --     organizations, or the whole entitlement model is bypassed.
  select pg_get_functiondef(p.oid) into qual
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'has_course_access';
  if qual like '%organization%' then
    raise exception 'has_course_access() now reads organization data — the seam was widened';
  end if;
  if qual like '%enrollments%' then
    raise exception 'has_course_access() reads enrollments again — Q-L violated';
  end if;

  -- 7.7 anon holds nothing on either organization table.
  select string_agg(grantee || ':' || privilege_type, ', ') into bad
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('organizations', 'organization_memberships')
    and grantee in ('anon', 'PUBLIC');
  if bad is not null then
    raise exception 'anon/PUBLIC still hold privileges on an organization table: %', bad;
  end if;

  raise notice 'XPA-7 040: organization attribution added, membership lifecycle enforced, self-join isolation defect closed, access seam unchanged.';
end $$;

commit;
