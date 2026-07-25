# SEC-2 — Identity & Registration Security Remediation

**Classification:** Internal — Security
**Date:** 2026-07-04
**Phase:** Implementation (remediation of SEC-1 findings)
**Predecessor:** [`sec-1-identity-registration-forensic-audit.md`](./sec-1-identity-registration-forensic-audit.md)

---

## 1. Executive summary

Every **Critical** and **High** finding from SEC-1 is now closed in the repository. The identity architecture is unchanged: single-tenant, `auth.users` + `profiles`, `platform_role` as the only role axis. Nothing was redesigned; controls were added around the existing model.

| SEC-1 finding | Severity | Status | Mechanism |
|---|---|---|---|
| **F-1** Public self-registration enabled | Critical | ✅ **Closed in repo**, ⚠️ **1 dashboard step required** | Signup page rewritten to an access-request form; no registration call remains anywhere; startup validation refuses to boot production while `disable_signup: false` |
| **F-2** Privilege escalation via `profiles` UPDATE | Critical | ✅ **Closed** (pending migration apply) | Migration 027: explicit `WITH CHECK` pinning `platform_role` + `BEFORE UPDATE` trigger backstop |
| **F-3** No identity audit logging | High | ✅ **Closed** | Migration 027: append-only `audit_log` + instrumentation of create / delete / role-grant |
| **F-4** No rate limiting on provisioning | High | ✅ **Closed** | `rateLimitDb` on admin provisioning (20/admin/hour); admin login already limited |
| **F-5** No invitation enforcement | High | ✅ **Closed by policy** | Provisioning is admin-only; no anonymous path exists. Full invitation module is a later phase (explicitly excluded here) |
| **F-6** UI-only mode gating on `/signup` | Medium | ✅ **Closed** | Gating removed entirely — the page cannot register in *any* mode |
| **F-7** Deletion unlogged / destroys evidence | Medium | ✅ **Closed** | Subject snapshot captured **before** deletion into `audit_log`, which has no FK to `auth.users` |
| **F-9** 9 failing tests | Medium | ✅ **Closed** | Repaired; suite is 96/96 green |
| **F-8** Shared admin credential, no MFA | Medium | ⏭ **Deferred** | MFA is an explicit exclusion of this phase |

**Verification:** typecheck clean · **96/96 tests passing** (was 57 pass / 9 fail) · production build clean · no new lint warnings · no secrets in client bundles.

---

## 2. Privilege-escalation verification (SEC-2 §5)

The brief required confirming or rejecting the SEC-1 finding **before** changing anything.

### Verdict: **CONFIRMED — the vulnerability was real and exploitable.**

**Authoritative policy.** `supabase/migrations/` is the deployed set; the root-level `fix_all.sql` / `fix_rls.sql` / `cx_saas_schema.sql` files are not applied. The last definition of the policy in that set is [`001_phase_a_rls_fix.sql:61`](../../supabase/migrations/001_phase_a_rls_fix.sql):

```sql
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (auth.uid() = id OR is_platform_admin());
```

No later migration (002–026) modifies it — verified by exhaustive grep.

**Why `platform_role` was writable.** The SEC-1 report said "no `WITH CHECK`". The precise mechanism is worth stating exactly, because it changes what the fix must do:

> PostgreSQL reuses the `USING` expression as `WITH CHECK` when `WITH CHECK` is omitted. So a check *was* applied to the post-update row — but that expression only constrains **row ownership**, never **column values**.

Tracing an exploit attempt:

| Step | Evaluation | Result |
|---|---|---|
| `UPDATE profiles SET platform_role='super_admin' WHERE id = auth.uid()` | | |
| `USING` — may this row be updated? | `auth.uid() = id` → true | ✅ allowed |
| Implicit `WITH CHECK` — is the new row acceptable? | new row still has `id = auth.uid()` → true | ✅ **allowed** |
| `CHECK (platform_role IN ('user','super_admin','consultant'))` | `'super_admin'` is listed | ✅ allowed |

**Every gate passes.** Any authenticated learner could self-promote through PostgREST using the public anon key plus their own session JWT, gaining `is_platform_admin() = true` and, with it, read access to every profile, enrollment and payment via the admin arms of every RLS policy.

