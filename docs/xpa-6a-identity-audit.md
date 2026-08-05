# XPA-6A — Identity & Authorization Audit, and Implementation Record

**Phase:** XPA-6A — Commercial Registration, Learner Identity and Domain Separation
**Audited:** 2026-08-06 against production project `eqoqcxkdcxeosjqaafhs`
**Method:** repository read + live probes using the **public anon key** for every
learner-boundary check, so results reflect what an anonymous internet caller
actually gets. Write probes used filters matching zero rows.

---

## 1. Repository identity audit

| # | Component | Classification | Evidence |
|---|---|---|---|
| 1 | Supabase Auth configuration | **partially complete** | `disable_signup = true`; **`mailer_autoconfirm = true`**; only `email` provider enabled |
| 2 | Public signup status | **complete (closed)** | live `POST /auth/v1/signup` → `422 signup_disabled` |
| 3 | Email verification behaviour | **defective for commercial use** | project-level autoconfirm on; no verification flow in app |
| 4 | Login page | **complete and reusable** | `signInWithPassword`, host-aware, `?next` honoured |
| 5 | Password recovery | **partially complete / unsafe** | worked, but `redirectTo: location.origin`, no rate limit, no audit |
| 6 | Callback route | **complete** | `/auth/callback`, correct `@supabase/ssr@0.3.0` cookie shape |
| 7 | Session refresh | **complete** | `getUser()` in middleware |
| 8 | Middleware | **partially complete** | `AUTH_REQUIRED` was mode-dependent → `['/app']` only in pilot |
| 9 | `lib/hosts.ts` | **complete and reusable** | allow-list; unknown host ⇒ public; all `*.vercel.app` ⇒ admin |
| 10 | Domain routing | **complete** | apex → www **308** verified live |
| 11 | Admin allowlists | **complete** | `ADMIN_OWNER_EMAILS`, fails closed on empty |
| 12 | Platform-admin checks | **partially complete** | 1 of 42 entry points relied on its layout alone — see §11 |
| 13 | User / profile tables | **complete and reusable** | `profiles` sound; **no new profile table needed** |
| 14 | Auth user creation paths | **complete** | exactly one: `admin/users/new/actions.ts` |
| 15 | Invitation / provisioning | **missing** | none — not required by the ratified model |
| 16 | Learner dashboard | **pilot-only** | sent anonymous visitors to `/courses` instead of `/login` |
| 17 | Enrollments | **complete, unused** | table sound; **0 rows** |
| 18 | Lesson access authorization | **UNSAFE — blocker** | see §5 |
| 19 | Course access authorization | **UNSAFE — blocker** | `enrollForFree` = self-service access |
| 20 | Certificate authorization | **complete** | `cert.user_id !== user.id → 403` |
| 21 | Voice Practice authorization | **pilot-only** | anonymous sessions permitted by design |
| 22 | Terms / privacy pages | **partially complete** | text present, **no version, no date** |
| 23 | Rate limiting | **complete and reusable** | `rateLimitDb` on `check_rate_limit()` |
| 24 | CAPTCHA support | **missing** | zero references anywhere |
| 25 | Audit / event logging | **complete and reusable** | `audit_log` append-only; `event_type` free text |
| 26 | Email sender / domain | **partially complete** | dry-run unless `RESEND_API_KEY` set (Q-D open) |
| 27 | Environment variables | **partially complete** | no `NEXT_PUBLIC_SITE_URL` locally; no CAPTCHA vars |
| 28 | CI security contracts | **complete and reusable** | 5 checks: CI, build, secrets, RLS lint, dep audit |

---

## 2. Existing authentication architecture

```
browser ──► Supabase Auth (password)         sign-in, recovery
        └─► Next.js middleware                session refresh + host boundary
             ├─ isAdminHost()                 internal host ⇒ owner-only
             ├─ AUTH_REQUIRED                 route gate (was mode-dependent)
             └─ requirePlatformAdmin()        per-page/action, host-independent
```

