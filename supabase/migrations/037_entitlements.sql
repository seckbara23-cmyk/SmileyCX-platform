-- ============================================================================
-- Migration 037 — XPA-6B: commercial entitlements.
--
-- Run as a SINGLE TRANSACTION.
--
-- ── THE RATIFIED MODEL (Q-L) ───────────────────────────────────────────────
--
-- Entitlement and enrollment are SEPARATE LIFECYCLES:
--
--   ENTITLEMENT  answers "may this learner access this course?"
--                Commercial. Granted, suspended, revoked, expires.
--   ENROLLMENT   records academic participation: progress, completion,
--                certificate relationship.
--
-- Two consequences, and both are the point rather than side effects:
--
--   * Revoking access MUST NOT delete learning history. Revocation touches the
--     entitlement only; the enrollment, lesson_progress, quiz_attempts and any
--     certificate survive untouched. A learner whose corporate licence lapses
--     keeps the record that they passed.
--
--   * Enrollment MUST NOT independently authorize access. Section 2 therefore
--     REMOVES the enrollments arm from has_course_access(). This is the whole
--     migration in one line: an enrollment row stops being a key and becomes a
--     transcript.
--
-- Safe to make now: production holds ZERO enrollments, so nothing loses access.
-- Doing it later, after real enrollments exist, would be a migration with
-- consequences rather than a definition change.
--
-- ── ACCESS PREDICATE (Q-M) ─────────────────────────────────────────────────
--
-- An entitlement grants access only when ALL of:
--     status = 'ACTIVE'
--     starts_at  is null or has passed
--     expires_at is null or is still in the future
--     revoked_at is null
--     the learner account is active            (already in has_course_access)
--
-- Expiry is evaluated from `expires_at`, NOT from the EXPIRED status. Access
-- therefore stops at the instant of expiry with no scheduled job in the loop.
-- `expire_due_entitlements()` exists to MATERIALISE the EXPIRED status for
-- reporting; correctness never depends on it having run. A security boundary
-- that needs a cron job to be correct is a security boundary that fails
-- silently when the cron job does not run.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
-- No payment provider, no corporate organizations, no evaluation programme.
-- The SOURCES for those exist as enum values so the model does not need
-- reshaping later, but nothing reads or writes them yet.
-- ============================================================================


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.has_course_access(uuid)') is null then
    raise exception 'XPA-6B 037 preflight: public.has_course_access(uuid) is missing — apply migrations 035 and 036 first';
  end if;
  if to_regprocedure('public.course_of_quiz(uuid)') is null then
    raise exception 'XPA-6B 037 preflight: migration 036 resolvers are missing — apply 036 first';
  end if;
  if to_regclass('public.enrollments') is null then
    raise exception 'XPA-6B 037 preflight: public.enrollments is missing';
  end if;
end $$;


-- ══ 1. THE ENTITLEMENTS TABLE ═════════════════════════════════════════════

create table if not exists public.entitlements (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  course_id     uuid        not null references public.courses(id) on delete cascade,

  -- Where the right to access came from. Ratified list (Q-L); the commercial
  -- sources are declared now so adding XPA-9 payments or XPA-6C evaluations
  -- never has to reshape this column.
  source        text        not null
                  check (source in (
                    'MANUAL_ADMIN', 'INDIVIDUAL_PURCHASE', 'CORPORATE_LICENSE',
                    'BUSINESS_EVALUATION', 'PROMOTIONAL_GRANT', 'MIGRATION'
                  )),

  -- Lifecycle (Q-M). COMPLETED is deliberately ABSENT: completion is academic
  -- and belongs to the enrollment. An entitlement that expired the day after a
  -- learner finished is still EXPIRED, and their completion still stands.
  status        text        not null default 'ACTIVE'
                  check (status in (
                    'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'CANCELLED'
                  )),

  starts_at     timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_reason text,

  -- Who granted it, and why. No FK: the record must outlive the admin account,
  -- the same reasoning as audit_log in migration 027.
  granted_by    uuid,
  granted_reason text,
  external_ref  text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Q-M: these two sources are time-limited BY DEFINITION. Enforced in the
  -- schema rather than the form, because a perpetual "evaluation" is not an
  -- evaluation and no UI should be the only thing preventing one.
  constraint entitlements_expiry_required
    check (
      source not in ('BUSINESS_EVALUATION', 'CORPORATE_LICENSE')
      or expires_at is not null
    ),

  -- A window that closes before it opens is a data-entry error, not a policy.
  constraint entitlements_window_ordered
    check (starts_at is null or expires_at is null or expires_at > starts_at),

  -- REVOKED and revoked_at travel together in both directions, so "is it
  -- revoked?" has exactly one answer.
  constraint entitlements_revocation_consistent
    check ((status = 'REVOKED') = (revoked_at is not null))
);

