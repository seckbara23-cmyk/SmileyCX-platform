-- ============================================================
-- Migration 027: Identity hardening (SEC-2 remediation)
--
-- Source of truth:
--   docs/security/sec-1-identity-registration-forensic-audit.md
--   docs/security/sec-2-remediation.md
--
-- Closes SEC-1 findings F-2 (privilege escalation) and F-3 (no audit log).
--
-- Additive + policy-tightening only. No permission is broadened anywhere:
--   * profiles UPDATE gains a WITH CHECK (strictly narrower than before)
--   * a BEFORE UPDATE trigger backstops the policy
--   * a new append-only audit_log table is created
--
-- ── F-2: the confirmed vulnerability ────────────────────────────────────────
-- Migration 001 defined:
--     CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE
--       USING (auth.uid() = id OR is_platform_admin());
--
-- PostgreSQL reuses USING as WITH CHECK when WITH CHECK is omitted. But that
-- expression only constrains ROW OWNERSHIP, never COLUMN VALUES: a row whose
-- platform_role has been changed to 'super_admin' still satisfies
-- `auth.uid() = id`, so the UPDATE is accepted. Any authenticated learner could
-- therefore run, via PostgREST with the public anon key + their own session:
--
--     UPDATE profiles SET platform_role = 'super_admin' WHERE id = auth.uid();
--
-- ...gaining is_platform_admin() = true and, with it, read access to every
-- profile, enrollment and payment through the admin arms of every RLS policy.
--
-- ── The fix (two independent layers) ────────────────────────────────────────
-- 1. RLS WITH CHECK — pins platform_role to its existing value for non-admins.
--    Uses a SECURITY DEFINER helper to read the current value, because a plain
--    subquery on profiles inside a profiles policy would recurse.
-- 2. BEFORE UPDATE trigger — enforces the same rule below RLS, so the guarantee
--    survives even if a future permissive policy is added (RLS policies are
--    OR-ed, so one careless policy would otherwise reopen the hole).
-- ============================================================

-- ── 1. SECURITY DEFINER helper: read the caller's current role ───────────────
-- SECURITY DEFINER runs as the function owner and bypasses RLS, so calling it
-- from inside a profiles policy does not recurse. Mirrors the existing
-- is_platform_admin() convention from migration 001.
create or replace function public.current_platform_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select platform_role from public.profiles where id = auth.uid()
$$;

comment on function public.current_platform_role() is
  'Returns the caller''s current platform_role, bypassing RLS. Used by the profiles UPDATE policy to pin the role against self-escalation (SEC-2 / F-2).';


-- ── 2. Tighten the profiles UPDATE policy ────────────────────────────────────
-- USING is unchanged (same rows remain updatable — nothing is broadened).
-- WITH CHECK is NEW and strictly narrowing: a non-admin may not alter their own
-- platform_role. Admins retain full update capability.
drop policy if exists "profiles_update_own" on public.profiles;

create policy "profiles_update_own"
  on public.profiles
  for update
  using (
    auth.uid() = id
    or public.is_platform_admin()
  )
  with check (
    public.is_platform_admin()
    or (
      auth.uid() = id
      and platform_role is not distinct from public.current_platform_role()
    )
  );


-- ── 3. Trigger backstop (defence in depth, below RLS) ────────────────────────
-- Trusted server contexts are allowed through:
--   * service_role  — the admin server actions (createAdminClient) legitimately
--                     set platform_role when provisioning users
--   * postgres / supabase_admin — SQL editor and migrations
--   * platform admins — the intended human path
-- Everything else that attempts to change platform_role is rejected.
create or replace function public.enforce_platform_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only guard actual changes to the role column.
  if new.platform_role is not distinct from old.platform_role then
    return new;
  end if;

  -- Trusted database roles (server-side admin code, migrations, SQL editor).
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  -- The intended human path: an existing platform administrator.
  if public.is_platform_admin() then
    return new;
  end if;

  raise exception 'platform_role may only be changed by a platform administrator'
    using errcode = '42501';
