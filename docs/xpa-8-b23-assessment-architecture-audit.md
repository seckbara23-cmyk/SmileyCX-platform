# XPA-8 B-2.3 — Assessment Architecture Audit

**Status: audit only. No implementation, no production mutation, no content authored.**
**Baseline:** production `a1b1250` · B-2.1 CLOSED · B-2.6 CLOSED · 5 published courses, zero placeholders · completion secured by entitlement (044) · B-2.6 verifier 29/29 · regressions 274/274.
**Question:** what should an XP Client Academy assessment — and therefore a certificate — actually prove?

---

## 0. The headline

**The assessment machinery is built; the assessments are not.** Server-side scoring,
five question types, three attachment scopes, randomization flags, answer-key column
revocation, an admin authoring UI and a certificate gate that already knows how to
demand module quizzes and a final exam — all of it exists and most of it is sound.
What sits on top of it in production is **one 3-question warm-up quiz, zero module
quizzes, zero final exams, and zero attempts ever recorded.**

Three findings need a ruling before any implementation:

1. **The harvest-and-retry residual is real and unresolved** — every submission returns
   the complete answer key to the browser, and attempts are unlimited.
2. **`submitQuizAnswers` has no entitlement check and `quiz_attempts` RLS is
   identity-only** — the exact S-1 shape B-2.6 just closed for `lesson_progress`,
   still open for quiz attempts.
3. **There is no source material to author from** — 0 transcripts, 0 subtitles, 0
   content bodies across all 82 published lessons. Responsible authoring requires
   course-owner input.

## 1. Existing infrastructure — works vs. merely exists

| Component | State | Evidence |
|---|---|---|
| `quizzes` table | **works** | `lesson_id` / `module_id` / `course_id`, exactly-one-parent CHECK (022), `passing_score` (001, default 70), `randomize_questions` / `randomize_options` (032) |
| `quiz_questions` | **works** | 5 types: multiple_choice, true_false, visual_choice, multiple_answer, drag_match (012/013); `options` JSONB, `correct_answer` int index, `explanation` |
| `quiz_attempts` | **works structurally** | per-attempt row: answers, score, max_score, passed, module_id (011/021). ⚠ RLS is `attempts_own FOR ALL (user_id = auth.uid() OR admin)` — **identity only, no access predicate** — the pre-044 `lesson_progress` shape |
| Server-side scoring | **works** | `app/actions/quiz.ts` `submitQuizAnswers` (XPA-6D): admin-client reads keys, grades all 5 types server-side. ⚠ no entitlement check; ⚠ returns the full key |
| Pass threshold | **works** | `max(quiz.passing_score ?? 80, 80)` — an authored threshold below 80 is silently raised to 80. The one production quiz says 70, so it would grade at 80 |
| Retry rules | **do not exist** | no attempt limit, no cooldown, no code path that reads prior attempts before accepting a new one |
| Best/latest semantics | **implicit best** | every gate asks "does any attempt with `passed=true` exist" — pass once, passed forever; later failures are recorded but never consulted |
| Answer-key protection | **works** | 038 revokes `correct_answer`, `drag_match_answers`, `explanation` from anon+authenticated at the **column grant** level; UPDATE also refused (42501). Verified continuously by XPA-6D (22/22 today) |
| Quiz visibility RLS | **works** | 036: `has_course_access(course_of_quiz(id))` for both quizzes and questions — entitlement seam, not enrollment |
| Module-quiz gate (player) | **works, mode-gated** | `nextIsBlocked = !PILOT_MODE && …` — inert today (production runs pilot), arms itself when mode flips to private |
| Final-exam surface | **works, empty** | `/learn/[courseSlug]/final-exam` exists; no course-level quiz exists to serve |
| Certificate gate | **works, mode-gated** | lessons 100% always; module quizzes + final exam checked only `if (!PILOT_MODE)` — and there are none to check |
| Progress calculation | **lessons only** | `course_progress` view and dashboard count completed lessons; quiz state contributes nothing to "progress %" anywhere |
| Admin authoring | **works** | `/admin/quizzes` new/edit forms: all 5 question types, all 3 scopes, per-question explanation |
| Randomization | **works, off** | both flags false on the one existing quiz |