**Confirmation method and its limits.** This is a static confirmation — exact policy text plus documented PostgreSQL semantics. It was **not** verified by executing the exploit against production, deliberately: doing so would have required creating a real account on the live system during an active incident investigation. A safe, transaction-wrapped empirical proof is embedded in migration 027 for the operator to run post-apply:

```sql
BEGIN;
  UPDATE profiles SET platform_role = 'super_admin' WHERE id = auth.uid();
  -- BEFORE 027: succeeds (1 row)        ← the vulnerability
  -- AFTER  027: ERROR 42501             ← the fix
ROLLBACK;
```

---

## 3. Implementation

### 3.1 Migration 027 — `supabase/migrations/027_identity_hardening.sql`

Additive and strictly narrowing. **No permission is broadened anywhere.**

**(a) `current_platform_role()` — SECURITY DEFINER helper.** A plain subquery against `profiles` inside a `profiles` policy would recurse. This mirrors the existing `is_platform_admin()` convention (SECURITY DEFINER bypasses RLS), so the policy can read the caller's *current* role safely.

**(b) Tightened UPDATE policy.** `USING` is byte-identical to before — the same rows remain updatable, so nothing is broadened. `WITH CHECK` is new and strictly narrowing:

```sql
with check (
  public.is_platform_admin()
  or (auth.uid() = id
      and platform_role is not distinct from public.current_platform_role())
)
```

A non-admin may still edit their own profile (name, avatar) but **cannot change `platform_role`**. `is not distinct from` is used rather than `=` so a `NULL` cannot slip through the comparison.

**(c) `BEFORE UPDATE` trigger backstop.** RLS policies are **OR-ed** — a single careless permissive policy added later would silently re-open the hole. The trigger enforces the same rule *below* RLS, so the guarantee survives policy drift. Trusted contexts pass through: `service_role` (the admin server actions legitimately set roles), `postgres`/`supabase_admin` (migrations, SQL editor), and existing platform admins. Everything else raises `42501`.

> **Two layers, deliberately.** The brief asked for "the smallest correct fix" and named `WITH CHECK`, column protection, or a trigger as acceptable. The policy fix alone closes the confirmed exploit; the trigger costs ~15 lines and makes the guarantee robust against future policy changes. Given this is the finding that could expose all learner PII, defence in depth was judged worth it.

**(d) `audit_log` table.** Append-only. **Deliberately has no foreign key to `auth.users`** — an audit record must outlive the user it describes. That is precisely the evidence destroyed in the SEC-1 incident (F-7). RLS: platform admins may `SELECT`; there are **no** INSERT/UPDATE/DELETE policies, so `anon` and `authenticated` cannot write at all — writes happen only through the service-role client in validated server actions. `UPDATE`/`DELETE` are additionally revoked from the application roles.

### 3.2 Public registration removed (SEC-2 §1, §3)

**`app/(auth)/signup/page.tsx` rewritten.** The `SignupForm` component — and its `supabase.auth.signUp()` call, password field, and `platform_role` metadata — is deleted. The route now renders only an access-request form (name + email → notifies the administrator). Mode-based branching is gone: the page cannot register an account in `pilot`, `public`, **or** `private` mode.

**This is not UI hiding.** The brief was explicit that the backend must reject unauthorized registration. Three independent layers now do:

1. **No client path exists** — a regression test asserts no source file calls `auth.signUp`, `signInAnonymously`, or `inviteUserByEmail`.
2. **Supabase rejects it** — `disable_signup: true` closes `POST /auth/v1/signup`, which is the *only* control that can close the direct-API path (R-3), since the anon key is public by design.
3. **The server refuses to run misconfigured** — §3.3.

**Registration inventory after remediation — exactly one path remains:**

| Path | Status |
|---|---|
| R-1 client `signUp()` on `/signup` | ❌ **Removed** |
| R-2 `admin.createUser()` (admin panel) | ✅ **Retained** — the sole provisioning flow: authorized, role-validated, rate-limited, audited |
| R-3 direct `POST /auth/v1/signup` | ❌ **Closed by `disable_signup: true`** (dashboard) + startup validation |

**Preserved and verified by tests:** login (`signInWithPassword`) and password reset (`resetPasswordForEmail`) are untouched.

