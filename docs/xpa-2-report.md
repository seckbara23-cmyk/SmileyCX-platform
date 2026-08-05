# XPA-2 — Course Catalogue & Learning Path Foundation

**Status:** implemented · **Schema:** strictly additive · **Migrations written:** 028, 029, 030
**Source of truth:** `public/Architecture_Catalogues_Parcours_XP-Client-Academy_V4.pdf`
**Decisions applied:** [decision register](xpa-decision-register.md) D-Q1, D-Q2

> **Migrations are applied by an operator, not by CI or the app.** Writing these
> files changed no production data. See §Deployment.

---

## 1. Repository audit (before any schema)

| Area | Finding |
|---|---|
| `courses` table | 18 columns; identity = `id` (uuid) + `slug` (unique). **No code, no catalogue, no path.** |
| Slugs | 6 courses, all published. 8 code paths look courses up **by slug** — the URL key must not move. |
| Lesson relationships | `courses → modules (23) → lessons (82)`, unchanged by this phase |
| Enrollments | **0 rows** |
| Progress | **0 rows** (`lesson_progress`) |
| Certificates | **0 rows**; `quiz_attempts` 0 |
| Course discovery | `/courses` groups by a hardcoded `parcours` tri-level in `data/seed.ts` — UI config, not a DB fact |
| Admin course pages | 9 admin pages query `courses`; all by `id`, none by title |
| APIs consuming courses | 24 query sites, 73 `course_id` references; FKs from `quizzes`, `feedback`, `exercises` |

**Consequence:** because enrollments, progress, attempts and certificates are all
empty, the backfill carries **zero learner-data risk**. Nothing references a
course by title anywhere, so introducing a code alongside the slug breaks no
consumer.

## 2. Schema additions (028)

Four new tables, one nullable column, two triggers. Nothing renamed or dropped.

```
catalogues (code PK 'C1'|'C2'|'C3', title, objective, position)
      │ 1-N
course_codes (code PK 'C1-F1', catalogue_code FK, canonical_title,
              objective, targets, position, status, retired_at)
      │ 0..1
courses.code  ← NEW nullable column, UNIQUE, FK → course_codes(code)
              (id, slug, title all untouched)

learning_paths (code PK 'PM-CONS'|'SEC-TEL', kind, title, objective, note, position)
      │ N-N via
learning_path_courses (path_code, course_code, position, is_socle)
              ← references a CODE, never a course id, never a title
```

**`course_codes` is the registry, independent of produced content.** A code with
no matching `courses` row *is* a planned-but-missing course. That is how the
admin surface reports gaps without inventing placeholder courses.

**`learning_path_courses` has no content columns at all** — only a code
reference, an order and a socle flag. This is the golden rule expressed in
DDL: a path physically cannot store pedagogical content.

### Immutability is enforced, not assumed

| Guarantee | Mechanism |
|---|---|
| An assigned course code can never change or be cleared | `courses_code_immutable` BEFORE UPDATE trigger |
| A registry code can never be renamed | `course_codes_permanent` trigger |
| A registry code can never be deleted → **never reused** | same trigger rejects DELETE; retire via `status` |
| One code ↔ at most one course | `courses_code_unique` |

## 3. Backfill mapping (030)

Matched by slug; only `courses.code` is written, and only where NULL.

| Code | Course slug | Provenance |
|---|---|---|
| C1-F1 | `les-fondamentaux-de-l-experience-client` | exact title match |
| C1-F2 | `les-fondamentaux-du-service-client` | exact title match |
| **C1-F3** | `communiquer-avec-les-clients-sur-les-canaux-digitaux` | **ratified D-Q2** |
| C2-F1 | `manager-une-equipe-orientee-client` | exact title match |
| C2-F2 | `mesurer-l-experience-client` | exact title match |
| C2-F4 | `gerer-les-reclamations-…-opportunite` | exact title match |

**No pause was required for C1-F3.** The phase brief said to pause "if it still
requires a management decision" — it does not: D-Q2 approved it, on the basis
that the code is the identity and the displayed title stays editable.

**Left deliberately absent:** C2-F3, C2-F5, C2-F6 and all eight C3 codes. Their
codes exist in the registry; no course row is stubbed for them.

**Slugs and titles are untouched.** Per D-Q2 the existing slug simply *becomes*
the historical one — the repository has no slug-alias or redirect mechanism
(verified: no `redirects` in `next.config.mjs`, no slug-history table).

## 4. Catalogue & path implementation (029)

- **3 catalogues** — C1 Fondations, C2 Intermédiaire, C3 Avancé
- **17 course codes** — see the contradiction note below
- **15 paths** — 9 professional (`PM-`) + 6 sector (`SEC-`)
- **All path↔course relations**, ordered, transcribed from V4 §6/§7 and
  cross-checked against the §8 matrix

The migration asserts its own integrity and aborts on drift: exactly 15 paths,
C1-F1 at position 1 in every path, and no path referencing an unknown code.

### Source contradiction — recorded, not resolved

V4 **§9.1** lists "codes existants" as C1-F1..C1-F3 · C2-F1..C2-F5 · C3-F1..C3-F8
(**16 codes**) and omits C2-F6. But **§10** defines C2-F6 as codified-and-backlogged,
and **§9.4** gives the next available C2 code as **C2-F7** — which is only
consistent if C2-F6 is taken.

All **17** codes are seeded, with C2-F6 as `backlog` exactly as §10 states.
Reported here rather than silently reconciled.

### Launch status — D-Q1 honoured

