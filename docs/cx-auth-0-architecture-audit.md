# CX-AUTH-0 — Private Admin Portal Architecture Audit

**Role:** Principal Software Architect
**Scope:** Documentation-only audit. No code modified, no schema changed, no users created.
**Date:** 2026-07-27
**Goal:** Separate the public academy website (`www.xpclient-academy.com`) from a private administration portal (`smiley-cx-platform.vercel.app`) without making the public site require authentication.

> **Headline:** The repository is **completely host-blind** — there is not a single read of `host`, `x-forwarded-host`, `VERCEL_URL`, or `VERCEL_ENV` anywhere in the codebase. Both hostnames serve byte-identical content from one production deployment. Separating them is therefore **net-new capability**, not a refactor. Along the way this audit found **three pre-existing security defects**, one of which is Critical and exploitable today.

---

## 1. Repository Architecture Discovered

| Property | Value | Evidence |
|---|---|---|
| Framework | Next.js **14.2.35** | `package.json` |
| Router | **App Router** exclusively (no `pages/`) | `app/` tree; no `pages/` directory |
| Language | TypeScript 5, strict | `tsconfig.json` |
| Database / Identity | **Supabase** (Postgres + Auth + Storage) | `lib/supabase/{client,server,admin}.ts` |
| SSR auth adapter | `@supabase/ssr` **0.3.0** | verified `node -p "require('./node_modules/@supabase/ssr/package.json').version"` |
| Deployment | Vercel, Node 24.x, single project `smiley-cx-platform` | Vercel project inspection |
| Middleware | Single root `middleware.ts`, 181 lines | `middleware.ts` |
| Env validation | **None at boot** — only `!` non-null assertions | `middleware.ts:82-83`, `app/auth/callback/route.ts:29-30` |
| Deploy-time config gate | `prebuild` → `verify-prod-config.mjs` | `package.json`; verified passing |
| Logging | Pino, structured, redacting | `lib/logger.ts` |
| Tests | 129 passing, 9 files; ~11% line coverage | verified below |

**Route groups:** `(public)`, `(auth)`, `(platform)`, `(learn)`, `(admin)`, `(admin-auth)`, plus an ungrouped `app/app/[orgSlug]` B2B surface.

**Counts:** 55 pages, 5 API routes, 20+ server-action files, 27 SQL migrations, 30 components.

---

## 2. Route Inventory

### 2.1 Public surface — must remain open on `www.xpclient-academy.com`

| Route | Purpose |
|---|---|
| `/` | Marketing homepage |
| `/courses` | Course catalogue |
| `/courses/[slug]` | Course detail |
| `/about`, `/about/founder` | About |
| `/contact` | Contact |
| `/privacy`, `/terms` | Legal |
| `/verify-certificate/[certificateId]` | Public certificate verification |
| `/access-restricted` | Private-mode landing |
| `/api/health` | Health probe (coarse status only when anonymous) |

### 2.2 Auth surface

| Route | Notes |
|---|---|
| `/login` | Learner login (Supabase session) |
| `/signup` | **Access-request form only** — registration removed by SEC-2 |
| `/forgot-password`, `/reset-password` | Recovery UI |
| `/auth/callback` | Code exchange — **defective, see F-2** |
| `/admin/login` | **Separate** admin login UI |

### 2.3 Private surface

| Route | Purpose | Current protection | Intended audience |
|---|---|---|---|
| `/admin` + 24 sub-pages | Courses, modules, lessons, quizzes, exercises, users, enrollments, payments, certificates, feedback, progress | Middleware cookie-**presence** check (`middleware.ts:166-171`) **+** server-side `super_admin` re-verify (`app/(admin)/layout.tsx:30-40`) | Platform admin |
| `/dashboard` | Learner dashboard | `AUTH_REQUIRED` — **only in non-pilot modes** (`middleware.ts:8-10`) | Learner |
| `/learn/**` | Lesson player, quizzes, final exam | Same as above | Learner |
| `/checkout`, `/certificate/**` | Payment / certificate | Same as above | Learner |
| `/certificates/[certificateId]` | Certificate view | Page-level | Learner |
| `/app/[orgSlug]/**` | **Second product** (B2B CX ops) | `/app` in `AUTH_REQUIRED` (all modes) | Org member |
| `/api/admin/login` | Admin auth | Rate-limited, generic errors | Public (by design) |
| `/api/admin/signout` | Logout | None needed | Admin |
| `/api/admin/upload-url` | Signed Storage upload URL | **Cookie presence ONLY — no role check** | Admin |
| `/api/certificates/[id]/pdf` | Certificate PDF | Session + ownership check (`route.ts:18-30`) | Owner |

