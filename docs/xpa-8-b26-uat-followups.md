# XPA-8 — UAT follow-up findings (raised during B-2.6 staging UAT)

**Raised by:** Marième Ba · **Date:** 19 August 2026
**Context:** staging UAT of B-2.6 (completion authority), Preview `0b7977c`
**UAT verdict:** **APPROVED WITH RESERVATIONS**

> These three findings are **NOT B-2.6 defects** and were explicitly excluded from that
> release scope. B-2.6 changed *who may record lesson completion*. None of the below
> touches completion, entitlement, or the access seam. They are recorded here so they are
> not lost and not silently folded into an unrelated release.

**Nothing in this document was fixed in B-2.6.** No file listed under "likely surface" was
modified by commit `0b7977c`. All three findings were closed later, by separate releases —
see each entry.

## Ledger status

Reconciled **10 September 2026** against production `main` @ `8ca845a`.
Updated **11 September 2026**: UAT-FU-3 closed against production `main` @ `1a1359b`.

| Finding | Status | Closed by |
|---|---|---|
| **UAT-FU-1** — catalogue incomplete | ✅ **CLOSED** | **CAT-1** — commit `0917a58`, PR #14, merged `209aeac` (9 Sep 2026) |
| **UAT-FU-2** — internal codes learner-facing | ✅ **CLOSED** | **B-2.5** — commit `ed56330`, PR #13, merged `53db92f` (7 Sep 2026) |
| **UAT-FU-3** — intermediate/advanced parcours buttons | ✅ **CLOSED** | **UAT-FU-3 release** — commit `1feb927`, PR #17, merged `1a1359b` (11 Sep 2026) |

The sections below keep the original 19 August triage text unchanged, followed by the
resolution where one exists.

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
| **Status** | ✅ **CLOSED** by CAT-1 (`0917a58`, merged `209aeac`) |
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

### Resolution — CAT-1

**Measured delta: one course.** Seven courses were published and six reached `/courses`.
The missing one was *Développer une culture client*. It was published and rendered its own
page, but appeared in no catalogue tier and no parcours. So of the three candidate causes
above, it was **(2) published but not listed**. It was not a query bug, though: the course
had no academic code. It was not a cache effect.

**Root cause.** `courses.code` is the permanent academic identity. The public catalogue
groups by its catalogue prefix, and every parcours/secteur membership is keyed on it.
Neither Admin course action ever wrote `code`, so every course authored through the Admin
UI was born with `code = NULL`. The catalogue excludes null-code rows by design. Every
future owner-created course would have been invisible the same way.

**Fix.**
- CAT-1 lets an administrator assign **one** registered, unused, non-retired canonical code
  to a course that has none. The code is permanent once set; replacing it, clearing it or
  reusing it is refused.
- Migration 028's foreign key, unique constraint and immutability trigger remain the
  authority.
- No migration was added.
- The catalogue's `.not('code', 'is', null)` filter was deliberately **not** relaxed.

**Completion.**
- C2-F5 was assigned through the Admin UI after merge, as an owner action.
- `learning_path_courses` already linked C2-F5 to seven parcours, so the course surfaced
  there with no further change. That also resolves the "parcours catalogue needs updating"
  half of the report for the métier and secteur paths.

**Production evidence** (10 September 2026, public anonymous reads of production):

| Surface | Observed |
|---|---|
| `/courses` page data | **7** published courses: Fondations 3 (C1-F1, C1-F2, C1-F3) · Intermédiaire 4 (C2-F1, C2-F2, C2-F4, C2-F5) · Avancé 0 |
| `/courses/developper-une-culture-client` | listed in **7** parcours |
| F-5.2 approved publication set (`scripts/security/publication-manifest.json`) | 7 published |
| Admin catalogue ("Formations produites") | 7, as reported by the owner |

**Superseded constraint.** The instruction above not to re-list C2-F2 no longer applies.
The content owner republished C2-F2 on 5 September 2026, and that was ruled legitimate on
6 September 2026 (see `publication-manifest.json`).

The level-journey buttons on `/courses` are **not** covered by this closure. They were
tracked separately as UAT-FU-3, since closed by PR #17.

