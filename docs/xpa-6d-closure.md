# XPA-6D — Content Protection: CLOSED

**Status: ✅ CLOSED — production PASS** (verified 2026-08-12)
**Baseline:** `c1910d6` (XPA-6B closed) — not reopened or modified
**Migration applied:** 038 — applied to `eqoqcxkdcxeosjqaafhs` on 2026-08-12

**The invariant this phase establishes, across both subsystems:**

> No learner-facing payload may contain an authoritative answer key before
> scoring.

---

## Production verification — 22 checks, 0 failures

`scripts/security/verify-xpa-6d.mjs`, run against production as a **real
entitled learner with a real JWT**. Anonymous denial would prove nothing here:
B-4 was always about the caller who is *supposed* to see the question.

### Quiz

| Check | Result |
|---|---|
| entitled learner reads learner-safe fields | ALLOWED, 3 rows |
| entitled learner reads `correct_answer` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner reads `drag_match_answers` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner reads `explanation` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner `select=*` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner mutates `correct_answer` | **refused 403 42501** |
| answer key after the attack | byte-identical |
| service role reads the key (scoring path) | ALLOWED, 3 rows |

### Exercise

| Check | Result |
|---|---|
| entitled learner reads learner-safe fields | ALLOWED, 2 rows |
| learner payload columns | `id,exercise_id,label,order_index` — **no mapping** |
| nested lesson-page payload | `id,label,order_index` — **no mapping** |
| **enrollment alone grants exercise access (Q-L)** | **DENIED_EMPTY, 0 rows** |
| entitled learner reads `correct_category_id` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner `select=*` | **REFUSED_BY_PRIVILEGE 403 42501** |
| entitled learner mutates `correct_category_id` | **refused 403 42501** |
| answer key after the attack | byte-identical |
| service role reads the key (scoring path) | ALLOWED, 2 rows |
| service role manages the key (admin path) | 204 |
| synthetic fixture cleanup | 0 exercises, 0 entitlements, 0 enrollments, 0 stray accounts |

**The verifier was proved to detect the defect before it was fixed.** Run
against production *before* 038, it failed **11 of 21** checks. A security probe
that has never been observed failing is not evidence.

### XPA-6B regression check

`scripts/security/verify-xpa-6a.mjs` — **57 checks, 0 failures**. One expectation
was strengthened by this phase; see *Changes to the XPA-6B verifier* below.

---

## The two findings

### B-4 — quizzes (known, retained from XPA-6A)

**Root cause:** `quiz_questions_visible` (036) is `FOR SELECT USING
has_course_access(...)`. **RLS is row-level.** A learner satisfying that
predicate could select every column. `anon` and `authenticated` held a
table-level grant, so the column boundary did not exist.

**Reproduced in production** with a disposable entitled learner:

```
select=*                 rows=3  leaked=["correct_answer","explanation","drag_match_answers"]
select=id,correct_answer [{"correct_answer":0},{"correct_answer":1},{"correct_answer":1}]
```

The learner UI hand-picked safe columns, so the key never leaked *by accident* —
but that is UI hiding, not protection.

### Exercises — discovered during this phase, and worse

**Root cause:** two compounding defects.

1. `app/(learn)/.../[lessonId]/page.tsx` is a `'use client'` component using the
   **browser** Supabase client, and it selected `correct_category_id` outright.
2. `ExerciseBlock` then computed `placements[item.id] === item.correct_category_id`
   **in the browser**.

**Severity difference.** B-4 required crafting a PostgREST query the UI never
issues. The exercise defect shipped the key to every learner on every lesson
render, where it was visible in DevTools with no effort, and correctness was
decided client-side — so a learner could score themselves. B-4 was an exposure;
this was an exposure *plus* an integrity hole.

**Both were latent in practice**: production holds 0 exercises, and no account
held an entitlement. The structures were live; the data was not.

### A third finding, found while building the verifier

