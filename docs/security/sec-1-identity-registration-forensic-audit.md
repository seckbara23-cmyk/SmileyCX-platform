# SEC-1 — Identity & Registration Security Forensic Audit

**Classification:** Internal — Security
**Date:** 2026-07-04
**Phase:** Forensic audit — **documentation only, no code or configuration changed**
**Scope:** Repository-wide + live read-only configuration probes
**Trigger:** Two unrecognized user accounts observed in production and deleted via the admin panel

---

## 1. Executive summary

### Verdict

**The unknown accounts were almost certainly legitimate, unsolicited public self-registrations — not an intrusion.** The platform currently permits anyone on the internet to create an account.

The decisive evidence is a live probe of the production Supabase Auth configuration:

```
GET {SUPABASE_URL}/auth/v1/settings
→ disable_signup: false          ← public signup is ENABLED
   mailer_autoconfirm: false     ← email confirmation IS required
   external: { email: true, all OAuth providers: false, anonymous_users: false, phone: false }
```

Combined with the repository evidence, this means: **`/signup` renders a working registration form in `pilot` mode (the current production mode), that form calls `supabase.auth.signUp()` directly from the browser, and the Supabase project accepts it.** No invitation, allowlist check, CAPTCHA, or rate limit stands in the way. Accounts appearing with "random-looking names and Gmail addresses" is the expected signature of organic or bot-driven discovery of a publicly reachable signup page.

### What this audit found beyond the incident

| # | Finding | Severity |
|---|---|---|
| F-1 | Public self-registration is enabled in production (`disable_signup: false`); `/signup` is publicly reachable and functional in `pilot` mode | **Critical** |
| F-2 | **Privilege escalation:** `profiles_update_own` RLS policy has `USING` but **no `WITH CHECK`** and no column restriction — any authenticated user can set their own `platform_role` to `super_admin` | **Critical** |
| F-3 | Zero audit logging for identity events — no `audit_log` table exists anywhere in the schema; account creation, role change, and deletion leave no application-side trace | **High** |
| F-4 | No rate limiting, CAPTCHA, or abuse protection on the registration path (client-side `signUp` bypasses the server entirely) | **High** |
| F-5 | No invitation system exists in the deployed schema — "invite-only" is a **UI illusion**, enforced nowhere | **High** |
| F-6 | Private-mode gating is UI-only on `/signup`; the mode flag is `NEXT_PUBLIC_*` (client-visible, client-trusted for form selection) | **Medium** |
| F-7 | Deleting a user via the admin panel is unlogged and irreversible — it destroyed the primary forensic evidence for this incident | **Medium** |
| F-8 | Admin bootstrap depends on a shared `ADMIN_USERNAME`/`ADMIN_EMAIL` env pair with a single shared password; no per-admin identity or MFA | **Medium** |
| F-9 | **9 pre-existing test failures** in the security-relevant suites (middleware auth-gating, admin login) — the safety net that would catch identity regressions is currently red | **Medium** |

### Answers to the mission questions

| Question | Answer | Confidence |
|---|---|---|
| Were the accounts legitimate? | Yes — ordinary public signups, most likely. No evidence of compromise. | High |
| How were they created? | `supabase.auth.signUp()` from the public `/signup` page (email + password) | High |
| When? | **Unknown** — no application-side record; `auth.users.created_at` existed but was destroyed on deletion | — |
| Which code path? | [`app/(auth)/signup/page.tsx:141`](../../app/(auth)/signup/page.tsx) → Supabase Auth API directly | High |
| Did they bypass intended security? | They bypassed *intended* invite-only onboarding, because that control **was never implemented** | High |
| Could more unknown accounts exist? | **Yes** — signup is still open right now | High |
| Was privilege escalation possible? | **Yes** — via F-2, any authenticated user could self-promote to `super_admin` | High |
| Does the platform currently allow unauthorized registrations? | **Yes** | High |

---

## 2. Identity architecture

### Actual identity model (vs. the model implied by the mission brief)

The brief anticipates a multi-tenant SaaS model (`app_user`, `user_role`, `client_user`, `invitations`, tenants). **None of those tables exist in the deployed schema.** The real model is deliberately simpler:

| Concept | Where it lives | Notes |
|---|---|---|
| `auth.users` | Supabase-managed | The only account store. Email/password only. |
| `profiles` | `public.profiles` ([schema.sql:11](../../supabase/schema.sql)) | 1:1 with `auth.users` via FK + `ON DELETE CASCADE`. Holds `platform_role`. |
| Role | `profiles.platform_role` | `CHECK IN ('user','super_admin','consultant')`, `DEFAULT 'user'` |
| Platform admin | `is_platform_admin()` SECURITY DEFINER fn | `platform_role IN ('super_admin','consultant')` |
| Admin session | `scx_admin` cookie | Separate from the Supabase learner session |
| Tenancy | **Does not exist** | Single-tenant LMS. `organizations` exists in `cx_saas_schema.sql` but that file is **not** in `migrations/` and is not deployed. |
| Invitations | **Does not exist** | `invitations` appears only in the undeployed `cx_saas_schema.sql`. |
| Impersonation | **Does not exist** | No impersonation code found. |
| Pilot identity | `anon_id` (localStorage UUID) | AI Practice only; not an account, no auth, no privileges. |

### Lifecycle & trust boundaries

