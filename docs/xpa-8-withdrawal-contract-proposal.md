# XPA-8 — Withdrawal contract: proposal to close the `lessons_visible` gap

**Status: PROPOSAL ONLY. No policy changed, no migration written, nothing applied.**
**Prepared:** 20 August 2026, after the second occurrence.
**Supersedes nothing.** The debt record is `docs/xpa-8-withdrawal-contract-gap.md`; this
document is the implementation proposal that record deferred.

---

## 0. The defect in one line

`lessons_visible` admits a lesson on **`is_preview = true` alone** and never consults the
owning course's publication state — so a **withdrawn** course serves its preview lessons,
and their object paths, to anonymous callers.

## 1. Two occurrences, both corrected by hand

| | Course | Date | Preview lessons | Anon exposure | Corrected by |
|---|---|---|---|---|---|
| 1 | **C2-F2** *Mesurer l'expérience client* | 17 Aug 2026 | 11 of 21 | 11 lessons, 10 object paths | migration **045** |
| 2 | **Développer une culture client** | 20 Aug 2026 | **10 of 10** (wholesale) | 10 lessons, 9 object paths | migration **048** |

Both courses were `is_published = false` throughout. In both cases withdrawal changed the
anonymous exposure by **exactly zero**, and a hand-written migration cleared the flags.

The second occurrence is the argument. Clearing flags per incident treats the symptom, and
the incidents arrive through ordinary authoring: someone creates lessons on a withdrawn
course and the authoring UI's preview checkbox does what it says. Nothing malicious, nothing
unusual — which is precisely why it will happen again.

## 2. The existing policy

`lessons_visible`, migration 036:

```sql
create policy "lessons_visible" on public.lessons for select
  using (
    lessons.is_preview = true
    or public.has_course_access(public.course_of_lesson(lessons.id))
  );
```

`modules_visible`, same migration, carries the analogous arm:

```sql
create policy "modules_visible" on public.modules for select
  using (
    public.has_course_access(modules.course_id)
    or public.module_has_preview_lesson(modules.id)
  );
```

So the gap is **two policies, not one**. A withdrawn course with a preview lesson leaks the
lesson row *and* its module row.

## 3. Dependents — the full list

| Dependent | Reads | Affected by the proposed change? |
|---|---|---|
| `public.public_course_lessons` (039) | `l.is_preview`, joins `courses`, **`where c.is_published = true`** | **No** — already publication-gated |
| `public.public_course_modules` (039) | joins `courses`, **`where c.is_published = true`** | **No** — already publication-gated |
| `public.module_has_preview_lesson(uuid)` (036) | `lessons.is_preview` | Yes — needs the same predicate, or `modules_visible` keeps leaking |
| `public.course_of_lesson(uuid)` (036) | lesson → module → course | No — resolution only |
| `quizzes_visible` / `quiz_questions_visible` (036) | `has_course_access(course_of_quiz(...))` | **No** — no preview arm at all |
| `exercises_select` (038) | `is_published AND has_course_access(...)` | **No** — already publication-gated |
| `app/(public)/courses/[slug]/page.tsx` | `lesson.is_preview` for the "Aperçu" badge | No — reads a published course by definition |
| `admin/modules/[id]/edit` | authors `is_preview` | No — admin path, `is_platform_admin()` |
| `lesson_progress` policies (044) | — | No |

**The decisive observation:** migration 039's public projections *already* express the
intended contract — both views join `courses` and filter `c.is_published = true`. The
product rule "a withdrawn course shows nothing publicly" is therefore **already ratified in
the view layer**; the base-table RLS simply never caught up. This is not a new product
decision. It is an alignment.

## 4. Proposed contract

> Anonymous lesson visibility requires **BOTH**: the lesson is a preview **AND** its owning
> course is published.

```sql
create policy "lessons_visible" on public.lessons for select
  using (
    (lessons.is_preview = true
     and public.course_is_published(public.course_of_lesson(lessons.id)))
    or public.has_course_access(public.course_of_lesson(lessons.id))
  );
```

with a new `SECURITY DEFINER` helper mirroring `course_of_lesson`'s shape:

```sql
create or replace function public.course_is_published(p_course_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select is_published from public.courses where id = p_course_id), false) $$;
```

and the same treatment for `module_has_preview_lesson`, either by wrapping it or by adding
the predicate to `modules_visible`.

**`coalesce(..., false)` is deliberate:** a lesson whose course cannot be resolved must be
invisible, not visible. Fail closed.

### Why a `SECURITY DEFINER` helper and not an inline join

Migration 036 exists because `lessons_visible` and `modules_visible` queried each other and
produced **`42P17` — infinite recursion in policy** — which made four content tables
unreadable by *every* caller including admins. An inline `exists (select 1 from courses …)`
inside `lessons_visible` would re-open that class of risk the moment `courses` gains a
policy that touches lessons. A definer function with a pinned `search_path` steps outside
RLS for the lookup and cannot re-enter it. `course_of_lesson`, `course_of_quiz` and
`module_has_preview_lesson` all already follow this pattern.