---

## UAT-FU-2 — internal architecture codes (e.g. `PM-CONS`) are learner-facing

| | |
|---|---|
| **Status** | ✅ **CLOSED** by B-2.5 (`ed56330`, merged `53db92f`) |
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

### Resolution — B-2.5

**What was leaking.** `public_learning_paths.code` (PM-CONS, PM-MAN, SEC-COM …) was
printed as visible text by three public components:

| Component | Where it showed |
|---|---|
| `app/(public)/courses/[slug]/page.tsx` | chips in the "Cette formation fait partie des parcours" section |
| `components/courses/PathCard.tsx` | chip on the `/parcours` and `/secteurs` cards |
| `components/courses/PathDetail.tsx` | eyebrow above the path title |

**Governing decisions.** The owner chose to take FU-2 into B-2.5 when authorising that
release. That is the decision the triage table below asked for before FU-2 could be
absorbed into another phase.

1. **Keep "Cette formation fait partie des parcours".** This is the second option above:
   the section and its human-readable parcours titles stay. It is a required
   fiche-de-formation feature (`docs/xpa-3-brief.md` §3.1, citing V4 §8).
2. **Remove learner-visible internal codes.** Only the rendered code went; each chip,
   card and heading now shows the path title alone.
3. **Keep existing code-based URLs unchanged.** `/parcours/<code>`, `/secteurs/<code>`,
   canonical and Open Graph URLs, and sitemap entries keep the lower-cased code. No slugs
   were introduced, no redirects created, no data migrated.
4. **Admin, internal and governance code authority stays intact.** The admin catalogue
   still shows the full code matrix, CAT-1 code assignment is unaffected, and
   `courses.code` / `learning_paths.code` remain the identity and lookup keys.

**What deliberately remains, not visible.** Codes still appear in URLs (decision 3). They
also appear as React list keys in the page's serialized data. Each key sits beside a link
that carries the same code, so removing the keys would disclose nothing less.

**Production evidence** (10 September 2026, public anonymous reads): **zero** internal
codes in visible text across `/`, `/courses`, two course detail pages, `/parcours`,
`/parcours/pm-cons`, `/secteurs` and `/secteurs/sec-com`. The three components have not
been modified since `ed56330`.

**Regression guard:** `__tests__/content/b2-5-code-leak.test.ts`. Its checks are
positional, so a code expression may appear as an attribute value but not as rendered text,
a template literal, or an `aria-label` / `title` / `alt` / `placeholder` value.

**Caution:** `origin/staging` predates B-2.5 and still renders the code chip on the course
page. It must not be merged.

---

## UAT-FU-3 — intermediate/advanced parcours buttons need correct published/upcoming behaviour