Authorization has never depended on the hostname, and still does not. The host
boundary decides *which site you are on*; `requirePlatformAdmin()` decides *what
you may do*, from a verified session and an email allowlist.

---

## 3. Reuse-versus-build matrix

| Concern | Decision | Why |
|---|---|---|
| Profile model | **REUSE** `profiles` + 8 nullable columns | A second profile model would immediately disagree with the first |
| Audit trail | **REUSE** `audit_log` / `logAuditEvent` | `event_type` is free text — new events need no migration |
| Rate limiting | **REUSE** `rateLimitDb` | Already distributed and serverless-safe |
| Host classification | **REUSE** `lib/hosts.ts` | Added `isCommercialHost()` only |
| Canonical URLs | **REUSE** `lib/brand.ts` | Single source of truth already exists |
| Email delivery | **REUSE** Resend layer | Added one template |
| Account creation | **REUSE** admin API pattern | Same controls as admin provisioning |
| Registration flow | **BUILD** | None existed |
| Email verification | **BUILD** | None existed |
| Legal acceptance | **BUILD** | None existed |
| CAPTCHA | **BUILD (seam only)** | No provider configured |
| Course-access seam | **BUILD** | The blocker in §5 |

---

## 4. Final domain authorization model

| Host | Anonymous | Learner | Owner |
|---|---|---|---|
| `xpclient-academy.com` | 308 → www | 308 → www | 308 → www |
| `www.xpclient-academy.com` | public pages, `/signup`, `/login` | + dashboard, own data | + `/admin` (role-checked) |
| `*.vercel.app` (internal) | `/login` only | **redirected to www, session intact** | full platform |

Two changes from CX-AUTH-1, both ratified (decisions 7–8):

* an authenticated non-owner on the internal host is now **redirected**, not
  signed out — that visitor is now usually an ordinary learner, and destroying
  their commercial session for landing on the wrong hostname is hostile;
* deep links survive the bounce **except** `/admin` and `/api`, which would only
  bounce again.

Neither grants anything. Authorization remains independent of hostname, asserted
by test.

---

## 5. Course-access gate audit — **BLOCKER FOUND AND CORRECTED**

Measured in production with the anon key, before any change:

| Table | Rows visible to an anonymous caller |
|---|---|
| `lessons` | **82 of 82** |
| `modules` | **23 of 23** |
| `quizzes` | **1 of 1** |
| `quiz_questions` | **3 of 3**, `correct_answer` included |

Three independent policy arms caused it:

| Arm | Source | Effect |
|---|---|---|
| `auth.uid() IS NULL AND is_published` | migration 008 | the deliberate pilot arm |
| `auth.uid() IS NOT NULL AND courses.is_free` | migration 005 | **every** published course is `is_free`, so any authenticated user reads everything |
| `is_preview = true` | migration 005 | **all 82 lessons carry it**, and it is not conditioned on the caller at all |

The third is the one that matters. Removing the pilot arm alone would have
*looked* like a fix and changed nothing — which is the same shape as XPA-2's
`USING (true)`, XPA-5A's column-blind RLS, and XPA-5A's additive `GRANT SELECT`.
A fourth instance of the recurring class recorded as **D-GRANT**.

Compounding it, `enrollForFree` let any authenticated user grant themselves an
active enrollment. With public registration open that is literally "registration
grants course access".

**Correction (migration 035):** one seam, `public.has_course_access(uuid)` —
platform admin, or a **verified, active** learner holding an **ACTIVE
enrollment**. No `is_free` arm, no `is_published` arm, no anonymous arm. All four
content policies were rewritten onto it, the blanket `is_preview` flag was reset,
and `enrollForFree` now denies unless explicitly re-opened by a flag that
defaults to off.

