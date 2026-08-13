# UAT-ACCESS-01 — Entitlement Is Access Authority: CLOSED

**Status:** ✅ implemented and production-verified
**Baseline:** `ee46c5e`
**Migration:** none — no schema, RLS, grant or policy change

**Ratified invariant:**

> **ENTITLEMENT** — may this learner access this course? *Commercial. Authority.*
> **ENROLLMENT** — what did this learner actually do? *Academic. Never authority.*
>
> A valid entitlement must never be overridden by the absence of an enrollment row.

---

## The two gates that disagreed

`(learn)/[courseSlug]/layout.tsx` admits a learner on `resolveCourseAccess`. Two
surfaces beneath it then asked a different question and could overturn that
answer.

### 1. The lesson player

```js
const { data: enrollment } = await supabase.from('enrollments')…
if (!enrollment) {
  if (FREE_ACCESS_MODE) { await enrollForFree(course.id) }   // a mode flag deciding access
  else { router.push(`/courses/${courseSlug}`); return }     // an entitled learner, bounced
}
```

Three defects in nine lines: an academic row used as authority; a mode flag as
the fallback authority; and a redirect that undid a decision the layout had
already made correctly. `enrollForFree` was additionally guaranteed to fail —
`SELF_ENROLLMENT_OPEN` is documented *"leave unset"* and is unset — so under
`FREE_ACCESS_MODE=false` the learner was simply ejected.

A fourth, subtler one: `useEffect` short-circuited on `PILOT_MODE` and called
`loadCourseAnon()`, so a signed-in learner in pilot never reached `loadCourse`
and their entitlement was never evaluated at all.

### 2. The certificate page

`enrollments` was its **only** gate. Wrong in both directions: an entitled
learner who had genuinely finished could be turned away for a missing academic
row, and the page conflated "may have this course" with "has earned this
certificate".

---

## Corrected behaviour

### Access contract — the player

| Learner state | Result |
|---|---|
| Valid entitlement, **no enrollment** | **enters** |
| Valid entitlement + enrollment | enters |
| Enrollment only | **denied** |
| Neither | denied |

The decision reads `my_course_access` — the learner-safe projection of the same
seam the layout enforces server-side and `has_course_access()` enforces in SQL,
and the one the dashboard already used. `FREE_ACCESS_MODE` is no longer imported
into the player at all; `SELF_ENROLLMENT_OPEN` never was.

An authenticated learner now takes the authorized path in **every** mode. The
anonymous branch survives only for pilot browsing, and the layout redirects
unauthenticated callers before the component renders.

### Certificate contract — two questions, two answers

| Question | Decided by |
|---|---|
| **Access authority** — may this learner have this course? | `resolveCourseAccess` (entitlement) |
| **Completion eligibility** — did they earn it? | `lesson_progress` + `quiz_attempts` |

An entitlement is permission to study, never evidence of having studied. All
completion checks are unchanged and still run: every lesson complete, every
module quiz passed, the final exam passed, and a course with zero lessons cannot
mint one. The certificate row is created only after all of them.

### Enrollment initialisation — automatic, and strictly after authorization

`ensureAcademicEnrollment(courseId)` — a new server action:

1. Authenticates the caller.
2. **Authorizes via `resolveCourseAccessById`** — the entitlement, and nothing
   else. No `PLATFORM_MODE`, no `FREE_ACCESS_MODE`, no `SELF_ENROLLMENT_OPEN`.
3. Returns early if a row already exists.
4. Upserts `onConflict: user_id,course_id` with `ignoreDuplicates` — idempotent
   and non-duplicating under concurrency.
5. Audits as `enrollment.initialized`, with `authorizing: false` in the metadata
   so a later reader of the log cannot mistake it for an access change.

The player calls it as `void ensureAcademicEnrollment(...)` **after** the access
decision. Its failure cannot deny entry: `lesson_progress` is keyed on
`(user_id, lesson_id)` under `USING (user_id = auth.uid())` and has no FK to
`enrollments`, so progress does not actually depend on the row — it exists for
academic history and admin views.

It is deliberately **not** `enrollForFree`, which answers "may this person help
themselves to a course?" and remains closed behind both its flags.

---

## Production evidence

Synthetic disposable actors against `eqoqcxkdcxeosjqaafhs`, course C1-F2
(4 modules / 18 lessons):

