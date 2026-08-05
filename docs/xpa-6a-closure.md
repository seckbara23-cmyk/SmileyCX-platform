# XPA-6A — Commercial Registration, Learner Identity & Domain Separation: CLOSED

**Status: ✅ CLOSED — production PASS** (independently verified 2026-08-06)
**Commits:** `943bea3` (implementation) · `a554023` (D-ACCESS) · `5c40a90` (035 correction) · `4e0e0be` (036 recursion fix) · `00b41c4` (XPA-6B brief)
**Migrations applied:** 035, 036

---

## Production verification — 32 checks, 0 failures

Re-run independently from this repository against `eqoqcxkdcxeosjqaafhs` using
`scripts/security/verify-xpa-6a.mjs`. Boundary probes use the **public anon key**
or a **real learner JWT**, so results reflect what those callers actually get.

| # | Check | Result |
|---|---|---|
| 1 | anon reads `modules` / `lessons` / `quizzes` / `quiz_questions` | **DENIED (200, 0 rows)** ×4 |
| 2 | anon reads `correct_answer` | **DENIED (200, 0 rows)** |
| 3 | anon reads `courses` (catalogue) | ALLOWED, 6 rows |
| 4 | anon reads `legal_acceptances` | refused `401 42501` |
| 5 | verified learner, **no enrollment**, reads content | **DENIED (200, 0 rows)** ×4 |
| 6 | `has_course_access()` un-enrolled | `false` |
| 7 | learner INSERT `legal_acceptances` | refused `403 42501` |
| 8 | learner self-sets `account_status` | refused `403 42501` |
| 9 | `has_course_access()` **with** an ACTIVE enrollment | `true` |
| 10 | enrolled learner reads lessons | **ALLOWED, 17 rows** — that course only, not all 82 |
| 11 | `super_admin` reads content | ALLOWED — 23 modules, 82 lessons, 1 quiz, 3 questions |
| 12 | pilot Voice Practice data | **11 sessions, 36 turns**, 4 drafts unpublished |
| 13 | `ai_scenarios` / `course_codes` / `catalogues` / `learning_paths` | all still private |
| 14 | preview lessons | 0 of 82 |
| 15 | probe accounts + enrollment cleaned up | 0 leftovers, 0 enrollments |

**The distinction that matters.** Every content denial now reads
`DENIED (200, 0 rows)` — the policy ran and said no. One commit earlier the same
checks read `42P17`, the policy failing to run at all. Item 10 is the other half:
a seam that denies everyone is broken, not secure, and **17 rows scoped to the
enrolled course** is what proves it grants correctly.

**Live surface:** apex `308` → www; `/`, `/courses`, `/parcours`, `/secteurs`,
`/signup`, `/login`, `/terms`, `/privacy` and course detail pages all `200`;
`/dashboard` redirects anonymous callers to `/login`; the internal host still
admits nobody anonymously. **CI:** five checks green on `00b41c4`.

---

## What XPA-6A delivered

**Public registration, without re-opening SEC-1.** `disable_signup` stays TRUE
permanently — `POST /auth/v1/signup` remains closed to the internet and the
deploy gate still fails the build if it is switched off. Registration is a server
action on the admin API behind: commercial host → Zod → CAPTCHA seam → rate limit
(IP + email) → current legal version → `createUser(unconfirmed)` → legal
acceptance (fails closed, rolls the account back) → profile with `platform_role`
from a literal → verification email → audit.

**Mandatory email verification.** Verified against the project: an unconfirmed
user cannot sign in (`email_not_confirmed`), the token is single-use (replay →
`otp_expired`), and generating a link does not overwrite the learner's chosen
password.

**Domain separation.** Ordinary learners on the internal host are redirected to
the commercial domain with their session intact. Learner emails are composed from
`PUBLIC_SITE_URL` and are structurally incapable of carrying the deployment
hostname. Authorization never consults the hostname.

**The course-access seam.** `has_course_access()` — admin, or a verified, active
learner with an ACTIVE enrollment. This closed a blocker where **82 of 82
lessons, 23 of 23 modules and 3 of 3 quiz questions (including
`correct_answer`)** were readable by any anonymous caller.

**One admin gap closed.** `app/(admin)/admin/page.tsx` was the only one of 42
entry points relying solely on its route-group layout while itself using the
service-role client.

---

## The two incidents, and what they cost

### Incident 1 — migration 035 failed to apply (42703)

