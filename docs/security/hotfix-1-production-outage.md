# HOTFIX-1 — Production outage investigation and repair

**Status:** root cause confirmed; code-side repair complete; **one operator action outstanding**
**Scope:** XP Client Academy (CX Academy) only. Effitrans untouched.
**Related:** [SEC-1 forensic audit](sec-1-identity-registration-forensic-audit.md) · [SEC-2 remediation](sec-2-remediation.md) · [SEC-3 DevSecOps](sec-3-devsecops.md)

---

## 1. Summary

`/courses` returned HTTP 500 in production. The reported symptom was misleading in
two ways, and both matter for anyone reading this later:

1. **It was not a `/courses` bug.** The failure occurred in the Next.js
   instrumentation hook during *server preparation*, before routing. Every route
   was affected. `/courses` is simply the most-visited public page, so it is
   where the outage surfaced.
2. **It was not a regression in the usual sense.** The application refused to
   boot *on purpose*. SEC-2 installed a fail-closed startup gate that throws when
   Supabase reports public self-registration is open. The gate did exactly what
   it was designed to do. What was missing was the operator step SEC-2 required:
   turning `disable_signup` on in the Supabase Dashboard.

The hypothesis stated in the incident brief — "the application is intentionally
refusing to boot because `disable_signup` is still false" — is **confirmed by
runtime evidence**, not assumed.

## 2. Evidence

Exception recorded in production runtime logs:

```
Error: An error occurred while loading instrumentation hook:
SECURITY: public self-registration is ENABLED on this Supabase project
(auth settings report disable_signup: false). …
    at async Module.t (/var/task/.next/server/instrumentation.js:1:754)
    at async r6.prepareImpl (next-server/server.runtime.prod.js)
```

| Observation | Value |
|---|---|
| Occurrences | 36 |
| Window | 22:24:28Z → 22:43:13Z |
| Routes affected | `/courses`, `/login.rsc`, `/admin/*`, `/admin/login` — i.e. unrelated route groups |
| Deployment | `dpl_6ocY438GomWTzihhJKpfuraqn6Ai` |
| Failure site | `prepareImpl` — server preparation, before any route handler |

The spread across unrelated route groups, plus the `prepareImpl` frame, is what
establishes this as an application-wide boot failure rather than a page defect.

**Supabase Auth settings at time of investigation:** `disable_signup: false`.
The SEC-2 operator checklist step was never performed.

**Migration 027 (SEC-2 identity hardening): applied.** Verified via the presence
of `audit_log`, which is section 4 of that migration — it exists only if the
policy (§2) and trigger (§3) sections executed first. The database-side
remediation is intact; only the external dashboard setting was outstanding.

## 3. Why the site later appeared healthy

The current deployment (`dpl_BW5goFN8Eu8eBV6uyyxhaSf2TEs9`, SEC-3) serves 200s.
Its logs show:

```
{"code":"SEC2_SIGNUP_UNVERIFIED","detail":"fetch failed"}
{"code":"SEC2_SIGNUP_UNVERIFIED","detail":"This operation was aborted"}
```

**The gate is nondeterministic**, because it depends on an outbound HTTP call
made during cold start:

| Probe outcome | Status | Result |
|---|---|---|
| Settings fetched, `disable_signup: false` | `insecure` | throws → **entire app 500s** |
| Fetch fails or times out | `unknown` | logs an error → **boots normally** |

So the identical code, against the identical (still-insecure) configuration,
either takes the platform down or silently permits it — decided by network luck
during cold start. The site being up right now is **not** evidence that the
problem is fixed. It is evidence that the probe failed.

The `unknown` → continue behaviour is the ratified SEC-2 policy (a transient
network fault must not take the platform down) and has **not** been changed.

## 4. A design observation, for ratification — not changed unilaterally

Refusing to boot does **not** close the registration hole it detects.

`POST /auth/v1/signup` is served by Supabase directly, using the public anon key.
It does not traverse this application. Taking the Next.js app down therefore
removes the *legitimate* surface (courses, login, admin) while leaving the
*insecure* one (direct Supabase registration) fully reachable. During the outage
window, registration was open and the platform was unavailable — the worst of
both.

This is raised as a decision for the platform owner, not a change made here. The
SEC-2 control has been left exactly as ratified. If you would like the runtime
gate softened to "log loudly and serve" — with the deploy-time gate below as the
hard block — that is a reasonable posture, but it is your call to make.

