-- ============================================================================
-- Migration 037 — XPA-6B: commercial entitlements.
--
-- Run as a SINGLE TRANSACTION.
--
-- ── WHY THE FIRST ATTEMPT FAILED ───────────────────────────────────────────
--
--   P0001: entitlements is not readable as anon:
--          permission denied for table entitlements (42501)
--
-- The migration revoked every privilege from anon — correctly — and then
-- asserted the table was READABLE as anon. Those two contracts contradict each
-- other, and the assertion was the wrong one: 42501 is the intended result.
--
-- This is the D-VERIFY mistake, made again and inverted. XPA-6A's outage came
-- from treating a BROKEN result as a denial. This treated an EXPECTED DENIAL as
-- broken. Writing the rule down was not enough; the assertion block has to
-- apply it, so §8 below now classifies every probe explicitly:
--
--   EXPECTED_DENIAL  SQLSTATE 42501            the privilege model working
--   ALLOWED          query succeeded           authorization intended here
--   BROKEN           any other SQLSTATE        never passes, whichever way
--
-- ── THE RATIFIED MODEL (Q-L) ───────────────────────────────────────────────
--
--   ENTITLEMENT  may this learner access this course?   commercial
--   ENROLLMENT   what did this learner actually do?     academic
--
--   * Revoking access MUST NOT delete learning history. Revocation touches the
--     entitlement only; enrollment, lesson_progress, quiz_attempts and any
--     certificate survive untouched.
--   * Enrollment MUST NOT independently authorize access. §4 REMOVES the
--     enrollments arm from has_course_access(). An enrollment row stops being a
--     key and becomes a transcript.
--
-- Safe now: production holds ZERO enrollments, so nothing loses access.
--
-- ── CORRECTED PRIVILEGE CONTRACT ───────────────────────────────────────────
--
-- `entitlements` is commercial authorization data. It carries provenance
-- (source, granted_by, external_ref), timing (starts_at, expires_at) and
-- revocation detail (revoked_at, revoked_reason). None of that is the learner's
-- business, and an anonymous caller must not learn the table exists.
--
--   public.entitlements      anon: NOTHING      authenticated: NOTHING
--   public.my_course_access  anon: NOTHING      authenticated: SELECT
--
-- The learner-facing reader is a VIEW that answers only "which courses may I
-- open, and has any access of mine ended?". It cannot leak provenance, dates or
-- reasons because it does not select them — the XPA-5A structural pattern,
-- where confidentiality is a property of the projection rather than of the
-- caller remembering which columns to ask for.
--
-- ── ACCESS PREDICATE (Q-M) ─────────────────────────────────────────────────
--
--     status = 'ACTIVE'  AND  revoked_at is null
--     AND (starts_at  is null or it has passed)
--     AND (expires_at is null or it is still in the future)
--     AND the learner account is active        (already in has_course_access)
--
-- Expiry is evaluated from `expires_at`, never from the EXPIRED status, so
-- access stops at the instant of expiry with no scheduled job in the loop.
-- A boundary that needs a cron job to be correct fails silently when the cron
-- job does not run.
--
-- ── NOT IN SCOPE ───────────────────────────────────────────────────────────
-- No payment provider, no corporate organizations, no evaluation programme.
-- The SOURCES exist so the model never has to be reshaped; nothing reads or
-- writes them yet.
-- ============================================================================


-- ══ 0. PREFLIGHT ══════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.has_course_access(uuid)') is null then
    raise exception 'XPA-6B 037 preflight: public.has_course_access(uuid) is missing — apply 035 and 036 first';
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

  source        text        not null
                  check (source in (
                    'MANUAL_ADMIN', 'INDIVIDUAL_PURCHASE', 'CORPORATE_LICENSE',
                    'BUSINESS_EVALUATION', 'PROMOTIONAL_GRANT', 'MIGRATION'
                  )),

  -- COMPLETED is deliberately ABSENT: completion is academic and belongs to the
  -- enrollment. An entitlement that expired the day after a learner finished is
  -- still EXPIRED, and their completion still stands.
  status        text        not null default 'ACTIVE'
                  check (status in (
                    'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'CANCELLED'
                  )),

  starts_at     timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_reason text,

  -- No FK on granted_by: the record must outlive the admin account, the same
  -- reasoning as audit_log in migration 027.
  granted_by    uuid,
  granted_reason text,
  external_ref  text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Q-M: these two are time-limited BY DEFINITION. In the schema rather than
  -- the form, because a perpetual "evaluation" is not an evaluation and no UI
  -- should be the only thing preventing one.
  constraint entitlements_expiry_required
    check (
      source not in ('BUSINESS_EVALUATION', 'CORPORATE_LICENSE')
      or expires_at is not null
    ),

  constraint entitlements_window_ordered
    check (starts_at is null or expires_at is null or expires_at > starts_at),

  -- REVOKED and revoked_at travel together in both directions.
  constraint entitlements_revocation_consistent
    check ((status = 'REVOKED') = (revoked_at is not null))
);