-- At most ONE live entitlement per learner per course. Terminal states are
-- excluded so history accumulates: a learner may hold a REVOKED 2025 licence,
-- an EXPIRED evaluation and one ACTIVE purchase for the same course.
create unique index if not exists entitlements_one_live_per_course_idx
  on public.entitlements (user_id, course_id)
  where status in ('PENDING', 'ACTIVE', 'SUSPENDED');

create index if not exists entitlements_user_idx    on public.entitlements (user_id, status);
create index if not exists entitlements_course_idx  on public.entitlements (course_id, status);
create index if not exists entitlements_expiry_idx  on public.entitlements (expires_at)
  where expires_at is not null and status = 'ACTIVE';

comment on table public.entitlements is
  'XPA-6B commercial right to access a course. SEPARATE from enrollments, which record academic participation. Revoking an entitlement never touches learning history.';
comment on column public.entitlements.status is
  'PENDING | ACTIVE | SUSPENDED | REVOKED | EXPIRED | CANCELLED. No COMPLETED — completion is academic and lives on the enrollment.';
comment on column public.entitlements.expires_at is
  'Access stops the instant this passes. The EXPIRED status is a reporting materialisation, not the access control.';

-- Keep updated_at honest without every writer remembering to.
create or replace function public.touch_entitlement_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists entitlements_touch_updated_at on public.entitlements;
create trigger entitlements_touch_updated_at
  before update on public.entitlements
  for each row execute function public.touch_entitlement_updated_at();


-- ══ 2. THE ACCESS PREDICATE, IN ONE PLACE ═════════════════════════════════
--
-- Scalar arguments rather than a row type so the SAME definition serves the
-- security seam, the admin list and the learner's My Courses. Three copies of
-- "is this still valid?" is how they end up disagreeing.
create or replace function public.entitlement_accessible(
  p_status     text,
  p_starts_at  timestamptz,
  p_expires_at timestamptz,
  p_revoked_at timestamptz
)
returns boolean
language sql
immutable
as $$
  select p_status = 'ACTIVE'
     and p_revoked_at is null
     and (p_starts_at  is null or p_starts_at  <= now())
     and (p_expires_at is null or p_expires_at >  now())
$$;

comment on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) is
  'XPA-6B. The single definition of "this entitlement currently grants access" (Q-M). Used by has_course_access, the admin list and My Courses.';

revoke all on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) to anon, authenticated;