## 2. Production inventory (5 published courses)

| Course | Modules | Lessons | Module quizzes | Lesson quizzes | Final exam | Questions | Attempts | Certificate logic today |
|---|---|---|---|---|---|---|---|---|
| C1-F1 | 3 | 17 | 0 | **1** | 0 | 3 | 0 | 100% lessons |
| C1-F2 | 4 | 18 | 0 | 0 | 0 | 0 | 0 | 100% lessons |
| C1-F3 | 4 | 17 | 0 | 0 | 0 | 0 | 0 | 100% lessons |
| C2-F1 | 4 | 17 | 0 | 0 | 0 | 0 | 0 | 100% lessons |
| C2-F4 | 4 | 13 | 0 | 0 | 0 | 0 | 0 | 100% lessons |

The single quiz: `70bbc2a8` *"Échauffement — Repérez le niveau"*, **lesson-scoped** on
C1-F1, 3 multiple-choice questions, `passing_score = 70` (graded at 80 by the clamp),
no randomization, **0 attempts all time**. Withdrawn courses carry no quizzes.

**Orphans: none.** 0 questions without a quiz, 0 attempts at all, every quiz parent
resolves. The B-2.6 audit's note that "the one quiz matches neither certificate-gate
query" still holds — lesson-scoped quizzes are invisible to certification. But NOT to
progression: the player counts a module as quiz-gated if any of its lessons carries a
quiz, so in private mode this warm-up becomes a hard gate on C1-F1 module 1. **A
3-question warm-up silently becoming a progression gate on mode flip is exactly the
class of mode-coupled behaviour B-2.6 removed for completion**, and B-2.3 must decide
its status deliberately (keep as gate / reclassify / delete).

## 3. The four concepts, from repository evidence

| Concept | Defined by | Authority | Exists today |
|---|---|---|---|
| **Lesson completion** | `lesson_progress.is_completed` | entitlement seam via `completeLesson` + 044 (B-2.6) | ✅ secured |
| **Assessment passed** | any `quiz_attempts` row with `passed=true` for that quiz | server scoring; ⚠ no entitlement check; ⚠ key returned | structurally, unused |
| **Course completed** | *no first-class record* — recomputed as "every lesson has a completed row" by each reader | derived | implicit only |
| **Certificate eligible** | certificate page: access + 100% lessons (+ quizzes when `!PILOT_MODE`, vacuously) | mixed | collapses to lessons |

They are four different things and the code keeps them four **except** at the
certificate gate, where — with no assessments existing and pilot mode skipping the
checks — *certificate eligible ≡ course completed ≡ 100% self-recorded lessons*.
B-2.6 made "self-recorded" mean "recorded by an entitled learner", which is the input
this phase inherits. No silent collapse is proposed; wave A below makes the
separation explicit per course.

## 4. Certificate semantics

**Today a certificate attests:** *an entitled learner recorded completion of every
lesson* — honour-based (no watch evidence, by B-2.6 ruling), no knowledge check.

| Option | Meaning | Cost | Risk |
|---|---|---|---|
| **A** — lessons only | what exists today, formalised | zero | certificate attests attendance, not learning; weakest claim for a B2B academy |
| **B** — lessons + final exam | one assessment per course proves retention | 5 final exams to author | single point of assessment; needs harvest-and-retry resolved |
| **C** — module quizzes + final exam | per-module checks + capstone | ~19 module quizzes + 5 finals | 4–6× authoring volume; module gates change the learning UX everywhere; most content to get wrong |
| **D** — configurable per course | `courses.requires_final_exam` flag; gate reads it | one column + gate logic | none real — it degrades to A per course until an exam exists |

**Recommendation: B, implemented via D's mechanism.** The product promise ("certificat"
on the public site) reads as an attainment claim, which A cannot honestly back once
assessments are possible. C multiplies authoring and UX risk before any evidence that
module-level gating is wanted. D-as-mechanism means the gate consults an explicit
per-course flag: courses whose final exam is authored and approved flip it on;
until then they remain honestly A. **No course silently changes behaviour, and the
gate stops depending on `PILOT_MODE`** — the same "mode is not an academic authority"
principle as B-2.6, applied to certification.

## 5. Assessment scope per course