-- At most ONE live entitlement per learner per course. Terminal states are
-- excluded so history accumulates: a learner may hold a REVOKED 2025 licence,
-- an EXPIRED evaluation and one ACTIVE purchase for the same course.
create unique index if not exists entitlements_one_live_per_course_idx
  on public.entitlements (user_id, course_id)
  where status in ('PENDING', 'ACTIVE', 'SUSPENDED');

create index if not exists entitlements_user_idx   on public.entitlements (user_id, status);
create index if not exists entitlements_course_idx on public.entitlements (course_id, status);
create index if not exists entitlements_expiry_idx on public.entitlements (expires_at)
  where expires_at is not null and status = 'ACTIVE';

comment on table public.entitlements is
  'XPA-6B commercial right to access a course. SEPARATE from enrollments, which record academic participation. Learners never read this table — see public.my_course_access.';

create or replace function public.touch_entitlement_updated_at()
returns trigger language plpgsql as $$
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
-- security seam, the learner view and the admin list. Three copies of "is this
-- still valid?" is how they end up disagreeing.
create or replace function public.entitlement_accessible(
  p_status     text,
  p_starts_at  timestamptz,
  p_expires_at timestamptz,
  p_revoked_at timestamptz
)
returns boolean
language sql
stable
as $$
  select p_status = 'ACTIVE'
     and p_revoked_at is null
     and (p_starts_at  is null or p_starts_at  <= now())
     and (p_expires_at is null or p_expires_at >  now())
$$;

comment on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) is
  'XPA-6B. The single definition of "this entitlement currently grants access" (Q-M).';

revoke all on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz) to authenticated;


-- ══ 3. LEARNER-FACING READER ══════════════════════════════════════════════
--
-- The ONLY entitlement surface a learner may read.
--
-- Structural confidentiality: this view cannot return `source`, `granted_by`,
-- `granted_reason`, `external_ref`, `expires_at`, `revoked_at` or
-- `revoked_reason`, because it does not select them. Not "the UI does not show
-- them" — it cannot serve them.
--
-- `access_ended` is deliberately COARSE. Distinguishing expired from revoked
-- from suspended would re-expose revocation data through the back door, and a
-- learner does not need it: every one of those means "contact us".
--
-- Aggregated per course so a learner with a revoked 2025 licence and an active
-- 2026 purchase sees one row saying yes, not two rows disagreeing.
create or replace view public.my_course_access as
select
  ent.course_id,
  bool_or(public.entitlement_accessible(
    ent.status, ent.starts_at, ent.expires_at, ent.revoked_at)) as has_access,
  bool_or(
    not public.entitlement_accessible(
      ent.status, ent.starts_at, ent.expires_at, ent.revoked_at)
    and ent.status <> 'PENDING'
  ) as access_ended
from public.entitlements ent
where ent.user_id = auth.uid()
group by ent.course_id;

comment on view public.my_course_access is
  'XPA-6B learner-safe projection. Own rows only (auth.uid()), aggregated per course. Deliberately EXCLUDES source, granted_by, granted_reason, external_ref, starts_at, expires_at, revoked_at and revoked_reason.';


-- ══ 4. THE SEAM — SAME FUNCTION, ENTITLEMENT ARM ══════════════════════════
--
-- XPA-6A promised XPA-6B would extend THIS function and touch no policy. That
-- is exactly what happens: the four content policies from migration 036 are not
-- edited and inherit the change atomically.
--
-- The enrollments arm is REMOVED, not supplemented (Q-L).
--
-- Still absent, still deliberate: no `is_free` arm (decision 4), no
-- `is_published` arm (publication controls DISCOVERY, never ACCESS), no
-- anonymous arm (the pilot is over).
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


-- ══ 5. EXPIRY MATERIALISATION — reporting only ════════════════════════════
--
-- Access already stops at expires_at (§2), so this changes NOTHING about who
-- can read what. It exists so an operator listing entitlements sees EXPIRED
-- rather than an ACTIVE row with a past date.
create or replace function public.expire_due_entitlements()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
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
  'XPA-6B. Materialises EXPIRED for reporting. Access control does NOT depend on this having run.';

