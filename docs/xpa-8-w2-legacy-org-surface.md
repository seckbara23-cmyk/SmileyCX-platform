# XPA-8 W2 — Legacy `/app/[orgSlug]` Surface (B-3): CLOSED

**Status:** ✅ B-3 **CLOSED** — the legacy organization product is retired
**Baseline:** `6a3603a` (XPA-8 W1 closed)
**Schema change:** **none** — no migration added, none edited

**Disposition:** retire, not guard.

---

## 1. What was there

A second, SmileyCX-era organization product living under `/app`:

| Route | Purpose |
|---|---|
| `/app/orgs` | organization picker |
| `/app/onboarding` | create-your-organization flow |
| `/app/[orgSlug]/dashboard` | per-org CX dashboard |
| `/app/[orgSlug]/journeys` | journey / touchpoint editor |
| `/app/[orgSlug]/actions` | action plans |
| `/app/[orgSlug]/feedback` | feedback entries |
| `/app/[orgSlug]/settings` | org settings |

with its own shell — `AppShellClient`, `AppSidebar`, `AppTopbar`, `OrgSwitcher` —
and its own membership guard in `lib/auth/session.ts`.

`middleware.ts` lists `/app` under `AUTH_REQUIRED`, so **any authenticated user**
reached it; it was never restricted to admins. The admin shell linked to it from
`app/(admin)/layout.tsx:86`.

## 2. Correction to the XPA-8 audit

The audit stated that `feedback` and `actions` "return `PGRST205` — they do not
exist", and concluded the pages could not render.

**That was wrong, and the error was mine.** `feedback` and `actions` were table
names I invented for the probe from the route names. The pages actually query
`journeys`, `touchpoints`, `action_plans` and `feedback_entries` — **all four
exist in production and all four are empty.** The pages rendered; they rendered
nothing.

The disposition does not change — an untested parallel product reachable by every
learner is retired on its own merits — but "half of it is guaranteed to error"
was not a true statement, and B-3 should not have rested on it.

## 3. Why retire rather than guard

XPA-7 already answers every organization question authoritatively at
`/admin/organizations`. Two answers to *"who belongs to this company"* is one too
many, and the second one was unowned.

**The legacy guard was actively wrong after XPA-7.** `requireOrgMembership` read
`organization_memberships` with **no filter on `status`**:

```ts
const { data } = await supabase
  .from('organization_memberships')
  .select('*, organization:organizations(*)')
  .eq('user_id', user.id)          // ← no .eq('status', 'ACTIVE')
```

XPA-7 introduced the `PENDING` / `ACTIVE` / `REMOVED` lifecycle and filtered the
SQL helpers (`is_org_member`, `get_org_role`, `has_org_role`) to `ACTIVE`. This
call site was not updated. Because RLS lets a learner read their own membership
row, a **REMOVED ex-employee or a PENDING invitee would still have passed it** —
the only membership check on the platform that ignored the lifecycle.

Nothing else called it, so no other caller inherited the bug. It is deleted, with
the reason recorded in `lib/auth/session.ts` rather than silently dropped.

## 4. What replaces it

One catch-all handler, `app/app/[[...path]]/page.tsx`:

```ts
export default async function RetiredLegacyOrgSurface() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (isOwnerEmail(user.email ?? '')) redirect('/admin/organizations')
  redirect('/dashboard')
}
```

**The slug is deliberately never read.** Resolving it would:

1. make the retired route an **existence oracle** — `/app/acme` behaving
   differently from `/app/not-a-real-org` tells an unrelated learner which
   companies are customers; and
2. key a redirect on **attacker-controlled input**.

So the destination depends only on *who is asking*, never on what they asked for.
Every branch lands outside `/app`, so no redirect loop is reachable. The handler
renders no markup at all — there is no stale SmileyCX screen to flash.

`/app` stays in `AUTH_REQUIRED`: an anonymous caller is stopped at the middleware
boundary and the handler's own `!user` branch is belt-and-braces.

## 5. Removed

| File | |
|---|---|
| `app/app/[orgSlug]/{dashboard,journeys,actions,feedback,settings}/page.tsx` | 5 pages |
| `app/app/[orgSlug]/layout.tsx`, `app/app/{layout,error}.tsx` | 3 layouts |
| `app/app/orgs/page.tsx`, `app/app/onboarding/page.tsx` | 2 pages |
| `components/layout/{AppShellClient,AppSidebar,AppTopbar,OrgSwitcher}.tsx` | 4 components, used by nothing else |
| `lib/auth/session.ts` → `getUserMemberships`, `requireOrgMembership` | 38 lines |

Inbound links repointed: `app/(admin)/layout.tsx` `/app/orgs` → `/admin/organizations`.
A test now walks `app/`, `components/` and `lib/` and fails on **any** surviving
`href` / `redirect()` / `push()` into `/app`.

Build confirms one route remains:

```
├ ƒ /app/[[...path]]        172 B    87.6 kB
├ ƒ /admin/organizations    1.7 kB   97.8 kB
├ ƒ /admin/organizations/[id]  2.15 kB  98.3 kB
```

No `[orgSlug]`, `/app/orgs` or `/app/onboarding` in the manifest.

## 6. Isolation still holds

`verify-xpa-7` — **32/32, 0 failures**, unchanged. Organization isolation,
membership lifecycle, corporate licensing and the org-admin boundary are all
proven against production after the retirement. W2 removed a *consumer* of the
organization tables; it changed no policy, no helper and no grant.

## 7. Local results

| Gate | Result |
|---|---|
| Typecheck · Lint | ✅ 0 errors |
| Full suite | ✅ **728 tests / 25 files** (was 707 / 24) |
| W2 regressions | ✅ **21** |
| Migration lint · asset guard · secret scan · bundle scan · build | ✅ ✅ ✅ ✅ ✅ |