`current_account_status()` is `language sql`, which PostgreSQL **fully
parse-analyses at CREATE time**. It read `profiles.account_status`, but the
`ALTER TABLE` adding that column came later in the file. A second defect was
hiding behind it: the `profiles_update_own` policy pinned `disabled_at` with an
inline subquery on `profiles`, which would have raised `42P17` on the next run.

Rolled back atomically; nothing was patched by hand.

### Incident 2 — migration 035 applied into an outage (42P17)

`lessons_visible` queried `modules`; `modules_visible` queried `lessons`. All
four content tables became unreadable by **every** caller that goes through RLS,
including platform admins. Fixed by migration 036: no content policy may query
another RLS-protected table; every cross-table lookup goes through a SECURITY
DEFINER resolver.

Public pages stayed up throughout — the catalogue reads `courses`, and HOTFIX-2's
graceful degradation absorbed the curriculum-outline error.

### The lesson, recorded because it is a habit and not a line of SQL

**Structural verification is not verification.** Migration 035 passed every check
it had — grants, column existence, policy text — while its policies were
unevaluatable. A policy can be perfectly formed and still not run.

**And worse: my post-apply probe scored "denied" as `status >= 400`**, so a 500
from a recursion error counted as a PASS for "anonymous callers are refused". It
reported 27 of 30 green on a database where nothing worked.

> DENIED and BROKEN are different results, and a check that cannot tell them
> apart is not a security check.

Both fixes are now permanent:

* migration 036 **exercises** each policy as `anon` and `authenticated` via
  `SET ROLE` at apply time, then re-asserts that anon sees zero protected rows
  while the catalogue stays readable;
* `verify-xpa-6a.mjs` has a `classify()` naming **DENIED / ALLOWED / BROKEN**
  separately, and BROKEN is never a pass — whichever answer was wanted;
* the verification proves the seam **grants** as well as denies.

This is the fifth instance of the programme's recurring class — a statement or
check that looks like it proves something and does not. See **D-GRANT** and
**D-ACCESS**.

---

## Migration ledger

| Migration | Individually verified | Ledger |
|---|---|---|
| 001–027 | mixed | **unreconciled** (D-LEDGER) |
| 031 public discovery projection | ✅ XPA-3 | **unreconciled** |
| 032 quiz randomization flags | ✅ XPA-4 | **unreconciled** |
| 033 voice practice production | ✅ XPA-5 | **unreconciled** |
| 034 voice scenario confidentiality | ✅ XPA-5A + grant correction | **unreconciled** |
| 035 learner identity and access | ✅ | reconciled |
| 036 content policy recursion fix | ✅ | reconciled |

031–034 are verified **by observed effect** — the objects exist and behave as
specified. What is missing is the CLI ledger entry, not the object. **Not
repaired, by decision.** Reconciling means `supabase migration repair` per
version after an object-by-object comparison — the same discipline as 001–027.

---

## Retained for XPA-6D — `quiz_questions.correct_answer`

`correct_answer` is a column on `quiz_questions`. RLS is **column-blind**, so a
learner with an ACTIVE enrollment who can see the row can read every column on
it, including the answer key. This follows structurally from two verified facts:
entitled callers read `quiz_questions` rows (admin read 3), and RLS decides rows
rather than columns (D-GRANT, XPA-5A).

**Mitigated, not closed.** XPA-6A reduced the audience from *the entire internet*
to *learners an admin explicitly enrolled*, and the learner UI never selects the
column — both quiz players use an explicit safe column list, and scoring is
server-side (XPA-4).

**The fix is a learner-safe projection**, the XPA-5A `public_voice_scenarios`
pattern: a view that cannot return a column it does not select, with
REVOKE-before-GRANT and an apply-time matrix assertion. **XPA-6D scope.**

---

## Outstanding (not blockers to closure)

1. **B-2 — `RESEND_API_KEY` / verified sender domain (Q-D).** Without it,
   verification email is dry-run and no self-registered account can be activated.
   This is the one item that makes public registration usable rather than merely
   correct.
2. **B-3 — no path to grant an enrollment.** XPA-6B.
3. **B-5 — legal text awaits counsel review** (`2026-08-06-draft`).
4. **B-6 — `mailer_autoconfirm = true`** at project level. Harmless for this flow
   (accounts are created explicitly unconfirmed) but should be turned off.
5. Four ElevenLabs agents + UAT before publishing Amara, Fatou, Kader, Awa.
6. **D-Q1** launch subset still unresolved.
