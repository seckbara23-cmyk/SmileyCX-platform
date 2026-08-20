# XPA-8 — UAT follow-up findings (raised during B-2.6 staging UAT)

**Raised by:** Marième Ba · **Date:** 19 August 2026
**Context:** staging UAT of B-2.6 (completion authority), Preview `0b7977c`
**UAT verdict:** **APPROVED WITH RESERVATIONS**

> These three findings are **NOT B-2.6 defects** and were explicitly excluded from that
> release scope. B-2.6 changed *who may record lesson completion*. None of the below
> touches completion, entitlement, or the access seam. They are recorded here so they are
> not lost and not silently folded into an unrelated release.

**Nothing in this document was fixed in B-2.6.** No file listed under "likely surface" was
modified by commit `0b7977c`.

---

## What B-2.6's UAT actually passed

Recorded first, because these are the acceptance criteria the release is being merged on.

| # | Acceptance path | Result |
|---|---|---|
| 1 | authenticated learner can complete a lesson | **PASS** |
| 2 | completion indicator appears | **PASS** |
| 3 | progress / count increases | **PASS** |
| 4 | completion survives a full refresh | **PASS** |
| 5 | progress survives navigating away and back | **PASS** |
| 6 | a second completion increments only once | **PASS** |
| 7 | reopening a completed lesson does not duplicate progress | **PASS** |
| 8 | video and lesson navigation work normally | **PASS** |

Items 6 and 7 are the idempotency guarantee, confirmed by a human against the same
behaviour the automated suite asserts (`already: true` short-circuit, `UNIQUE(user_id,
lesson_id)`).

---

## UAT-FU-1 — not all 7 published formations appear; parcours catalogue needs updating

| | |
|---|---|
| **Severity** | to be triaged — potentially learner-visible catalogue incompleteness |
| **Area** | public catalogue / parcours |
| **B-2.6 related?** | **No.** Completion does not read, write or filter the catalogue |
| **Likely surface** | `app/(public)/courses/`, `app/(public)/parcours/`, `catalogues`, `learning_paths`, `course_codes` |

**Reported:** the catalogue does not list all seven published formations, and the parcours
catalogue needs updating.

**Do not assume this is a bug before measuring it.** Three different things could produce
this symptom and they have different fixes:

1. **Genuinely fewer published courses than expected.** As of the B-2.6 audit there were
   **five** published courses, not seven — C2-F2 was deliberately unpublished by B-2B, and
   B-2C/B-2.1 dealt with the remainder. "7 published formations" may be the *intended*
   catalogue rather than the current one, in which case this is a content task, not a defect.
2. **Published but not listed** — a genuine catalogue/query defect.
3. **Stale cache.** `/courses` carries `export const revalidate = 60` (added by B-2B
   precisely because a prerendered catalogue kept serving a withdrawn course). A stale read
   is a third possibility and is cheap to rule out.

**First step:** count `courses where is_published = true` against what the page renders, and
name the delta. Do not "fix" the listing before that number is known.

**Interaction to respect:** publication controls **discovery**, never **access** (migrations
035, 037). Whatever changes here must not become an access authority, and must not re-list
C2-F2, which B-2B withdrew on purpose.

---

## UAT-FU-2 — internal architecture codes (e.g. `PM-CONS`) are learner-facing

| | |
|---|---|
| **Severity** | to be triaged — presentation / information disclosure of internal taxonomy |
| **Area** | course detail page |
| **B-2.6 related?** | **No** |
| **Likely surface** | the "Cette formation fait partie des parcours" block on `app/(public)/courses/[slug]/` |

**Reported:** internal architecture codes such as `PM-CONS` should not be shown to learners.
Suggested remedy is to review hiding the *"Cette formation fait partie des parcours"* block.

**Note the two options are not the same thing**, and the choice is a product decision:

- **Hide the block** — removes the codes and the parcours context together.
- **Keep the block, show labels not codes** — retains the pedagogical context ("this course
  belongs to a learning path") while dropping the internal taxonomy.

The second is likely what a learner benefits from, but that is not mine to decide. Flagging
it so the follow-up does not default to deletion without considering it.

**Related standing constraint:** the platform already holds that internal architecture and
prompt-engineering source material must not be publicly served (see the `public/` asset
policy and `check-public-assets.mjs`). This is the same principle applied to rendered text
rather than files, which is an argument for treating it as more than cosmetic.

---

## UAT-FU-3 — intermediate/advanced parcours buttons need correct published/upcoming behaviour

| | |
|---|---|
| **Severity** | to be triaged — navigation leads to unavailable content |
| **Area** | parcours catalogue |
| **B-2.6 related?** | **No** |
| **Likely surface** | `app/(public)/parcours/`, level-filtered CTAs |

**Reported:** the intermediate and advanced parcours catalogue buttons need correct
published / upcoming course behaviour.

**Probable shape:** a CTA that routes to a course which is not published returns 404 — the
same class of mismatch B-2B fixed for the main catalogue, where the listing advertised
`"available": true` for a course whose detail route had already begun 404ing. The lesson
from B-2B applies directly: **checking the database is not sufficient; the rendered payload
has to be fetched.** B-2B's verifier caught this only by requesting the page.

An "upcoming" state must be a *presentation* state. It must not be implemented by granting
any form of access to unpublished content.

---

## Triage notes

| | |
|---|---|
| **Are any of these release blockers for B-2.6?** | **No.** Marième's verdict is explicit, and none touches completion, entitlement or RLS |
| **Do any share a surface with B-2.6?** | **No.** `0b7977c` modified no catalogue, parcours or course-detail file |
| **Do FU-1 and FU-3 overlap?** | **Probably.** Both concern the parcours catalogue's notion of what is published. Investigate together; they may be one root cause |
| **Suggested sequencing** | FU-1 and FU-3 as one investigation (measure first, then fix). FU-2 is independent and needs a product ruling before any code change |
| **Phase assignment** | Not assigned. These are **not** B-2.3, B-2.4, B-2.5 or UX-1, and must not be absorbed into them without a decision |

---

**Status: RECORDED, NOT TRIAGED, NOT SCHEDULED.**
No work has been done on any of these three findings.
