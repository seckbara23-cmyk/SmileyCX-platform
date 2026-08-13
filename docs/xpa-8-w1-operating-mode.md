# XPA-8 W1 — Operating-Mode Authority (B-1): CLOSED

**Status:** ✅ B-1 **CLOSED** — code verified, production **not** flipped
**Baseline:** `9ccbd77` (XPA-7 closed)
**Schema change:** **none**

**Invariant established:**

> A learner who has legitimate platform access must not require their email
> address to be hardcoded in the repository.

---

## 1. Root cause

`PLATFORM_MODE=private` locked the entire site behind a hardcoded list in
`lib/access-control.ts`:

```ts
export const ALLOWED_PRIVATE_EMAILS = [
  'seckbara23@gmail.com',
  'mariemelly@gmail.com',
]
```

**Wrong in fact.** The real account is `mariemeify@gmail.com`; the list said
`mariemelly@` — most likely copied from the founder's public contact `mailto:`
in `app/(public)/about/founder/page.tsx`. A third real account was absent.

Measured against production:

| Account | Entitlements | Old allowlist | New model |
|---|---|---|---|
| `seckbara23@gmail.com` | 0 | ADMITTED | ADMITTED |
| **`mariemeify@gmail.com`** | **6** | **LOCKED OUT** | **ADMITTED** |
| `bawizee22@gmail.com` | 0 | **LOCKED OUT** | ADMITTED |

Enabling the ratified mode would have locked out **2 of 3 real accounts,
including the learner holding every entitlement on the platform.**

**Wrong in kind, and this is the part that mattered.** An email address is not
an authorization. Onboarding a learner would have required editing source and
redeploying — that is a deployment, not an onboarding model. The allowlist was
built as a **pre-launch site lockdown**, for a period when nobody was supposed
to see the platform, and was being asked to serve as **admission** for a
platform with paying customers. Different jobs.

**A second, independent defect in the same gate.** `PRIVATE_MODE_EXEMPT`
exempted only auth and admin paths. `operating-mode.md` ratifies *"Public
marketing pages | Publicly available"*, yet private mode would have put the
entire vitrine — home, catalogue, course detail, contact, legal — behind a
login. A B2B prospect cannot request access to a site they cannot see.

---

## 2. Old authority model

| Question | Old answer |
|---|---|
| Who is this user? | Supabase session ✅ |
| **May this account use the app?** | **hardcoded email list** ❌ |
| Which course may they open? | `has_course_access()` ✅ |
| What have they done? | enrollments ✅ |
| Which org may they act in? | memberships ✅ |

## 3. New authority model

| Question | New answer |
|---|---|
| Who is this user? | Supabase session |
| **May this account use the app?** | **`profiles.account_status`** (+ `platform_role` for admins) |
| Which course may they open? | `has_course_access()` — unchanged |
| What have they done? | enrollments — unchanged |
| Which org may they act in? | memberships — unchanged |

`resolveAdmission()` is synchronous and dependency-free: the caller fetches the
profile with whatever client it already holds, and the rule decides. Keeping the
I/O out makes the rule testable without a database.

**Admission is not entitlement.** A test asserts `lib/access-control.ts` contains
no reference to entitlements, enrollments, organizations or `has_course_access`,
and that the course seam contains no reference to admission or any mode flag.
Proved in production: a fresh admitted account with no entitlement still gets
`has_course_access = false`.

## 4. Schema changes

**None.** `profiles.account_status` already existed and already meant this:

- added by migration 035, `not null default 'active'`
- `CHECK (account_status in ('active','suspended','disabled'))`
- **already consulted** by `resolveCourseAccessById()` — a suspended learner was
  already refused course access
- pinned by `profiles_update_own` WITH CHECK

Per §3 of the brief, an existing authoritative signal was reused rather than a
new table or boolean added.

## 5. Allowlist disposition

`ALLOWED_PRIVATE_EMAILS` and `isAllowedPrivateUser` are **deleted**. Both call
sites in `middleware.ts` — the site-wide gate and the learner-auth-page redirect
— now call `isAdmittedUser(supabase, user.id)`, which reads the caller's own
profile through the session-scoped client. **No service-role key touches the
edge**, and a failed read resolves to *not admitted*.

The only surviving occurrences of the old address are this document, the
explanatory comment in `lib/access-control.ts`, and the founder's public contact
link — none of which is an authority.

## 6. Fail-closed mode behaviour

| `NEXT_PUBLIC_PLATFORM_MODE` | Before | After |
|---|---|---|
| `'private'` | private | private |
| `'pilot'` | pilot | pilot |
| `'public'` | public | public |
| **missing** | **pilot** | **production → `private`**, otherwise `pilot` |
| **invalid / typo** | **pilot** | **production → `private`**, otherwise `pilot` |
| whitespace | pilot | trimmed, then as above |