> **Critical:** `AUTH_REQUIRED` is mode-dependent. In the current `pilot` default it is `['/app']` **only** (`middleware.ts:8-10`) — so `/dashboard`, `/learn`, `/checkout`, `/certificate` are **not** middleware-protected today. That is intentional for the pilot, but it means the middleware currently protects far less than it appears to.

---

## 3. Authentication Architecture

### 3.1 What exists — two parallel, unrelated systems

**System A — Learner (Supabase Auth).** Email+password via `signInWithPassword` (`app/(auth)/login/LoginForm.tsx:45`); session in Supabase cookies; refreshed in middleware via `getUser()` (`middleware.ts:104`); server reads via `lib/supabase/server.ts`. Correct `get/set/remove` cookie API for v0.3.0.

**System B — Admin (custom cookie).** `/api/admin/login` validates a single username from `ADMIN_USERNAME` env, authenticates that one mapped `ADMIN_EMAIL` against Supabase, then sets a **custom `scx_admin` cookie**. It **discards the Supabase session** (`persistSession: false`, `route.ts:60`).

| Capability | Status |
|---|---|
| Password login (learner) | ✅ Functional |
| Password login (admin) | ✅ Functional, rate-limited by IP **and** username (`route.ts:17,42`), generic errors (`:52-54`) |
| Password reset — send email | ✅ Functional (`forgot-password/page.tsx:28`) |
| Password reset — **complete** | ❌ **BROKEN** (F-2) |
| Email verification | ❌ Same defect (same callback) |
| Magic links / OAuth / MFA | ❌ Not implemented |
| Session refresh | ✅ Learner only; admin cookie has no refresh |
| Session revocation | ❌ None for admin |
| Account disable | ❌ Not implemented |
| Audit of admin actions | ⚠️ Partial — `audit_log` covers user provisioning/deletion only |

### 3.2 Is the current auth suitable for an admin portal?

**Partially — System B must be replaced, not extended.** Findings F-1/F-2/F-3 below explain why. There is **no need for a second auth provider**: Supabase Auth is present, functional, and should become the single source of truth for admin identity too. The custom `scx_admin` cookie is the problem, not Supabase.

---

## 4. Role & Permission Inventory

**Actual DB-backed vocabulary:**

| Type | Values | Source |
|---|---|---|
| `PlatformRole` | `user` \| `super_admin` \| `consultant` | `types/cx.ts:6` |
| `OrgRole` | `org_admin` \| `cx_manager` \| `team_manager` \| `analyst` \| `viewer` | `types/cx.ts:9` |
| `UserRole` | `learner` \| `company_admin` | `types/index.ts:5` — **legacy, UI labels only, NOT stored** (comment at `:3-4`) |

Org role ranking + helpers exist (`ORG_ROLE_RANKS`, `hasOrgPermission`, `canManageOrg`, `canManageCX`, `canEdit`, `canAnalyze` — `types/cx.ts:254-280`). **No equivalent helper exists for `PlatformRole`** — platform authorization is a hardcoded string comparison to `'super_admin'` in three places.

**Mapping to the roles named in the brief:**

| Brief role | Exists? | Reality |
|---|---|---|
| `SUPER_ADMIN` | ✅ | `super_admin` — the only role that grants admin access |
| `ADMIN` | ❌ | No platform-level `admin` tier. `consultant` exists in the type + RLS (`001:35`) but **is never checked in application code** |
| `INSTRUCTOR` | ❌ | Does not exist in any form |
| `COMPANY_ADMIN` | ⚠️ | Only as a legacy UI label; the org-level analogue is `org_admin` |
| `LEARNER` | ⚠️ | Legacy label; DB stores `user` |

**Conclusion:** the platform is effectively **binary** — `super_admin` or not. Any multi-tier admin model (instructor, content editor) is net-new and requires a product decision (D-3).