The exercise verifier kept returning `DENIED_EMPTY` for an entitled learner.
That was not protection — it was `exercises_select` (023) still predicating on
an ACTIVE row in `enrollments`. Proved against production:

| Probe learner | Rows |
|---|---|
| no entitlement, no enrollment | 0 |
| **entitlement only** — the ratified seam | **0** |
| **+ enrollment** — the rule XPA-6B abolished | **1** |

Every other content table moved to `has_course_access()` in 035/036; exercises
were missed. So exercises granted on the superseded rule and denied the learners
the ratified one entitles — an XPA-6B regression in a subsystem nobody
re-checked. Fixed here because it is the access model for the very rows this
migration protects: withholding a column is hollow if the row reaches the wrong
person.

---

## The security architecture

**Column privileges, not a view or an RPC.** Every legitimate reader of both
keys was already the service role:

| Path | Client |
|---|---|
| quiz scoring — `app/actions/quiz.ts` | `createAdminClient()` |
| quiz admin read/write | `createAdminClient()` |
| exercise admin read/write | `createAdminClient()` |
| exercise scoring — `app/actions/exercise.ts` | `createAdminClient()` **(changed in 038)** |

No legitimate path read these columns as `anon` or `authenticated`, so the
smallest coherent change was to stop granting them. A learner-safe view would
add an object to maintain and leave the base table reachable; an RPC would
duplicate a scoring path that already exists.

**RLS governs which rows. Privileges govern which columns.** Both are required.

### Learner-safe contracts

| Table | Granted to `anon`/`authenticated` | Withheld |
|---|---|---|
| `quiz_questions` | `id, quiz_id, question, options, order_index, question_type, question_image_url` | `correct_answer`, `drag_match_answers`, `explanation` |
| `exercise_items` | `id, exercise_id, label, order_index` | `correct_category_id` |

`explanation` is withheld deliberately — it explains *why* an answer is right
and therefore reveals it. It is still shown after submission, from the scoring
action's generated payload, never from a table read.

### Client-side scoring removed

`ExerciseBlock` no longer receives, references, or compares the key:

- `ExerciseItem` lost `correct_category_id`.
- The `pilotMode` branch that graded in the browser is **deleted**. The server
  action already scored for everyone and persisted only for authenticated users,
  so no case needed it.
- `correctPlacements` is now derived from the **server's** `itemResults`, which
  is null before submission — so there is nothing to reveal early.
- Scoring arithmetic was extracted to `lib/exercises/scoring.ts`, the single
  scoring path, unit-tested without a database.

---

## Migration boundary

**One migration, 038.** Quiz and exercise protection are the same operation
(column privileges on a content table) enforcing the same invariant, and they
share one assertion harness. Splitting them would have duplicated ~90 lines of
verification to no benefit. The `exercises_select` policy correction lives in
the same file because it governs the rows whose columns the same file protects;
separating them would allow a state where one is applied and not the other.

**038 wraps itself** in `begin`/`commit`. 037 declared "run as a SINGLE
TRANSACTION" without wrapping itself, leaving atomicity to the operator's tool —
recorded in the XPA-6B closure, corrected here.

**037 was not edited.** Asserted by a test.

### Apply-time verification inside 038

~30 guards, all classifying outcomes rather than pattern-matching one SQLSTATE:
withheld columns unreadable by both app roles; `select *` refused; the
learner-safe projection still **working** (a seam that denies everyone is broken,
not secure); no writes; service-role scoring intact; the exact column-privilege
matrix; no surviving table-level grant; and `exercises_select` consulting
`has_course_access` and not `enrollments`.

---

## Regression coverage

`__tests__/security/xpa-6d-answer-key-protection.test.ts` — **19 tests**, two
named so the defects cannot silently return:

- `XPA-6A finding B-4 — quiz_questions.correct_answer must not reach a learner`
- `XPA-6D — exercises must not ship correct_category_id to the browser`

