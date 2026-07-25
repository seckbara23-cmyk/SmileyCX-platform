# CX Academy — Operating Mode

> **Current mode: INVITE-ONLY DEVELOPMENT MODE**
> Effective 2026-07-25 (HOTFIX-3). This is the official operating mode until public launch.

---

## 1. What this means

The pilot phase is complete. CX Academy is now in controlled development while
content (courses, modules, videos, quizzes, certificates, payments) continues to
be built.

| | Status |
|---|---|
| Anonymous public registration | **Closed** |
| Account creation | Platform Admin only (provisioning / invitation) |
| Existing users | **Preserved** — nothing was deleted or migrated |
| Login | Working |
| Password reset | Working |
| Public marketing pages | Publicly available |
| Learning content | Available per `PLATFORM_MODE` |

Anyone who wants access requests it; an administrator provisions the account.

## 2. Why

Two forces converged:

1. **SEC-1** found that `/signup` called `supabase.auth.signUp()` directly from
   the browser with no invitation check, allowlist, rate limit, or CAPTCHA, and
   the Supabase project accepted it. Two unrecognised accounts appeared in
   production. SEC-2 removed the client path; closing the Supabase-side setting
   completes it.
2. **The platform is not finished.** Content, payments and certificates are
   still being built. Public self-registration during this phase creates
   accounts that cannot be supported and cannot be meaningfully served.

Invite-only is therefore both the security posture and the product posture until
launch.

## 3. Enforcement architecture (HOTFIX-3)

Registration is closed at the **only** place that actually closes it — Supabase.
`POST /auth/v1/signup` is served by Supabase directly using the public anon key;
it never traverses this application. **No amount of application-side logic can
close it.** This is the single most important fact about this control.

The application's job is therefore to *verify and report*, and to refuse to ship
when the setting is wrong:

```
DEPLOY TIME  ──  enforcement
   npm run verify:prod-config
   disable_signup=false  →  exit 1  →  build fails  →  insecure build never ships
                                       (Vercel keeps serving the last good deploy)

RUNTIME      ──  observability
   disable_signup=false  →  log.fatal [SEC2_SIGNUP_ENABLED]
                         →  /api/health reports "degraded"
                         →  application CONTINUES SERVING
```

### Why runtime no longer throws

It used to. The throw ran inside the Next.js instrumentation hook during server
*preparation*, so it failed **every route** — a nonexistent course slug returned
500 instead of 404 (see [HOTFIX-1](hotfix-1-production-outage.md) and
[HOTFIX-2](hotfix-2-course-detail-500.md)). It was also nondeterministic: it
depended on an outbound fetch during cold start, so identical code against
identical configuration either took the platform down or silently permitted it.

Critically, **it did not close the hole it detected.** It removed the legitimate
surface (courses, login, admin) while leaving the insecure one fully reachable.

This is not a weakening of SEC-2. Enforcement moved *earlier*, to a
deterministic gate that cannot be defeated by a cold-start network fault. What
was removed is a self-inflicted outage that protected nobody.

## 4. Operator workflow

### 4.1 Closing registration (one time)

```
Supabase Dashboard
  → Authentication
  → Sign In / Providers
  → Email
  → turn OFF "Allow new users to sign up"
```

Verify:

```bash
curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup
# must print: true
```

Or from the repository:

```bash
npm run verify:prod-config
# ✓ Auth configuration verified: public self-registration is disabled.
```

### 4.2 Deploy-time enforcement (active — no action needed)

Enforcement is wired into `package.json` as npm's automatic `prebuild` hook:

```json
"prebuild": "node scripts/security/verify-prod-config.mjs",
"build":    "next build",
```

npm runs `prebuild` before every `npm run build`, which is what Vercel invokes.
No dashboard configuration is required, and the gate cannot be forgotten.

Behaviour:

| Setting | Gate | Outcome |
|---|---|---|
| `disable_signup: true` | exit 0 | build proceeds |
| `disable_signup: false` | **exit 1** | **build fails; insecure deployment never ships** |
| unreachable / unreadable | exit 0 + warning | build proceeds (a transient network fault must not block a deploy) |
| placeholder credentials (CI) | exit 0 + skip notice | build proceeds |

> **Ordering note, for the record.** This hook was deliberately added *after*
> `disable_signup` was set to `true`. Enabling it while the setting was still
> `false` would have blocked the very deployment that restored availability.
> If registration is ever reopened intentionally (see §6), remove this hook in
> the same change, or every build will fail by design.

### 4.3 Provisioning a user

```
/admin  →  Users  →  New User
```

This is the **only** account-creation path in the system. It is authorized
(`requirePlatformAdmin()`), role-validated against an allow-list, rate-limited
(`rateLimitDb`), and audited to `audit_log` on both success and failure.

### 4.4 Monitoring

```bash
curl -s https://<host>/api/health
```

| Response | Meaning |
|---|---|
| `{"status":"ok"}` | `disable_signup` verified true |
| `{"status":"degraded"}` | Either confirmed insecure, or the setting could not be read |

Anonymous callers get only that coarse status. A platform admin (`scx_admin`
cookie, `super_admin` re-verified server-side) additionally receives the stable
code — `SEC2_SIGNUP_ENABLED` or `SEC2_SIGNUP_UNVERIFIED` — and detail. Search
production logs for those codes.

## 5. What remains in force

Nothing from the earlier phases was relaxed:

| Control | Status |
|---|---|
| No `auth.signUp` / `signInAnonymously` / `inviteUserByEmail` in source | Enforced by regression test |
| Exactly one `admin.createUser` call site | Enforced by regression test |
| Migration 027 — `platform_role` self-escalation blocked (RLS `WITH CHECK` + BEFORE UPDATE trigger) | Applied, untouched |
| `audit_log` — identity events auditable, survives user deletion | Untouched |
| Rate limiting on provisioning and admin login | Untouched |
| RLS across all tables | Untouched |
| Deploy-time enforcement gate | Active (see 4.2) |

## 6. Transition to public launch

When the platform is ready to open, in this order:

1. Finish content, payments and certificate issuance.
2. Decide the registration model — open signup, waitlist approval, or paid
   enrollment only. **This is a product decision, not a configuration toggle.**
3. If self-registration is chosen, build a server-owned registration path first:
   Zod validation → invitation/allowlist check → `rateLimitDb` → `admin.createUser()`
   → audit event. Do **not** restore the client-side `supabase.auth.signUp()`
   call; that was the SEC-1 incident path.
4. Only then flip `disable_signup` to `false`, and remove the deploy gate in the
   same change so the two stay consistent.
5. Set `NEXT_PUBLIC_PLATFORM_MODE=public`.
6. Update this document.

Until step 6 is done, **invite-only development mode is the operating mode.**