All five published courses are structurally identical (video-led, 3–4 modules,
13–18 lessons, no existing assessments). There is **no repository evidence** that any
course needs module-level gating; there is product evidence (the certificate promise)
that a terminal check is wanted. Therefore:

- **Final exam: all five courses** — one per course, uniform semantics.
- **Module quizzes: none required for launch.** The machinery stays; authoring them
  is optional enrichment per course, decided later with the course owner.
- The existing C1-F1 warm-up quiz needs a ruling (§2): recommended — keep it as an
  ungated formative exercise (it already contributes nothing to certification;
  the module gate should stop counting lesson-scoped quizzes, or the quiz stays and
  the gate's arming on mode-flip is accepted deliberately).

## 6. Passing and retries — current defaults and recommendation

| Question | Today | Recommendation |
|---|---|---|
| Threshold | `max(passing_score ?? 80, 80)`; floor is code-enforced | keep 80 floor; author exams at 80 |
| Attempts | unlimited | keep unlimited **only if** the reveal changes (below); otherwise limit or cooldown |
| Best/latest | implicit best (any pass endures) | keep — re-attempts must not un-earn a certificate |
| Answer reveal | **full key + explanations returned on every submission** | see harvest-and-retry ruling |
| Randomization | flags exist, off | ON (both) for final exams — presentational only, grading unchanged (032) |

### The harvest-and-retry residual (XPA-6D) — ruling required

`submitQuizAnswers` returns `correctAnswers`, `multipleAnswerCorrect`,
`dragMatchAnswers` and `explanations` for **every** question on **every** submission,
and nothing limits attempts. Submit blank → receive the complete key → resubmit
perfect. 038 protects the columns at rest; the scoring action hands the same data out
after one throwaway attempt. For a 3-question warm-up this is pedagogy; for the exam
that mints a certificate it voids the certificate.

Options, smallest change first:

- **R1 — per-question correctness only** (right/wrong + score, no correct indices, no
  explanations) for quizzes marked as exams; full reveal stays for formative quizzes.
  One flag, one branch in the action's return path.
- **R2 — reveal after pass** (key shown only once `passed=true`): learner still
  harvests on the passing attempt, but by then the exam is already passed — combined
  with randomization this is adequate for a v1.
- **R3 — attempt limits / cooldowns**: heavier, needs product rules (how many? reset
  how?), and punishes honest failure more than it stops harvesting.

**Recommendation: R1 for exams (+ randomization on), full reveal retained for
formative quizzes.** This must be explicitly ruled on before implementation — it is
the exact residual XPA-6D documented, and building final exams without resolving it
would certify answer-key possession.

## 7. Security — what B-2.3 must preserve, and the one hole it must close

| Invariant | State | B-2.3 impact |
|---|---|---|
| 038 answer-key column revoke | intact, XPA-6D 22/22 | untouched — authoring writes via service role already |
| Server-side scoring | intact | untouched |
| Entitlement authority (Q-L) | quizzes/questions SELECT: entitlement-gated (036) | preserved |
| No client-held keys | at rest yes; **post-submission NO** | resolved by §6 ruling |
| No enrollment-as-access | 022's enrollment arms superseded by 036 | preserved |

**The hole (S-1 shape, quiz edition):** `submitQuizAnswers` never checks
`resolveCourseAccessById`, and `attempts_own` RLS is identity-only — an unentitled,
expired or revoked account can submit and record passing attempts for any quiz, via
the action *or* bare PostgREST. Pre-B-2.3 this is inert (nothing reads attempts).
The moment a certificate consults `quiz_attempts`, it is the same defect B-2.6
closed for `lesson_progress`, and it has the same two-part fix:

1. entitlement check in the action (course resolved server-side from the quiz —
   `course_of_quiz()` already exists, 036);
2. ~~**migration 046**: split `attempts_own` by command exactly as 044 did~~ —
   **SUPERSEDED, see the CORRECTION at the foot of this document. 046 was drafted,
   security-reviewed and WITHDRAWN before application: migration 011 already
   provides a stronger boundary, and 046 would have weakened it. Never apply it.**
   The original reasoning is left below for the record —
   SELECT/DELETE identity-only (transcript retained), INSERT/UPDATE require
   `has_course_access(course_of_quiz(quiz_id))`. Same helpers, same pattern, same
   apply-after-code ordering.

## 8. Authoring source material — the hard constraint

Measured, per published course:

| Course | Lessons | Videos | **Transcripts/subtitles** | Content bodies | PDFs |
|---|---|---|---|---|---|
| C1-F1 | 17 | 17 | **0** | 0 | 0 |
| C1-F2 | 18 | 18 | **0** | 0 | **3** |
| C1-F3 | 17 | 17 | **0** | 0 | 0 |
| C2-F1 | 17 | 17 | **0** | 0 | 0 |
| C2-F4 | 13 | 13 | **0** | 0 | 0 |

Zero subtitle objects exist in storage platform-wide; zero `content` bodies. The only
inspectable instructional material is: **3 PDFs on C1-F2**, the **two B-2.1 lesson
specifications** (C1-F3 M3L4, C2-F4 M4L1, in `docs/xpa-8-b21-lesson-specifications.md`),
and the published voice scenario's rubric. Everything else lives inside 82 private
MP4s that this environment cannot transcribe.

**Consequence — stated plainly, per the B-2C discipline:** final exams for the five
courses **cannot be responsibly authored from what the repository holds.** Question
stems invented from lesson *titles* would test guesswork about content nobody
inspected. Required from the course owner, per course, before wave B:

- lesson transcripts, scripts, or slide decks — any faithful text form of what the
  videos teach; **or**
- an owner-written exam blueprint: the 8–12 things a learner must be able to answer
  after the course, with the facts that make each answer right or wrong; **or**
- owner-authored draft questions for review and wiring.

Same stop-gate shape as B-2.1's authoring handoff. The B-2.1 specs prove the format
works when the owner supplies substance.

## 9. Schema — reuse, one migration

**Sufficient as-is:** quizzes (3 scopes, threshold, randomization), 5 question types,
attempts, admin forms, scoring action, certificate gate skeleton, `course_of_quiz()`.

**Required:**

- ~~**Migration 046**~~ — **WITHDRAWN. Not required, and must never be applied**;
  migration 011 already denies learner INSERT/UPDATE/DELETE on `quiz_attempts`.
  See the CORRECTION at the foot of this document.
- **`courses.requires_final_exam boolean not null default false`** — the D-mechanism
  flag (§4). One column; the gate reads it instead of `PILOT_MODE`.
- **No new tables.** Exam-vs-formative can be expressed by scope (course-scoped quiz
  = exam) plus the reveal rule keyed on the same fact — no `is_exam` column needed
  unless the reveal ruling wants formative course-level quizzes someday.

## 10. Proposed waves

| Wave | Content | Gate |
|---|---|---|
| **B-2.3A — assessment contract** | Rulings ratified (certificate semantics, reveal, attempts, warm-up quiz status); `requires_final_exam` column (migration **047**) + certificate gate rewired off `PILOT_MODE`; entitlement check in `submitQuizAnswers`; reveal rule; tests + `verify-xpa-8-b23.mjs`. **No 046 — withdrawn** | your GO on the rulings |
| **B-2.3B — content preparation** | per-course source material or blueprints from course owner; exam drafts; **STOP GATE: owner approval per exam** | human input |
| **B-2.3C — wiring** | author approved exams via existing admin surface; flip `requires_final_exam` per approved course; randomization on | B-2.3A closed |
| **B-2.3D — staging UAT** | staging → Preview → PR → CI/Security → Marième UAT (pass path, fail path, retry, no key leak, certificate refusal without exam) | her approval |
| **B-2.3E — production closure** | merge → deploy → apply **047** → verifier green → regressions green. The ledger runs **044 → 045 → 047**; the 046 gap is intentional | evidence table |

A and B can run in parallel — the contract does not depend on content. Nothing in A
changes learner-visible behaviour while every `requires_final_exam` is false, which is
what makes it safe to ship ahead of content.

## 11. Decisions required before GO

1. **Certificate semantics** — recommended: B via D's flag (final exam required once
   authored, per course; lessons-only until then, honestly).
