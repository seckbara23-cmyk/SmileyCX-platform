# CAT-ARCH — V8 catalogue architecture: closure of slices 01, 02 and 03

Marième's *Architecture des catalogues et parcours de formation — Version 8* is
the business authority for CX Academy's catalogue. CAT-ARCH-00 audited it against
the existing schema and found V8 to be a **delta** over the model migrations
028–031 already implemented, not a new architecture. This records what the first
three slices delivered, and what remains.

---

## CAT-ARCH-01 — display order becomes readable (CLOSED)

**Problem.** `course_codes.position` had meant display order since 028, but the
public catalogue sorted by `courses.code`, because the registry is deliberately
closed to `anon` (D-Q5: publishing the registry would publish the roadmap). V8's
required order — Fondations opening on C1-F4 — was therefore unreachable.

**Delivered.** Migration **056**: `public.public_catalogue_courses`, a narrow
projection of published courses only, positions re-ranked `row_number() …
partition by catalogue_code order by position, code` so a gap cannot betray an
unproduced code; plus `course_codes_catalogue_position_unique (catalogue_code,
position) DEFERRABLE INITIALLY DEFERRED`, so a whole catalogue can be reordered
in one statement. `getPublishedCoursesByCatalogue()` switched to two reads: the
view supplies membership and order, `courses` supplies content under its own RLS.

Deliberately **order-neutral** — nothing a visitor saw changed.

PR #26, merge `f0e13bc`. Applied to production 2026-09-26. Post-apply
verification 34/34 GET-only.

## CAT-ARCH-02 — the V8 registry and order (CLOSED)

Migration **057**, data only, under owner rulings R1–R4a:

| Ruling | Result |
|---|---|
| R1 | C1-F3's registry label → `Communiquer avec les clients sur les canaux digitaux`, the name every learner surface already showed |
| R2 | C2 order → F4, F1, F2, F5, with the unproduced F3/F6 appended at 5 and 6 |
| R3 | C3-F9 registered, unproduced, `objective`/`targets` NULL, status `undecided` |
| R4a | C1-F4 registered at Fondations position 1, shifting F1→2, F2→3, F3→4 |

057 wrote one table. It fingerprinted ten others before and after, asserted the
exact 19-code end state, read the visible order back through 056's own view and
refused to commit on anything else. 24/24 mutants caught offline against the live
corpus. Rollback is **partial by design** and says so: 028's
`course_codes_permanent` refuses `DELETE`, so C1-F4 and C3-F9 can never be
removed.

PR #27, merge `218ff58`. Applied 2026-09-27 20:11:02Z. Post-apply verification
34/34.

## CAT-ARCH-03 — R4b closed and the ruling caught up (this slice)

**R4b — the eighth course.** `donnez-envie-a-vos-clients-de-revenir` had been
published for weeks with `code = NULL`, so it appeared in no catalogue. It was
the single failing check on the publication governance verifier.

On **2026-09-27 at 22:06:34Z** the owner assigned it **C1-F4** through the Admin
form — the CAT-1 path CAT-ARCH-00 specified for this step, taken directly rather
than through a governed slice. The assignment is **irreversible**: 028's
`courses_code_immutable` permits `NULL → code` exactly once. No `audit_log` entry
exists because code assignment is not an audited event; publication did not
change, so no recorder fired. The evidence is `courses.updated_at`.

Ratified by the owner on 2026-09-27. **R4b is CLOSED**, and the public catalogue
now carries 8 courses with Fondations opening on C1-F4 — the V8 requirement, met.

**R4c — the ruling.** `scripts/security/publication-manifest.json` updated to
govern the approved 8-course catalogue: C1-F4 added; `developper-une-culture-client`
corrected from `code: null` to C2-F5 (production had carried C2-F5 for weeks —
the verifier keys on slug, so it never caught it); C1-F1 and C2-F1 refreshed
17 → 18 lessons. The verifier went from **1 failure to 0** (25 checks, no
notices: production matches the ruling exactly).

**Explicitly not ruled on.** The owner ratified publication while reserving the
free/paid split. C1-F4 has all 8 of its lessons flagged `is_preview`, so the
entire course is anonymously readable *and* it is now the first card in
Fondations. That number is recorded in the manifest as observation, never as
approval, and is reserved for review with Marième. **CAT-ARCH-03 changed no
preview flag**, no publication state, no code, and no migration.

---

## Current production state

```
registry      19 codes   C1-F1..F4 · C2-F1..F6 · C3-F1..F9
courses        8, all published, all coded
projection     8 rows
  Fondations   C1-F4  C1-F1  C1-F2  C1-F3
  Intermédiaire C2-F4  C2-F1  C2-F2  C2-F5
  Avancé       empty — no C3 course produced
```

`catalogues`, `course_codes`, `learning_paths` and `learning_path_courses` remain
`42501` to browser roles. The six WC-2 raw lesson media columns remain `42501`.
Learner state — entitlements, enrollments, progress, certificates — has not been
touched by any catalogue slice.

## What remains

| Slice | Purpose | Blocked on |
|---|---|---|
| CAT-ARCH-04 | path memberships to V8 | **R5** — the V8 membership tables are not in the repository |
| CAT-ARCH-05 | sector presentation metadata | **R6** — public visuals/examples, or admin-only notes? |
| CAT-ARCH-06 | admin editors for order, registry, membership | nothing — ready whenever wanted |
| CAT-ARCH-07 | derived parcours progress | **R8** — equal or lesson-count weighting |

Also open: **D-Q1** (the launch subset — no code is `status = 'launch'` and none
may be invented until the « Lancement Soft » document arrives), and the
free/paid split of C1-F4.

CAT-ARCH-06 is the highest-value next step: it would let Marième reorder the
catalogue and edit the registry herself, instead of each change requiring a
migration.
