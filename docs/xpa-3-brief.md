# XPA-3 — Catalogue & Path Discovery Experience

**Status:** brief only — **not implemented**. Awaiting GO.
**Inputs:** [XPA-2 report](xpa-2-report.md) · [XPA-2 reconciliation](xpa-2-reconciliation.md) · [decision register](xpa-decision-register.md)
**Prerequisite:** XPA-2 closed, production initialization **PASS** (verified 2026-08-05)

---

## 1. Objective

Give learners and B2B buyers a way to find the right training through the two
axes the V4 architecture defines:

```
« qui je suis »   → professional path (PM-…)   → individual learner
« où je travaille » → sector path (SEC-…)      → B2B buyer
                          ↓ both lead to ↓
                    the same courses, by code
```

Replace the pilot-era `/courses` page, whose grouping is a hardcoded
`parcours: 'debutant'|'intermediaire'|'avance'` in `data/seed.ts` matched to DB
courses by slug/title heuristics, with discovery driven by the real academic
model.

**Out of scope:** launch-cohort filtering (D-Q1 open), B2B group enrollment
(XPA-7), payments (XPA-9), learning-flow changes (XPA-4), Voice Practice (XPA-5),
any schema change to courses/modules/lessons.

## 2. The one hard prerequisite: a narrow public read policy

XPA-2 deliberately closed all four academic tables to admin-only, after
discovering that a public `USING (true)` policy had exposed the unproduced
roadmap to anonymous callers (reconciliation §5). **XPA-3 must reopen only what
discovery genuinely needs, and no more.**

### The rule

> A course code is publicly visible **only if it has a published course.**
> Paths and catalogues are publicly visible as structure.

That yields exactly what a visitor needs — "this path contains these trainings,
N of which are available today" — while keeping unproduced titles, objectives
and the backlog private.

### Proposed migration 031 (to be written in XPA-3, not now)

```sql
-- Catalogues: structure only, safe to publish.
create policy "catalogues_public_select"
  on public.catalogues for select using (true);

-- Paths: the commercial offer itself — safe to publish.
create policy "learning_paths_public_select"
  on public.learning_paths for select using (true);

-- Course codes: ONLY those with a published course.
-- Unproduced codes, their titles and the backlog stay private.
create policy "course_codes_public_select"
  on public.course_codes for select
  using (exists (
    select 1 from public.courses c
    where c.code = course_codes.code and c.is_published = true
  ));

-- Path composition: only rows whose course code is publicly visible.
create policy "lpc_public_select"
  on public.learning_path_courses for select
  using (exists (
    select 1 from public.courses c
    where c.code = learning_path_courses.course_code and c.is_published = true
  ));
```

**Consequence to design around, not against:** a public path page will show
*fewer* entries than the admin view. PM-PRO recommends 7 courses; only 2 exist.
The page must state the path's full shape honestly ("7 formations, 2 disponibles
aujourd'hui") rather than silently presenting a 2-course path — otherwise the
offer looks thin and the roadmap is misrepresented. Since the count of hidden
items is itself a (small) disclosure, confirm the wording is acceptable — see
Q-E.

**Verification required after applying 031** — the same anon-key probe used in
the XPA-2 reconciliation, asserting: catalogues 3, paths 15, course_codes **6**
(not 17), and that no unproduced code (C2-F3, C2-F5, C2-F6, all C3) is returned.

## 3. Scope

### 3.1 Discovery entry points

- `/formations` (or keep `/courses` — see Q-F) — the hub: choose an axis.
- `/parcours/[code]` — professional path detail (PM-CONS … PM-DIR).
- `/secteurs/[code]` — sector path detail (SEC-TEL … SEC-ADM).
- Existing `/courses/[slug]` course detail — **unchanged**, plus a
  "fait partie des parcours…" section driven by `learning_path_courses`
  (V4 §8 names this explicitly as a fiche-de-formation feature).

### 3.2 Path pages must show