---

## 5. Domain & Hostname Resolution

### 5.1 Live verification (curl, 2026-07-27)

| Host | Result |
|---|---|
| `https://www.xpclient-academy.com/` | **200**, `x-vercel-cache: HIT`, serves marketing homepage |
| `https://xpclient-academy.com/` | **308 → www** (Vercel apex redirect) |
| `https://smiley-cx-platform.vercel.app/` | **200**, serves the **identical** marketing homepage |
| `smiley-cx-platform-git-main-…vercel.app` | **302** (Vercel Deployment Protection) |
| `smiley-cx-platform-seckbara23-…vercel.app` | **302** (Vercel Deployment Protection) |

Both primary hosts returned `<title>XP Client Academy — Formations en expérience client au Sénégal</title>`.

**`smiley-cx-platform.vercel.app` is the production alias, not a preview URL.** Confirmed by Vercel project inspection (listed under project `domains`; `latestDeployment.target = "production"`) and corroborated by it serving production content while branch-scoped URLs are SSO-gated.

### 5.2 Host-awareness in code: **none**

```
grep -rn "x-forwarded-host|headers().get('host')|nextUrl.host|hostname|VERCEL_URL|VERCEL_ENV"
  app lib components middleware.ts instrumentation.ts scripts
→ 0 results
```

The application **cannot currently distinguish** `www.xpclient-academy.com` from `smiley-cx-platform.vercel.app` from a preview URL from `localhost`. Every routing decision is path-based only.

### 5.3 Hardcoded absolute URLs — three different, all wrong

| Location | Fallback | Problem |
|---|---|---|
| `app/layout.tsx:8` | `https://academy.smileycx.com` | `metadataBase` — **not the production domain**; canonical/OG URLs point at a domain that is not `www.xpclient-academy.com` |
| `app/actions/enrollment.ts:109` | `https://smileycx.com` | Email links |
| `app/(admin)/admin/certificates/page.tsx:12`, `certificates/[certificateId]/page.tsx:11`, `users/[id]/page.tsx:71` | `https://smiley-cx-platform.vercel.app` | Certificate verification URLs default to the **admin** hostname |

`NEXT_PUBLIC_SITE_URL` is read in code but **absent from `.env.example`** — if unset in Vercel, certificate links silently use the vercel.app host.

`/auth/callback` uses request `origin` (`route.ts:19`) so it follows whichever host was used — correct behaviour, but it means Supabase's allow-list must include every host.

---

## 6. Security Findings

Severity uses the RELEASE-1 scale. **F-1 is exploitable today.**

### F-1 — CRITICAL: `/api/admin/upload-url` has no authorization check

**Evidence:** `app/api/admin/upload-url/route.ts:25-28` — the only gate is:

```ts
const adminCookie = request.cookies.get('scx_admin')?.value
if (!adminCookie) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
```

The cookie **value is never validated** — no role lookup, no signature check. The route then uses the **service-role** client (`:63`) to mint a signed upload URL (`:72-74`) into the **public** `course-media` bucket (`:66-70`, `public: true`, 500 MB limit).

Middleware does not cover it: `ADMIN_ROUTES = ['/admin']` (`middleware.ts:13`) does not match `/api/admin/*`, and `/api` is explicitly exempt from the private-mode gate (`middleware.ts:26`).

**Impact:** any anonymous caller sending `Cookie: scx_admin=x` obtains signed write access to a public bucket — arbitrary file hosting on your domain (phishing/malware distribution), storage-cost amplification, and content defacement. Rate limit is 30/min *per cookie value*, which an attacker chooses freely.

**Not verified:** I did **not** attempt to upload a file to production. The finding is from code inspection; the authorization gap is unambiguous.

### F-2 — HIGH: password recovery and email verification are broken

**Evidence:** `app/auth/callback/route.ts:32-39` passes `{ getAll, setAll }` to `createServerClient`. But `@supabase/ssr@0.3.0` defines:

```ts
type CookieMethods = { get?, set?, remove? }   // node_modules/@supabase/ssr/dist/index.d.ts:11-15
```

**Runtime-verified:** the v0.3.0 bundle contains **zero** occurrences of `getAll`, and a live probe confirmed the SDK never invokes the supplied `getAll`. The adapter is silently ignored, so `exchangeCodeForSession` cannot persist the session cookie → the user lands on `/reset-password` with no session → `updateUser({password})` fails.

