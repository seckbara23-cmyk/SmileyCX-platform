# XPA-6B — Enrollments & Course Entitlements: CLOSED

**Status: ✅ CLOSED — production PASS** (verified 2026-08-12)
**Commits:** `fa4164a` (implementation) · `5bcffa4` (037 privilege contract) · `74d81d4` (037 outcome classification) · `fe64b8f` (CI re-run)
**Migration applied:** 037 — applied to `eqoqcxkdcxeosjqaafhs` on 2026-08-12

---

## Production verification — 57 checks, 0 failures

Run from this repository against `eqoqcxkdcxeosjqaafhs` using
`scripts/security/verify-xpa-6a.mjs`, which carries XPA-6B's assertions (see
*Verifier naming* below). Boundary probes use the **public anon key** or a **real
learner JWT**, so every result is what that caller actually receives.

| # | Check | Result |
|---|---|---|
| 1 | anon reads `modules` / `lessons` / `quizzes` / `quiz_questions` | **DENIED (200, 0 rows)** ×4 |
| 2 | anon reads `correct_answer` | **DENIED (200, 0 rows)** |
| 3 | anon reads `courses` (catalogue) | ALLOWED, 6 rows |
| 4 | anon reads `entitlements` (base table) | refused `401 42501` |
| 5 | anon INSERT / UPDATE / DELETE `entitlements` | `REFUSED_BY_PRIVILEGE` ×3 |
| 6 | anon reads `my_course_access` | refused `401 42501` |
| 7 | verified learner, no enrollment, reads content | **DENIED (200, 0 rows)** ×4 |
| 8 | **ACTIVE enrollment alone grants access** | **`false`** — the Q-L invariant |
| 9 | `has_course_access()` with an ACTIVE entitlement | `true` |
| 10 | entitled learner reads lessons | ALLOWED, 17 rows — that course only, not all 82 |
| 11 | entitled learner reads `my_course_access` | ALLOWED, 1 row, safe columns only |
| 12 | **entitled** learner reads `entitlements` | refused `403 42501` |
| 13 | learner INSERT `my_course_access` | `REFUSED_BY_VIEW` `500 55000` (database-level) |
| 14 | learner UPDATE / DELETE **unfiltered** | `REFUSED_BY_API` `400 21000` |
| 15 | learner UPDATE / DELETE **filtered** | `REFUSED_BY_VIEW` `500 55000` (database-level) |
| 16 | all five write probes left data byte-identical | ✅ ×5 |
| 17 | suspension removes access at once | `false` — no job in the loop |
| 18 | reinstatement restores access | `true` |
| 19 | expiry removes access without a cron job | `false`, row still `ACTIVE` |
| 20 | revocation preserves the enrollment | 1 enrollment intact |
| 21 | `super_admin` reads content | 23 modules, 82 lessons, 1 quiz, 3 questions |
| 22 | prior phases intact | 11 ai_sessions, 36 ai_turns, 4 drafts unpublished, previews 0 of 82 |
| 23 | probe fixtures cleaned up | 0 leftovers, 0 enrollments, 0 entitlements |

**The invariant that defines this phase is #8.** An ACTIVE enrollment now grants
nothing. Access comes from an entitlement and only from an entitlement, which is
decision Q-L option B. Items 17–19 are the other half: suspension and expiry
withdraw access *immediately*, computed at read time, with no materialisation
job that could lag or fail.

---

## The gap this closure exposed: committed is not deployed

XPA-6B was implemented in `fa4164a`, corrected twice, and pushed green. It was
treated as done. It was not deployed.

The first production run of the verifier failed **15 of 53 checks**, every one
tracing to a single cause:

```
entitlements      404 PGRST205  Could not find the table 'public.entitlements'
my_course_access  404 PGRST205  Could not find the table 'public.my_course_access'
```

That is the **service role** — the reply is not RLS, it is absence. Migration
037 had never been applied. For six days the repository described an entitlement
model that production did not have, and production kept running XPA-6A's rule,
under which the verifier duly reported:

```
✗ enrollment alone grants NO access        true     ← it granted
✗ suspension removes access at once        true
✗ expiry removes access without a cron job true
```

**Blast radius: none.** `enrollments` held 0 rows throughout, so no learner ever
held access by the superseded rule. The weakness was latent, not live.

**The lesson, recorded because it is the third of its kind.** XPA-6A's incidents
were about a *migration that failed to apply* and *a probe that could not tell
DENIED from BROKEN*. This one is about a migration that was never attempted at
all — and about phase closure being declared from the repository's state rather
than the database's. A phase is not closed because CI is green. CI proves the
code compiles and its tests pass; it says nothing about whether the schema those
tests assume exists in production. **Only a probe against production closes a
phase.**

---

## The verifier defect found while closing

With 037 applied, two checks still failed:

```
✗ learner UPDATE my_course_access refused   BROKEN:400:21000
✗ learner DELETE my_course_access refused   BROKEN:400:21000
```

`21000` is `cardinality_violation`. Measured directly rather than reasoned about:

| Probe | Result |
|---|---|
| UPDATE **unfiltered** | `400 21000` — *"UPDATE requires a WHERE clause"* |
| UPDATE **filtered** | `500 55000` — *"cannot update view my_course_access"* |
| DELETE **unfiltered** | `400 21000` — *"DELETE requires a WHERE clause"* |
| DELETE **filtered** | `500 55000` — *"cannot delete from view my_course_access"* |

PostgREST refuses an unfiltered `PATCH`/`DELETE` itself, before the statement
reaches Postgres. So the classification was wrong — a refusal scored as BROKEN,
the **fourth** variant of the mistake catalogued in 037's own header.

