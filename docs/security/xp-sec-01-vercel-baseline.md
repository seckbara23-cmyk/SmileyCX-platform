# XP-SEC-01 — Vercel security baseline & UAT isolation plan

**Project:** `smiley-cx-platform` (`prj_tb4Nsr3fNiBNsN1lzT2TkWRWkPCw`)
**Team:** `seckbara23-6470s-projects` (`team_Wp0z3ITrNPAmPWmCVhyFpIxF`)
**Measured:** 2026-10-27 · **Baseline SHA:** `e90746b9572d09e40d9fe444e0e2151b89395f03`

> **Nothing in this document has been applied.** Every item is either a measurement or a proposal awaiting owner authorization.

---

## 1. Measured configuration (Phase 3)

Read from the Vercel API and CLI. Plan entitlements were **not** used to infer any value.

| Control | State | Evidence |
|---|---|---|
| Firewall custom rules | **DISABLED** | `firewall overview` → *"Firewall: Not configured"*; API returns 404 *Seawall Config not found* |
| Rate-limiting rules | **DISABLED** | implied by the above — rate limits are firewall rules, and no config exists |
| Attack Mode (global challenge) | **DISABLED** | `firewall overview` → *"Attack Mode: Off"* — correct; it challenges *all* requests |
| System Mitigations (automatic DDoS) | **ENABLED** | `firewall overview` → *"System Mitigations: Active"* |
| System Bypass IPs | **0 configured** | `firewall overview` |
| Deployment Protection — password | **DISABLED** | `passwordProtection.enabled = false` |
| Deployment Protection — Vercel Auth (SSO) | **ENABLED** | `ssoProtection = { enabled: true, deploymentType: "all_except_custom_domains" }` |
| Deployment Protection — trusted IPs | **DISABLED** | `trustedIps.enabled = false` |
| Preview authentication | **ENABLED** (consequence of SSO above) | every `*.vercel.app` preview 302s to `/sso-api` |
| Production public access | **ENABLED** | custom domains exempt from SSO; `/`, `/courses`, `/login`, `/signup` all 200 |
| Log drains / monitoring | **none configured** | `GET /v1/drains` → 404 |
| Spending limits & alerts | **UNVERIFIED** | not exposed by the API responses available here |
| Team permissions & tokens | **UNVERIFIED** | `get_team` returns only name/slug/id |
| Plan tier | **UNVERIFIED** | not present in the API response; not inferred |

**Environment variables** (names and scopes only; no values read):

* Shared **Preview + Production**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_OWNER_EMAILS`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `NEXT_PUBLIC_PLATFORM_MODE`, three AI feature flags.
* **Production only**: `EMAIL_FROM`, `RESEND_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `NEXT_PUBLIC_PILOT_MODE`, `NEXT_PUBLIC_FREE_ACCESS_MODE`.
* **No `PAYTECH_*` variable exists in any environment**, so PayTech is inert everywhere.

---

## 2. The blocker that governs sandbox UAT

Two independent problems, both must be solved before a PayTech sandbox notification can ever arrive.

### 2.1 Preview and Production share one database

All three Supabase variables are scoped `Production, Preview` with the same values — project `eqoqcxkdcxeosjqaafhs`. **Anything a Preview deployment writes lands in the production database.**

### 2.2 Vercel Authentication blocks the callback

`ssoProtection.deploymentType = "all_except_custom_domains"`. A PayTech IPN is an unauthenticated server-to-server POST; sent to a `*.vercel.app` preview it is intercepted by Vercel's auth layer and redirected to `/sso-api` **before reaching the application.** The XP-PAYTECH-03 callback fix makes the request *name* the right origin; it cannot make Vercel accept it.

**Two supported routes. Neither is applied.**

**Option A — preview custom domain (recommended).** Assign e.g. `uat.xpclient-academy.com` to the UAT branch. Because protection is `all_except_custom_domains`, a custom domain is **exempt from SSO**, so the IPN reaches the app. It also supplies the one thing PayTech structurally needs: a **stable origin**, since the merchant dashboard holds fixed URLs while per-deployment preview URLs change on every push. Set `PAYTECH_CALLBACK_BASE_URL` to it.

*Trade-off:* that host becomes publicly reachable. Acceptable because the UAT database holds synthetic data only, and the application's own gates still apply — `isAdminHost()` treats any non-`*.vercel.app` host as the commercial app, so `PLATFORM_MODE` governs it. Add `noindex` for that host.

**Option B — Protection Bypass for Automation.** Generate the bypass secret and include it in the registered IPN URL. Narrower: only that endpoint becomes reachable, and preview browsing stays fully authenticated. *Trade-off:* a secret lives inside a URL stored at the provider, and must be rotated when UAT ends. **Verify first** that Vercel honours the bypass as a *query parameter* on a *POST* — if it is header-only, PayTech cannot use it and Option A is the only route.

---

## 3. Ready-to-execute UAT provisioning plan (Phase 2)

Blocked on two things: **owner approval for a billable resource**, and Supabase access (the Supabase MCP server failed to connect this session, so no project could be inspected or created).

**Cost:** a second Supabase project on the Free tier is **$0**; on a paid org it is typically **~$25/month**. The exact figure depends on the organization's plan and must be confirmed in the Supabase dashboard before creating anything. **No billable resource was created.**