end;
$$;

comment on function public.enforce_platform_role_change() is
  'BEFORE UPDATE backstop preventing platform_role self-escalation below the RLS layer (SEC-2 / F-2).';

drop trigger if exists profiles_enforce_role_change on public.profiles;
create trigger profiles_enforce_role_change
  before update on public.profiles
  for each row execute function public.enforce_platform_role_change();


-- ── 4. Audit log (F-3) ───────────────────────────────────────────────────────
-- Deliberately has NO foreign key to auth.users: an audit record must survive
-- deletion of the user it describes. That is precisely the evidence that was
-- lost in the SEC-1 incident (F-7).
create table if not exists public.audit_log (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null,                       -- e.g. user.created, user.deleted, user.role_changed
  actor_type      text not null
                    check (actor_type in ('admin', 'self', 'system', 'anonymous')),
  actor_id        uuid,                                -- no FK: survives actor deletion
  actor_email     text,
  subject_user_id uuid,                                -- no FK: survives subject deletion
  subject_email   text,
  method          text,                                -- e.g. admin_panel, self_signup, api
  invitation_id   uuid,                                -- reserved for the future invitation module
  outcome         text not null
                    check (outcome in ('success', 'failure')),
  reason          text,                                -- failure reason (never a secret)
  ip              text,
  user_agent      text,
  metadata        jsonb not null default '{}'::jsonb,  -- never passwords, tokens or secrets
  created_at      timestamptz not null default now()
);

create index if not exists audit_log_created_idx  on public.audit_log(created_at desc);
create index if not exists audit_log_event_idx    on public.audit_log(event_type, created_at desc);
create index if not exists audit_log_subject_idx  on public.audit_log(subject_user_id);
create index if not exists audit_log_actor_idx    on public.audit_log(actor_id);

comment on table public.audit_log is
  'Append-only identity audit trail (SEC-2 / F-3). No FK to auth.users so records outlive the users they describe. Never store passwords, tokens or secrets in metadata.';

-- RLS: platform admins may read. No INSERT/UPDATE/DELETE policies exist, so
-- anon and authenticated cannot write at all; writes happen exclusively through
-- the service-role client in validated server actions.
alter table public.audit_log enable row level security;

drop policy if exists "audit_log_admin_read" on public.audit_log;
create policy "audit_log_admin_read"
  on public.audit_log
  for select
  using (public.is_platform_admin());

-- Append-only at the grant layer as well: even with a future policy mistake,
-- application roles cannot rewrite or erase history.
revoke update, delete on public.audit_log from anon, authenticated;


-- ── VERIFICATION (run manually after applying; expects the exploit to FAIL) ──
-- Run as an ordinary authenticated user (e.g. in the SQL editor with a JWT set,
-- or from PostgREST with a learner session):
--
--   UPDATE profiles SET platform_role = 'super_admin' WHERE id = auth.uid();
--   -- expected: ERROR 42501 platform_role may only be changed by a platform administrator
--   --           (or: new row violates row-level security policy)
--
--   UPDATE profiles SET full_name = 'Still Editable' WHERE id = auth.uid();
--   -- expected: SUCCESS (ordinary self-service updates are unaffected)
--
-- Safe transactional proof (rolls back, changes nothing):
--   BEGIN;
--     UPDATE profiles SET platform_role = 'super_admin' WHERE id = auth.uid();
--   ROLLBACK;


-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Reverting re-opens F-2. Only do this if the fix demonstrably breaks a flow.
--
-- drop trigger if exists profiles_enforce_role_change on public.profiles;
-- drop function if exists public.enforce_platform_role_change();
-- drop policy if exists "profiles_update_own" on public.profiles;
-- create policy "profiles_update_own" on public.profiles for update
--   using (auth.uid() = id or public.is_platform_admin());   -- VULNERABLE (pre-SEC-2)
-- drop function if exists public.current_platform_role();
-- drop table if exists public.audit_log;