This is the **same class of bug** fixed in `middleware.ts` and `lib/supabase/server.ts` (both correctly use `get/set/remove`); this file was missed.

**Why CI didn't catch it:** verified experimentally — `tsc` does **not** error on the wrong shape, because excess-property checking is weak against the intersection target `SupabaseClientOptions & { cookies: CookieMethods }`. There is also no test covering `/auth/callback`.

**Correction to prior documentation:** `docs/security/operating-mode.md` and the RELEASE-1 audit both record "Password reset: Working". That was based on the code paths existing and the *send* step functioning; the *completion* step is defective. The send step (`resetPasswordForEmail`) does work — the failure is in the callback.

### F-3 — HIGH: the admin session is an unsigned bearer token

**Evidence:** `app/api/admin/login/route.ts:97` sets `scx_admin` to `data.user.id` — the raw UUID. No HMAC, JWT, or session library exists anywhere (`grep` for `createHmac|jwt|jose|iron-session` → 0 hits).

Consequences:
- **Possession = admin.** Anyone who obtains the admin's user UUID can forge the cookie from any HTTP client. `httpOnly` does not help — the attacker sets the header themselves.
- **No revocation.** Logout only clears the cookie in that browser (`api/admin/signout/route.ts`). A leaked value stays valid until the UUID changes, which never happens.
- **No server-side session record**, so no expiry beyond the client-held 8 h `maxAge`, and no way to disable an account's active sessions.

Mitigating: UUIDs are unguessable, and `/admin/*` pages re-verify `super_admin` server-side (`app/(admin)/layout.tsx:30-40`). So this is not remotely brute-forceable — the risk is leakage (logs, screenshots, DB access, referrer) and the total absence of revocation.

### F-4 — MEDIUM: `/login` advertises public registration

`app/(auth)/login/LoginForm.tsx:144-150` renders *"Pas encore de compte ? S'inscrire gratuitement"* linking to `/signup`. Registration is closed (SEC-2/HOTFIX-3); `/signup` is now only an access-request form. Directly contradicts the brief's "no public signup link".

### F-5 — MEDIUM: private-mode allowlist is hardcoded in source

`lib/access-control.ts:17-20` hardcodes two personal Gmail addresses as the private-mode allowlist. Changing access requires a code deploy, and the addresses are in git history.

### F-6 — MEDIUM: public certificate verification can expose learner email

`app/(public)/verify-certificate/[certificateId]/page.tsx:22` selects `profiles(full_name, email)` and falls back to rendering the **email** when `full_name` is empty (`:34`).

### F-7 — LOW: no environment-variable validation at boot

`process.env.X!` non-null assertions throughout (`middleware.ts:82-83`, `auth/callback:29-30`). A missing var surfaces as a runtime crash, not a startup error.

### Requirements assessed and found *adequate*

- **Open redirects:** guarded in all three places — `middleware.ts:155`, `auth/callback:24`, login `next` handling. All reject `//`.
- **Service-role key leakage:** clean. Server-only, no `NEXT_PUBLIC_` prefix; `scan:bundle` passes (92 files, 12 patterns).
- **Client-side-only authorization:** not present — `/admin` re-verifies server-side.
- **Static generation of private pages:** `/login` is explicitly dynamic (documented at `login/page.tsx:3-6`); admin pages are dynamic (`ƒ` in build output).
- **Role escalation:** blocked by migration 027 (RLS `WITH CHECK` + BEFORE UPDATE trigger).
- **Preview deployments:** already SSO-protected (verified 302).

---

## 7. Public vs Private Surface — does the public site leak private data?

**No private data or actions are exposed on the public marketing surface**, with one caveat (F-6, learner email on certificate verification).

The genuine problem is the inverse of a leak: **the private hostname exposes the entire public site**. `smiley-cx-platform.vercel.app` currently serves the full marketing site, course catalogue, and learner login — verified identical to the public domain.

---

## 8. Reuse vs Build