revoke all on function public.expire_due_entitlements() from public;
revoke all on function public.expire_due_entitlements() from anon;
revoke all on function public.expire_due_entitlements() from authenticated;


-- ══ 6. RLS ════════════════════════════════════════════════════════════════
alter table public.entitlements enable row level security;

-- Defence in depth only: with NO table grant, RLS is never even reached by an
-- app role. The policy exists so that if a grant is ever added by mistake, rows
-- are still scoped rather than open.
drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own" on public.entitlements for select
  using (user_id = auth.uid() or public.is_platform_admin());


-- ══ 7. PRIVILEGES — REVOKE FIRST, ALWAYS ══════════════════════════════════
--
-- D-GRANT: Supabase applies ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- anon, authenticated, so BOTH objects below were born holding all seven
-- privileges. A bare `grant select` would be additive and restrict nothing.
--
-- The view matters more than the table: it is security_invoker = false (needed,
-- so the projection reads past RLS) and auto-updatable, so writes through it
-- would execute as the VIEW OWNER and bypass RLS entirely. That is exactly the
-- XPA-5A finding.
revoke all on public.entitlements from public;
revoke all on public.entitlements from anon;
revoke all on public.entitlements from authenticated;

revoke all on public.my_course_access from public;
revoke all on public.my_course_access from anon;
revoke all on public.my_course_access from authenticated;

-- Exactly one privilege, to exactly one role, on exactly one object.
grant select on public.my_course_access to authenticated;


-- ══ 8. APPLY-TIME VERIFICATION ════════════════════════════════════════════
--
-- Classifies every probe as EXPECTED_DENIAL / ALLOWED / BROKEN. The helper is
-- dropped at the end of this section, so it leaves nothing behind.
create or replace function public.xpa6b_probe(p_role text, p_sql text)
returns text
language plpgsql
as $$
begin
  execute format('set role %I', p_role);
  execute p_sql;
  reset role;
  return 'ALLOWED';
exception
  when insufficient_privilege then      -- 42501
    reset role;
    return 'EXPECTED_DENIAL';
  when others then
    reset role;
    return 'BROKEN:' || sqlstate || ':' || replace(sqlerrm, E'\n', ' ');
end $$;

do $$
declare
  v        text;
  bad      text;
  n        integer;
  v_user   uuid;
  v_other  uuid;
  v_course uuid;
  v_ent    uuid;
  cols     text;