Ordered course list by `position`; socle commun flagged (`is_socle`) for sector
paths; available vs coming-soon per entry; the path `objective` and `note`
(PM-OPT's scoping note and the sector `note` fields carry real sales content);
C1-F1 presented first, always.

### 3.3 Retire pilot scaffolding

`data/seed.ts` static parcours config, `MIN_CARDS_PER_PARCOURS` padding and the
"Bientôt disponible" placeholder cards in `app/(public)/courses/page.tsx` are
superseded. Remove only after the new pages render correctly — one change,
verified, not a big-bang swap.

## 4. Files likely to change

| File | Change |
|---|---|
| `supabase/migrations/031_public_discovery_policies.sql` | **New** — §2 |
| `lib/queries/catalogue.ts` | **New** — typed reads for catalogues/paths/codes |
| `app/(public)/parcours/page.tsx` · `[code]/page.tsx` | **New** |
| `app/(public)/secteurs/page.tsx` · `[code]/page.tsx` | **New** |
| `app/(public)/courses/page.tsx` | Rework — drive from the model |
| `app/(public)/courses/[slug]/page.tsx` | Add "parcours" section only |
| `components/courses/PathCard.tsx` etc. | **New** presentational components |
| `app/sitemap.ts` | Add path URLs (course URLs still deferred) |
| `data/seed.ts` | Retire static parcours config (last step) |

**Must not change:** auth, RLS on any pre-existing table, `courses`/`modules`/
`lessons` schema, the learning player, quizzes, certificates, Voice Practice,
payments, `lib/hosts.ts`, `middleware.ts`.

## 5. Tests

1. **Anon exposure** — after 031, anon sees 3 catalogues, 15 paths, **6** course
   codes; asserts each unproduced code is absent. This is the XPA-2 regression
   guard and the most important test in the phase.
2. **Path composition** — each rendered path matches `learning_path_courses`
   ordering; C1-F1 first in all 15.
3. **Socle** — sector paths show C1-F1 + C1-F2 as socle commun.
4. **Missing content** — a path with unproduced courses renders without error
   and states the true total.
5. **No invented recommendations** — every displayed course traces to a
   `learning_path_courses` row; nothing is inferred.
6. **Course detail** — shows correct path memberships from the §8 matrix.
7. **No regression** — `/courses`, `/courses/[slug]`, learn player, dual-domain
   routing, 265 existing tests green.

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | 031 re-opens the registry too widely, re-creating the XPA-2 exposure | **High** | The published-course-only predicate; anon-probe test as a gate |
| R-2 | Public pages leak unproduced titles via joins or `select *` | **High** | Select explicit columns; RLS is the backstop, not the only control |
| R-3 | Path pages look empty (PM-PRO 2/7) and undersell the offer | Medium | Show true totals with honest "à venir" framing (Q-E) |
| R-4 | Retiring `data/seed.ts` breaks the existing course grid | Medium | Retire last, after new pages verified |
| R-5 | URL churn on `/courses` harms existing links/SEO | Medium | Keep `/courses` working; add paths alongside (Q-F) |
| R-6 | Sitemap advertises paths whose courses don't exist | Low | List paths, not unproduced course URLs |

## 7. Open questions

| # | Question | Blocks |
|---|---|---|
| **Q-E** | Path pages will show "7 formations, 2 disponibles". Is exposing the *count* of unreleased courses acceptable, or should pages show only what exists? | §2 wording, R-3 |
| **Q-F** | New routes `/parcours` + `/secteurs`, or fold both into `/courses`? French URLs suit the audience; `/courses` has existing links. | Route design |
| Q-G | Sector paths recommend PM-OPT as an entry point (V4 §7). Render as a cross-link, or leave in the `note` text as today? | Path page design |
| Q-D1 | D-Q1 remains open — no launch filtering. Confirm discovery ships without it. | Scope confirmation |

## 8. GO / NO-GO

**CONDITIONAL GO.** The data foundation is in place and verified. The work is
well-bounded and additive.

The condition is **Q-E**, because it determines the public read policy in §2 —
and that policy is the control that keeps the roadmap private. Getting it wrong
re-creates the exact exposure XPA-2 just closed. Q-F should be settled at the
same time to avoid rerouting after launch; Q-G is cosmetic.

No implementation begins until Q-E is answered.
