# XPA-8 WC-1 — Withdrawal contract: CLOSED

**Status:** ✅ CLOSED — production PASS
**Migration:** `supabase/migrations/050_withdrawal_contract.sql`, applied to production on **16 September 2026**
**PR:** #19 · reviewed head `b53314b2174afae7a3b3a707f4d49daed22184ce` · merge `92fce222a589b7c3edad1019284d7f402bec5aee`
**Debt record:** [xpa-8-withdrawal-contract-gap.md](xpa-8-withdrawal-contract-gap.md)
**Design:** [xpa-8-withdrawal-contract-proposal.md](xpa-8-withdrawal-contract-proposal.md) — Option A

**The contract, now enforced in the database:**

> Anonymous and unentitled preview visibility requires BOTH that the lesson is a preview AND
> that its course is published. Entitled learner access stays independent of publication.
> Withdrawal never touches preview flags.

---

## What was wrong

Ratified in 035 and 037: *publication controls discovery, never access.* The access half held.
The discovery half did not. `lessons_visible` (036) admitted a lesson on `is_preview = true`
alone, and `modules_visible` admitted a module on `module_has_preview_lesson()` alone, so a
**withdrawn** course kept serving its preview lessons, their modules and their object paths to
anonymous and unentitled callers.

It happened twice through ordinary authoring (C2-F2, 17 August; culture-client, 20 August). Each
time a corrective migration cleared the flags by hand (045, 048, and again inside 049), which
destroyed authoring state and treated the incident rather than the cause.

## What changed

| Object | Change |
|---|---|
| `public.course_is_published(uuid)` | **new** — `STABLE SECURITY DEFINER`, `search_path = public, pg_temp`, `coalesce(…, false)`; EXECUTE revoked from PUBLIC, granted to `anon` and `authenticated` |
| policy `lessons_visible` | `ALTER POLICY … USING`: preview arm now also requires `course_is_published(course_of_lesson(id))`; entitled arm byte-identical to 036 |
| policy `modules_visible` | `ALTER POLICY … USING`: preview arm now also requires `course_is_published(course_id)`; entitled arm byte-identical to 036 |

Nothing else: no helper redefined, no other policy altered, and no row committed — the section 5
fixture writes transient rows inside the transaction and rolls them back.

The migration verifies itself at apply time, in one REPEATABLE READ transaction:

| § | Assertion |
|---|---|
| 0 | refuses unless both policies are the 036 forms and `has_course_access()` does not reference publication |
| 2 | new form in place; roles unchanged; publication tested **exactly once**, never on the entitled arm; helper is DEFINER with EXECUTE for both roles |
| 3 | every content table and both public views readable as `anon` and `authenticated` (no `42P17`) |
| 4 | rows visible to anon equal an independent count of preview lessons on published courses |
| 5 | a synthetic course goes publish → withdraw → republish, read as anon at each step, the flag surviving; rolled back via a caught sentinel (`XW050`) and proven gone |

---

## Release evidence

| Gate | Result |
|---|---|
| Offline proof | exact file applied to PostgreSQL 17 (PGlite) with the access helpers, policies, views and 053 recorder extracted verbatim; defect reproduced before 050, full regression matrix passed after — including an entitled learner keeping a withdrawn course they hold, and admins unaffected |
| Migration mutants | **12/12** abort at apply time, including the 035 recursion cycle (`42P17`) and a publication test leaking onto the entitled arm |
| Structural suite | `__tests__/security/wc-1-withdrawal-contract.test.ts` — 26 tests; **12/12** suite mutants caught |
| Repository gates on `b53314b` | 45 files, 1302/1302 tests; typecheck, lint, ESLint (0 errors), `lint:sql`, build (70 routes), `audit:prod`, secret, bundle and public-asset scans |
| GitHub, PR head `b53314b` | **7/7**: Typecheck · Lint · Test, Production build, Secret scan, RLS / migration lint, Dependency audit, Vercel Preview Comments, Vercel |
| GitHub, merge `92fce22` (push to `main`) | **5/5** CI and Security jobs |
| Merge integrity | parents `773479d` + `b53314b`; tree identical to the reviewed head; exactly the 7 reviewed files, content-identical |
| Vercel production | `dpl_EkwpvgjRxqzSyuP2Q8LWdh4KxmMk`, READY on `92fce22` |

## Production application — 16 September 2026

**Method.** Applied once, whole and unmodified, by the owner in the Supabase SQL Editor, after
pre-apply checks confirmed `main` at `92fce22`, the file content-identical to the reviewed
version (`69f413e24545`), production READY on that SHA, and the helper absent. Not re-run.