1. **Inspect** existing Supabase organizations for an existing `xp-client-academy-uat`; reuse only if genuinely separate from `eqoqcxkdcxeosjqaafhs`.
2. **Create** `xp-client-academy-uat`, region matching production (`eu-west` family for Senegal latency — confirm production's region first).
3. **Apply the full migration history in order**, `001` → `062`, using each file's own operator procedure. Do not skip; several carry preflight assertions that depend on predecessors.
4. **Verify** (read-only):
   ```sql
   select to_regprocedure('public.complete_payment(text,text,text,text,text,numeric,text)') is not null as fn_exists;
   select to_regclass('public.payments_provider_token_unique') is not null as replay_key;
   select relrowsecurity from pg_class where oid = 'public.payments'::regclass;
   select polname, polcmd from pg_policy where polrelid = 'public.payments'::regclass order by polname;
   select count(*) from information_schema.columns where table_name='payments';  -- expect 19
   ```
   Expect the policy set `payments_insert_service/a`, `payments_no_browser_delete/d`, `payments_no_browser_update/w`, `payments_own/r`.
5. **Seed synthetic data only** — invented learners, one test course with a non-zero XOF price. **Never** copy production users, learner progress, payments, certificates or service-role secrets. Storage buckets start empty, so course media will be absent; that is expected and does not block a payment test.
6. **Auth settings** in UAT: mirror production's `disable_signup` posture, then create test users directly.
7. **Do not call `complete_payment()`** during setup.

### Vercel Preview reconfiguration (Phase 2C) — needs approval

Add **Preview-scoped** overrides for the three Supabase variables pointing at UAT. **Do not edit the Production values.**

> **Three variables are not sufficient.** Preview also shares `ADMIN_OWNER_EMAILS` (same admin allowlist), and `ANTHROPIC_API_KEY` + `ELEVENLABS_API_KEY` — so a Preview deployment can spend real money against those third-party accounts. Decide deliberately whether to give UAT its own keys or accept the spend. Preview has **no** mailer (`RESEND_API_KEY` is Production-only), so UAT sends no email.

Order of operations matters: **add the UAT Preview overrides first, redeploy, prove isolation, and only then remove Preview from the production database credentials.** Reversing that order leaves Preview with no database.

### Proving isolation (Phase 2D)

* Preview resolves to the UAT project — read `NEXT_PUBLIC_SUPABASE_URL` from the Preview build's client bundle (public by design) and assert it is **not** `eqoqcxkdcxeosjqaafhs`.
* Production still resolves to `eqoqcxkdcxeosjqaafhs` — same check against production.
* No Preview service-role credential references production — confirm the Preview-scoped `SUPABASE_SERVICE_ROLE_KEY` was replaced, by scope listing, without printing values.
* UAT migrations and policies present — the SQL in step 4.
* Then a synthetic, **non-payment** learner journey in UAT only.

---

## 4. Proposed security baseline (Phase 4) — observation first

All rules start in **LOG/observe** mode. Nothing is enforced until logs show zero false positives.

| # | Surface | Rule | Mode | Notes |
|---|---|---|---|---|
| 1 | `/login`, `/signup`, `/forgot-password`, `/reset-password` | rate limit per IP | **LOG** | ⚠ See the Supabase caveat below |
| 2 | `/admin*` | monitor, alert on anomalies | **LOG only** | RBAC + RLS stay the authority; never the firewall |
| 3 | `/contact`, waitlist | bot protection where supported | **LOG** | Verify server-side token checks; CAPTCHA is a known open item |
| 4 | `/checkout`, `/api/payments/*` initiation | rate limit per authenticated user | **LOG** | App already has DB-backed limits in `lib/rate-limit.ts` |
| 5 | **`/api/payments/paytech/ipn`** | **explicit EXCLUSION from every challenge, bot check and rate limit** | **enforce exclusion** | A server-to-server POST cannot solve a browser challenge |
| 6 | Production site | no geo blocking, no global challenge | — | Keep the learning site publicly accessible |

**⚠ The authentication caveat that makes rule 1 largely decorative.** Supabase Auth is called **directly from the browser to `*.supabase.co`** — it never transits Vercel. A Vercel rate limit therefore protects only our own server actions (`registerLearner`, password reset actions), **not** Supabase's `/auth/v1/token` or `/auth/v1/signup`. Credential-stuffing protection must be configured in **Supabase's own Auth rate limits**. Do not report rule 1 as login protection.

**Never:** Attack Mode (challenges everything, including the IPN), broad geographic blocking, or enforcing any rule before its logs are clean.

### Rollback

| Change | Rollback |
|---|---|
| Firewall rule added | `vercel firewall rules` → remove, then `vercel firewall publish`; or `vercel firewall discard` for unpublished drafts |
| Attack Mode toggled | `vercel firewall attack-mode` → off (immediate) |
| Deployment Protection changed | restore `ssoProtection.deploymentType = "all_except_custom_domains"`, `passwordProtection.enabled = false`, `trustedIps.enabled = false` |
| Protection bypass secret created | delete the secret in project settings; rotate the registered IPN URL |
| Preview env overrides added | remove the Preview-scoped variables; the shared Production+Preview values resume |
| Preview custom domain assigned | unassign the domain; the branch reverts to `*.vercel.app` and SSO applies again |

Capture `vercel firewall overview` and the project's protection block **before** any change — the values in §1 are that baseline.