```
                      ┌──────────────────────────────────────────┐
  PUBLIC INTERNET ───▶│ /signup  (client component)              │  ← TRUST BOUNDARY (weak)
                      │ supabase.auth.signUp()  [browser → Supabase]
                      └───────────────┬──────────────────────────┘
                                      │  (no server hop, no app-side validation)
                                      ▼
                            auth.users  INSERT
                                      │
                     AFTER INSERT trigger: handle_new_user()  [SECURITY DEFINER]
                                      ▼
                     public.profiles (platform_role := 'user' — HARD-CODED)
                                      │
                          email confirmation link → /auth/callback
                                      ▼
                            session issued → middleware gate
```

**Key structural observation:** the registration path has **no server-side hop**. The browser talks to Supabase Auth directly. Every application-layer control the team believes exists (mode gating, allowlist, waitlist) sits *beside* this path, not *on* it.

### Deletion path

`app/(admin)/admin/users/[id]/actions.ts:15` → `adminClient.auth.admin.deleteUser(userId)` → `profiles` row cascades. **No audit record is written.** (F-7)

---

## 3. Registration path inventory

Exhaustive search across the repository for `signUp`, `createUser`, `admin.createUser`, `inviteUser`, `generateLink`, `auth.admin`, `signInWithOAuth`, `signInAnonymously`, and direct `auth.users` inserts.

| # | Path | Location | Auth required | Authz check | Invitation | Rate limit | Audit log | Reachable by anonymous? |
|---|---|---|---|---|---|---|---|---|
| **R-1** | `supabase.auth.signUp()` — public signup form | [`app/(auth)/signup/page.tsx:141`](../../app/(auth)/signup/page.tsx) | ❌ No | ❌ **None** | ❌ None | ❌ **None** | ❌ None | ✅ **YES** |
| **R-2** | `adminClient.auth.admin.createUser()` — admin panel | [`app/(admin)/admin/users/new/actions.ts:19`](../../app/(admin)/admin/users/new/actions.ts) | ✅ Yes | ✅ `requirePlatformAdmin()` | n/a | ❌ None | ❌ None | ❌ No |
| **R-3** | Direct Supabase Auth REST API | `POST {SUPABASE_URL}/auth/v1/signup` with the public anon key | ❌ No | ❌ **None** | ❌ None | Supabase built-in only | Supabase only | ✅ **YES** |

**R-3 is the important one for the threat model:** even if the `/signup` *page* were removed entirely, the Supabase Auth endpoint remains open to anyone holding the `NEXT_PUBLIC_SUPABASE_ANON_KEY` — which is, by design, embedded in every page of the site. **The only control that actually closes public registration is the server-side `disable_signup` setting in the Supabase project.**

### Paths that do NOT exist (verified absent)

- No OAuth sign-in (all providers `false` in live config)
- No magic-link/OTP sign-in code (`signInWithOtp` — 0 hits)
- No anonymous auth (`signInAnonymously` — 0 hits; `anonymous_users: false`)
- No phone auth (`phone: false`)
- No `inviteUserByEmail` / `generateLink` usage
- No SQL path inserting into `auth.users`

---

## 4. Supabase Auth configuration (live, production)

Probed read-only via the public `/auth/v1/settings` endpoint:

| Setting | Value | Assessment |
|---|---|---|
| `disable_signup` | **`false`** | ⛔ **Public registration OPEN — root cause of the incident** |
| `mailer_autoconfirm` | `false` | ✅ Email confirmation required (limits throwaway accounts; does not stop real mailboxes) |
| `external.email` | `true` | Email/password enabled |
| `external.*` (google, github, azure, apple, …) | all `false` | ✅ No OAuth attack surface |
| `external.anonymous_users` | `false` | ✅ No anonymous auth |
| `external.phone` / `phone_autoconfirm` | `false` | ✅ No phone/SMS surface |

**Not observable without dashboard/service-role access** (documented as evidence gaps): JWT expiry & rotation policy, redirect-URL allowlist, allowed origins/CORS, password strength policy, leaked-password protection, per-project Auth rate limits, CAPTCHA/hCaptcha toggle, SMTP configuration.

**Conclusion:** the production Auth configuration is that of an **open-registration consumer product**, which directly contradicts the stated intent of an invite-only pilot.

---

## 5. Middleware & authorization review

[`middleware.ts`](../../middleware.ts) is well-constructed and is *not* the weak point. Verified behavior:

- Runs `supabase.auth.getUser()` on every matched request (session refresh + validation).
- **Private mode:** site-wide allowlist gate; non-exempt routes require an authenticated **and** allowlisted user (`ALLOWED_PRIVATE_EMAILS`), else redirect to `/login` or `/access-restricted`.
- **Pilot/public mode:** `AUTH_REQUIRED` prefix list protects `/app`, `/dashboard`, `/learn`, `/checkout`, `/certificate`.
- Authenticated users are redirected away from `/login`, `/signup`, `/forgot-password`.
- `/admin/*` (except `/admin/login`) requires the `scx_admin` cookie; the role check (`super_admin`) is re-verified server-side in the admin layout.
- Security headers applied on every response (CSP, HSTS, X-Frame-Options, Permissions-Policy).

### The structural gap

Middleware governs **navigation**, not **account creation**. `/signup` is deliberately exempt from the private-mode gate (to avoid a redirect loop), and registration itself never transits middleware — the browser calls Supabase directly (R-1/R-3). **Middleware cannot prevent, and does not observe, account creation.** This is the correct architectural reading of why "invite-only" felt enforced but wasn't.