| | |
|---|---|
| **Status** | ✅ **CLOSED** by the UAT-FU-3 release (`1feb927`, PR #17, merged `1a1359b`) |
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

### Resolution — PR #17

**Where the defect actually was.** The surface was not `/parcours`: the métier and secteur
paths have no levels. It was the three level-journey cards on `/courses` (Fondations /
Intermédiaire / Avancé). The components behind them were byte-identical on the UAT Preview
`0b7977c` and on production, so what Marième saw was still live.

The "probable shape" above was **not** the defect: no CTA routed to an unpublished course
(all 7 published course pages returned 200). Instead, every journey card offered "Voir les
formations" unconditionally. For a journey with nothing published, that button scrolled the
learner onto "Aucune formation dans ce parcours pour le moment". That was Avancé.

**Owner rulings.**
1. **Journey cards only.** Pricing and all commercial behaviour are out of scope and
   unchanged.
2. **A journey with zero published courses** still shows normally and displays
   **"Bientôt disponible"**. It offers no active "Voir les formations": no button, no link,
   no `/contact`, no scroll onto an empty list.
3. **A journey with one or more published courses** keeps "Voir les formations" exactly as
   before: it filters to that journey's published courses and scrolls to them.
4. **The state must be derived** from the published course list, never hard-coded, so an
   empty journey opens by itself when its first course is published.

**Implementation.**
- `parcoursAvailability()` in `app/(public)/courses/content.ts` computes, per journey:
  0 published courses → upcoming; 1 or more → available.
- `CoursesView.tsx` calls it once, on the published list the page already loads, and passes
  each card its value.
- `ParcoursCard.tsx` switches its action slot on that value.
- No journey is named in the logic, and there is no new query or authority.
- Untouched: `courses/page.tsx`, the catalogue query, `CourseCard.tsx` and
  `PricingSection.tsx`. No migration, no Supabase change.

**Final behaviour in production.**

| Journey | Published courses | Card |
|---|---|---|
| Fondations | 3 | **available** — "Voir les formations" |
| Intermédiaire | 4 | **available** — "Voir les formations"; filters to its 4 formations |
| Avancé | 0 | **upcoming** — "Bientôt disponible", no journey action |

- **Derived from data:** availability comes from published-course data, so Avancé becomes
  available automatically when its first course is published, within the page's 60-second
  revalidation.
- **Nothing unpublished exposed:** no unpublished course, future title, planned count or
  placeholder card is shown. Decision Q-E holds.
- **Rest of the page unchanged:** "Voir toutes les formations" still shows all 7 published
  formations, and pricing is unchanged.

**Evidence chain.**

| Gate | Result |
|---|---|
| Automated tests | 21 new behavioural tests (components rendered and clicked in jsdom); full suite 1276/1276; mutation testing 8/8 caught |
| Human Preview UAT | **PASS** — Vercel Preview `dpl_D6dBmwztSLNMKpNFGguL442aXMsx` built from `1feb927` |
| GitHub checks on PR #17 | all success — CI (Typecheck · Lint · Test, Production build) and Security (Secret scan, RLS / migration lint, Dependency audit) |
| Merge | PR #17 merged as `1a1359b` (tree identical to the approved `1feb927`) |
| Vercel Production | **READY** on `1a1359b` — `dpl_Cb3FRr1nMFSsXWodvoYQhGRyN47d`, serving `www.xpclient-academy.com` and `xpclient-academy.com` |
| Human production verification | **PASS** (11 September 2026) — Fondations and Intermédiaire show "Voir les formations"; Avancé shows "Bientôt disponible" with no normal journey action; Intermédiaire displays 4 published formations; "Voir toutes les formations" restores all 7 |

**Regression guard:** `__tests__/content/uat-fu-3-parcours-availability.test.ts`.

---

## Triage notes (19 August 2026, with outcomes)

| | |
|---|---|
| **Are any of these release blockers for B-2.6?** | **No.** Marième's verdict is explicit, and none touches completion, entitlement or RLS |
| **Do any share a surface with B-2.6?** | **No.** `0b7977c` modified no catalogue, parcours or course-detail file |
| **Do FU-1 and FU-3 overlap?** | Triaged as **probably**. **Outcome:** no. FU-1's root cause was the unassigned course code, closed by CAT-1. FU-3 was a separate presentation defect on the `/courses` journey cards, closed by PR #17 |
| **Suggested sequencing** | Originally: FU-1 and FU-3 as one investigation, FU-2 independent and needing a product ruling first. **Outcome:** each finding was closed independently: FU-2, then FU-1, then FU-3 |
| **Phase assignment** | Originally unassigned, not to be folded into B-2.3, B-2.4, B-2.5 or UX-1 without a decision. **Outcome:** FU-1 → CAT-1. FU-2 → B-2.5, by owner decision. FU-3 → its own release, PR #17 |

---

## Final summary

**Status (11 September 2026): all three of Marième's recorded UAT follow-ups — FU-1, FU-2
and FU-3 — are CLOSED.**

| Finding | Closed by | Production |
|---|---|---|
| **UAT-FU-1** — catalogue incomplete | CAT-1 — PR #14 | merged `209aeac` |
| **UAT-FU-2** — internal codes learner-facing | B-2.5 — PR #13 | merged `53db92f` |
| **UAT-FU-3** — journey buttons ignore published state | UAT-FU-3 release — PR #17 | merged `1a1359b`, Vercel Production READY, human-verified |

No finding in this document remains open. None of the three required a migration, and none
changed RLS, entitlement, enrollment, publication or canonical code authority.
