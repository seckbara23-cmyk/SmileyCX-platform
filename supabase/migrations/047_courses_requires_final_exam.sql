-- ============================================================================
-- Migration 047 — XPA-8 B-2.3A: per-course final-exam requirement flag.
--
-- Run as a SINGLE TRANSACTION. STRICTLY ADDITIVE: one boolean column, NOT NULL
-- DEFAULT FALSE. No existing row changes behaviour, no policy is touched, no
-- question, attempt, score or certificate is reinterpreted.
--
-- ⚠ NOT APPLIED IN THIS PHASE.
--
-- ── WHY THERE IS NO MIGRATION 046 ──────────────────────────────────────────
--
-- B-2.3A was scoped to include a 046 that would split `quiz_attempts` RLS the
-- way 044 split `lesson_progress`: SELECT identity-only, INSERT/UPDATE gated on
-- `has_course_access()`. It was written, and then withdrawn, because the
-- premise turned out to be false.
--
-- The B-2.3 audit read migration 001's `attempts_own FOR ALL` and reported it
-- as the live policy. It is not. **Migration 011 already replaced it**, and was
-- never superseded:
--
--   attempts_select_own      SELECT  user_id = auth.uid() OR is_platform_admin()
--   attempts_insert_service  INSERT  WITH CHECK (false)
--   attempts_admin_all       ALL     is_platform_admin()
--
-- Verified against production with an ENTITLED fixture acting on its own row:
--
--   INSERT   403 42501
--   UPDATE   204 returned, ZERO rows changed (passed stayed false)
--   DELETE   204 returned, the row survived
--   SELECT   200, own history readable
--
-- That is stricter than the proposed 046, which would have replaced
-- `WITH CHECK (false)` with `user_id = auth.uid() AND has_course_access(...)`
-- and thereby NEWLY PERMITTED an entitled learner to POST a fabricated
-- `passed: true, score: 100` row straight to PostgREST. Applying it would have
-- been a security regression dressed as a hardening.
--
-- What WAS genuinely open is the application half, and it is fixed in B-2.3A:
-- `submitQuizAnswers` writes with the service role, which bypasses RLS
-- entirely, so the action was the only gate on who may record an attempt — and
-- it had none. It now calls `resolveCourseAccessById` on the course resolved
-- from the quiz.
--
-- ── WHAT THE FLAG MEANS ────────────────────────────────────────────────────
--
-- false (default)  certificate = every required lesson complete.
--                  Exactly today's contract. Nothing changes for any course.
--
-- true             certificate additionally requires a course-scoped quiz to
--                  EXIST and to have a passing attempt by that learner.
--
-- ── FAIL CLOSED ────────────────────────────────────────────────────────────
--
-- `requires_final_exam = true` with no course-scoped quiz attached does NOT
-- silently issue a certificate. `resolveCertificateEligibility` returns
-- `final_exam_missing`, logs it as an operator error, and withholds. A
-- misconfiguration must cost a certificate that was not earned, never grant
-- one — which is why the default is false and why flipping it is deliberate.
--
-- ── NOT FLIPPED FOR ANY COURSE ─────────────────────────────────────────────
--
-- Ratified: no course turns this on until its exam is authored and approved
-- (B-2.3B/C). This migration adds the column and stops. Every one of the five
-- published courses keeps lessons-only certification, honestly, until an
-- operator flips its flag on purpose:
--
--   update public.courses set requires_final_exam = true where code = 'C1-F1';
--
-- Doing that before an exam exists withholds certificates rather than breaking
-- anything, by the fail-closed rule above.
-- ============================================================================

begin;

alter table public.courses
  add column if not exists requires_final_exam boolean not null default false;

comment on column public.courses.requires_final_exam is
  'XPA-8 B-2.3A. When true, a certificate additionally requires a passing attempt on this course''s course-scoped final exam. Default false = lessons only (the pre-B-2.3 contract). Flag true with no exam attached FAILS CLOSED: no certificate is issued. PLATFORM_MODE has no bearing on this.';


-- ══ SELF-VERIFICATION ═════════════════════════════════════════════════════
--
-- Fails the transaction rather than reporting a success that did not happen.

do $$
declare
  v_default text;
  v_notnull boolean;
  v_true    int;
begin
  select column_default, (is_nullable = 'NO')
    into v_default, v_notnull
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'courses'
    and column_name  = 'requires_final_exam';

  if v_default is null then
    raise exception 'XPA-8 B-2.3A: courses.requires_final_exam was not created';
  end if;

  if not v_notnull then
    raise exception 'XPA-8 B-2.3A: requires_final_exam must be NOT NULL — a null would be neither required nor not-required';
  end if;

  if v_default not like '%false%' then
    raise exception 'XPA-8 B-2.3A: requires_final_exam default is %, expected false', v_default;
  end if;

  -- Adding the column must not have turned it on anywhere.
  select count(*) into v_true from public.courses where requires_final_exam;
  if v_true <> 0 then
    raise exception 'XPA-8 B-2.3A: % course(s) already require a final exam — this migration must change no behaviour', v_true;
  end if;

  raise notice 'XPA-8 B-2.3A: courses.requires_final_exam added (NOT NULL, default false, 0 courses enabled).';
end $$;

commit;

-- ============================================================================
-- OPERATOR STEP
--
--   Safe to apply at any time — additive, default false, and the application
--   already tolerates the column's absence (it reads 42703 as `false`).
--
--     1. Merge staging → main; production deployment finishes.
--     2. Apply THIS migration.
--     3. node scripts/security/verify-xpa-8-b23.mjs
--
--   This is the ONLY migration B-2.3A ships. See above for why there is no 046.
--
--   Do NOT flip the flag for any course in this phase. B-2.3B (owner-approved
--   exam blueprints) and B-2.3C (authoring + wiring) come first.
--
-- ROLLBACK
--
--   begin;
--   alter table public.courses drop column if exists requires_final_exam;
--   commit;
--
--   Safe: the application reads a missing column as false, which is the same
--   contract the column's default expresses.
-- ============================================================================