**Stated plainly:** with 0 enrollments and 0 payments in production, course
material becomes **admin-only** until XPA-6B ships the grant path. That is the
ratified posture (decisions 3, 5, 6), not a side effect.

---

## 6–10. Implementation

**Registration** (`app/actions/auth.ts`, server action)
`commercial host → Zod → CAPTCHA seam → rate limit (IP + email) → current legal
version → createUser(unconfirmed) → legal acceptance (FAIL CLOSED, rolls back the
account) → profile (role from a literal) → verification email → audit`.

Supabase `disable_signup` stays **true** permanently. Registration runs through
the admin API, which is exempt from it. Opening `disable_signup` would have been
three lines and would have re-opened every gap SEC-1 was about.

**Email verification.** `admin.generateLink({type:'signup'})` → `hashed_token` →
link composed from `PUBLIC_SITE_URL` → `/auth/verify` → `verifyOtp`. Verified
against this project: an unconfirmed user cannot sign in (`email_not_confirmed`),
the token is single-use (replay → `otp_expired`), and generating a link does
**not** overwrite the learner's chosen password.

**Password recovery.** Moved into a server action; link built from
`PUBLIC_SITE_URL`, rate limited, audited, neutral response for every outcome.

**Learner profile.** 8 nullable columns on `profiles`. No payment, entitlement or
B2B fields.

**Legal acceptance.** `legal_acceptances`, append-only, unique per
`(user, document, version)`. Registration fails closed if it cannot be written.
Pages now declare their version and carry a visible *pending legal review*
notice — XPA-6A does not write legal wording.

**Dashboard.** Requires a session; shows verification and account status; honest
empty state — *"Vous n'êtes inscrit à aucune formation"*, not "browse the
catalogue".

---

## 11. Admin-domain enforcement

One real gap found and closed: `app/(admin)/admin/page.tsx` was the only admin
entry point relying solely on its route-group layout, while itself using the
service-role client to read user counts, payment totals and recent learner
emails. The layout guard is real and did run, so this was **not an open door** —
but an invariant with one exception is one nobody can rely on. It now calls
`requirePlatformAdmin()` itself, so the privileged queries do not execute at all
for an unauthorized caller. A test asserts all 42 entry points.

---

## 15. Exact privilege matrix

| Object | `anon` | `authenticated` | Enforced by |
|---|---|---|---|
| `legal_acceptances` | **none** | `SELECT` only | REVOKE→GRANT + apply-time assertion |
| `has_course_access(uuid)` | `EXECUTE` | `EXECUTE` | required — RLS evaluates as the calling role |
| `is_email_verified()` | `EXECUTE` | `EXECUTE` | same |
| `current_account_status()` | `EXECUTE` | `EXECUTE` | same |
| `lessons` / `modules` / `quizzes` / `quiz_questions` | unchanged grants, **rewritten policies** | same | `has_course_access()` |
| `ai_scenarios` | none (XPA-5A) | none | untouched |
| `courses` | unchanged | unchanged | discovery must keep working |

Migration 035 asserts at apply time: `authenticated` holds exactly `SELECT` on
`legal_acceptances`; `anon`/`PUBLIC` hold nothing; zero lessons remain
`is_preview`; and `has_course_access()` denies with no authenticated user.

---

## 21. Remaining blockers

| # | Blocker | Owner |
|---|---|---|
| **B-1** | **Migration 035 is NOT applied.** First attempt failed and rolled back atomically; corrected version below is ready to re-run. Until applied, registration fails closed (no `legal_acceptances`) and RLS still permits anonymous reads of all content. | operator |
| **B-2** | `RESEND_API_KEY` / verified sender domain (Q-D). Without it verification email is dry-run and **no account can ever be activated**. | operator |
| **B-3** | No path to grant an enrollment. `activateEnrollment` needs a pre-existing `payments` row, and none exist. Course access is admin-only until XPA-6B. | XPA-6B |
| **B-4** | `quiz_questions.correct_answer` is still readable by an **entitled** learner via PostgREST. Audience reduced from the entire internet to admin-enrolled learners. Needs a learner-safe projection. | XPA-6D |
| **B-5** | Legal text awaits counsel review; version `2026-08-06-draft`. | operator / legal |
| **B-6** | `mailer_autoconfirm = true` at project level. Harmless for this flow (accounts are created explicitly unconfirmed) but should be turned off. | operator |