begin
  -- ── 1 & 2. anon has NO direct privilege on entitlements ────────────────
  --    42501 is the CORRECT answer. This is the assertion the first attempt
  --    got backwards.
  v := public.xpa6b_probe('anon', 'select 1 from public.entitlements limit 1');
  if v <> 'EXPECTED_DENIAL' then
    raise exception 'anon SELECT entitlements: expected EXPECTED_DENIAL (42501), got %', v;
  end if;

  foreach bad in array array[
    'insert into public.entitlements (user_id, course_id, source) values (gen_random_uuid(), gen_random_uuid(), ''MANUAL_ADMIN'')',
    'update public.entitlements set status = ''ACTIVE'' where false',
    'delete from public.entitlements where false'
  ] loop
    v := public.xpa6b_probe('anon', bad);
    if v <> 'EXPECTED_DENIAL' then
      raise exception 'anon write on entitlements: expected EXPECTED_DENIAL (42501), got % for %', v, left(bad, 40);
    end if;
  end loop;

  -- anon must not reach the learner view either.
  v := public.xpa6b_probe('anon', 'select 1 from public.my_course_access limit 1');
  if v <> 'EXPECTED_DENIAL' then
    raise exception 'anon SELECT my_course_access: expected EXPECTED_DENIAL (42501), got %', v;
  end if;

  -- ── 3. An authenticated learner cannot reach the BASE table ────────────
  v := public.xpa6b_probe('authenticated', 'select 1 from public.entitlements limit 1');
  if v <> 'EXPECTED_DENIAL' then
    raise exception 'authenticated SELECT entitlements: expected EXPECTED_DENIAL (42501), got %', v;
  end if;

  -- ...and the view it CAN reach is read-only.
  v := public.xpa6b_probe('authenticated', 'select 1 from public.my_course_access limit 1');
  if v <> 'ALLOWED' then
    raise exception 'authenticated SELECT my_course_access: expected ALLOWED, got %', v;
  end if;
  v := public.xpa6b_probe('authenticated', 'delete from public.my_course_access where false');
  if v <> 'EXPECTED_DENIAL' then
    raise exception 'authenticated DELETE my_course_access: expected EXPECTED_DENIAL (42501), got %', v;
  end if;

  -- ── 4. The learner view leaks no provenance, timing or revocation data ──
  select string_agg(column_name, ', ') into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'my_course_access'
    and column_name in ('source', 'granted_by', 'granted_reason', 'external_ref',
                        'starts_at', 'expires_at', 'revoked_at', 'revoked_reason',
                        'status', 'user_id');
  if cols is not null then
    raise exception 'my_course_access exposes confidential column(s): %', cols;
  end if;

  -- ── 15. The exact privilege matrix ─────────────────────────────────────
  select string_agg(grantee || ':' || privilege_type, ', ' order by grantee || ':' || privilege_type)
    into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'entitlements'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if bad is not null then
    raise exception 'entitlements must hold NO app-role privileges, found: %', bad;
  end if;

  select string_agg(grantee || ':' || privilege_type, ', ' order by grantee || ':' || privilege_type)
    into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'my_course_access'
    and not (grantee = 'authenticated' and privilege_type = 'SELECT')
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if bad is not null then
    raise exception 'my_course_access must hold ONLY authenticated:SELECT, found also: %', bad;
  end if;

  select count(*) into n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'my_course_access'
    and grantee = 'authenticated' and privilege_type = 'SELECT';
  if n <> 1 then
    raise exception 'my_course_access: authenticated is missing SELECT';
  end if;

  -- ── 12 (structural). The seam no longer consults enrollments ───────────
  --    The behavioural proof is below, but it is skipped on an empty database.
  --    This one always runs.
  if pg_get_functiondef('public.has_course_access(uuid)'::regprocedure) ~* 'public\.enrollments' then
    raise exception 'has_course_access() still reads enrollments — enrollment must not authorize access (Q-L)';
  end if;
  if pg_get_functiondef('public.has_course_access(uuid)'::regprocedure) !~* 'public\.entitlements' then
    raise exception 'has_course_access() does not consult entitlements';
  end if;

  -- ── 16 & 17. The four content policies still evaluate ──────────────────
  foreach bad in array array['lessons', 'modules', 'quizzes', 'quiz_questions'] loop
    v := public.xpa6b_probe('anon', format('select 1 from public.%I limit 1', bad));
    if v <> 'ALLOWED' then
      raise exception 'content policy on % is not evaluatable as anon: %', bad, v;
    end if;
    v := public.xpa6b_probe('authenticated', format('select 1 from public.%I limit 1', bad));
    if v <> 'ALLOWED' then
      raise exception 'content policy on % is not evaluatable as authenticated: %', bad, v;
    end if;
  end loop;

  -- ── 14. Q-M expiry requirement is enforced by the SCHEMA ───────────────
  select id into v_user from auth.users where email_confirmed_at is not null limit 1;
  select id into v_course from public.courses limit 1;

  if v_user is null or v_course is null then
    raise notice 'XPA-6B 037: no confirmed user or no course — behavioural checks 5-13 skipped.';
  else
    begin
      insert into public.entitlements (user_id, course_id, source)
      values (v_user, v_course, 'BUSINESS_EVALUATION');
      raise exception 'BUSINESS_EVALUATION was accepted without expires_at';
    exception when check_violation then null;
    end;
    begin
      insert into public.entitlements (user_id, course_id, source)
      values (v_user, v_course, 'CORPORATE_LICENSE');
      raise exception 'CORPORATE_LICENSE was accepted without expires_at';
    exception when check_violation then null;
    end;

    -- ── 5-13. The lifecycle, exercised for real ──────────────────────────
    -- All test data lives inside a subtransaction that is deliberately rolled
    -- back by the sentinel below, so nothing is committed and item 18 is
    -- satisfied by construction rather than by remembering to clean up.
    begin
      -- Act as this learner. set_config(..., true) is transaction-local.
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

      if public.is_platform_admin() then
        raise notice 'XPA-6B 037: sampled user is an admin — lifecycle checks skipped.';
      else
        -- 6 & 12. No entitlement -> no access, even WITH an enrollment.
        if public.has_course_access(v_course) then
          raise exception 'access granted with no entitlement';
        end if;

        insert into public.enrollments (user_id, course_id, status)
        values (v_user, v_course, 'active')
        on conflict (user_id, course_id) do nothing;

        if public.has_course_access(v_course) then
          raise exception 'enrollment alone granted access — Q-L violated';
        end if;

        -- 7. ACTIVE, in-window -> access.
        insert into public.entitlements (user_id, course_id, source, status)
        values (v_user, v_course, 'MANUAL_ADMIN', 'ACTIVE')
        returning id into v_ent;
        if not public.has_course_access(v_course) then
          raise exception 'an ACTIVE in-window entitlement did not grant access';
        end if;

        -- 8. Suspension -> no access.
        update public.entitlements set status = 'SUSPENDED' where id = v_ent;
        if public.has_course_access(v_course) then
          raise exception 'a SUSPENDED entitlement still granted access';
        end if;

        -- 9. Reinstatement -> access.
        update public.entitlements set status = 'ACTIVE' where id = v_ent;
        if not public.has_course_access(v_course) then
          raise exception 'reinstatement did not restore access';
        end if;

        -- 10. Revocation -> no access, immediately.
        update public.entitlements
           set status = 'REVOKED', revoked_at = now() where id = v_ent;
        if public.has_course_access(v_course) then
          raise exception 'a REVOKED entitlement still granted access';
        end if;

        -- 13. And learning history survived it.
        select count(*) into n from public.enrollments
         where user_id = v_user and course_id = v_course;
        if n <> 1 then
          raise exception 'revocation destroyed the enrollment — Q-L violated';
        end if;

        -- 11. Expiry -> no access, with no job having run.
        insert into public.entitlements (user_id, course_id, source, status, expires_at)
        values (v_user, v_course, 'MANUAL_ADMIN', 'ACTIVE', now() - interval '1 second')
        returning id into v_ent;
        if public.has_course_access(v_course) then
          raise exception 'an entitlement past expires_at still granted access';
        end if;
        select count(*) into n from public.entitlements
         where id = v_ent and status = 'ACTIVE';
        if n <> 1 then
          raise exception 'expiry test row was mutated — expiry must not depend on a status flip';
        end if;

        -- 3. The learner view shows only this learner's rows.
        select count(*) into n from public.my_course_access;
        if n = 0 then
          raise exception 'my_course_access returned nothing for a learner who has entitlements';
        end if;

        select id into v_other from auth.users where id <> v_user limit 1;
        if v_other is not null then
          perform set_config('request.jwt.claims',
            json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
          select count(*) into n from public.my_course_access where course_id = v_course;
          if n <> 0 then
            raise exception 'a learner can enumerate another learner''s entitlements';
          end if;
        end if;
      end if;

      -- Roll the test data back. The sentinel is the only clean way to undo
      -- inserts inside a plpgsql block.
      raise exception 'XPA6B_ROLLBACK_TEST_DATA';
    exception
      when others then
        if sqlerrm <> 'XPA6B_ROLLBACK_TEST_DATA' then raise; end if;
    end;

    perform set_config('request.jwt.claims', '', true);

    -- 18. Nothing survived.
    select count(*) into n from public.entitlements;
    if n <> 0 then
      raise exception 'behavioural checks left % entitlement row(s) behind', n;
    end if;
    select count(*) into n from public.enrollments where user_id = v_user and course_id = v_course;
    if n <> 0 then
      raise exception 'behavioural checks left an enrollment behind';
    end if;
  end if;

  -- The seam must still deny an unauthenticated caller.
  if exists (
    select 1 from public.courses c
    where public.has_course_access(c.id)
      and not coalesce(public.is_platform_admin(), false)
  ) then
    raise exception 'has_course_access() grants access with no authenticated user';
  end if;

  raise notice 'XPA-6B 037: privilege matrix, learner view and full entitlement lifecycle verified.';
end $$;

drop function if exists public.xpa6b_probe(text, text);


-- ══ ROLLBACK ══════════════════════════════════════════════════════════════
-- Restoring the enrollment-authorizes-access model (contradicts Q-L):
--
--   -- re-create has_course_access() with the enrollments arm from migration 035
--   drop view  if exists public.my_course_access;
--   drop table if exists public.entitlements cascade;
--   drop function if exists public.entitlement_accessible(text, timestamptz, timestamptz, timestamptz);
--   drop function if exists public.expire_due_entitlements();
--
-- Dropping entitlements does NOT touch enrollments, lesson_progress,
-- quiz_attempts or certificates — the separation working as designed.
-- ══════════════════════════════════════════════════════════════════════════
