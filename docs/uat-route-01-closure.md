# UAT-ROUTE-01 — Malformed Learning Route / Access-Denied CTA: CLOSED

**Status:** ✅ fix verified in production
**Baseline:** `bb3afc6` (XPA-6D closed) — not reopened
**Scope:** production regression fix. No migration. No schema, RLS, grant or
entitlement change of any kind.

---

## Root cause

Production generated:

```
/learn/les-fondamentaux-de-l-experience-client/undefined/undefined
```

`app/(public)/courses/[slug]/page.tsx` built its learning CTA as:

```ts
const lessonHref = `/learn/${slug}/${modules[0]?.slug}/${modules[0]?.lessons?.[0]?.slug}`
```

Three facts combine:

1. `modules` is read with the **learner's session client**, so it is RLS-filtered
   by the XPA-6A/6B/6D access model.
2. The page seeds `modules` from a static `COURSE_MODULES` fallback, then
   **overwrites it unconditionally**: `modules = (dbModules ?? []).map(...)`.
   When RLS returns nothing, the fallback is replaced by `[]`.
3. Optional chaining on an empty array yields `undefined`, and a template
   literal stringifies `undefined` to the seven characters `"undefined"`.

So the URL was malformed for **exactly the users who lacked access** — who then
hit the gate at `app/(learn)/learn/[courseSlug]/layout.tsx` and saw the denial
screen. The broken route and the denial screen appeared together because they
have the same cause.

This was never an access-control failure. The entitlement gate worked correctly
throughout; only the link pointing at it was malformed.

### Why the CTA was also wrong

The denial screen's primary CTA read **"Voir la formation"** and pointed at
`/courses/{slug}` — the page the learner had just come from, under the same
words they had just clicked. The destination was always correct and never a
gated route; the *label* promised entry it could not grant and simply looped.

---

## Audit of every learning-URL constructor

| Site | Verdict |
|---|---|
| `app/(public)/courses/[slug]/page.tsx` ×2 | **defective** — the root cause |
| `app/(learn)/.../[lessonId]/page.tsx` `${module?.id}/quiz` | **latent** — same class, `module` is nullable state |
| `app/(platform)/dashboard/page.tsx` | correct — guards, falls back to `/courses/{slug}` |
| `app/(platform)/checkout/page.tsx` | correct — guards, falls back to `/courses/{slug}` |
| `app/(learn)/.../final-exam/page.tsx` | correct — guarded by `if (lastLesson)` |
| `app/(learn)/.../[moduleId]/quiz/page.tsx` | correct — segments from loaded rows |
| `components/lms/LessonNavigation.tsx` | correct — segments from loaded rows |
| `components/lms/LessonSidebar.tsx` | correct — segments from `.map()` over real rows |
| `app/(platform)/certificate/[courseSlug]/page.tsx` | correct — no variable segment |

**The safe pattern already existed.** Dashboard and checkout both resolve a
concrete lesson and otherwise fall back to `/courses/{slug}`. The fix names that
existing convention rather than inventing one, and applies it to the two places
that did not follow it. No broader navigation refactor was performed.

---

## The repaired navigation contract

`lib/learn/routes.ts` — the canonical constructors:

| Function | Contract |
|---|---|
| `isRouteSegment(v)` | rejects `undefined`, `null`, `''`, and the **strings** `"undefined"` / `"null"` |
| `lessonHref(course, mod, lesson)` | a URL, or **`null`** if any segment is missing |
| `moduleQuizHref(course, mod)` | a URL, or `null` |
| `finalExamHref(course)` | a URL, or `null` |
| `firstLessonHref(course, modules)` | first module that actually has a lesson, or `null` |
| `learnEntryHref(course, modules, preferred?)` | **never null** — degrades to `/courses/{slug}` |

Two decisions worth recording:

- **`lessonHref` returns `null`, not a best-effort string.** The caller is forced
  to decide what to do instead and cannot accidentally render a broken link.
- **The already-stringified forms are rejected.** `"undefined"` is what the
  defect actually produced, so a value that has already passed through a
  template literal must not slip back through the validator.

`learnEntryHref` also discards a *preferred* URL that already contains
`/undefined` or `/null`, so a malformed resume-URL computed elsewhere cannot be
honoured.

---

## Changes

| File | Change |
|---|---|
| `lib/learn/routes.ts` | **new** — canonical route constructors |
| `app/(public)/courses/[slug]/page.tsx` | both malformed templates → `learnEntryHref` |
| `app/(learn)/.../[lessonId]/page.tsx` | `${module?.id}/quiz` → guarded `moduleQuizHref` |
| `app/(learn)/learn/[courseSlug]/layout.tsx` | CTA relabelled; destination via `coursePageHref` |
| `__tests__/routing/uat-route-01-learning-routes.test.ts` | **new** — 20 regressions |