### 3.3 Startup configuration validation (SEC-2 §2)

`lib/security/auth-config.ts` + `instrumentation.ts` (enabled via `experimental.instrumentationHook` in `next.config.mjs`).

On server start the app probes the public `/auth/v1/settings` endpoint and classifies the result into three states — never silently continuing:

| State | Condition | Behaviour |
|---|---|---|
| `secure` | `disable_signup: true` | Log at info, boot normally |
| `insecure` | `disable_signup: false` | Log at **error**, and **throw in production** — the server does not start |
| `unknown` | Network failure, non-200, malformed payload | Log at **error**, boot continues |

> **Why `unknown` does not hard-fail.** A transient network blip between Vercel and Supabase during a cold start must not take the whole platform down; a *confirmed* open-registration configuration must never run. The distinction is enforced in code and covered by tests. `unknown` is still an error-level event — it is never treated as "probably fine".

> **Why the throw is production-only.** Local development, `vitest`, and CI builds must not depend on the live dashboard state. Non-production runs still log the finding loudly.

### 3.4 Audit logging (SEC-2 §6)

`lib/audit/log.ts` → `logAuditEvent()`, writing via the service-role client. It **never throws**: a failure to audit must not break the user-facing action, but it is always logged at error level so the gap is visible.

Recorded fields cover the brief exactly: **actor** (`actor_type`, `actor_id`, `actor_email`), **target** (`subject_user_id`, `subject_email`), **method**, **invitation** (`invitation_id`, reserved for the future module), **timestamp** (`created_at`), **outcome** (`success` / `failure` + `reason`).

| Event | Where | Notes |
|---|---|---|
| `user.created` | `admin/users/new/actions.ts` | Success **and** every failure branch (invalid role, rate limited, Supabase error) |
| `user.role_changed` | same | Emitted separately when a privileged role is granted at creation, so role grants are queryable on their own |
| `user.deleted` | `admin/users/[id]/actions.ts` | Subject snapshot (email, name, role, created_at) captured **before** deletion |

**Secrets are never logged.** Passwords, tokens and keys are never passed to the helper; a regression test asserts the helper contains no password/token field.

### 3.5 Rate limiting (SEC-2 §7)

Reuses the existing `rateLimitDb` (Supabase-backed, serverless-safe) — no second rate limiter was introduced.

| Surface | Limit | Status |
|---|---|---|
| Admin provisioning | 20 per admin / hour | ✅ **Added** |
| Admin login | 5 per IP **and** per username / 15 min | ✅ Pre-existing |
| Learner login | — | ⚠️ **External** — see below |
| Password reset | — | ⚠️ **External** — see below |
| Invitation acceptance | n/a | No invitation module in this phase |

> **Honest limitation.** Learner login and password reset are **client-side** calls straight to Supabase Auth (`signInWithPassword`, `resetPasswordForEmail`) — the same architecture that made public signup invisible to the application. There is no server hop to rate-limit. Two options were considered:
>
> - **Add a server-side pre-check** — rejected. It would be trivially bypassable (the client can skip it and call Supabase directly), which is exactly the "workaround / temporary bypass" the binding principles forbid.
> - **Move authentication server-side** — rejected *for this phase*. It is the correct long-term architecture, but it rewrites the login flow that was only just stabilised, against the binding principle "avoid breaking pilot users". It is recorded as the top item for a later phase.
>
> In the meantime these surfaces are protected by **Supabase's own per-project Auth rate limits**, configured in the dashboard. This is listed in the production checklist as an operational task with exact settings, not silently ignored.

### 3.6 Test repairs (SEC-2 §8) — scope strictly limited to the 9 known failures

| File | Failures | Repair |
|---|---|---|
| `__tests__/api/admin-login.test.ts` | 7 | The mock of `@/lib/rate-limit` omitted `rateLimitDb`, so the route import failed and the whole file died. Added the missing export to the mock. **No production code changed** — the rate limiting was always correct; only the test's mock was stale. |
| `__tests__/middleware.test.ts` | 2 | Tests asserted `/dashboard` and `/learn/*` redirect when unauthenticated. `AUTH_REQUIRED` is **mode-dependent**: `['/app']` in `pilot`, the full list in `public`/`private`. The suite ran in `pilot` (the default), so those routes are not edge-gated — by design, since pilot opens content to anonymous visitors and `/dashboard` self-protects at page level. **Repair: pin the suite to `public` mode**, so the assertions verify the strictest matrix and keep their security value, with a comment documenting the mode dependency so the drift cannot recur silently. |