| Concern | Decision | Rationale |
|---|---|---|
| Identity provider | **REUSE** Supabase Auth | Present, functional, RLS-integrated. Brief forbids a second provider. |
| Admin session | **REPLACE** `scx_admin` with a real Supabase session | F-3. Removes the unsigned bearer token and gains refresh + revocation for free. |
| Role model | **REUSE** `platform_role` | `super_admin` already enforced server-side and in RLS. |
| Login UI | **REUSE** `/login` shell, add host-awareness | Already French-first, mobile-friendly, branded, dynamic, open-redirect-safe. |
| Password recovery | **FIX then reuse** | Cannot be offered until F-2 is fixed — the brief conditions it on "a safe recovery flow exists". |
| Host boundary | **BUILD** | Zero host-awareness exists today. |
| Admin dashboard | **REUSE** all 24 existing `/admin` pages | Fully built; the brief's "map before building" applies — do not rebuild. |
| RBAC helpers | **BUILD** small `PlatformRole` helper | Org roles have helpers; platform roles use scattered string comparison. |

---

## 9. Recommended Target Architecture

### Recommendation: **Option A — middleware host enforcement**, with a narrow slice of Option B.

**Rejecting Option C (separate deployment):** no evidence supports it. The admin surface is already isolated in the `(admin)` route group with its own layout and server-side role verification. A second deployment would duplicate env vars, double the deploy-gate surface, and split the audit trail — with no security gain over a correctly implemented host boundary.

**Rejecting pure Option B:** route groups alone cannot express a *host* boundary; they are path-based. Host discrimination must happen in middleware regardless.

### Design

```
Request → middleware.ts
   │
   ├─ classify host:  PUBLIC_HOST | ADMIN_HOST | PREVIEW | LOCALHOST
   │     from x-forwarded-host (Vercel-set), falling back to request host
   │
   ├─ ADMIN_HOST:
   │     allow  /login, /auth/*, /api/health, /_next/*, static assets
   │     allow  /admin/** only with a valid session AND platform_role=super_admin
   │     deny   everything else (public marketing, /courses, /learn) → 404 or /login
   │     never  serve the marketing homepage
   │
   └─ PUBLIC_HOST:
         serve public site unchanged (NO new auth requirement)
         /admin/** → 404 (not a redirect — do not advertise the admin host)
```

**Key design decisions:**

1. **Host allow-list, never deny-list.** `ADMIN_HOSTS` as an env-driven set so `admin.xpclient-academy.com` is added later with zero code change — satisfying the brief's future-hostname requirement.
2. **Trust `x-forwarded-host` only because Vercel sets it.** Vercel overwrites this header at the edge; it is not client-controllable there. This must be re-verified if the platform ever changes.
3. **On the admin host, return 404 (not redirect) for public paths** — avoids confirming the existence of a marketing site behind the admin hostname, and prevents the redirect loop that would follow from redirecting `/` → `/login` → `/`.
4. **Authorization stays server-side.** Middleware is a *boundary*, not the enforcement point. Every `/admin` page keeps its `layout.tsx` role re-verification, and server actions must gain their own guards (CX-AUTH-3). Per the brief: a browser redirect is not protection.
5. **Cache correctness.** Both hosts currently return `x-vercel-cache: HIT` on `/`. Host-varying responses must not be shared. Vercel keys the edge cache by host, but any host-dependent response must additionally be `Cache-Control: private, no-store` and dynamic. **This requires explicit verification in CX-AUTH-1** — it is the most likely source of a subtle cross-host leak.

---

## 10. Implementation Phases

The proposed sequence is **sound and correctly ordered**, with two revisions.

**Revision 1 — insert CX-AUTH-0.5 (hotfix) before CX-AUTH-1.** F-1 is exploitable today and F-2 breaks a flow the admin portal depends on. Neither should wait behind a multi-phase programme.

**Revision 2 — move password recovery earlier.** The brief conditions the login page's forgot-password link on "a safe recovery flow exists". It does not (F-2). Fix in 0.5 so CX-AUTH-2 can include it.