## 5. What changed in this repair

No security control was weakened, removed, or bypassed. Public signup was not
re-enabled. Migration 027 was not touched. No test was relaxed.

| Change | File | Purpose |
|---|---|---|
| Stable error codes | `lib/security/auth-config.ts` | `SEC2_SIGNUP_ENABLED` / `SEC2_SIGNUP_UNVERIFIED` on every result and log line, so operators can grep production logs and diagnose immediately |
| Deploy-time gate | `scripts/security/verify-prod-config.mjs` | Moves the hard failure from *runtime* to *deploy time* |
| Operator health check | `app/api/health/route.ts` | Makes the silent `unverified` state observable |
| npm script | `package.json` | `npm run verify:prod-config` |
| Regression tests | `__tests__/security/auth-config-failclosed.test.ts` | 19 tests pinning the behaviour |

### Why a deploy-time gate is strictly better than the runtime one

The runtime gate turns an operator configuration mistake into a whole-application
outage, nondeterministically. The deploy-time gate:

- is **deterministic** — the build passes or fails once, with clear output;
- **fails closed harder** — an insecure build never goes live, and Vercel keeps
  serving the last good deployment instead of 500ing;
- is **diagnosable** — the reason appears in the build log.

It does not replace the runtime check, which still catches a setting flipped
*after* deployment. It front-runs it.

Verified locally against the real project (`disable_signup: false`):

```
✗ [SEC2_SIGNUP_ENABLED] DEPLOYMENT BLOCKED
exit 1
```

and against CI placeholder credentials:

```
• Skipping production Auth config check (no real Supabase project configured).
exit 0
```

### Health endpoint disclosure model

Per the constraint *"do not reveal security configuration details publicly"*:

- **anonymous** → `{"status":"ok"|"degraded"}` only. No codes, no detail, no
  configuration values. Useful to an uptime monitor, useless to an attacker.
- **platform admin** (`scx_admin` cookie, `super_admin` re-verified server-side
  against the database) → the error code and detail needed to diagnose.

`unknown` reports as `degraded`, never `ok` — an unverified control is not a
healthy one. The raw Supabase settings payload and all credentials are never
returned.

## 6. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass (pre-existing unused-var warnings only) |
| `npm run lint:sql` | pass — 27 migrations, 4 known baseline findings, no new |
| `npm run scan:secrets` | pass — 7 patterns, tracked files + git history |
| `npm run scan:bundle` | pass — 92 files, 12 patterns |
| `npm run build` | pass |
| Test suite | **115/115** (was 112; +19 new, net of the file split) |

Regression coverage added, per the incident brief:

- `disable_signup=false` still causes deliberate production failure
- `disable_signup=true` allows normal boot
- network failure / abort / non-200 → `unknown`, **never** `secure`
- error codes are exactly the published strings
- the gate is reachable only from `instrumentation.ts` — enforced by a `git grep`
  assertion, so no future route can turn this into a route-scoped outage again
- `/courses` does not depend on the gate
- health endpoint leaks nothing to anonymous callers

Pre-existing SEC-2 coverage (anonymous signup blocked, login and password
recovery preserved, migration 027 blocks self-promotion, no secrets in the
client) remains green and was **not** modified.

## 7. OUTSTANDING — operator action required

**This cannot be done from code.** Reporting and stopping here, as instructed.

`disable_signup` is **still `false`** on the production Supabase project. Public
self-registration is open right now, regardless of the application being up.

```
Supabase Dashboard
  → Authentication
  → Sign In / Providers
  → Email
  → turn OFF "Allow new users to sign up"
```

Then verify:

```bash
curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup
# must print: true
```

Then redeploy. Until this is done:

- the platform can 500 application-wide at any cold start, unpredictably;
- anyone holding the public anon key can create an account directly against
  Supabase, which is the hole SEC-2 was written to close.

Once the setting is flipped, `npm run verify:prod-config` will report
`✓ Auth configuration verified` and the runtime gate will stop firing.

## 8. Recommended follow-up

Wire `verify:prod-config` into the deployment pipeline (Vercel build command or
the SEC-3 `security.yml` workflow with production secrets) so an insecure
configuration can never reach production again. Not done here: it requires
production credentials in CI, which is an operator decision about secret
placement, not a code change.