Covering: the 038 grant/revoke shape for both tables; no learner-facing
projection naming a key column; `ExerciseBlock` neither holding nor comparing
the key; both actions reading via the admin client; no browser file referencing
the service role; scoring behaviour (all-correct, all-wrong, partial rounding,
unplaced-item, empty exercise); and migration discipline.

**Two test-design notes worth keeping.** Assertions run on comment-stripped
source and on the extracted `.select(...)` projections, not raw file text —
because these files legitimately *mention* the key columns in comments
explaining why they must not be selected, and because `explanations` (the
feedback payload) contains `explanation` as a substring. A blunt `toContain`
check fails on correct code and passes on commented-out leaks.

Local suite: **544 tests / 18 files**, up from 525 / 17.

---

## Changes to the XPA-6B verifier

`verify-xpa-6a.mjs`'s `anon quiz_questions.correct_answer` check expected
`DENIED_EMPTY` — the column was granted and only RLS withheld the rows, which is
precisely what B-4 exploited. After 038 the correct answer is `EXPECTED_DENIAL`
(42501), refused before RLS is consulted. The expectation was strengthened, not
relaxed: accepting `DENIED_EMPTY` again would mean the grant had returned.

---

## Stale documentation corrected

`docs/xpa-0-audit.md` recorded "*correct answers never sent to client*". The
repository disproves it — `app/actions/quiz.ts` returns `correctAnswers`,
`multipleAnswerCorrect`, `dragMatchAnswers` and `explanations`, and the
final-exam page renders them at four sites. Correct answers **are** sent,
deliberately, after submission. The audit now carries a dated correction that
distinguishes authoritative key exposure (a defect, now closed) from generated
post-submission feedback (intended product behaviour, preserved).

---

## Residual risks

1. **Harvest-and-retry (accepted, not closed).** `app/actions/quiz.ts` returns
   feedback for **every** question in the quiz, and retries are permitted. A
   learner may submit once deliberately wrong, harvest the full key from the
   response, and retry to pass. This is a product decision — narrowing the
   payload changes the learner feedback experience — and was explicitly
   deferred rather than invented. Proposed remedy: return feedback only for
   questions actually answered, and only on a passing or final attempt.
2. **Exercise scoring is not verified end-to-end in production.** The verifier
   proves the data path scoring depends on — service role can read the key, the
   learner cannot — but does not invoke the Next.js server action. The
   arithmetic is covered by unit tests. Stated plainly rather than implied.
3. **Zero production content.** 0 exercises and 0 entitlements exist; every
   production result above comes from synthetic fixtures, cleaned deterministically.
4. **038 ledger row absent** if applied via the dashboard SQL editor rather than
   `supabase db push`, consistent with 031–034 and 037 (D-LEDGER). Not repaired,
   by decision.
5. **`exercise_answers.is_correct`** remains learner-readable. It is the
   learner's own graded result, not a reusable key, and is correct as-is.
6. **Verifier naming**, inherited: XPA-6B's gate is still a file called
   `verify-xpa-6a.mjs` printing `XPA-6A PASS`.

---

## Explicit exclusions

Not touched, by instruction: XPA-6C corporate evaluation · XPA-7 B2B
organizations · XPA-9 payments · XPA-1 branding and public-asset remediation ·
the six untracked `public/` files · general lint cleanup · unrelated refactors.

The uncommitted comment-only edit to `037_entitlements.sql` in the working tree
was **not** staged and remains uncommitted.

---

## Is XPA-6C safe to begin?

**Yes.** Both answer-key exposures are closed at the database boundary and
verified in production. The access seam is now consistent across every content
table — lessons, modules, quizzes, and finally exercises all resolve through
`has_course_access()`, so XPA-6C inherits one access model rather than two.

Two things XPA-6C should carry forward rather than rediscover: the
harvest-and-retry decision above needs an owner, and any new assessment surface
must be added to `verify-xpa-6d.mjs`'s projections — the script deliberately
hard-codes the learner-safe column lists so that widening a projection breaks
the verifier rather than silently widening the blast radius.