Server-side authorization elsewhere is sound: server actions call `requirePlatformAdmin()`; mutations validate with Zod; UI protection is never the only layer for admin routes.

---

## 6. Registration workflow — where validation actually occurs

```
Registration form (client)          ── validation: length/format only, CLIENT-SIDE, trivially bypassed
        ↓
supabase.auth.signUp()              ── NO application authorization, NO invitation check,
        ↓                              NO rate limit, NO audit
auth.users INSERT                   ── Supabase: email uniqueness + password policy only
        ↓
handle_new_user() trigger           ── ✅ platform_role FORCED to 'user' (ignores client metadata)
        ↓
public.profiles row                 ── default role = 'user', no tenant (none exist)
        ↓
Email confirmation → /auth/callback ── ✅ open-redirect protected (relative paths only)
        ↓
Session issued                      ── welcome email sent
        ↓
First protected navigation          ── ✅ middleware gate (mode-dependent)
```

**Missing validation, in order of importance:**

1. No server-side authorization on registration (R-1 has no server hop at all).
2. No invitation/allowlist verification at creation time.
3. No abuse controls (rate limit, CAPTCHA, disposable-domain screening).
4. No audit event at any step.
5. Client-supplied `platform_role: 'user'` is sent in signup metadata ([`signup/page.tsx:145`](../../app/(auth)/signup/page.tsx)) — **currently inert** because the trigger hard-codes the role, but it is a latent trap: any future change to `handle_new_user()` that reads `raw_user_meta_data->>'platform_role'` would instantly become a critical escalation. (One such variant already exists in the undeployed [`fix_all.sql:69`](../../supabase/fix_all.sql), which does `COALESCE(NEW.raw_user_meta_data->>'role', 'learner')`.)

**Positive finding:** the deployed trigger is correct. The signup metadata cannot escalate a role today.

---

## 7. Invitation architecture

**There is no invitation system in the deployed platform.**

- No `invitations` table in `supabase/migrations/` (the deployed set, 001–026).
- `invitations` appears only in [`supabase/cx_saas_schema.sql`](../../supabase/cx_saas_schema.sql) — an alternate multi-tenant schema **not applied** to this project.
- No invitation tokens, expiry, acceptance flow, replay protection, or tenant binding exist.

What *is* presented to users as "invitation-based" is:

- **Private mode** shows `WaitlistForm` on `/signup` with the copy "Accès sur invitation" ([`signup/page.tsx:61`](../../app/(auth)/signup/page.tsx)). Submitting it only **sends an email to the administrator** via [`app/actions/waitlist.ts`](../../app/actions/waitlist.ts) — it writes no database row and creates no account. (Note: this also means the waitlist leaves no queryable record; the `waitlist` table does not exist — confirmed by a live 404 `PGRST205`.)
- **`ALLOWED_PRIVATE_EMAILS`** ([`lib/access-control.ts:18`](../../lib/access-control.ts)) is an **access** allowlist checked by middleware *after* login — it is **not** a registration control. A non-allowlisted person can still create an account; they are merely redirected to `/access-restricted` afterwards.

**Can invitations be bypassed? They cannot be bypassed because they do not exist.** "Invite-only" is currently a copywriting claim, not a security control. (F-5)

---

## 8. Unknown-user reconstruction

### Attempted reconstruction

| Evidence sought | Available? | Why |
|---|---|---|
| Creation timestamp | ❌ | Lived in `auth.users.created_at`; row deleted |
| Auth provider | ⚠️ Inferable | Only email/password is enabled → necessarily `email` |
| Email confirmation status | ❌ | `auth.users.email_confirmed_at`; row deleted |
| Inviter | ❌ n/a | No invitation system exists |
| API endpoint used | ⚠️ Inferable | Only R-1/R-3 are anonymous-reachable |
| Application audit event | ❌ | **No `audit_log` table exists** (F-3) |
| Assigned role | ⚠️ Inferable | Trigger forces `'user'`; cascade-deleted with the profile |
| Tenant | ✅ n/a | No tenancy in this platform |
| Last login | ❌ | `auth.users.last_sign_in_at`; row deleted |
| Password reset activity | ❌ | Supabase Auth audit only |
| Invitation usage | ✅ n/a | None exist |

### Why the evidence is unavailable

Three compounding causes:

1. **No application-side audit logging** — the platform never recorded the events.
2. **Deletion is destructive and cascading** — `auth.admin.deleteUser()` removed the Supabase row; the FK `ON DELETE CASCADE` removed the profile. The admin panel offers no soft-delete or archival.
3. **The one surviving source was not captured before deletion** — Supabase's own **Auth Logs** (Dashboard → Logs → Auth) retain sign-up/sign-in events independently of the `auth.users` row, subject to the project's retention window (typically 1 day on Free, 7 days on Pro).

### ⚠️ Recommended immediate evidence-preservation action (outside this repo)

**If the deletions occurred within the retention window, export the Supabase Auth logs now** — Dashboard → Logs → Auth Logs, filter around the deletion date for `signup` / `user_confirmation_requested` / `login` events. This is the only remaining source that can supply exact timestamps, IP addresses, and user agents for the two accounts. Every day of delay risks permanent loss.

### Logging required to make future incidents reconstructible

