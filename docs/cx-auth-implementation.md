# CX-AUTH — Administration Portal Authentication

**Status:** CX-AUTH-1 implemented (allowlist admin login)
**Model:** Explicit email allowlist. No roles, no tiers, no hierarchy.
**Related:** [CX-AUTH-0 audit](cx-auth-0-architecture-audit.md) · [operating mode](security/operating-mode.md)

---

## 1. The allowlist model

The administration portal authorizes a small, explicitly configured allowlist of
addresses — `ADMIN_OWNER_EMAILS`, comma-separated. Authorization is a single
question:

> Is the authenticated Supabase user's email on the allowlist?

Every listed address has **identical, full** administration access. This is an
allowlist, **not** a role model: there is deliberately no hierarchy, no
`ADMIN`/`INSTRUCTOR` tier, and no company-administrator concept. The platform's
existing `platform_role` column is untouched, but administration access no
longer depends on it — the allowlist is the sole authority.

Adding or removing an administrator is a configuration change: edit
`ADMIN_OWNER_EMAILS` and redeploy. No code change, no migration.

Comparison is case-insensitive and whitespace-trimmed on both sides, so
`  MarieMeify@GMAIL.com ` matches a configured `mariemeify@gmail.com`.

## 2. Two hostnames, one deployment

| Hostname | Purpose | Anonymous access |
|---|---|---|
| `www.xpclient-academy.com` | Public marketing site | **Fully public — unchanged** |
| `smiley-cx-platform.vercel.app` | Private administration portal | **Denied — everything redirects to `/login`** |

Both hostnames serve the same Next.js deployment. Before CX-AUTH-1 the
application was entirely host-blind, so the admin hostname served the complete
public website to anyone. `lib/hosts.ts` is now the single place that
distinguishes them.

**The public site did not change.** No page on `www.xpclient-academy.com`
requires authentication that did not require it before.

## 3. Authentication flow

```
smiley-cx-platform.vercel.app/<anything>
        │
        ├─ /login, /forgot-password, /reset-password, /auth/*, /api/auth/*, /api/health
        │     └─ allowed without a session (otherwise the owner could never sign in)
        │
        ├─ no session ──────────────► 307 /login
        │
        ├─ session, NOT the owner ──► 307 /api/auth/signout?error=forbidden
        │                                  └─ session destroyed ──► /login  "Accès non autorisé"
        │
        └─ session IS the owner ────► /  →  /admin      (everything else allowed)
```

Sign-in itself is unchanged Supabase Auth: email + password via
`signInWithPassword`. No new identity provider was introduced.

## 4. Enforcement is server-side, not middleware-only

Middleware is a **boundary**, not the enforcement point. A browser redirect is
not protection — server actions can be invoked directly without ever rendering
the page that hosts them.

| Layer | Mechanism |
|---|---|
| Host boundary | `middleware.ts` → `isAdminHost()` + `isOwnerEmail()` |
| Every admin page and action (41 call sites, 36 files) | `requirePlatformAdmin()` → `getOwnerSession()` |
| `/api/admin/upload-url` | `getOwnerSession()` → 401 |
| `/api/health` detail | `getOwnerSession()` |

`getOwnerSession()` uses `supabase.auth.getUser()`, which **validates the JWT
against Supabase**, rather than `getSession()`, which merely reads the cookie.

### Fails closed

If `ADMIN_OWNER_EMAILS` is missing, empty, or contains only separators/whitespace,
the parsed allowlist is empty and `isOwnerEmail()` returns `false` for every
input — including an empty email. A missing environment variable **locks the
portal**; it never opens it.

## 5. Security repairs included in this phase

Two defects found in the CX-AUTH-0 audit sat inside the surface being hardened
and are fixed here.

### F-1 (Critical) — `/api/admin/upload-url` authorization bypass

Previously the route checked only that an `scx_admin` cookie was **present** —
never its value, never a role — then used the **service-role** client to mint a
signed upload URL into a **public** bucket. Any anonymous caller sending
`Cookie: scx_admin=x` obtained write access.

Now requires a verified owner session. Verified at runtime:

```
POST /api/admin/upload-url  Cookie: scx_admin=anything                          → 401
POST /api/admin/upload-url  Cookie: scx_admin=00000000-0000-0000-0000-000000000000 → 401
POST /api/admin/upload-url  (no cookie)                                         → 401
```

No signed URL is issued in any case. The rate-limit key is also now bound to the
verified user id rather than an attacker-chosen cookie value.

### F-2 (High) — password recovery was broken