-- ══ 3. THE SEAM — SAME FUNCTION, ENTITLEMENT ARM ══════════════════════════
--
-- XPA-6A promised that XPA-6B would extend THIS function and touch no policy.
-- That is exactly what happens here: the four content policies from migration
-- 036 are not edited, and inherit the change atomically.
--
-- The enrollments arm is REMOVED, not supplemented (Q-L: enrollment must not
-- independently authorize access).
--
-- Still absent, still deliberate:
--   * no `is_free` arm      — decision 4: account != payment != enrollment != access
--   * no `is_published` arm — publication controls DISCOVERY, never ACCESS
--   * no anonymous arm      — the pilot is over
create or replace function public.has_course_access(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p_course_id is not null
    and (
      public.is_platform_admin()
      or (
        auth.uid() is not null
        and public.is_email_verified()
        and coalesce(public.current_account_status(), 'active') = 'active'
        and exists (
          select 1
          from public.entitlements ent
          where ent.user_id   = auth.uid()
            and ent.course_id = p_course_id
            and public.entitlement_accessible(
                  ent.status, ent.starts_at, ent.expires_at, ent.revoked_at)
        )
      )
    )
$$;

comment on function public.has_course_access(uuid) is
  'XPA-6A seam, XPA-6B arm. Admin, or a verified active learner holding a currently-accessible ENTITLEMENT. Enrollment does not authorize access (Q-L).';


-- ══ 4. EXPIRY MATERIALISATION — reporting only ════════════════════════════
--
-- Access already stops at expires_at (section 2), so this changes NOTHING about
-- who can read what. It exists so an operator listing entitlements sees EXPIRED
-- rather than an ACTIVE row with a past date.
--
-- Returns the number of rows it moved, so a caller can log something meaningful.
create or replace function public.expire_due_entitlements()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.entitlements
     set status = 'EXPIRED'
   where status = 'ACTIVE'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.expire_due_entitlements() is
  'XPA-6B. Materialises EXPIRED for reporting. Access control does NOT depend on this having run — expiry is evaluated from expires_at.';

-- service_role only. A learner must never be able to invoke a bulk status
-- change, and anon has no business knowing it exists.
revoke all on function public.expire_due_entitlements() from public;
revoke all on function public.expire_due_entitlements() from anon;
revoke all on function public.expire_due_entitlements() from authenticated;


-- ══ 5. RLS ════════════════════════════════════════════════════════════════
alter table public.entitlements enable row level security;

-- Read-only to the subject and to platform admins. No INSERT / UPDATE / DELETE
-- policy exists for app roles at all: every write goes through an audited,
-- admin-authorized server action running as service_role, which bypasses RLS.
-- A missing policy is a denial.
drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own" on public.entitlements for select
  using (user_id = auth.uid() or public.is_platform_admin());


-- ══ 6. PRIVILEGES — REVOKE FIRST, ALWAYS ══════════════════════════════════
--
-- D-GRANT: Supabase applies ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- anon, authenticated, so this table was born holding all seven privileges. A
-- bare `grant select` would be additive and restrict nothing.
revoke all on public.entitlements from public;
revoke all on public.entitlements from anon;
revoke all on public.entitlements from authenticated;

grant select on public.entitlements to authenticated;


-- ══ 7. APPLY-TIME ASSERTIONS ══════════════════════════════════════════════
--
-- D-VERIFY: assert the resulting STATE, and EXERCISE what was created. A
-- migration that only describes itself is how XPA-6A shipped four unevaluatable
-- policies that passed every structural check.
do $$
declare
  bad     text;
  n       integer;
  ok      boolean;
begin
  -- 7a. Privilege matrix is exactly SELECT for authenticated, nothing for anon.
  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'entitlements'
    and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if bad is not null then
    raise exception 'entitlements: authenticated holds unintended privileges: %', bad;
  end if;

  select string_agg(privilege_type, ', ' order by privilege_type) into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'entitlements'
    and grantee in ('anon', 'PUBLIC');
  if bad is not null then
    raise exception 'entitlements: anon/PUBLIC still hold: %', bad;
  end if;

  -- 7b. The predicate says what Q-M says. Each case is a rule that would
  --     otherwise be verified only by reading it.
  if not public.entitlement_accessible('ACTIVE', null, null, null) then
    raise exception 'predicate denies a plain ACTIVE entitlement';
  end if;
  if public.entitlement_accessible('ACTIVE', null, now() - interval '1 second', null) then
    raise exception 'predicate grants an EXPIRED window';
  end if;
  if public.entitlement_accessible('ACTIVE', now() + interval '1 day', null, null) then
    raise exception 'predicate grants an entitlement that has not started';
  end if;
  if public.entitlement_accessible('ACTIVE', null, null, now()) then
    raise exception 'predicate grants a revoked entitlement';
  end if;
  foreach bad in array array['PENDING', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'CANCELLED'] loop
    if public.entitlement_accessible(bad, null, null, null) then
      raise exception 'predicate grants a % entitlement', bad;
    end if;
  end loop;

  -- 7c. The seam no longer consults enrollments.
  if pg_get_functiondef('public.has_course_access(uuid)'::regprocedure) ~* 'from public\.enrollments' then
    raise exception 'has_course_access() still reads enrollments — enrollment must not authorize access (Q-L)';
  end if;
  if pg_get_functiondef('public.has_course_access(uuid)'::regprocedure) !~* 'public\.entitlements' then
    raise exception 'has_course_access() does not consult entitlements';
  end if;

  -- 7d. Q-M expiry requirement is enforced by the schema, not by a form.
  begin
    insert into public.entitlements (user_id, course_id, source)
    select u.id, c.id, 'BUSINESS_EVALUATION'
    from auth.users u, public.courses c limit 1;
    raise exception 'BUSINESS_EVALUATION was accepted without expires_at';
  exception
    when check_violation then null;      -- expected
    when no_data_found  then null;
  end;

  -- 7e. EXERCISE the policies as the real roles. A recursion, a missing grant
  --     or an unevaluatable policy aborts here rather than shipping.
  begin
    set role anon;
    perform 1 from public.entitlements limit 1;
    reset role;
  exception when others then
    reset role;
    raise exception 'entitlements is not readable as anon: % (%)', sqlerrm, sqlstate;
  end;

  begin
    set role authenticated;
    perform 1 from public.entitlements limit 1;
    select count(*) into n from public.lessons;
    reset role;
  exception when others then
    reset role;
    raise exception 'content policies broke under the new seam: % (%)', sqlerrm, sqlstate;
  end;

  -- 7f. And the seam still DENIES an unauthenticated caller.
  select exists (
    select 1 from public.courses c
    where public.has_course_access(c.id)
      and not coalesce(public.is_platform_admin(), false)
  ) into ok;
  if ok then
    raise exception 'has_course_access() grants access with no authenticated user';
  end if;

  raise notice 'XPA-6B 037: entitlements created, seam moved off enrollments, predicate and policies verified.';
end $$;


-- ══ ROLLBACK ══════════════════════════════════════════════════════════════
-- Restoring the enrollment-authorizes-access model (contradicts Q-L):
--
--   -- re-create has_course_access() with the enrollments arm from migration 035
--   drop table if exists public.entitlements cascade;
--   drop function if exists public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz);
--   drop function if exists public.expire_due_entitlements();
--
-- Dropping entitlements does NOT touch enrollments, lesson_progress,
-- quiz_attempts or certificates — which is the separation working as designed.
-- ══════════════════════════════════════════════════════════════════════════