An `audit_log` table (append-only, admin-read-only) capturing at minimum: `event_type`, `actor_id`, `actor_type` (self/admin/system), `subject_user_id`, `email`, `ip`, `user_agent`, `metadata jsonb`, `created_at` — written on: registration, email confirmation, login success/failure, password reset request/completion, role change, admin user create, and **user deletion (with a snapshot of the deleted row)**.

---

## 9. User-creation permission inventory

| Principal | Can create a user? | Mechanism | Controls |
|---|---|---|---|
| **Anonymous (internet)** | ✅ **YES** | R-1 `/signup`, R-3 direct Auth API | ⛔ **None** (email confirmation only) |
| **Authenticated learner** | ✅ Yes (same as anonymous) | R-1/R-3 | ⛔ None |
| **`super_admin` / `consultant`** | ✅ Yes | R-2 admin panel | `requirePlatformAdmin()` ✅ |
| **Service role** | ✅ Yes | `createAdminClient()` server-side only | Key never exposed to browser ✅ |
| **Automation / CI** | ❌ No | — | No automated provisioning exists |

**Privilege escalation analysis — one confirmed vector (F-2):**

[`001_phase_a_rls_fix.sql:61`](../../supabase/migrations/001_phase_a_rls_fix.sql)

```sql
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (auth.uid() = id OR is_platform_admin());
```

A Postgres `UPDATE` policy with only a `USING` clause restricts **which rows may be updated**, not **what the resulting row may contain**. With no `WITH CHECK` and no column-level restriction, an authenticated user can execute:

```sql
UPDATE profiles SET platform_role = 'super_admin' WHERE id = auth.uid();
```

…directly against PostgREST using the public anon key plus their own session JWT. `platform_role` is in the `CHECK` list, so the constraint permits it. This grants `is_platform_admin()` = true, unlocking every admin-gated RLS policy across the schema.

> **Mitigating factor (partial, not sufficient):** the `/admin` UI additionally requires the `scx_admin` cookie, which is only issued by `/api/admin/login` after authenticating against `ADMIN_EMAIL` + password. So a self-promoted user does **not** immediately get the admin *UI*. However, they **do** immediately gain `super_admin` privileges at the **database/RLS layer** — able to read all profiles, all enrollments, all payments, and all learner data directly through PostgREST. That is a full confidentiality breach regardless of the UI gate.

This was **not** exploited by the unknown accounts as far as can be determined (no evidence either way, given F-3), but it is exploitable today by any registered user.

---

## 10. Default-role analysis

| Aspect | Value | Assessment |
|---|---|---|
| Default `platform_role` | `'user'` (column default **and** hard-coded in trigger) | ✅ Correct, least-privilege |
| Client metadata influence | Sent but ignored | ✅ Safe today; latent trap (§6) |
| Default tenant | n/a — no tenancy | ✅ |
| Anonymous permissions | Read published course content (pilot-mode RLS) | ⚠️ Intentional for pilot |
| Authenticated permissions | Own profile, own progress, own enrollments; **+ free enrollment in pilot** | ⚠️ See below |

**Does a self-registered user automatically receive platform access?** In the current `pilot` mode: **yes.** `FREE_ACCESS_MODE` is true in pilot, so `enrollForFree()` auto-enrolls any authenticated user reaching a lesson ([`app/actions/enrollment.ts`](../../app/actions/enrollment.ts), invoked from the lesson player). A stranger who registers can therefore self-enroll and consume the full course catalogue at no cost. In `private` mode they would instead be bounced to `/access-restricted` by middleware.

---

## 11. RLS review

| Table | Anonymous | Authenticated | Assessment |
|---|---|---|---|
| `profiles` | ❌ No rows (live probe returned `[]`) | Own row (+ all rows if `is_platform_admin()`) | ⚠️ **UPDATE lacks `WITH CHECK` — F-2** |
| `courses` / `modules` / `lessons` | Published content readable (pilot) | Same + enrolled access | ⚠️ Intentional |
| `enrollments`, `lesson_progress`, `quiz_attempts` | ❌ | Own rows | ✅ |
| `payments` | ❌ | Own rows | ✅ (hardened in phase 2) |
| `ai_sessions` / `ai_turns` / `ai_feedback` / `ai_scores` | ❌ **0 rows** (verified live) | Own sessions only | ✅ |
| `ai_scenarios` / `ai_competencies` / `ai_rubrics` | Published/active rows readable | Same | ⚠️ Minor: exposes `agent_id`, `prompt_template` (documented, non-credential) |
| `rate_limits` | Service-role only | — | ✅ |
| `invitations`, `app_user`, `user_role`, `client_user`, `employee`, `finance`, `messaging` | **Tables do not exist** | — | n/a |

**Enumeration risk:** anonymous `SELECT` on `profiles` correctly returns zero rows. However, **Supabase Auth's own signup endpoint is an enumeration oracle** in the default configuration — attempting to register an existing email returns a distinguishable response. This is a Supabase-level setting, not a repository issue.

**Tenant isolation:** not applicable — single-tenant platform.

---

## 12. API surface inventory