Publication state is not privileged — `public_course_lessons` exposes it to `anon` today —
so the definer rights leak nothing.

## 5. Effects

| Audience | Today | After |
|---|---|---|
| **Anonymous, published course, preview lesson** | visible | **visible — unchanged** |
| **Anonymous, published course, non-preview** | invisible | invisible |
| **Anonymous, WITHDRAWN course, preview lesson** | **visible (the defect)** | **invisible** |
| **Entitled learner, any course** | visible via `has_course_access` | **unchanged** — publication never gated access (035/037) |
| **Entitled learner, withdrawn course they hold** | visible | **unchanged** — the ratified B-2B guarantee |
| **Platform admin** | visible | unchanged — `has_course_access` admits admins |
| **Public catalogue** (`/courses`, `/courses/[slug]`) | 039 views, publication-gated | **unchanged** |

The second-to-last row is the one that must not break, and it does not: the entitlement arm
is untouched. *Publication controls discovery, never access* survives intact — this change
makes discovery behave, and leaves access exactly where it is.

## 6. Regression matrix to prove before applying

| # | Fixture | Expectation |
|---|---|---|
| 1 | anon · published course · preview lesson | **visible** (must not regress the teaser) |
| 2 | anon · published course · non-preview | invisible |
| 3 | anon · withdrawn course · preview lesson | **invisible** — the fix |
| 4 | anon · withdrawn course · preview lesson's **module** | **invisible** |
| 5 | anon · object path on any withdrawn lesson | **0 exposed** |
| 6 | entitled learner · published course | all lessons visible |
| 7 | **entitled learner · withdrawn course they hold** | **all lessons visible** — B-2B |
| 8 | expired / revoked / enrollment-only | refused, unchanged |
| 9 | platform admin | all lessons visible |
| 10 | `/courses` catalogue payload | identical before and after |
| 11 | `/courses/[slug]` for a published course | identical, preview badges intact |
| 12 | `module_has_preview_lesson` on a withdrawn course | false |
| 13 | **no `42P17`** on lessons, modules, quizzes, quiz_questions, exercises | all readable by anon, learner and admin |
| 14 | XPA-6A, 6C, 6D, 7, W2, W3-storage, B-2B, B-2.1, B-2.6 | **303/303** |

Item 13 is not optional. Migration 035 passed every structural check while the system was
broken; only *exercising* the policies caught it. Any implementation must read as each role
and classify the outcome, not pattern-match the policy text.

## 7. Rollback risk

**Moderate — the highest-risk change proposed in XPA-8 so far**, and the reason it gets its
own phase rather than riding along with a corrective.

| Risk | Likelihood | Mitigation |
|---|---|---|
| `42P17` recursion returns, content tables unreadable by everyone | low but catastrophic | definer helper, never an inline join; exercise every role before commit |
| A published course's preview teaser disappears | low | matrix item 1; the published arm is unchanged |
| An entitled learner loses a withdrawn course they hold | low | matrix item 7; the entitlement arm is untouched |
| Statement timeout — 035 hit one on `quiz_questions_visible` | low | the helper is a single indexed PK lookup |
| Catalogue payload changes | very low | 039 views already publication-gated; matrix items 10–11 |

Rollback is a single `create or replace policy` restoring the current predicate, and it is
cheap — but a failed apply that produces `42P17` would be *live* until rolled back, so the
migration must be applied with someone watching, not fire-and-forget.

## 8. Alternatives considered

| Option | Verdict |
|---|---|
| **A — require publication in the policy** *(proposed)* | Aligns RLS with what 039's views already do. Correct at the source |
| **B — clear preview flags when a course is withdrawn** | Rejected. Destroys authoring state; republishing silently loses the curator's choices, and it makes withdrawal lossy, contradicting B-2B's "nothing was destroyed" |
| **C — verifier-only guard: assert 0 preview flags on withdrawn courses** | Rejected as a *substitute*, worth keeping as a *supplement*. It moves the invariant out of the database into a script that runs when someone remembers |
| **D — do nothing, correct each incident** | Rejected. Two occurrences in four days, arriving through ordinary authoring |

**Recommendation: A, with C as a cheap supplementary check** — a single assertion in XPA-6A
that no withdrawn course carries a preview flag would have caught both incidents the moment
they happened, rather than at the next full verifier run.

## 9. Suggested phasing

| Wave | Content |
|---|---|
| **W-1** | Write the helper + both policy replacements as one forward migration. Apply-time self-verification that exercises all four content tables as anon, learner and admin (the 038 pattern) |
| **W-2** | Extend XPA-6A with the supplementary invariant (option C) and a withdrawn-course preview fixture |
| **W-3** | Apply to production with observation; re-run 303/303 |

Small, but it changes a policy that has already caused one platform-wide outage. It should
not share a commit with anything else.

---

**Nothing in this document has been implemented. `lessons_visible` and `modules_visible` are
untouched, and migration 048 deliberately did not alter them.**