**Result.** The editor reported *Success. No rows returned* and no error. It displayed none of
the five `WC-1 050` notices; the SQL Editor does not surface `RAISE NOTICE` output for scripts, so
their absence is not evidence of failure. Commit was established from the database instead.

Applying through the SQL Editor writes no CLI migration-ledger row, consistent with the
existing D-LEDGER practice.

### Evidence the transaction committed

Every probe was a GET request; nothing was written.

| Evidence | Before apply | After apply |
|---|---|---|
| `course_is_published` in the API schema | absent | **present** |
| anon call, unknown id | 404 `PGRST202` | **200 `false`** — fail-closed, and the anon grant applied |
| anon call, published course | — | **200 `true`** |
| helper agrees with `is_published` | — | **8/8** courses |

The file is one transaction: the preflight, the helper, both policy changes and verification
sections 2 to 5 all run before a single final COMMIT, and any failed assertion raises and rolls
everything back. The helper therefore exists only if every section passed and the whole
transaction committed. The section 5 fixture left no trace: course, lesson, module and
`audit_log` counts are all unchanged.

### Contract in production

| Check | Result |
|---|---|
| anon reads of `lessons` / `modules` | HTTP 200 — no `42P17`, no 5xx |
| anon-visible lessons | **24**, exactly the preview lessons of published courses |
| non-preview lessons visible to anon | **0** |
| anon-visible modules | **14**, exactly the modules holding a published preview |
| anon quizzes / quiz questions / exercises | 0 / 0 / 0 |
| catalogue and both public views | readable; 8 courses |

### Invariants, before → after

| Invariant | Before | After |
|---|---|---|
| courses / published | 8 / 8 | **8 / 8** |
| preview flags | 24 | **24** |
| per course | C1-F1 6 · C1-F2 4 · C1-F3 0 · C2-F1 0 · C2-F2 1 · C2-F4 0 · C2-F5 5 · 8th course 8 | **identical** |
| course `updated_at` (all 8) | — | **unchanged** |
| lessons / modules | 127 / 34 | **127 / 34** |
| entitlements / enrollments | 7 / 6 | **7 / 6** |
| lesson_progress / certificates | 45 / 2 | **45 / 2** |
| audit_log | 14 | **14** |

### Publication governance

`publication_governance_installed()` is still **true**, and all three 053 recorders are installed
and ENABLE ALWAYS. `verify-publication-governance.mjs` (read-only) reports no publication drift
and every access-authority check green. Its single failure — **course set 8 observed / 7
approved** — is the **pre-existing** drift from `donnez-envie-a-vos-clients-de-revenir`,
recorded in Phase 0 before 050 was written and held for owner / Marième confirmation. It is
**outside WC-1** and was not caused by it.

---

## Limits of the production evidence — recorded, not hidden

- **The policy text was not read directly.** `pg_policy` is not reachable over the REST API.
  The committed transaction is the evidence that section 2's form assertions passed. The owner
  may confirm with a read-only query in the SQL Editor:
  `select polname, pg_get_expr(polqual, polrelid) from pg_policy where polname in ('lessons_visible', 'modules_visible');`
- **Withdrawal behaviour was not exercised against real production data.** Every course is
  published, and no course was withdrawn to manufacture a test. The behaviour was proven by the
  section 5 fixture inside the committed transaction and by the offline matrix.
- **Entitled-learner and admin paths were not probed in production.** That needs real sessions,
  and `verify-xpa-6a` creates accounts and mutates rows by design. They are covered by the
  apply-time structural assertions and the offline proof. `verify-xpa-6a`, re-based by WC-1 onto
  published courses, has **not** been run against production.

## Operational effect

The next time a course carrying preview flags is withdrawn, its preview lessons and modules
disappear from anonymous and unentitled callers without any corrective migration, and the flags
are kept. Republishing restores the teaser exactly. Nobody needs to clear flags by hand.

**Rollback** — the commented block at the foot of migration 050 restores the exact 036
policies and then drops the helper. It re-opens the gap and touches no data.

## Not in WC-1

- **WC-2** — storage object path and legacy URL disclosure. A separate work item, recorded
  locally as a proposal; **no WC-2 work is included here**.
- The 86 legacy `video_url` / `pdf_url` values — untouched.
- C2-F2 and C2-F5 empty lessons — AUTHOR / COMPLETE ruling stands; no content changed.
- `donnez-envie-a-vos-clients-de-revenir` — HOLD: not unpublished, no code assigned, preview
  flags untouched.
- Migrations 052 and 053 byte-identical; 046 withdrawn; 051 reserved.