| Endpoint / action | Type | Auth | Authz | Rate limit | Audit | Notes |
|---|---|---|---|---|---|---|
| `POST /api/admin/login` | Route Handler | ❌ (is the login) | Username + Supabase password + `super_admin` check | ✅ **IP + username, 5/15min, DB-backed** | ⚠️ `log.warn` only | ✅ Generic errors, no enumeration |
| `POST /api/admin/signout` | Route Handler | Cookie | — | ❌ | ❌ | Low risk |
| `POST /api/admin/upload-url` | Route Handler | ✅ | Admin | ❌ | ❌ | Signed upload URLs |
| `GET /api/certificates/[id]/pdf` | Route Handler | ✅ | Owner | ❌ | ❌ | |
| `joinWaitlist()` | Server Action | ❌ | — | ❌ | Email only | ⚠️ Unauthenticated email-send trigger — spam/abuse vector |
| `createUser()` | Server Action | ✅ | `requirePlatformAdmin()` | ❌ | ❌ | R-2 |
| `deleteUser()` | Server Action | ✅ | `requirePlatformAdmin()` | ❌ | ❌ | **Destroys evidence (F-7)** |
| `enrollForFree()` | Server Action | ✅ | Session | ❌ | ❌ | Auto-enrolls in pilot |
| AI practice/coach actions | Server Actions | Session or `anon_id` | Ownership in code | ✅ `rateLimitDb` | ❌ | Phase 1/2 work |
| **`supabase.auth.signUp()`** | **Direct → Supabase** | ❌ | ❌ | ❌ | ❌ | **R-1 — the incident path** |

---

## 13. Service-role audit

`createAdminClient()` ([`lib/supabase/admin.ts`](../../lib/supabase/admin.ts)) reads `SUPABASE_SERVICE_ROLE_KEY` — **server-only, never `NEXT_PUBLIC_`**. Used in ~50 files.

| Caller group | Guard | Assessment |
|---|---|---|
| `app/(admin)/**` pages & actions | `requirePlatformAdmin()` / admin layout role check | ✅ |
| `app/api/admin/*` | Cookie + role verification | ✅ |
| `lib/rate-limit.ts` | Internal only | ✅ |
| `app/actions/ai-*.ts` | In-code ownership checks (`user_id` / `anon_id`) | ✅ Reviewed in phases 1–2 |
| `app/actions/payment.ts`, `enrollment.ts`, `quiz.ts` | Session + ownership | ✅ |
| `app/(public)/verify-certificate/[id]` | Public by design (certificate verification) | ⚠️ Intentional; returns only certificate validity |

**No dangerous usage found.** The key is not exposed to the browser (independently verified during phase 2B bundle greps). The principal residual risk is *breadth*: service-role bypasses RLS entirely, so every one of those ~50 call sites relies on correct in-code authorization. Adding tenant/ownership assertions as shared helpers (rather than per-file) would reduce future drift.

---

## 14. Environment configuration audit