**15 of the 21 W2 assertions were confirmed to fail against pre-W2 `6a3603a`.**
The 6 that pass there are the "stayed in its lane" invariants — entitlement seam
untouched, W1 admission untouched, `/app` still auth-required, no migration
added, XPA-7 surfaces still present. Those *must* pass on both sides; a W2 that
changed them would be out of scope.

### One pre-existing test corrected

`__tests__/security/xpa-7-organizations.test.ts:297` asserted that
`lib/auth/session.ts` does not match `/has_org_role|is_org_member/` — reading the
**raw** file, while every other source in that file is read through `stripTs`.
The W2 comment explaining *why* `requireOrgMembership` was deleted names those
helpers in prose, which tripped it.

The line now uses `stripTs`, like its neighbours. **This was verified to be a
relaxation of a false positive, not of the check**: injecting a real
`supabase.rpc('is_org_member', …)` call into `lib/auth/session.ts` still fails
the assertion, and removing it passes. A comment calls nothing.

---

## 8. Two findings outside W2 scope, surfaced by the verifier run

`verify-xpa-6a` came back **52/57** where W1 recorded 57/57. W2 touched no SQL, so
I probed production rather than assume. **All five failures share one root cause,
and it is a production data change, not a code regression** — but chasing it
surfaced something that matters more.

### F-1 — C2-F2 was filled, and every one of its lessons was flagged public preview

B-2's empty published course now has content:

| Course | Lessons | `is_preview` |
|---|---|---|
| les-fondamentaux-du-service-client | 18 | 0 |
| les-fondamentaux-de-l-experience-client | 17 | 0 |
| communiquer-…-canaux-digitaux | 17 | 0 |
| manager-une-equipe-orientee-client | 17 | 0 |
| gerer-les-reclamations-… | 13 | 0 |
| **mesurer-l-experience-client (C2-F2)** | **20** | **20 of 20** |

The lessons policy from migration `001:143` has an `OR is_preview = true` arm, so
those 20 rows and their 4 parent modules are **anonymously readable**. Measured:
anon sees exactly 20 lessons and 4 modules — precisely the preview set, with
**zero** non-preview leakage. `quizzes`, `quiz_questions`, `exercises` and
`exercise_items` still return 0 rows to anon, so XPA-6D holds.

The column defaults to `false`, so these were set deliberately — but 20 of 20 is
**the blanket-preview pattern migration 035 was written to eliminate** ("all 82
lessons carry it, which makes preview meaningless and the whole catalogue
public"). 035's guard fires only while *every* lesson is flagged, so it correctly
did not undo this, exactly as designed.

The five verifier failures follow: `verify-xpa-6a` hardcodes the immediate
post-035 snapshot — *preview lessons must be 0*, *anon reads of `modules` and
`lessons` must be `DENIED_EMPTY`*. That was true the day it was written and is
not an invariant; 035's own comment calls designating preview lessons "a normal
editorial action". **The verifier is now permanently red for a legitimate
content change, and a permanently-red check stops being a signal.**

I did **not** edit `verify-xpa-6a.mjs`. Making another phase's failing security
verifier green during an unrelated phase is how a real finding gets buried.
Recommended, for the user's ruling: replace the snapshot assertions with the
invariant — *anon-visible lessons must equal exactly the `is_preview` set, must
carry no body, and no non-preview row may ever appear.* That is strictly stronger
than "the count is 0" and survives editorial change.

### F-2 — Course video media has no entitlement check at all ⚠️

This one is not about the preview flag, and it is the more serious of the two.

All three storage buckets are **public**:

```
course-videos   public=true
course-media    public=true
certificates    public=true
```

A video URL taken from a lesson that RLS **correctly hides** from anonymous
callers still returns the file to a caller with no credentials whatsoever:

| Lesson (anon cannot read the row) | API rows to anon | Unauthenticated `HEAD` on its video |
|---|---|---|
| Émotions, frictions & mini-cartographie | 0 | **200 · video/mp4 · 15.2 MB** |
| Les irritants | 0 | **200 · video/mp4 · 13.6 MB** |
| Boucler la boucle | 0 | **200 · video/mp4 · 16.5 MB** |

90 of 102 lessons carry a `video_url`. **`has_course_access()` governs the lesson
row; it does not govern the file.** The only thing protecting paid media is that
the bucket is not listable without auth — the URLs are secret, not protected.
That is obscurity, and it fails the moment a URL is known.

Combined with F-1 it is already live: the 20 anon-readable C2-F2 lessons hand any
anonymous visitor the URLs, so **the whole of C2-F2's video content is currently
downloadable by the public.**

`certificates` being public also warrants a look — certificates carry learner
names.

Neither finding is caused by W2, neither is in W2 scope, and I have changed
nothing about either. **F-2 should be triaged before launch**; the standard fix
is a private bucket plus short-lived signed URLs minted server-side behind
`has_course_access()`.

---

## 9. Verdict

**B-3 is closed.** The legacy surface is gone, its only inbound link is
repointed, the lifecycle-ignoring membership guard is deleted, organization
isolation is proven intact at 32/32, and 15 regressions fail against the pre-W2
commit.

**XPA-8 remains NO-GO.** B-2 was the last of the three original blockers still
open; it is now *partly* addressed — C2-F2 has 20 lessons where it had 0 — but it
is not closed: **no lesson on the platform has any `content` at all** (0 of 102),
H-1's total absence of assessments is unchanged, and F-1 leaves that course
publicly readable. F-2 is a new pre-launch item that did not exist in the
original blocker set.