2. **Harvest-and-retry** — recommended: R1 (no key reveal on exams) + randomization;
   explicitly accept or override the residual.
3. **Attempts** — recommended: unlimited with R1; alternatively name a limit.
4. **The C1-F1 warm-up quiz** — keep as formative-ungated (recommended), or accept it
   arming into a module gate on mode flip, or remove.
5. **Module quizzes at launch** — recommended: none required; final exams only.
6. **Source material** — who produces transcripts/blueprints per course, and in what
   form (§8). This is the critical-path item; everything in wave B waits on it.

---

**B-2.3 STATUS: AUDITED — no implementation. Machinery ready; content absent;
two security items (reveal, attempts RLS) and six rulings stand between here and GO.**

---

# CORRECTION — issued during B-2.3A implementation (20 August 2026)

**§0 finding 2 and §7 of this audit were WRONG about the database half.**

The audit stated that `quiz_attempts` carried the pre-044 shape — `attempts_own FOR ALL`,
identity-only — and that an unentitled account could therefore record a passing attempt via
bare PostgREST. It read migration **001** and reported that policy as live **without
checking whether a later migration had superseded it.**

Migration **011** superseded it, and nothing has since:

| Policy | Command | Rule |
|---|---|---|
| `attempts_select_own` | SELECT | `user_id = auth.uid() OR is_platform_admin()` |
| `attempts_insert_service` | INSERT | **`WITH CHECK (false)`** |
| `attempts_admin_all` | ALL | `is_platform_admin()` |