Entitlement enforcement was not touched. No migration, no RLS, no grant change.

---

## Regression coverage

20 tests, one named for the defect:
`UAT-ROUTE-01 — /learn/<course>/undefined/undefined must never be generated`.

Covering the §6 list: no generated URL contains `/undefined/undefined`;
navigation resolves a valid module and lesson; empty leading modules are
skipped rather than assumed populated; denied users are sent to a valid
non-protected destination; a manually malformed URL fails safely; the gate still
renders children only when `access.allowed`; the gate is not weakened (no
`PILOT_MODE` / `FREE_ACCESS_MODE` bypass, no literal `allowed = true`);
inconsistent course/module/lesson combinations are rejected; and resume behaviour
prefers a valid URL while discarding a malformed one.

**The static guard was proved to detect the original defect.** It scans every
`/learn/` template literal across nine files for optional-chained interpolations:

```
PRE-FIX  (HEAD bb3afc6): 4 offenders
POST-FIX (working tree): 0 offenders
```

A regression test that cannot fail on the unfixed code is not a regression test.

---

## Production evidence

### Before — defect reproduced on the live site

`GET https://www.xpclient-academy.com/courses/les-fondamentaux-de-l-experience-client`
as an **anonymous** visitor returned HTTP 200, and the rendered HTML contained
exactly one `/learn/` href:

```
/learn/les-fondamentaux-de-l-experience-client/undefined/undefined
```

matching the reported URL exactly, and confirming the trigger is an RLS-emptied
module list rather than anything user-specific.

### After — `51fb8e5` deployed

The fix cannot be observed in production before it ships, so local gates and both
production security verifiers were required to pass first; CI was green on
`51fb8e5` before this section was written.

**Course page, anonymous visitor** — `GET /courses/les-fondamentaux-de-l-experience-client`

| Check | Result |
|---|---|
| HTTP | 200 |
| occurrences of `undefined/undefined` | **0** (was 1) |
| `/learn/` hrefs rendered | **none** — an anonymous visitor is offered signup/checkout, not a lesson |
| links to the public course page | 2 |

**The exact reported URL, entered manually** —
`GET /learn/les-fondamentaux-de-l-experience-client/undefined/undefined`

| Check | Result |
|---|---|
| final HTTP | 200 after 1 redirect |
| final URL | `/login?next=%2Flearn%2F…%2Fundefined%2Fundefined` |
| application error / stack trace in body | **0** |
| lesson content markers (`<video`, `video_url`, `lesson-content`) | **0** — nothing protected leaked |

It fails safely: the access gate intercepts before any lesson query runs and
redirects an unauthenticated caller to sign-in. The `next` parameter still
carries the malformed path, which is harmless — on return the gate re-evaluates
and either denies (unentitled) or the player's `resolveLesson` falls through to
the first real lesson (entitled). Neither path renders an error or exposes
content.

**Entitlement enforcement unchanged.** `verify-xpa-6d.mjs` 22/22 and
`verify-xpa-6a.mjs` 57/57 were re-run against production during this fix; an
entitled synthetic learner still reads learner-safe content and an unentitled one
still reads none.

---

## Local results

| Gate | Result |
|---|---|
| Typecheck | ✅ |
| Lint | ✅ 0 errors |
| Full suite | ✅ **564 tests / 19 files** (was 544 / 18) |
| UAT-ROUTE-01 regressions | ✅ 20 / 20 |
| Migration lint | ✅ 38 scanned, 4 baseline |
| Secret scan | ✅ |
| Production build | ✅ |
| `verify-xpa-6d.mjs` | ✅ **22 / 22** — answer-key protection intact |
| `verify-xpa-6a.mjs` | ✅ **57 / 57** — entitlement model intact |

Both security verifiers were re-run specifically because this change touches
routing around the access gate. Neither regressed.

---

## Residual notes

1. **`isEnrolled` on the course page still reads `enrollments`.** It drives only
   which CTA copy and progress card are shown, never access — access is decided
   by `resolveCourseAccess` → `my_course_access`. But it is the same superseded
   signal XPA-6B abolished and XPA-6D removed from `exercises_select`, so the
   progress card is inert while enrollments are empty. Out of scope here;
   recorded so it is not rediscovered a third time.
2. **The static guard is deliberately narrow** — it flags optional chaining
   inside `/learn/` template literals in nine known files. A new file is not
   covered until it is added to the list. That is a conscious trade: a
   repo-wide AST rule would be a lint-infrastructure change, not a regression fix.
3. The pre-existing comment-only edit to `037_entitlements.sql` and the six
   untracked `public/` assets remain untouched and uncommitted.
