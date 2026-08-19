# XPA-8 — architecture debt: the withdrawal contract has a hole

**Recorded:** 19 August 2026 · **Status: RECORDED, NOT SCHEDULED, NOT REDESIGNED**
**Found during:** the pre-B-2.6 corrective phase, while restoring C2-F2's preview flags
**Deliberately out of scope** of that corrective phase, of B-2.6, and of migration 045.

---

## The claim the platform makes

Ratified in migrations 035 and 037, stated verbatim in both:

> publication controls DISCOVERY, never ACCESS

The half everyone checks is that withdrawal must not confiscate a held entitlement — B-2B
proved that, and it still holds. The half nobody checked is the other direction: **that
withdrawal actually removes discovery.**

It does not, completely.

## What is actually true

`lessons_visible` (migration 036) admits a lesson on `is_preview = true` alone. It never
consults the owning course's `is_published`. So:

**A withdrawn course still serves its preview lessons — and their `video_object_path` /
`pdf_object_path` — to anonymous callers.**

Measured on 19 August, after C2-F2 was withdrawn and *before* migration 045:

| | Before withdrawal | After withdrawal | After 045 |
|---|---|---|---|
| C2-F2 in `/courses` catalogue | listed | **absent** | absent |
| `/courses/mesurer-l-experience-client` | 200 | **404** | 404 |
| anon-visible C2-F2 lessons | 11 | **11 — unchanged** | **0** |
| …exposing an object path | 10 | **10 — unchanged** | **0** |

Withdrawal moved the catalogue and the detail route and changed the lesson exposure by
exactly nothing. Migration 045 closed today's instance by clearing the flags; it did not
close the gap.

## Why it stayed latent until now

The combination had never occurred. Before 17 August, C2-F2 was withdrawn **and** carried
zero preview flags — F-1 and migration 043 had cleared them. A withdrawn course with
preview flags simply did not exist, so no verifier had a reason to look.

The 17 August republication created that combination for the first time, and XPA-6A caught
the consequence rather than the cause: it failed on *object paths visible to anon*, which
is downstream of *lessons visible to anon*, which is downstream of *preview flags surviving
withdrawal*.

## Severity

**Moderate, and bounded.** This is a metadata leak, not a content leak.

The paths themselves were verified unusable by an anonymous caller — `400` on both
`/storage/v1/object/public/course-content/…` and the RLS route — because migration 041 made
the bucket private and F-2 delivers only through short-lived signed URLs issued after an
authorization check. What leaked was the existence and filename of an object, plus lesson
titles and ids of a course that is supposed to be undiscoverable.

The standing constraint *"do not treat an unguessable filename as security"* cuts both ways:
the filename was never the protection, so losing it costs less than it appears — but the
same reasoning means there is no benefit in publishing it either.

## What a fix would have to decide

**Not decided here.** Three shapes, with different consequences:

1. **`lessons_visible` also requires the course to be published.**
   Cleanest statement of the contract. Risk: 036 exists precisely because policies that
   query other tables produced `42P17` infinite recursion and made four content tables
   unreadable by every caller including admins. Any change here must go through a
   `SECURITY DEFINER` helper — `course_of_lesson()` already exists and 038 and 044 both use
   it — and must be *exercised*, not merely structurally checked. That was 035's exact
   failure mode.

2. **Withdrawal clears preview flags as a side effect.**
   Cheap and wrong: it destroys authoring state, so republishing silently loses the
   curator's preview choices. It also makes withdrawal lossy, which contradicts B-2B's
   "nothing was destroyed" guarantee.

3. **Accept it, and enforce zero preview flags on withdrawn courses with a verifier.**
   No policy risk, but the invariant then lives in a script rather than in the database,
   and it is enforced only when someone runs it.

Option 1 is the honest fix. Option 3 is the cheap guard. They are not exclusive.

## Related

- Migration 036 — why any policy change here is risky (`42P17`)
- Migration 043 / F-1 — the previous clearing of these same flags
- Migration 045 — today's corrective; clears the flags, does not touch the policy
- B-2B — the other half of the contract, which holds
- XPA-6A — the verifier that caught the symptom

---

**No work has been done on this. No policy was modified. It is recorded so that the next
person to withdraw a course knows the guarantee is weaker than the sentence suggests.**