But the classification was the smaller half. **An unfiltered probe never
exercises the view at all.** The check claimed to prove "a learner cannot write
through `my_course_access`" while actually proving "PostgREST rejects unfiltered
writes". Those are different statements and only the second was being tested.
The security invariant had never been verified — it happened to hold.

**Fix, in `scripts/security/verify-xpa-6a.mjs`:**

1. `classifyWrite()` names `21000` as `REFUSED_BY_API` — a refusal, not a fault.
2. Every view write is probed **both** ways. The unfiltered form documents the
   API guard; the **filtered** form reaches the rewriter and must be refused by
   the **database** (`REFUSED_BY_PRIVILEGE` or `REFUSED_BY_VIEW`).
   `REFUSED_BY_API` is explicitly *not* accepted where a database-level refusal
   is required, so a probe that stops short can never again read as a pass.

Check count rose 53 → 57. The two new filtered probes both return `55000`.

---

## What XPA-6B delivered

**The entitlement as the unit of commercial access.** `entitlements` carries
provenance (`source`, `granted_by`, `granted_reason`, `external_ref`), a validity
window (`starts_at`, `expires_at`) and a revocation record (`revoked_at`,
`revoked_reason`). `has_course_access()` consults it; an enrollment is learning
history and grants nothing.

**No app role holds any privilege on `entitlements`.** Not anon, not
authenticated. Reads and writes alike answer `42501` — for an entitled learner
too (#12). Commercial provenance is not learner-visible data.

**`my_course_access` is the learner's only window**, exposing exactly
`course_id`, `has_access`, `access_ended` — verified to carry no `source`,
`granted_by`, `granted_reason`, `external_ref`, `status` or timing column. It
aggregates with `GROUP BY`, so it is not auto-updatable and writes are refused
structurally, before privileges are consulted (#13, #15).

**Lifecycle without a scheduler.** Suspension, expiry and reinstatement are
computed at read time. An expired entitlement stops granting access while its
row stays `ACTIVE` and unmutated (#19) — no job to lag, fail, or be replayed.

**Admin grant path** at `app/(admin)/admin/entitlements/` with server actions in
`app/actions/entitlements.ts`, audited via `lib/audit/log.ts`.

---

## Migration ledger

| Migration | Individually verified | Ledger |
|---|---|---|
| 001–027 | mixed | **unreconciled** (D-LEDGER) |
| 031–034 | ✅ by observed effect | **unreconciled** |
| 035 learner identity and access | ✅ | reconciled |
| 036 content policy recursion fix | ✅ | reconciled |
| **037 entitlements** | ✅ **57-check production PASS** | **unreconciled** |

037 was applied through the Supabase dashboard SQL editor, not `supabase db
push`, so no CLI ledger entry was written. It joins 031–034: the object exists
and is verified by observed effect; what is missing is the ledger row. **Not
repaired, by decision** — consistent with D-LEDGER.

One caveat worth recording: the file declares *"Run as a SINGLE TRANSACTION"* but
**does not wrap itself** in `BEGIN`/`COMMIT`. Atomicity depended on the executing
tool. It applied cleanly and the 57-check probe confirms the end state, but the
next migration to carry an apply-time assertion block should wrap itself rather
than rely on the operator.

---

## Residual risks

1. **Verifier naming.** XPA-6B's production gate is a file called
   `verify-xpa-6a.mjs` that prints `XPA-6A PASS`. Coverage was folded in by
   `5bcffa4` (+156 lines) and `74d81d4` (+60). Duplicating it into a
   `verify-xpa-6b.mjs` would create ~200 lines destined to drift, so it was not
   done. The honest fix is to rename it to something phase-neutral
   (`verify-access-model.mjs`) once no document references the old name.
2. **037 ledger row absent** — see above.
3. **Zero production entitlements.** The model is verified but unexercised by
   real commercial traffic; every result above comes from synthetic fixtures.
4. **`quiz_questions.correct_answer` remains exposed to entitled learners** —
   finding B-4, unchanged by this phase and the whole subject of XPA-6D below.

---

## Explicitly out of scope

Automated payments (XPA-9), corporate evaluation (XPA-6C), B2B organizations
(XPA-7), branding and public-asset remediation (XPA-1). None were touched.

---

## Handoff to XPA-6D — content protection

B-4 is now the oldest open security finding. The static audit is done and the
root cause is not in doubt:

`quiz_questions_visible` (migration 036) is `FOR SELECT USING
(has_course_access(course_of_quiz(quiz_id)))`. **RLS is row-level.** Any learner
satisfying that predicate may select every column, `correct_answer` included.
The learner UI hand-picks safe columns in
`app/(learn)/learn/[courseSlug]/[moduleId]/quiz/page.tsx` and
`app/(learn)/learn/[courseSlug]/final-exam/page.tsx`, but that is UI hiding —
substituting `select=*` against PostgREST returns the key.

**The favourable finding:** scoring is already server-side.
`app/actions/quiz.ts` reads `correct_answer` through `createAdminClient()`
(service role), not the learner session. Removing the learner's access to that
column should therefore not break scoring — which points at a column-privilege
and learner-safe-projection change rather than a new quiz engine.

**Open question for XPA-6D §7:** `app/actions/quiz.ts` returns `correctAnswers`,
`multipleAnswerCorrect`, `dragMatchAnswers` and `explanations` after submission.
That is a deliberate feedback payload rather than raw table exposure, but it
returns the whole quiz's key on completion. Whether that is intended product
behaviour is not settled by any document in `docs/` and must be decided, not
invented.