| State | `has_course_access` | modules | lessons | note |
|---|---|---|---|---|
| **A — entitlement only** | **true** | 4 | 18 | **0 enrollment rows** — access exists without one |
| **B — enrollment only** | **false** | 0 | 0 | denied, content unreadable |
| **C — entitlement + enrollment** | true | 4 | — | `lesson_progress` write `201`, read-back 1 row |

State A is the finding: the learner is authorized **because of the entitlement**,
with no academic row in existence.

**Certificate separation:**

- Actor A — entitled, `0/18` lessons complete → **eligible = false**. An
  entitlement alone produces no certificate.
- Actor B — enrollment only → `has_course_access = false`, cannot reach the page.

**Fixtures cleaned deterministically:** entitlements 6→6, enrollments 6→6,
lesson_progress 0→0. Marième's six entitlements and six enrollments were read
only and are unchanged.

---

## Operating-mode independence

Proven three ways:

1. The access decision reads `my_course_access`, computed by
   `has_course_access()` in Postgres from the entitlement alone. **No
   environment variable is an input**, so the same learner resolves identically
   under pilot, private and public.
2. A regression asserts no mode flag appears anywhere between the access read
   and the enrollment call, and that `lib/auth/course-access.ts` mentions none
   of `PLATFORM_MODE` / `PILOT_MODE` / `FREE_ACCESS_MODE` / `SELF_ENROLLMENT_OPEN`.
3. `FREE_ACCESS_MODE` is no longer imported by the player.

Production still runs `PLATFORM_MODE=pilot`; it was **not** changed, and the
corrected flow no longer cares.

---

## Tests

`__tests__/security/uat-access-01-entitlement-authority.test.ts` — **21 tests**,
named regression `UAT-ACCESS-01: …`. Covering the player gate, the absence of
`enrollForFree` and mode flags, idempotent non-authorizing audited initialisation
ordered after the decision, certificate access-vs-completion separation, the SQL
seam still reading entitlements and never enrollments, and mode independence.

**Seven assertions were confirmed to fail against pre-fix `ee46c5e`** — five on
the player, two on the certificate page.

One pre-existing test was corrected, not weakened.
`xpa-6a-learner-identity.test.ts` asserted the `SELF_ENROLLMENT_OPEN` guard
precedes the first `.upsert(` **in the file** — a proxy valid only while
`enrollForFree` owned the first upsert. `ensureAcademicEnrollment` added an
earlier one belonging to a different function with its own entitlement guard, so
the proxy broke while the guarantee did not. The assertion is now scoped to
`enrollForFree`'s own body, which is what it was always trying to say.

Local suite: **604 tests / 21 files**, up from 583 / 20.

---

## Residual legacy enrollment debt

Left in place deliberately; none interferes with the invariant.

| Location | Use | Why it stays |
|---|---|---|
| `checkout/page.tsx` | "already enrolled → /dashboard" | routing convenience, not authority |
| `courses/[slug]/page.tsx` `isEnrolled` | progress card + 2 section branches | inert while `enrollments` is sparse; the CTA already moved to `resolveCourseAccess` in UAT-ROUTE-02 |
| `enrollForFree()` | self-service enrollment | closed behind two fail-closed flags; still the correct home for that question |
| admin surfaces ×5 | counts, academic history | legitimate |
| `payments/actions.ts` | `activateEnrollment` after payment | legitimate |
| `dashboard/page.tsx` | access from the view, progress from enrollments | **the reference pattern** |

Also unresolved and recorded elsewhere: production runs `PLATFORM_MODE=pilot`
while invite-only is ratified, and `lib/pilot.ts` fail-opens to `'pilot'` when
the variable is unset.

---

## Is XPA-6C safe to begin?

**Technically yes.** The access model is now consistent across every surface that
can admit or refuse a learner: layout, player, certificate and course page all
resolve through the entitlement seam, and enrollment is academic state
everywhere. XPA-6C inherits one authority rather than two.

**But it remains blocked on a product decision, not on code.** `docs/xpa-6c-brief.md`
records that the repository contains exactly one ratified fact about XPA-6C —
`BUSINESS_EVALUATION`, an entitlement *source* labelled *"Évaluation entreprise"*
with mandatory expiry. The evidence says a commercial trial workflow; the
original task brief assumed an employee-competency assessment engine. Those
share almost no schema, security model or acceptance criteria, and if the
assessment reading is chosen the harvest-and-retry policy must be ratified first.