Production degrades toward lockdown; local development keeps the permissive
default it needs, stated explicitly via the exported `FALLBACK_MODE` so that
changing it is also a decision.

**This changes nothing where the variable is set.** Production sets `pilot`
explicitly today and still gets `pilot`. Only absence and typos behave
differently, and only in the safe direction.

## 7. Marième — production evidence

`mariemeify@gmail.com`: `platform_role=user`, `account_status=active`, **6 ACTIVE
`MANUAL_ADMIN` entitlements**, 6 active enrollments.

Under the new rule she resolves **ADMITTED**, and her address appears nowhere in
the repository. Her entitlements were **not** mutated — read-only throughout.

**Limitation, stated plainly:** this is database-level and rule-level evidence.
Her password was not used and her session was not impersonated, so the browser
round-trip through middleware was not exercised for her specific account. The
middleware path itself is covered by the negative case below, which used a real
JWT.

## 8. Unauthorized-account evidence

A disposable account, with a real session:

| Step | Result |
|---|---|
| fresh account, `status=active` | **ADMITTED** |
| administrator sets `status=suspended` | **DENIED (suspended)** |
| learner self-PATCHes back to `active` | **`403 42501` — RLS-pinned, status stayed `suspended`** |
| `has_course_access` (no entitlement) | `false` |

Suspension takes effect on the next request. No redeploy, no source change.
Fixture removed; 0 strays, profiles back to 3.

## 9. Public-route behaviour

Now exempt from the private gate: `/` (exact match — a `/` prefix would exempt
the whole site), `/courses`, `/parcours`, `/secteurs`, `/about`, `/contact`,
`/terms`, `/privacy`, plus the pre-existing `/login`, `/forgot-password`,
`/reset-password`, `/access-restricted`, `/admin`, `/api`, `/auth`.

**Not exempt, asserted by test:** `/learn`, `/dashboard`, `/checkout`,
`/certificate`.

Migration 039's projections already make the catalogue safe to serve
anonymously — `public_course_modules` / `public_course_lessons` structurally
cannot return lesson bodies — so no entitlement is needed to read public course
metadata.

## 10. Admin / RBAC behaviour

- `/admin` keeps its own `getOwnerSession()` gate and is exempt from the learner
  admission path.
- Platform-admin authority still comes from the owner allowlist, **not** from
  `account_status` — asserted by test.
- Admission admits a `super_admin` on their role, which grants the application,
  **not any course**.
- Admission consults no organization role, so an `org_admin` gains no platform
  privilege.
- `lib/access-control.ts` performs no writes.

## 11. Local results

| Gate | Result |
|---|---|
| Typecheck · Lint | ✅ / ✅ 0 errors |
| Full suite | ✅ **707 tests / 24 files** (was 675 / 23) |
| W1 regressions | ✅ **32** |
| Migration lint · asset guard · secret scan · build | ✅ ✅ ✅ ✅ |

**Six W1 assertions were confirmed to fail against pre-W1 `9ccbd77`** —
allowlist removed, no `isAllowedPrivateUser` in middleware, admission reads
`account_status`, middleware reads `profiles`, `FALLBACK_MODE` exists,
`/courses` exempt in private.

## 12. Production verifiers

`verify-xpa-6a` **57/57** · `verify-xpa-6c` **30/30** · `verify-xpa-6d` **22/22**
· `verify-xpa-7` **32/32** — **141 checks, 0 failures**. Entitlement authority,
enrollment non-authority, organization isolation and answer-key protection all
intact.

---

## SAFE TO FLIP `PLATFORM_MODE` TO PRIVATE: **YES — after this commit deploys**

Both reasons it was unsafe are closed:

1. All three real accounts are admitted by account state, none hardcoded.
2. The public marketing site stays public, as ratified.

**Conditions:** the flip must happen **after** this commit is deployed — flipping
against the currently-deployed code would still use the old allowlist and lock
out Marième. And this closes **B-1 only**. B-2 (empty published course) and B-3
(legacy `/app/[orgSlug]` reachable) remain open, so the overall XPA-8 verdict
stays **NO-GO** for launch.

### Exact next operator action

1. Confirm this commit is live on `www.xpclient-academy.com`.
2. Vercel → project → Settings → Environment Variables → set
   `NEXT_PUBLIC_PLATFORM_MODE=private` for Production.
3. Redeploy (the value is `NEXT_PUBLIC_`, so it is inlined at build time — an
   env change alone is not enough).
4. Verify, in this order: `/` and `/courses/…` load anonymously; `/learn/…`
   redirects an anonymous visitor to `/login`; Marième signs in and reaches
   `/dashboard` and a lesson; a suspended account lands on `/access-restricted`.
5. If anything is wrong, set the variable back to `pilot` and redeploy — the
   rollback is one variable and one deploy.

**Not performed here.** Per the stop condition, production was not flipped.