Nothing else was touched.

### 3.7 Security regression tests (SEC-2 §9)

New: `__tests__/security/registration.test.ts` — **30 tests**, all passing.

| Requirement from the brief | Test coverage |
|---|---|
| Anonymous signup blocked | No source file calls `auth.signUp` / `signInAnonymously` / `inviteUserByEmail`; signup page has no password field; page declares invitation-only |
| Invite-only enforced | Exactly **one** `admin.createUser` call site exists, and it is the admin action |
| Authenticated cannot self-promote | Policy has explicit `WITH CHECK`; `WITH CHECK` pins `platform_role`; trigger exists, is `BEFORE UPDATE`, raises `42501`; helper is `SECURITY DEFINER` |
| RLS blocks unauthorized updates | `USING` clause asserted unchanged (not broadened, never `true`) |
| Admin provisioning still works | Trigger permits `service_role`/`postgres`/`supabase_admin` and platform admins; role allow-list validated |
| Login unaffected | `signInWithPassword` still present |
| Password reset unaffected | `resetPasswordForEmail` still present |
| Audit | Required columns present; **no FK to `auth.users`**; admin-read-only, no write policies; create audited on success *and* failure; delete snapshots before destroying; helper logs no secrets |
| Rate limiting | Provisioning uses `rateLimitDb`; admin login limited per IP and per username |
| Config validation | secure / insecure / unknown classification; **throws in production when signup is enabled**; does **not** throw on an unreachable endpoint; wired into `instrumentation.ts` + `next.config.mjs` |

> **Why several tests are source-level assertions.** The vulnerability was a *client-side* call directly to Supabase — there is no server function to unit-test. The only durable guarantee is that the call does not exist in the codebase, so the test asserts exactly that. This is a real regression guard: it already caught a doc-comment in the rewritten signup page that contained the forbidden call pattern.

**Not covered by automated tests:** live execution of the SQL exploit against a real session. That requires the migration applied plus a real authenticated user, and is an operator step — the transaction-wrapped proof is in the migration and in §5 below.

---

## 4. Repository changes vs. dashboard configuration

**A clean separation, because one of these cannot be enforced from code.**

| Control | Enforced in repository | Requires Supabase Dashboard |
|---|---|---|
| No registration UI / no client signup call | ✅ | — |
| Only admin provisioning exists | ✅ | — |
| `platform_role` self-escalation blocked | ✅ (migration 027) | Apply the migration |
| Audit logging | ✅ (migration 027 + actions) | Apply the migration |
| Provisioning rate limit | ✅ | — |
| Admin login rate limit | ✅ | — |
| **`POST /auth/v1/signup` closed** | ❌ **Cannot be** | ✅ **`disable_signup = true`** |
| Learner login / password-reset rate limits | ❌ (client-side calls) | ✅ Auth rate limits |
| CAPTCHA, leaked-password protection | ❌ (excluded from this phase) | ✅ |

**Why `disable_signup` cannot be enforced from the repository:** the Supabase Auth REST endpoint accepts the public `anon` key, which is embedded in every page by design. No amount of application code can prevent a direct call to it. The repository's contribution is to **detect** the insecure state and refuse to run in production (§3.3).

---

## 5. Production checklist

Ordered. **Step 1 must precede deployment** — the app will refuse to boot in production while signup is open.

### Before deploying

- [ ] **1. Disable public signup.** Supabase Dashboard → **Authentication → Sign In / Providers → Email** → turn **off** "Allow new users to sign up". Verify:
      `curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup` → must print `true`.
- [ ] **2. Apply migration 027.** SQL Editor → run `supabase/migrations/027_identity_hardening.sql`.
- [ ] **3. Verify the escalation is closed** (as an ordinary learner session):
      ```sql
      BEGIN;
        UPDATE profiles SET platform_role='super_admin' WHERE id = auth.uid();
        -- expected: ERROR 42501 platform_role may only be changed by a platform administrator
      ROLLBACK;
      ```