`app/auth/callback/route.ts` passed `{ getAll, setAll }`, but
`@supabase/ssr@0.3.0` defines `CookieMethods` as `{ get, set, remove }` and
contains **zero** references to `getAll`. The adapter was silently ignored, so
the exchanged session was never persisted and recovery could not complete.
`tsc` does not catch the wrong shape. Now matches `lib/supabase/server.ts`.

### F-3 (High) — the unsigned admin cookie is gone

`scx_admin` held the admin's **raw user UUID**, unsigned. Possession equalled
admin access, and logout could not revoke it. The routes that minted it
(`/api/admin/login`, `/api/admin/signout`, `/admin/login`) are **deleted**.
Authorization now derives from a real Supabase session — signed, refreshable,
and revocable.

## 6. Password setup for the owner

**No password is ever generated, printed, stored, or committed.**

```bash
# 1. Dry run — prints the target address, creates nothing, sends nothing
node scripts/auth/provision-owner.mjs

# 2. Verify the address is EXACTLY correct, then:
node scripts/auth/provision-owner.mjs --confirm
```

For **every** address in `ADMIN_OWNER_EMAILS`, the script:
1. Creates the account in Supabase Auth if it does not exist (idempotent).
2. Ensures a `profiles` row exists.
3. Sends a **password-setup email** via `resetPasswordForEmail`.

Each holder clicks the link, chooses their own password, and signs in:

```
email → /auth/callback?next=/reset-password&type=recovery
      → session established (F-2 fix)
      → holder sets password
      → /login
```

Requires `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_OWNER_EMAILS`.

## 7. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_OWNER_EMAILS` | **Yes** | Comma-separated allowlist of authorized administrators, e.g. `mariemeify@gmail.com,seckbara23@gmail.com`. Trimmed and compared case-insensitively. Server-side only — no `NEXT_PUBLIC_` prefix, never in the client bundle. Missing/empty ⇒ portal locked. |
| `ADMIN_HOSTS` | No | Comma-separated private hostnames. Defaults to `smiley-cx-platform.vercel.app`. Add `admin.xpclient-academy.com` here later — **no code change needed**. |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Canonical public URL for certificate links and password-setup redirects. |

## 8. Route reference

### Public — no session required (on the public host)

`/` · `/courses` · `/courses/[slug]` · `/about` · `/about/founder` · `/contact` ·
`/privacy` · `/terms` · `/verify-certificate/[id]` · `/api/health` ·
`/login` · `/forgot-password` · `/reset-password` · `/auth/callback`

### Protected — owner session required

`/admin` and all 24 sub-pages · all admin server actions ·
`/api/admin/upload-url` · admin detail in `/api/health`

On the **admin host**, everything not in the auth-entry list above requires the
owner session — including `/`, `/courses` and `/about`.

## 9. Preview deployments

`*.vercel.app` hosts that are not the configured admin host are treated as
**admin hosts** (deny by default), so a preview URL never serves the public site
anonymously. Vercel Deployment Protection is additionally active on
branch-scoped URLs (verified: they return 302).

## 10. Known trade-off — admin login rate limiting

The deleted `/api/admin/login` carried application-level brute-force protection
(5 attempts / 15 min, per IP **and** per username). Sign-in is now a direct
browser→Supabase call, so the application server is not in the request path and
cannot rate-limit it. Brute-force protection is therefore **Supabase-side only**.

Supabase enforces its own auth rate limits, but the configured threshold **could
not be verified from this repository**.

**Tracked for CX-AUTH-2:** either move sign-in into a server action so
`rateLimitDb` applies, or confirm and document the Supabase limit. This is
recorded in `__tests__/security/registration.test.ts` so it cannot be forgotten.

## 11. Verification performed

Runtime verification against a production build (`next start`), using `Host` and
`x-forwarded-host` headers:

| Host | Path | Result |
|---|---|---|
| `www.xpclient-academy.com` | `/`, `/courses`, `/about`, `/contact`, `/login` | **200** (public preserved) |
| `www.xpclient-academy.com` | `/admin` | 307 → `/login` |
| `smiley-cx-platform.vercel.app` | `/`, `/courses`, `/about`, `/contact` | **307 → `/login`** |
| `smiley-cx-platform.vercel.app` | `/admin`, `/admin/users` | 307 → `/login?next=…` |
| `smiley-cx-platform.vercel.app` | `/login`, `/forgot-password` | **200** (owner can sign in) |
| any | `/api/auth/signout?error=forbidden` | 307 → `/login?error=forbidden` |

Gates: typecheck **PASS** · tests **161/161 PASS** · build **PASS (exit 0)**.