Verified against production with an **entitled** fixture acting on its own row:

| Operation | Result |
|---|---|
| INSERT | **403 `42501`** |
| UPDATE `passed=true` | **204 returned, ZERO rows changed** — `passed` stayed `false` |
| DELETE own attempt | **204 returned, the row survived** |
| SELECT own history | **200** — retention intact |

The UPDATE and DELETE results are worth their own note: both returned `204`, and both did
nothing. Only the row comparison revealed it. That is the standing rule — *never read a
2xx as evidence of access* — earning its keep again.

## Consequence: migration 046 was withdrawn, not shipped

046 would have replaced `WITH CHECK (false)` with
`user_id = auth.uid() AND has_course_access(...)`, which **newly permits an entitled learner
to POST a fabricated `passed: true, score: 100` row directly to PostgREST.** Applying it
would have been a security regression dressed as a hardening. It was written, tested against
production, found harmful, and deleted. B-2.3A ships **047 only**.

## What was genuinely open, and is now fixed

The **application** half. `submitQuizAnswers` writes with the service role, which bypasses
RLS entirely — so the action was the *only* gate on who may record an attempt, and it had
none. An expired, revoked, enrollment-only or never-entitled caller could have a passing
attempt recorded on their behalf. That is real, it is what B-2.3A fixed, and the fact that
RLS would have refused the same write from the browser does not diminish it: the service
role is precisely the path that ignores RLS.

## Why the audit got it wrong, and the habit that prevents a repeat

For `lesson_progress` the migration-001 policy genuinely *was* live, and B-2.6 confirmed it
by probing production. For `quiz_attempts` the audit inferred from 001 alone and never
probed, because there were zero attempts to probe with — no learner had ever submitted one,
so nothing looked wrong.

**A policy's definition is where it was last written, not where it was first written.** The
check is one grep (`grep -n 'attempts' supabase/migrations/*.sql`) or one probe. B-2.6's
discipline — measure production, never trust the document — was applied to completion and
not to assessment.

## Corrected §7 security table

| Invariant | Actual state | B-2.3A |
|---|---|---|
| 038 answer-key column revoke | intact | untouched |
| Server-side scoring | intact | untouched |
| Entitlement authority on quizzes/questions SELECT | intact (036) | preserved |
| **Direct-API attempt INSERT** | **already closed by 011** | **untouched — no 046** |
| **Direct-API attempt UPDATE / DELETE** | **already closed by 011** | untouched |
| **Entitlement check in `submitQuizAnswers`** | **ABSENT** | **added** |
| Answer-key reveal after submission | **open (XPA-6D residual)** | **closed for exams** |
| Attempt budget | none | 3 for exams |

Everything else in the audit stands: the machinery inventory, the production counts, the
four-concept separation, the certificate-semantics recommendation, the authoring-source gap
(0 transcripts across 82 lessons), and the waves.