**Operator environment variables**

| Variable | Purpose | Required |
|---|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | verification delivery | **yes (B-2)** |
| `NEXT_PUBLIC_SITE_URL` | canonical origin | recommended |
| `NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT` | re-open self-enrollment | **leave unset** |
| `CAPTCHA_PROVIDER`, `CAPTCHA_SECRET_KEY` | enable CAPTCHA | optional |

---

## 14b. Migration 035 — failed apply and correction

The first apply failed. It **rolled back atomically**: verified afterwards that
none of the eight new `profiles` columns, neither new helper function, and no
`legal_acceptances` table existed. Nothing was left behind and **no manual
production patching was performed or is needed**.

### Every reference migration 035 makes to `public.profiles`

Live columns, read from production: `avatar_url, company_id, created_at, email,
full_name, id, platform_role, role, updated_at`.

| Referenced by 035 | Pre-existed? | Resolution |
|---|---|---|
| `id`, `email`, `full_name`, `platform_role` | **yes** | use as-is |
| `first_name`, `last_name`, `display_name`, `preferred_language` | no | **created by the migration** |
| `accepted_terms_version`, `accepted_privacy_version` | no | **created by the migration** |
| `account_status`, `disabled_at` | no | **created by the migration** |

No reference was to a wrongly-named column, and none needed removing. All eight
missing columns are legitimately new; the defect was **when** they were created,
not whether.

### Root cause 1 — order (this is what failed)

`current_account_status()` is `language sql`, and PostgreSQL **fully
parse-analyses a SQL-language function body at CREATE time** — unlike plpgsql,
which only checks syntax. It reads `profiles.account_status`, but the
`ALTER TABLE` adding that column came *later* in the file. Result: `42703` on the
first function.

**Fix:** all column additions moved to section 1, before any function. The
ordering is now labelled load-bearing and pinned by a test.

### Root cause 2 — recursion (would have failed the *next* run)

The hardened `profiles_update_own` policy pinned `disabled_at` with an inline
`select … from public.profiles` — a subquery on the table the policy guards,
which raises `42P17 infinite recursion detected in policy for relation
"profiles"`. Masked by root cause 1, so it would have produced a second failed
apply.

**Fix:** a `current_disabled_at()` SECURITY DEFINER helper, the same pattern
migration 027 introduced for `current_platform_role()` for exactly this reason.

### Also corrected while in there

* **Preflight block.** Missing dependencies now fail at the top with a named
  object instead of a bare `42703` several sections in.
* **Genuine idempotency for the `is_preview` reset.** An unconditional
  `set is_preview = false` is *repeatable*, not idempotent — re-running it later
  would silently un-publish preview lessons an administrator had since chosen.
  It now fires only while the broken pattern holds (every lesson flagged).
* **The matching assertion** checks the dangerous state (`n_preview = n_total`)
  rather than "zero previews", which would have turned a legitimate editorial
  act into a failed migration.
* **Constraints** use `drop … if exists` + `add`, scoped to the table, instead of
  a `conname`-only probe that can collide across tables.
* **A post-apply assertion** verifies all eight columns exist.

Five new tests pin both root causes and the idempotency guarantees.

---

## 20. XPA-6B readiness

Extend `public.has_course_access()` with one `or exists (… active entitlement …)`
arm, and the mirrored arm in `resolveCourseAccessById()`. No policy, page, layout
or route changes. Both sites are marked `XPA-6B` in the source.