| Phase | Scope | Notes |
|---|---|---|
| **CX-AUTH-0.5** ⚠️ NEW | Fix F-1 (add role check to upload-url), F-2 (correct cookie API), F-4 (remove signup link) | Small, independent, high value |
| **CX-AUTH-1** | Host classification + middleware boundary + preview doctrine | Add `ADMIN_HOSTS` env; deny-by-default on admin host |
| **CX-AUTH-2** | Admin login on Supabase sessions; retire `scx_admin` (F-3); session refresh + logout | Replaces System B |
| **CX-AUTH-3** | Server-side RBAC: `PlatformRole` helper; guard every server action and `/api/*` | Closes the "action invoked without visiting the page" class |
| **CX-AUTH-4** | Admin shell + route migration | Reuse existing 24 pages; no rebuild |
| **CX-AUTH-5** | Password recovery hardening, account disable, admin action audit | Extends `audit_log` beyond provisioning |
| **CX-AUTH-6** | Production/preview hardening; canonical URL cleanup; `metadataBase` fix | Resolves §5.3 |

---

## 11. Files Likely to Change

| File | Change | Phase |
|---|---|---|
| `middleware.ts` | Host classification + boundary | 1 |
| `lib/hosts.ts` *(new)* | Host allow-list + classifier | 1 |
| `app/api/admin/upload-url/route.ts` | **Add role verification** | 0.5 |
| `app/auth/callback/route.ts` | `getAll/setAll` → `get/set/remove` | 0.5 |
| `app/(auth)/login/LoginForm.tsx` | Remove signup link; host-aware copy | 0.5 / 2 |
| `app/api/admin/login/route.ts` | Issue Supabase session, drop `scx_admin` | 2 |
| `app/(admin)/layout.tsx`, `lib/auth/session.ts` | Read Supabase session | 2 |
| `app/api/admin/signout/route.ts` | Real sign-out | 2 |
| `lib/permissions/*` *(new)* | `PlatformRole` helpers | 3 |
| `app/actions/*.ts` | Per-action authorization guards | 3 |
| `app/layout.tsx:8` | Correct `metadataBase` | 6 |
| `app/(admin)/admin/{certificates,users}/**` | Replace vercel.app fallbacks | 6 |
| `.env.example` | Add `ADMIN_HOSTS`, `NEXT_PUBLIC_SITE_URL` | 1 |

---

## 12. Database Changes

**None required for CX-AUTH-1 through CX-AUTH-4.** `profiles.platform_role` already exists, is indexed (`001:300`), RLS-protected, and hardened against self-escalation (027).

Optional, later:
- **CX-AUTH-5:** `admin_sessions` table *if* explicit revocation is wanted beyond Supabase's own session invalidation; a `disabled_at` column on `profiles` for account disabling; extend `audit_log` coverage.
- **Not needed:** no new roles unless the product decides to add tiers (D-3).

---

## 13. Environment Variables Required