| Variable | Exposure | Assessment |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | Public (by design) | ✅ Expected — but note this is what makes R-3 universally reachable |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | ✅ Verified absent from client bundles |
| `NEXT_PUBLIC_PLATFORM_MODE` | **Public** | ⚠️ Client-visible and client-trusted for `/signup` form selection (F-6) |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` | Server-only | ⚠️ Single shared admin identity (F-8) |
| `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY` | Server-only | ✅ Verified absent from client bundles |
| Payment gateway keys | Server-only, unset during pilot | ✅ |

**Is production configuration consistent with an invite-only SaaS? No.** Three contradictions: `disable_signup: false`; `PLATFORM_MODE=pilot` (which renders the real signup form and enables free auto-enrollment); and no invitation infrastructure. The configuration is that of an **open pilot**, and the platform is behaving exactly as configured.

---

## 15. Bot resistance

| Control | Present | Notes |
|---|---|---|
| CAPTCHA / hCaptcha / Turnstile | ❌ | Supabase supports this natively; not enabled |
| Email verification | ✅ | `mailer_autoconfirm: false` — the *only* active barrier |
| Invitation-only | ❌ | Does not exist |
| Signup rate limiting | ❌ | No app-side limit; Supabase project defaults only |
| Disposable-domain screening | ❌ | |
| Account lockout | ⚠️ Admin login only (5/15min) | Learner login has none |
| Leaked-password protection | ❓ Unknown | Supabase setting, not observable from here |
| Password strength policy | ⚠️ Client-side ≥8 chars only | Server policy unknown |

Email confirmation alone stops only the laziest automation; it does not stop a human or a bot with mailbox access. **Registration flooding is currently feasible** and would generate unbounded `auth.users` rows plus outbound confirmation email volume (a deliverability/reputation risk for the sending domain).

---

## 16. Logging inventory

| Source | Exists | Retention | Reconstructive value |
|---|---|---|---|
| Application `audit_log` | ❌ **None** | — | **Zero** |
| Structured app logs (Pino) | ⚠️ Partial | Vercel runtime logs (short) | Admin login failures, action errors; **no signup events** |
| Supabase Auth Logs | ✅ Provider-side | Plan-dependent (~1–7 days) | **The only source with signup timestamps/IPs** |
| Supabase Postgres logs | ✅ Provider-side | Plan-dependent | Query-level, hard to attribute |
| Vercel access logs | ✅ | Short | `/signup` page views only — **not** the Auth API call (that goes browser → Supabase, bypassing Vercel entirely) |

**Can future incidents be reconstructed? Not today.** This is the single highest-leverage remediation: without it, every future identity question ends in "evidence unavailable."

---

## 16b. Test-suite integrity (F-9)

The verification gates for this phase surfaced **9 pre-existing failures** in exactly the suites that guard identity. These predate this audit (`git diff` is empty — the working tree matches HEAD), but they matter: **a red safety net cannot catch an identity regression.**

| Suite | Failures | Root cause | Security meaning |
|---|---|---|---|
| `__tests__/api/admin-login.test.ts` | 7 | Stale mock — the test's `vi.mock('@/lib/rate-limit')` does not export `rateLimitDb`, which was added when admin-login rate limiting was introduced | **Test defect, not a product defect.** The rate limiting itself is implemented and correct ([`route.ts:11-50`](../../app/api/admin/login/route.ts)). But the entire admin-login test file is currently non-executing, so brute-force protection is **unverified by CI**. |
| `__tests__/middleware.test.ts` | 2 | Tests assert unauthenticated `/dashboard` and `/learn/*` return `307`; in `pilot` mode `AUTH_REQUIRED` is narrowed to `['/app']`, so middleware returns `200` | **Reflects an intentional pilot-mode design change, not an open hole.** Verified: [`app/(platform)/dashboard/page.tsx:18-19`](../../app/(platform)/dashboard/page.tsx) performs its own `getUser()` + `redirect()`, so the page still self-protects. The loss is **defense-in-depth** (single-layer instead of two) and **test accuracy** (the suite no longer encodes the real intended posture). |

**Assessment:** neither failure indicates an exploitable vulnerability, and neither contributed to the incident. Both should nonetheless be resolved in SEC-2 — the admin-login mock as a straightforward fix, and the middleware tests as a deliberate decision to re-state the intended per-mode auth matrix (which doubles as documentation of that policy).

---

## 17. Threat model & risk ranking

| ID | Threat | Feasibility now | Impact | Severity |
|---|---|---|---|---|
| T-1 | **Public self-registration** — anyone creates an account | **Trivial** (confirmed live) | Unauthorized platform + free course access; unbounded user table | **Critical** |
| T-2 | **Privilege escalation via `profiles` UPDATE** — self-promote to `super_admin` | **Trivial** for any registered user | Full read of all learner PII, payments, enrollments via RLS | **Critical** |
| T-3 | **No audit trail** — incidents unreconstructable | Already realized | Forensic blindness; compliance exposure | **High** |
| T-4 | **Registration flooding** | Easy (no rate limit/CAPTCHA) | DB bloat, email reputation damage, cost | **High** |
| T-5 | **Account enumeration** via Auth signup responses | Easy | Confirms which emails are registered | **Medium** |
| T-6 | **Waitlist email abuse** — unauthenticated send trigger | Easy | Spam to admin inbox, Resend quota burn | **Medium** |
| T-7 | **Shared admin credential** — single identity, no MFA, no per-admin attribution | Requires credential | Full admin compromise; unattributable actions | **Medium** |
| T-8 | **Latent metadata-role trap** — future trigger change reads client `platform_role` | Not exploitable today | Would be instant critical escalation | **Medium** (latent) |
| T-9 | Invitation replay / tenant escape / service-role misuse | **Not applicable** | — | **N/A** |
| T-10 | Brute force on learner login | Moderate (no app-side limit) | Account takeover | **Low–Medium** |

---

## 18. Timeline reconstruction

### Reconstructable (high confidence, from configuration evidence)

```
[unknown date]  Supabase project created with default settings
                → disable_signup defaults to FALSE
                                    ↓
2026-07-03      PLATFORM_MODE switched private → pilot (commit f54a0ce)
                → /signup begins rendering the REAL SignupForm to the public
                → FREE_ACCESS_MODE becomes true (auto-enrollment)
                                    ↓
[unknown date]  Two visitors reach /signup (organic discovery, search, or bot)
                → supabase.auth.signUp(email, password)
                → auth.users row created; handle_new_user() → profiles(role='user')
                → confirmation email sent; (confirmation status unknown)
                                    ↓
[unknown date]  Administrator observes the accounts
                → deleteUser() via admin panel → rows cascade-deleted
                → NO audit record written  ← evidence destroyed
                                    ↓
2026-07-04      SEC-1 forensic audit (this document)
```

### Not reconstructable — and precisely why

| Missing datum | Blocking cause |
|---|---|
| Exact creation timestamps | No audit log; `auth.users` rows deleted |
| Source IP / user agent | Never recorded app-side; only in Supabase Auth Logs (retention-limited) |
| Whether emails were confirmed | `email_confirmed_at` deleted with the rows |
| Whether either account logged in or enrolled | No audit log; enrollments cascade-deleted |
| Whether either attempted the T-2 escalation | **No logging of profile role changes** — this is the most concerning gap |

> **The T-2 question is genuinely open.** Because there is no audit trail on `profiles.platform_role`, the audit **cannot rule out** that either account self-promoted before deletion. Nothing suggests it did; nothing proves it didn't. The Supabase Auth logs (if still within retention) plus a current census of `profiles WHERE platform_role != 'user'` are the two checks that can partially close this — both are operator actions outside this repository.

---

## 19. Recommendations

### Immediate (do today — before any further exposure)

| # | Action | Addresses | Severity | Where |
|---|---|---|---|---|
| I-1 | **Set `disable_signup: true`** in Supabase Dashboard → Auth → Providers → Email | T-1 | Critical | Dashboard (config, not code) |
| I-2 | **Fix the `profiles` UPDATE policy** — add `WITH CHECK` preventing self-modification of `platform_role` | T-2 | Critical | New migration |
| I-3 | **Export Supabase Auth logs now** for the incident window before retention expires | Evidence | Critical | Dashboard |
| I-4 | **Census current roles:** `SELECT id, email, platform_role, created_at FROM profiles WHERE platform_role <> 'user'` — verify only expected admins exist | T-2 verification | Critical | SQL |
| I-5 | **Census all accounts:** `SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC` — identify any further unrecognized accounts | Unknown accounts | High | SQL |
| I-6 | Enable Supabase **CAPTCHA** and **leaked-password protection** | T-4, T-10 | High | Dashboard |

> **I-1 and I-2 together are the true fix.** I-1 alone closes R-1/R-3; I-2 alone closes the escalation. Neither substitutes for the other.

### Short-term (this sprint)

| # | Action | Addresses | Severity |
|---|---|---|---|
| S-1 | Create an append-only `audit_log` table + write events on signup, login, role change, admin create, **and delete (with row snapshot)** | T-3 | High |
| S-2 | Move registration behind a **server action** (`/api/auth/register` or `registerUser()`) so app-side authorization, rate limiting, and auditing become possible at all | T-1, T-4 | High |
| S-3 | Rate-limit registration and learner login with the existing `rateLimitDb` infrastructure | T-4, T-10 | High |
| S-4 | Replace the hard-delete admin flow with **soft-delete/archive** (retain a tombstone record) | T-3, F-7 | Medium |
| S-5 | Rate-limit `joinWaitlist()`; persist waitlist entries to a table instead of email-only | T-6 | Medium |
| S-6 | Remove the inert `platform_role` from signup metadata; add a regression test asserting the trigger ignores client-supplied roles | T-8 | Medium |
| S-7 | RLS regression tests: assert a non-admin **cannot** change their own `platform_role` | T-2 | High |
| S-8 | **Repair the 9 failing tests** (F-9): add `rateLimitDb` to the admin-login mock; re-state middleware tests as an explicit per-mode auth matrix | F-9 | Medium |

### Long-term (next quarter)

| # | Action | Addresses | Severity |
|---|---|---|---|
| L-1 | Build a **real invitation system** (tokens, expiry, single-use/replay protection, email binding) if invite-only is the intended model | T-1, F-5 | High |
| L-2 | Per-admin identities with **MFA**; retire the shared `ADMIN_USERNAME`/`ADMIN_EMAIL` credential | T-7 | Medium |
| L-3 | Admin action audit UI + alerting on privileged events (role change, user delete) | T-3 | Medium |
| L-4 | Formal RLS test suite in CI covering every table's anon/authenticated/admin matrix | All | Medium |
| L-5 | Session-security hardening review: JWT lifetime, refresh rotation, redirect-URL allowlist, CORS origins | Unknown gaps | Medium |
| L-6 | Consider column-level privileges (`REVOKE UPDATE (platform_role) ON profiles FROM authenticated`) as defense-in-depth beyond the RLS fix | T-2 | Low |

---

## 20. Decisions requiring ratification

These are **product/business decisions**, not engineering choices. SEC-2 cannot proceed correctly without explicit answers:

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | **Is the platform invite-only or open-pilot?** The code says one thing and the configuration says another. | (a) Invite-only → I-1 + L-1 · (b) Open pilot → keep signup, add abuse controls, update the "Accès sur invitation" copy | **(a) Invite-only** — matches stated intent |
| D-2 | Should self-registered users get **free course access** automatically (`FREE_ACCESS_MODE` in pilot)? | Keep / gate behind allowlist / require admin approval | Gate behind approval while invite-only |
| D-3 | Retention policy for identity audit logs | 90 days / 1 year / indefinite | ≥ 1 year for privileged events |
| D-4 | Should deleted users be **archived** rather than hard-deleted? | Yes / no | Yes (soft-delete + tombstone) |
| D-5 | Should the two deleted accounts be **notified or investigated** further? | Depends on Auth-log findings from I-3 | Decide after I-3 |
| D-6 | Is a single shared admin credential acceptable through launch? | Yes with MFA / no, per-admin now | Add MFA immediately; per-admin by launch |

---

## 21. SEC-2 implementation roadmap

**SEC-2 is the remediation phase. Sequenced so each step is independently verifiable and rollback-able.**

### SEC-2.0 — Emergency containment (config + evidence; no code)
1. Supabase Dashboard: `disable_signup = true`; enable CAPTCHA; enable leaked-password protection.
2. Export Auth logs for the incident window (I-3).
3. Run the role census (I-4) and account census (I-5); document results in an addendum to this report.
4. **Gate:** confirm `/auth/v1/settings` returns `disable_signup: true`; confirm no unexpected `platform_role != 'user'` rows.

### SEC-2.1 — Close privilege escalation (migration 027)
5. New migration: recreate `profiles_update_own` with a `WITH CHECK` that pins `platform_role` to its existing value for non-admins (admins retain full update via `is_platform_admin()`).
6. Optionally `REVOKE UPDATE (platform_role) ON public.profiles FROM authenticated` as belt-and-braces (L-6).
7. Add vitest/SQL regression tests: non-admin self-promotion must fail; admin role change must succeed; self-update of `full_name` must still succeed.
8. **Gate:** tests pass; manual PostgREST attempt to self-promote returns an RLS violation.

### SEC-2.2 — Audit logging (migration 028 + write path)
9. `audit_log` table (append-only; RLS: admin-read, service-role-write; no UPDATE/DELETE policies).
10. `logAuditEvent()` helper; instrument signup, login success/failure, role change, admin user create, and user delete (snapshot).
11. Replace hard-delete with soft-delete + tombstone (S-4).
12. **Gate:** each instrumented action writes exactly one row; admin can read; learner cannot.

### SEC-2.3 — Server-side registration + abuse controls
13. Introduce a server action / route handler that owns registration: Zod validation → invitation or allowlist check → `rateLimitDb` → `admin.createUser()` → audit event.
14. Repoint the signup UI at it; **remove the client-side `supabase.auth.signUp()` call and the `platform_role` metadata**.
15. Rate-limit learner login and `joinWaitlist()`; persist waitlist rows.
16. **Gate:** registration without an invitation is rejected server-side; rate limit trips as configured; audit rows appear.

### SEC-2.4 — Invitation system (if D-1 = invite-only)
17. `invitations` table: single-use token (hashed), expiry, email binding, `accepted_at`, issuer.
18. Admin UI to issue/revoke; acceptance flow bound to the invited email; replay rejected.
19. **Gate:** token reuse fails; expired token fails; email mismatch fails.

### SEC-2.5 — Verification & hardening
20. RLS matrix test suite in CI (anon / authenticated / admin per table).
21. Re-run this audit's live probes and confirm every Critical/High finding is closed.
22. Per-admin identities + MFA (L-2); admin audit UI (L-3).

---

## 22. Evidence index

| Finding | Primary evidence |
|---|---|
| Public signup enabled | Live probe: `GET /auth/v1/settings` → `disable_signup: false` |
| Signup form is client-side, ungated | [`app/(auth)/signup/page.tsx:141`](../../app/(auth)/signup/page.tsx) |
| Mode gating is UI-only | [`app/(auth)/signup/page.tsx:296-309`](../../app/(auth)/signup/page.tsx) |
| Production mode is `pilot` | `.env.local`, `.env.example`; commit `f54a0ce` |
| Role escalation vector | [`supabase/migrations/001_phase_a_rls_fix.sql:61`](../../supabase/migrations/001_phase_a_rls_fix.sql) — no `WITH CHECK` |
| Trigger forces safe default role | [`001_phase_a_rls_fix.sql:76-93`](../../supabase/migrations/001_phase_a_rls_fix.sql) |
| Latent metadata-role trap | [`supabase/fix_all.sql:69`](../../supabase/fix_all.sql) (undeployed variant) |
| No audit log | Repository-wide grep for `audit_log` → 0 hits in `migrations/`, `lib/`, `app/` |
| No invitations deployed | `invitations` only in undeployed `cx_saas_schema.sql` |
| No waitlist table | Live probe → `404 PGRST205` |
| Anon cannot read profiles | Live probe → `200 []` |
| Admin creation is gated | [`app/(admin)/admin/users/new/actions.ts:7`](../../app/(admin)/admin/users/new/actions.ts) |
| Admin login is rate-limited | [`app/api/admin/login/route.ts:11-50`](../../app/api/admin/login/route.ts) |
| Deletion is unlogged | [`app/(admin)/admin/users/[id]/actions.ts:15`](../../app/(admin)/admin/users/[id]/actions.ts) |
| Middleware behavior | [`middleware.ts`](../../middleware.ts) |

---

## 23. Audit method & limitations

**Method:** exhaustive repository search across all registration/auth primitives; full read of the signup, login, callback, middleware, admin-auth, and admin-user-management paths; review of all 26 deployed migrations for identity tables, triggers, and RLS; service-role call-site inventory; and **read-only** live probes of the public Supabase Auth settings endpoint and anonymous PostgREST visibility.

**Limitations:**
- No Supabase Dashboard access → JWT/redirect/CORS/CAPTCHA/password-policy settings not directly observable.
- No service-role queries were run → `auth.users` and `profiles` were **not** enumerated (the censuses in I-4/I-5 are recommended operator actions, deliberately not performed by this audit).
- The two accounts were deleted before the audit → no direct artifact analysis was possible.
- Supabase Auth logs were not accessible from this environment.

**Constraint compliance:** no code was modified, no signup disabled, no Supabase configuration changed, no permissions or RLS altered, no middleware added, no fixes implemented. The only files added by this phase are this report and its directory.

---

## 24. Verification gate results

Run at audit close, on the working tree for this phase:

| Gate | Result | Notes |
|---|---|---|
| `git status` | ✅ | Only `docs/security/` added (plus 3 pre-existing untracked images) |
| `git diff` (tracked files) | ✅ **empty** | **Proves the phase is documentation-only** |
| `npx tsc --noEmit` (typecheck) | ✅ **pass** | Exit 0, no errors |
| `npx vitest run` (full suite) | ⚠️ **57 passed / 9 failed** | **All 9 failures pre-existing on HEAD** — see §16b (F-9). Cannot have been introduced by this phase: the tracked-file diff is empty. |
| `npm run build` (production) | ✅ **pass** | Compiled successfully |

**Honest gate status:** four of five gates are green. The test suite is **not** fully green, and this report does not claim otherwise. The 9 failures are pre-existing, are analysed in §16b, are test-side rather than product-side, and repairing them is scheduled as **S-8** in SEC-2 — deliberately *not* done here, because fixing them would require modifying code, which this forensic phase forbids.

---

**End of SEC-1 report.**