Every code is `undecided` **except C2-F6** (`backlog`, stated by the source
document itself). Nothing is marked `launch`: the « Lancement Soft » document
defining the 7-course cohort is not in the repository, and launch status must
not be invented. The seed's `ON CONFLICT` deliberately does **not** overwrite
`status`, so re-running can never clobber a decision recorded later.

## 5. A security decision worth flagging

The four new tables were initially given public `SELECT` (`USING (true)`) on the
reasoning that catalogue structure is commercial metadata, not learner data.
**The repository's SQL linter rejected it, and it was right to.**

RLS `USING (true)` makes a table readable through PostgREST by anyone holding
the anon key, which is public by design. That would have published the **entire
product roadmap** — every unproduced course code, the backlog entry, and the
full path composition — to any anonymous caller. That directly contradicts
**D-Q5**, which ratified that the V4 architecture document must not be publicly
served; exposing its contents through an API instead of a PDF is the same
disclosure by another route.

All four tables are therefore **administrator-only** in XPA-2. Nothing public
consumes them yet — discovery is XPA-3. When XPA-3 builds public discovery it
should add a **narrow** read policy (e.g. paths plus only those codes that have
a published course), not open the registry wholesale.

## 6. Administration (read-only)

`/admin/catalogue` — new page, added to the admin nav. Shows catalogues, all
course codes with produced/missing state, launch status, the 15 paths with
ordered assignments, socle flags, per-path "produced/total" counts, and an
explicit **"Formations codifiées sans contenu"** panel.

No create/edit/delete affordance anywhere; a test asserts the page performs no
writes. Authorization is the platform standard — `requirePlatformAdmin()`
server-side, unchanged. If the migrations have not been applied, the page renders
a clear notice instead of erroring.

## 7. Files changed

**New (6):** `supabase/migrations/028_academic_model.sql` ·
`029_seed_catalogues_paths.sql` · `030_backfill_course_codes.sql` ·
`app/(admin)/admin/catalogue/page.tsx` ·
`__tests__/academic/xpa-2-academic-model.test.ts` · this report.

**Modified (2):** `app/(admin)/layout.tsx` (one nav entry) ·
`lib/brand.ts` (comment wording only — see §8).

**Unchanged:** every existing migration, all auth/RLS/session code, payments,
quiz and voice engines, the lesson player, and all 24 course-consuming call sites.

## 8. Tests — 50 new, 265 total

Because migrations are operator-applied, the tests read the **migration files**
as the artefact under review, and re-derive the path matrix from the seed to
compare against V4 §8 transcribed independently. If either drifts, the suite fails.

Proven: schema is additive (no drop/rename/truncate; exactly one nullable column
added to `courses`) · SET-clause parsing proves **only** `code` and `updated_at`
are ever written to `courses`, never `slug`, `title` or `id` · codes are immutable
(course, registry, no-delete, unique) · 17 codes with only C2-F6 backlog and zero
`launch` · 15 paths, none invented · **C1-F1 first in all 15** · each of the 15
V4 §8 matrix rows verified individually · positions contiguous and unique ·
sector socle is exactly C1-F1+C1-F2 · backfill maps exactly 6 courses and invents
none · no policy on any pre-existing table · every new write policy has
`WITH CHECK` · no migration touches auth/payments/progress/quiz/voice tables ·
**tracked migrations unmodified** (git-diff assertion) · admin page is read-only.

Three test failures during development were my own assertions matching **SQL
comments** (the rollback blocks) rather than executable SQL — fixed with a
comment-stripping helper, the same lesson the RLS linter encodes. One was a
loose regex matching a `WHERE slug =` read as if it were a rename; it now parses
SET clauses properly.

## 9. CI results

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npx vitest run` | **PASS — 265/265, 0 failed, 0 skipped** |
| `npm run lint` | **PASS** |
| `npm run lint:sql` | **PASS** — 30 migrations, 4 known baseline findings, **0 new** |
| `npm run scan:secrets` | **PASS** |
| `npm run scan:public-assets` | **PASS** |
| `npm run scan:bundle` | **PASS** |
| `npm run build` | **PASS** |

## 10. Deployment implications

1. **Migrations 028–030 are not yet applied.** They are files; an operator
   applies them. Until then the app behaves exactly as today, and
   `/admin/catalogue` shows its "not initialised" notice.
2. **Apply in order** (028 → 029 → 030). 029 and 030 are idempotent; 028 uses
   `if not exists` throughout.
3. **Zero downtime, zero data risk.** The only write to existing data is
   `courses.code`, on rows where it is NULL. Enrollments, progress, certificates
   and attempts are all empty in any case.
4. Each migration carries a **rollback block**; the schema is additive so
   rollback is clean.
5. **No environment variable changes.** No Vercel configuration changes.

## 11. Readiness for XPA-3

Ready. XPA-3 (discovery) has what it needs: 15 paths with ordered course codes,
socle flags, per-path notes, and a produced/missing signal. Two things to carry
forward:

- **Add a narrow public read policy** — the tables are admin-only today (§5).
- **D-Q1 still blocks launch status.** Discovery can render paths without it,
  but any "launch cohort" filtering waits on the « Lancement Soft » document.

---

## Confirmations

- ✅ **Additive schema only** — 4 new tables, 1 nullable column; no drop, rename or truncate
- ✅ **Immutable course codes introduced** — enforced by triggers, not convention; retired codes can never be reused
- ✅ **Existing slugs preserved** — no slug written anywhere, proven by SET-clause analysis
- ✅ **Existing titles preserved** — same proof
- ✅ **No authentication changes** — no auth file touched
- ✅ **No payment changes**
- ✅ **No Voice Training changes**
- ✅ **XPA-3 has not begun** — no discovery UI, no recommendations generated