| Variable | Status | Purpose |
|---|---|---|
| `ADMIN_HOSTS` | **NEW** | Comma-separated admin hostnames (`smiley-cx-platform.vercel.app`, later `admin.xpclient-academy.com`) |
| `NEXT_PUBLIC_SITE_URL` | **Used in code, missing from `.env.example`** | Canonical public URL |
| `NEXT_PUBLIC_APP_URL` | Exists | Must be corrected to `https://www.xpclient-academy.com` |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` | Exists | Single-admin mapping; superseded in CX-AUTH-2 |

No secrets are added. No Vercel variable is changed during CX-AUTH-0.

---

## 14. Vercel Configuration Required

- **No `vercel.json` exists** — host routing will be code-level (middleware), which is preferable for testability.
- `www.xpclient-academy.com` (+ apex 308) and `smiley-cx-platform.vercel.app` both already alias the production deployment — **no DNS change needed**.
- **Preview doctrine — already satisfied, must be preserved:** branch/project-scoped URLs return 302 (Deployment Protection). Doctrine: *deny by default via Vercel Deployment Protection; never rely on application auth alone for previews.* Application-level defence is added anyway — previews classify as `PREVIEW`, which is treated as admin-host (deny-by-default), never public.
- Later: add `admin.xpclient-academy.com` as a domain and append it to `ADMIN_HOSTS`.

---

## 15. Test Strategy

Current coverage is a genuine risk: **129 tests but ~11% lines**, with `app/actions` and all components at 0%, and **no test for `/auth/callback`** — which is exactly why F-2 survived.

| Layer | Additions |
|---|---|
| Unit | Host classifier: public / admin / preview / localhost / spoofed / port / case variations |
| Middleware | Per-host matrix: admin host + no session → `/login`; admin host + `/courses` → 404; public host + `/` → 200; public host + `/admin` → 404 |
| Integration | `/api/admin/upload-url` **rejects a forged cookie** (F-1 regression); `/auth/callback` persists a session (F-2 regression) |
| Server actions | Each admin action rejects an unauthenticated and a non-`super_admin` caller |
| E2E | Fix the stale `e2e/auth.spec.ts` (asserts a signup field SEC-2 removed) and **wire Playwright into CI** — it currently never runs |
| Cache | Assert host-dependent responses are `no-store` and never cross-host cached |

---

## 16. Rollback Plan

Each phase is independently revertible; CX-AUTH-1 carries the availability risk.

1. **Feature-flag the boundary.** `ADMIN_HOSTS` unset → classifier returns `PUBLIC` for every host → current behaviour exactly. Rollback = clear one env var, no redeploy of code.
2. **Deploy order:** merge host classification with the boundary disabled → verify both hosts serve 200 → enable `ADMIN_HOSTS` → verify.
3. **Blast radius:** a misclassification could 404 the public site. Mitigate with the allow-list (only listed hosts are admin; everything else defaults public) — a config typo fails *open to public*, which is the safe direction for availability and does not expose admin pages, since `/admin` retains server-side role checks independently.
4. **Vercel instant rollback** to the prior production deployment remains available.
5. CX-AUTH-2 (session change) will log out existing admins — expected; requires one re-login.

---

## 17. Blockers & Decisions Requiring Approval

| # | Decision | Why it needs you |
|---|---|---|
| **D-1** | **Fix F-1 immediately as a hotfix?** | It is exploitable today. My recommendation: yes, before any CX-AUTH phase. |
| **D-2** | Canonical admin URL — keep `smiley-cx-platform.vercel.app`, or move to `admin.xpclient-academy.com` now? | Design supports both; deciding now avoids a second migration. |
| **D-3** | Introduce `ADMIN`/`INSTRUCTOR` tiers, or stay binary `super_admin`? | The platform is binary today. Adding tiers is a product decision, not a refactor. |
| **D-4** | On the public host, should `/admin` **404 or redirect** to the admin host? | I recommend 404 — a redirect advertises the admin hostname. |
| **D-5** | Multi-admin support? | `ADMIN_USERNAME`/`ADMIN_EMAIL` supports exactly **one** admin. Real provisioning exists (`/admin/users/new`), but the login path is single-user. |
| **D-6** | Replace the hardcoded private-mode allowlist (F-5) with DB-backed access? | Currently requires a deploy to change access. |
| **D-7** | Suppress learner email on public certificate verification (F-6)? | Minor privacy exposure. |

---

## 18. Verification Results (local, this audit)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ **PASS** — 0 errors |
| Tests | `npx vitest run` | ✅ **PASS** — 129/129, 9 files |
| Build | `npm run build` | ✅ **PASS** — `EXIT=0` |
| Deploy gate | `prebuild` → `verify-prod-config.mjs` | ✅ `Auth configuration verified: public self-registration is disabled` |
| Diff | `git status` | ✅ Documentation only — one new file |

*(An earlier build invocation reported exit 255; that was a truncated PowerShell pipe from `Select-Object -First`, not a build failure. Re-run with full output capture returned `EXIT=0`.)*

---

## 19. Conclusion

The existing authentication, authorization, route structure, and hostname behaviour are now **fully mapped**. The proposed design protects the Vercel hostname **without touching the public XP Client Academy website**: the public host's behaviour is unchanged, and the admin host becomes deny-by-default with server-side role enforcement behind it.

Two things must be understood before implementation begins:

1. **Host separation is net-new.** The repository has zero host-awareness. Nothing existing can be adapted; the classifier and boundary are new code.
2. **Three pre-existing defects sit inside the surface being hardened.** F-1 (Critical, exploitable now), F-2 (breaks the recovery flow the portal depends on), F-3 (the admin session model being replaced). Building the host boundary on top of them would create the illusion of a private portal whose `/api/admin/upload-url` still accepts a forged cookie.

**CX-AUTH-0 is complete.** Recommended next action: approve **D-1** and execute **CX-AUTH-0.5** before CX-AUTH-1.