- [ ] **4. Verify self-service updates still work:**
      `UPDATE profiles SET full_name='Test' WHERE id = auth.uid();` → must succeed.

### Incident follow-up (still outstanding from SEC-1)

- [ ] **5. Export Supabase Auth logs** for the incident window — Logs → Auth. **Time-critical:** retention is ~1–7 days and this is the only surviving evidence about the two deleted accounts.
- [ ] **6. Role census:** `SELECT id, email, platform_role, created_at FROM profiles WHERE platform_role <> 'user';` → confirm only expected admins exist. *This is the check that closes the open SEC-1 question of whether either deleted account self-promoted.*
- [ ] **7. Account census:** `SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC;` → identify any further unrecognized accounts.

### After deploying

- [ ] **8. Confirm the app booted** — logs should contain `Auth configuration verified: public signup is disabled`. If the app failed to start with a `SECURITY:` error, step 1 was not completed.
- [ ] **9. Smoke-test the preserved flows:** learner login, password reset, admin login, admin user creation, admin user deletion.
- [ ] **10. Confirm auditing is live:** after creating a test user, `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 5;` → expect a `user.created` row.
- [ ] **11. Configure Auth rate limits** (compensating control for client-side login / password reset) — Dashboard → Authentication → Rate Limits.
- [ ] **12. Rotate credentials if warranted** — if step 6 reveals an unexpected `super_admin`, treat as a live compromise: rotate `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL` password, and review `audit_log`.

---

## 6. Rollback considerations

| Change | Rollback | Risk of rolling back |
|---|---|---|
| Migration 027 | Rollback block at the foot of the file | ⛔ **Re-opens the Critical F-2 escalation.** Only if the fix demonstrably breaks a legitimate flow. |
| Signup page | `git revert` | ⛔ Re-opens public registration (F-1) if `disable_signup` is also off. |
| Startup validation | Remove `instrumentationHook` from `next.config.mjs` | Server boots without verifying config — silent insecurity returns. |
| Audit logging | `git revert` | Loses the trail; no functional impact (the helper never throws). |
| Provisioning rate limit | `git revert` | Low. |
| Test repairs | `git revert` | Reverts to a red suite. |

**Safe partial rollback.** The audit logging and rate limiting are independent of the escalation fix and the signup removal — either can be reverted without weakening the other two. **Do not** roll back migration 027 and the signup page together: that returns the platform to the exact pre-incident posture.

**Failure mode to expect if migration 027 is applied *without* the app deploy:** none — the migration is backward-compatible with the current code (admin provisioning runs as `service_role`, which the trigger permits).

**Failure mode if the app is deployed without step 1:** the production server throws at startup and does not serve traffic. This is intentional fail-closed behaviour, and is why step 1 is first.

---

## 7. Remaining work (explicitly out of scope here)

Excluded by the brief, carried forward:

| Item | From | Phase |
|---|---|---|
| MFA / per-admin identities (F-8) | SEC-1 L-2 | SEC-3 |
| Full invitation module (tokens, expiry, replay protection) | SEC-1 L-1 | SEC-3 |
| Server-side login + password reset (enables real rate limiting) | §3.5 | SEC-3 — **highest-value remaining item** |
| CAPTCHA / leaked-password protection | SEC-1 I-6 | Dashboard, any time |
| Soft-delete / archival instead of hard delete | SEC-1 S-4 | SEC-3 |
| Admin audit UI + alerting on privileged events | SEC-1 L-3 | SEC-3 |
| Full RLS matrix test suite in CI | SEC-1 L-4 | SEC-3 |
| Waitlist persistence + rate limiting | SEC-1 S-5 | SEC-3 |

---

## 8. Verification results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ **Pass** — no errors |
| `npx vitest run` | ✅ **96 passed / 0 failed** (7 files) — up from 57 passed / 9 failed |
| `npm run build` | ✅ **Compiled successfully** |
| New lint warnings | ✅ **None** in any SEC-2 file |
| Client-bundle secret scan | ✅ No service-role key, audit internals, or signup call present |

**Test delta:** +39 tests (30 new security regression tests, 9 repaired).

---

**End of SEC-2 report.**
