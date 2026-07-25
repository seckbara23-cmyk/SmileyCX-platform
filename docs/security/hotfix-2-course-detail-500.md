# HOTFIX-2 — Course detail 500 investigation

**Verdict: not a new incident.** `/courses/<slug>` returns 500 for the same
reason `/courses` did in [HOTFIX-1](hotfix-1-production-outage.md): the SEC-2
boot gate. No defect exists in the course detail page.

**Status:** investigation complete, no code defect found, regression tests added.
**Outstanding:** the same operator action as HOTFIX-1 — `disable_signup = true`.

---

## 1. Runtime evidence

The brief instructed not to pursue instrumentation *unless runtime evidence
directly points there*. It does — explicitly:

```
### 23:20:42 GET /courses/les-fondamentaux-de-l-experience-client 500 [error/serverless]
dep=dpl_FEokGxGg6EEYpHosJQm3MHpS3uPT branch=main cache=MISS
    Failed to prepare server
    Error: An error occurred while loading instrumentation hook:
      [SEC2_SIGNUP_ENABLED] SECURITY: public self-registration is ENABLED …
        at async Module.t (/var/task/.next/server/instrumentation.js:1:754)
        at async r9.prepareImpl (next-server/server.runtime.prod.js:17:41819)
```

`Failed to prepare server` is decisive: the route module never executed. The
`[SEC2_SIGNUP_ENABLED]` prefix is the stable code added in HOTFIX-1 (`534db6e`),
which is how we know this is the current deployment and not a stale log.

Project-wide there are exactly **two** runtime error groups in the last 24h.
Both are this same instrumentation error. **There is no course-detail exception.**

## 2. Reproduction — the failure is not scoped to the slug page

Live probe of `https://smiley-cx-platform.vercel.app`:

| Route | Status |
|---|---|
| `/courses` | 500 |
| `/courses/les-fondamentaux-de-l-experience-client` | 500 |
| `/courses/comprendre-client-qualite-experience` | 500 |
| **`/courses/does-not-exist-xyz`** | **500** |
| `/contact` | 500 |
| `/login` | 500 |
| `/admin` | 307 |

Two rows settle it:

- **A nonexistent slug returns 500, not 404.** If the page were running,
  `notFound()` would produce a 404. It cannot even reach that line.
- **`/admin` returns 307** because middleware runs on the edge runtime, which
  prepares independently of the Node.js server. Edge redirects still work while
  every Node-rendered route is down.

So: not only the slug page, not only one course — the whole Node.js application,
exactly as in HOTFIX-1. The brief's three diagnostic options ("only the slug page
fails / all course detail pages fail / only one course fails") are all false.

## 3. The course page and its data are healthy

Queried as an **anonymous** visitor with the public anon key — the same RLS path
a public request takes:

```
courses lookup (slug + is_published) → error: null, found: true
  id: debc2117-dc55-4b6f-98d7-280da12c2505
  level: "beginner"   (present in LEVEL_LABELS)
  cover_url: https://eqoqcxkdcxeosjqaafhs.supabase.co/storage/v1/object/public/…
  intro_video_url: null
modules + lessons join → error: null, 3 modules (7, 5, 5 lessons)
```

Every failure point the brief listed was checked:

| Checked | Result |
|---|---|
| slug exists / published / RLS readable | yes, anonymously |
| modules + lessons relations | present, join returns no error |
| `cover_url` host vs `next.config.mjs` | `*.supabase.co` is in `remotePatterns` — `next/image` will not throw |
| `level` vs `LEVEL_LABELS` | `beginner` is mapped |
| `notFound()` handling | correct (proved by local 404) |
| `Promise.all` progress block | gated behind `isEnrolled && user && dbCourse` |
| `generateMetadata` / OpenGraph | all fields `??`-guarded; tested |
| null dereference on `lessons` | normalized via `m.lessons ?? []` |

**Local production-equivalent render against the real production database:**

| Route | Status |
|---|---|
| `/courses` | 200 |
| `/courses/les-fondamentaux-de-l-experience-client` | **200** |
| `/courses/les-fondamentaux-du-service-client` | 200 |
| `/courses/communiquer-avec-les-clients-sur-les-canaux-digitaux` | 200 |
| `/courses/does-not-exist-xyz` | **404** |

The failing page returned 86,514 bytes of correct HTML — right `<h1>`, 3 modules,
no error markers. The page works. Only the boot gate stands between it and
production.

## 4. Introducing commit

The boot gate was introduced by **`83aca17` — `fix(security): SEC-2 identity and
registration remediation`** (which added `instrumentation.ts` and
`lib/security/auth-config.ts`).

**This is related to SEC-2, and stating otherwise would be wrong.** The gate is
behaving as designed; what is missing is the operator step SEC-2 requires. The
course detail page itself has not been meaningfully touched since `63104e2`
(a UX pass), which long predates the failures.

## 5. Fix

**No product code was changed.** There is no defect to repair, and inventing one
would be the speculative fix the brief forbids. Weakening the gate to restore
availability is likewise excluded by the HOTFIX-1 constraints.

What was added:

| Change | Why |
|---|---|
| `__tests__/pages/course-detail.test.ts` (9 tests) | Locks in the behaviour verified empirically above |
| `vitest.config.ts` — `esbuild: { jsx: 'automatic' }` | Next compiles JSX with the automatic runtime, so page modules never import React; without this, importing a Server Component in a test fails with `React is not defined`. Test infrastructure only. |

A Server Component is just an async function returning an element tree, so the
page is invoked directly with Supabase mocked — no page refactor was needed to
make it testable.

Tests: existing course renders · missing slug 404s · unpublished course 404s
(never leaks existence) · zero modules · missing `lessons` key · explicitly null
`lessons` · RLS denial degrades instead of throwing · anonymous visitor ·
`generateMetadata` survives a missing course.

## 6. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| Test suite | **124/124** (was 115; +9) |
| `npm run build` | pass |
| `npm run lint:sql` | pass — no new findings |
| `npm run scan:secrets` | pass |

## 7. Outstanding — unchanged from HOTFIX-1

Redeploying will **not** fix this. The gate reads live Supabase configuration at
boot, so a new deployment fails the same way whenever the probe succeeds.

```
Supabase Dashboard → Authentication → Sign In / Providers → Email
  → turn OFF "Allow new users to sign up"    then redeploy
```

Verify: `curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup` → `true`

Until then the platform will keep flapping between "fully down" and "up but
unverified" depending on whether the cold-start probe reaches Supabase — which
is what made this look like a new, page-specific incident.
