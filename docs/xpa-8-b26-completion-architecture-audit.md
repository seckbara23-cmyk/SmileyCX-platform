# XPA-8 B-2.6 — Completion Architecture Audit

**Status:** audit only. **No implementation, no production mutation.**
**Baseline:** `a6b2489` · 5 published courses, zero placeholders · 274 production checks
**Question:** *"Completion is tied to a mechanism disabled by operating mode."* — is it, and what is the correct completion authority?

---

## 0. The headline, in two parts

**B-2.6 as stated is real but now LATENT, and smaller than it looks.** `PLATFORM_MODE`
has **no academic authority** over completion. It changes exactly one thing: whether a
button is rendered. `markComplete()` itself contains no mode logic, the database contains
no mode logic, and after B-2.1 every published lesson is video-led — so **no lesson is
currently uncompletable.** The defect is a robustness gap that bites the next non-video
lesson, not an active blocker.

**The audit found something considerably worse.** Completion has **no access control at
all**. Any authenticated account can mark any lesson complete — in a course it has never
been entitled to, with an expired or revoked entitlement, with no entitlement whatsoever,
and in a course that has been withdrawn from publication. Since no course has any
assessment, **100% self-asserted lesson progress is the entire certificate requirement.**

---

## 1. The authority graph

```
                     ┌───────────────────────────────────────────┐
   ACCESS AUTHORITY  │  entitlements → has_course_access()       │  ← intact, unchanged
                     │  (no is_published arm, no enrollment arm) │
                     └───────────────────────────────────────────┘
                                        │  gates PAGE + MEDIA
                                        ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  LESSON PLAYER (client component)                                     │
   │    handleVideoTimeUpdate  duration − currentTime ≤ 2s ──┐             │
   │    handleVideoEnded ────────────────────────────────────┤             │
   │    onMarkComplete  ← button, HIDDEN when pilotMode ─────┤             │
   │                                                          ▼            │
   │                                            markComplete()            │
   │                                            · no mode logic           │
   │                                            · no access re-check      │
   └──────────────────────────────────┬────────────────────────────────────┘
                                      │ browser JWT, direct PostgREST upsert
                                      ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  lesson_progress   UNIQUE(user_id, lesson_id)                         │
   │  RLS: progress_own FOR ALL                                            │
   │       USING / WITH CHECK (user_id = auth.uid() OR is_platform_admin())│
   │       ← identity only. NO course, entitlement or publication predicate│
   └──────────────────────────────────┬────────────────────────────────────┘
            ▲                         │
            │ service role            ▼ read by
   markVoiceLessonComplete    certificate gate · dashboard · player ·
   (server-authoritative)     course detail · admin user page · course_progress view
```

**The single most important line:** the access authority gates the *page* and the *media*.
It does **not** gate the *write*.

## 2. Every completion writer

| # | Writer | Client/Server | Auth used | Access re-checked? |
|---|---|---|---|---|
| 1 | **Lesson player `markComplete()`** — `learn/…/[lessonId]/page.tsx:346` | **client** | learner JWT, direct PostgREST upsert | **NO** |
| 2 | **`markVoiceLessonComplete()`** — `app/actions/ai-practice.ts:595` | **server action** | service role (`createAdminClient`) | no — but lesson is resolved from the **scenario**, never client input |
| 3 | Platform admin | either | `is_platform_admin()` arm in RLS | n/a by design |

Nothing else writes. There is **no** progress initialisation on enrollment, and **no**
delete path outside the FK cascade.

Writer 2 is the better-built of the two and the repository says so in its own comment:
*"Server-authoritative and idempotent… the lesson is resolved from the SCENARIO, never
from client input, so a learner cannot complete an arbitrary lesson by forging a payload."*
**That protection exists for voice and not for video.**

## 3. Every completion reader

| Reader | Uses it for |
|---|---|
| `certificate/[courseSlug]/page.tsx:60` | **certificate eligibility** — requires `completedCount >= totalLessons` |
| `dashboard/page.tsx:82` | per-course progress % |
| `learn/…/[lessonId]/page.tsx:195` | sidebar ticks, auto-advance, resume point |
| `courses/[slug]/page.tsx:201` | "continue where you left off" CTA + `nextStep` |
| `admin/users/[id]/page.tsx:108` | admin view of a learner's progress |
| `course_progress` view (001:315) | `completed_lessons`, `percentage`, joined **from enrollments** |

Note the view is keyed on `enrollments` — a learner entitled but not enrolled has no row
in it, while the certificate gate ignores enrollment entirely. Two different notions of
"whose progress counts" already coexist.

## 4. PLATFORM_MODE coupling — exactly what it changes

| Site | Effect of pilot mode |
|---|---|
| `LessonNavigation.tsx:41` `if (pilotMode) return null` | **hides the primary "Marquer comme complétée" CTA** |
| `LessonNavigation.tsx:210` | hides the mobile "Terminer" button |
| `LessonNavigation.tsx:183` | hides *"Votre progression est sauvegardée automatiquement."* |
| `page.tsx:401` `nextIsBlocked = !PILOT_MODE && …` | disables the module-quiz gate |
| `certificate/…:72` `if (!PILOT_MODE)` | **skips the quiz/final-exam checks entirely** |
| `markComplete()` | **nothing — no mode logic exists in the writer** |
| RLS / database | **nothing — no mode concept exists server-side** |

**Was it intentional and documented?** Introduced in `ced2981` *"feat: premium LMS
experience — sidebar, navigation, progress, completion"* — the same commit that created
the file. There is **no design note anywhere** justifying it. The intent is nonetheless
legible from `docs/xpa-6-brief.md:33`:

> *Pilot progress lives in **localStorage** | `PILOT_MODE`, `updateProgress()`*

In pilot, learners were assumed **anonymous**, so a "save my progress" button and a
"your progress is saved automatically" caption were both meaningless — and were hidden
together. That is coherent for the platform as it was.

**That assumption has already been retired.** UAT-ACCESS-01 rewrote the player so a
signed-in learner always takes the authorized path in every mode; its own comment records
this. The proof that the coupling is now vestigial is a stale comment two lines above the
write:

```ts
// In PILOT_MODE userId is null, so localStorage is the only persistence.
if (!userId) return
await supabase.from('lesson_progress').upsert(…)
```

**`userId` is NOT null in pilot for an authenticated learner** — the code sets it at
`page.tsx:217` before this ever runs. Authenticated pilot learners *do* persist progress
to the database today. The comment describes a world that no longer exists.

**Does private mode restore the button?** Yes — the gate is purely `PILOT_MODE`, so
flipping to `private` renders it again, with no other change.

**Does any server-side authority change with mode?** **No.** Mode is presentational for
completion. The one place it touches academic outcome is the *certificate* gate skipping
quiz checks (§8) — which today is a no-op because no quizzes exist.

## 5. Lesson-completion invariant, by modality

| Modality | Lessons in production | Completion event that exists today |
|---|---|---|
| **video** | **82 of 82** published lessons | `handleVideoEnded`, or `duration − currentTime ≤ 2s` |
| text / `content` | 0 | **none** — content renders, nothing marks completion |
| PDF / resource | 3 (all *alongside* a video) | **none** of its own |
| exercise | 0 (`exercises` table empty) | **none** |
| voice scenario | 5 (1 published, alongside a video) | **`markVoiceLessonComplete`** — server-authoritative |
| quiz | 1 (inert, gates nothing) | quiz_attempts exists; 0 attempts ever |
| mixed | every PDF/voice lesson is video + enrichment | the **video** event carries it |

**The repository's actual rule is: a lesson is complete when its video ends.** Every other
modality either has no completion event or rides on the video's. After B-2.1 that rule
covers 100% of published lessons, which is why B-2.6 is latent rather than active.

*No new pedagogical rule is proposed here for the modalities that lack one.* Choosing one
is a product decision (§11).

## 6. Video completion semantics — what a certificate currently attests

| Question | Answer |
|---|---|
| Started? | not recorded |
| Percentage watched? | **not recorded** |
| Ended event? | yes — client-side |
| Duration threshold? | yes — client-side, final 2 seconds |
| Client or server confirmed? | **client only** |
| Watch evidence stored? | **none.** `lesson_progress.watched_seconds` exists in the schema and is **written by no code anywhere** — a grep across `app`, `lib` and `components` returns nothing. Every row carries the default `0` |

**Can a learner trivially complete without watching?** Yes, and not by tampering with the
player — the browser writes to PostgREST directly with the learner's own JWT, so a single
authenticated API call is sufficient. **Proved in production:** a bare `POST
/rest/v1/lesson_progress` returned `201` with `is_completed: true, watched_seconds: 0`.

This is not a DRM gap. It means **a certificate currently attests that an account asserted
completion — nothing more.**

## 7. Manual completion semantics

| Question | Answer |
|---|---|
| Who may invoke it | any authenticated learner (button hidden in pilot; the *function* is reachable regardless) |
| Server-side authorization | **none beyond `user_id = auth.uid()`** |
| Requires entitlement? | **NO** |
| Enrollment alone sufficient? | **YES** — and so is nothing at all |
| Expired / revoked entitlement? | **YES, both succeed** |
| Idempotent? | **Yes** — `UNIQUE(user_id, lesson_id)` + upsert; replay left the row count unchanged (3 → 3) |
| Another learner's lesson? | **No** — RLS refuses with `403 42501` |
| A lesson outside the learner's course? | **YES** |
| An unpublished/withdrawn course's lesson? | **YES** |

## 8. Production A–F matrix

Six synthetic learners against C1-F1, ID-scoped, fully cleaned (0 strays; Marième
untouched — 1 progress row, 6 entitlements, unchanged).

| | Fixture | `has_course_access()` | `lesson_progress` write |
|---|---|---|---|
| **A** | entitlement + enrollment | `true` | **201 WRITTEN** |
| **B** | entitlement, no enrollment | `true` | **201 WRITTEN** |
| **C** | enrollment only | `false` | **201 WRITTEN** ⚠ |
| **D** | expired entitlement | `false` | **201 WRITTEN** ⚠ |
| **E** | revoked entitlement | `false` | **201 WRITTEN** ⚠ |
| **F** | neither | `false` | **201 WRITTEN** ⚠ |

Additional probes:

| Probe | Result |
|---|---|
| A writes progress for **C2-F1**, which A does not hold (`has_course_access` = `false`) | **201 WRITTEN** ⚠ |
| A writes progress for **C2-F2**, an **unpublished** course | **201 WRITTEN** ⚠ |
| A writes a row with `user_id = F` (impersonation) | **403 `42501`** ✅ refused |
| Replay of the same write | idempotent, 3 → 3 rows ✅ |

**The access seam and the completion write disagree in four of six cases.** RLS enforces
*identity* correctly and enforces *entitlement* not at all.

## 9. Certificate consequences — the three distinct things

| Course | Lessons | Module quizzes | Final exam | Assessments gate the certificate? | Does 100% progress alone qualify? |
|---|---|---|---|---|---|
| C1-F1 | 17 | 0 | 0 | **no** | **YES** |
| C1-F2 | 18 | 0 | 0 | **no** | **YES** |
| C1-F3 | 17 | 0 | 0 | **no** | **YES** |
| C2-F1 | 17 | 0 | 0 | **no** | **YES** |
| C2-F4 | 13 | 0 | 0 | **no** | **YES** |

Platform-wide: **0 quiz attempts ever, 0 certificates ever issued.**

The three notions must be kept apart, and today two of them collapse:

- **course completion** = every lesson has an `is_completed` row — *self-asserted*
- **assessment passed** = **does not exist**; the one quiz has `course_id` and `module_id`
  NULL so it matches neither certificate-gate query
- **certificate eligible** = entitlement + course completion (+ quiz checks that are both
  empty *and* skipped in pilot)

⇒ **certificate eligible ≡ course completion ≡ "the learner's browser said so".**
That is the input B-2.3 needs.

## 10. Findings

### Security

| ID | Finding | Severity |
|---|---|---|
| **S-1** | `lesson_progress` RLS checks identity only. A learner with **no entitlement** — expired, revoked, or never granted — can create completion rows for **any** lesson, including lessons of courses they cannot open and courses withdrawn from publication. Proved: 4 of 6 A–F fixtures wrote successfully with `has_course_access() = false` | 🔴 **HIGH** |
| **S-2** | Completion is written by the **browser** directly to PostgREST. There is no server-side completion action for video, though one already exists for voice | 🟠 MEDIUM |

Impersonation is **not** possible (`403 42501`) — the identity half of the policy is sound.

### Academic integrity

| ID | Finding | Severity |
|---|---|---|
| **AI-1** | A certificate attests only that an account asserted completion. No watch evidence is captured: `watched_seconds` is written nowhere and is always `0` | 🟠 MEDIUM |
| **AI-2** | Because no assessment gates any course, **100% self-asserted progress = certificate** on all five published courses | 🟠 MEDIUM (input to B-2.3) |
| **AI-3** | A learner whose entitlement expires mid-course can still complete the remaining lessons and become certificate-eligible for a course they can no longer open | 🟠 MEDIUM |

### Correctness

| ID | Finding | Severity |
|---|---|---|
| **C-1** | `page.tsx:343` states *"In PILOT_MODE userId is null"* — **false** since UAT-ACCESS-01. Authenticated pilot learners do persist to the database | 🟡 LOW (stale comment, but it is the comment that makes the mode coupling look intentional) |
| **C-2** | `course_progress` (001) is keyed on **enrollments** while the certificate gate ignores enrollment — two definitions of whose progress counts | 🟡 LOW |

## 11. Remediation options

### A — Remove the `PLATFORM_MODE` coupling from manual completion
Delete `if (pilotMode) return null` and the two sibling gates in `LessonNavigation.tsx`.
**Justified by evidence:** the gate encodes an assumption (pilot ⇒ anonymous learner) that
UAT-ACCESS-01 already retired, and the stale comment at `page.tsx:343` is the residue.
No pedagogy decision required — it restores an existing, working control.
**Cost:** three conditionals. **No migration.** **Does not address S-1.**

### B — Make completion modality-aware
**Not justified today.** All 82 published lessons are video-led; there is no text-only,
PDF-only or exercise lesson in production to be aware of. Building a modality matrix now
would be designing for content that does not exist, and it would require the very
pedagogy ruling §11's stop gate reserves.

### C — One server-authoritative completion action, shared by all modalities
**This is what actually fixes S-1 and S-2, and it is reuse, not invention.**
`markVoiceLessonComplete` already is this: server action, service-role write, idempotent
upsert, lesson resolved server-side rather than trusted from the client. Generalising it
to a `completeLesson(lessonId)` server action that calls `resolveCourseAccessById()` before
writing would put completion behind the same seam as the page and the media.
**Cost:** one server action + repointing the player. **Migration:** required only if the
RLS policy is also tightened (recommended, so the direct-API path closes too).

### D — Leave video completion alone, repair only non-video
**Nothing to repair.** There are no non-video lessons. This option is empty today.

### Recommendation

**A is justified and sufficient for B-2.6 exactly as scoped**, and requires no ruling.

**But B-2.6 is not the important finding.** S-1 is, and A does not touch it. The
architecture-consistent fix for S-1 is **C**, using the pattern the repository already
built for voice. I recommend A and C be considered together — A alone leaves a completion
system that anyone can write to.

## 12. Migration required?

- **Option A:** no.
- **Option C:** a server action needs none; **tightening `progress_own` RLS to require
  `has_course_access(course_of_lesson(lesson_id))` does** — a forward-only policy
  replacement, in the style of 036. Both helpers already exist.

## 13. Tests and verifiers required

- Regression: the pilot gate is gone; `markComplete` still has no mode logic; the stale
  comment is corrected.
- Extend `verify-xpa-8-b21` or add `verify-xpa-8-b26` with the **A–F matrix as
  assertions** — C, D, E, F must be **refused**, A and B allowed, impersonation refused,
  cross-course refused, withdrawn-course refused.
- The existing seven verifiers must stay green; none is expected to move.

## 14. Stop gate

**Two things require a ruling and are NOT decided here:**

1. **What evidence should count as completing a video lesson?** The repository has no
   ratified rule. `watched_seconds` exists and is never written — evidence of an intent
   that was never implemented. Honour-based completion is a legitimate product choice;
   so is a watch threshold. **I am not choosing.**
2. **Should an expired or revoked learner keep completing?** AI-3 is arguably a product
   question (does access loss freeze the transcript?) rather than a pure security bug.
   The ratified separation says enrollment/progress is *academic record* and entitlement
   is *access* — which suggests writes should stop while the record is retained, but that
   sentence has never been applied to completion specifically.

**B-2.6 as scoped — removing the operating-mode coupling — is clear to implement and
needs neither ruling.** S-1 needs ruling #2 before its remediation can be specified.

---

**B-2.6 STATUS: AUDITED — clear to implement Option A; S-1 requires a product ruling**

---

# XPA-8 B-2.6 — IMPLEMENTATION RECORD

**Status:** implemented on `staging`. **Application half deployed; database half awaits an operator.**
**Baseline:** `5856307` (merged PR #1) · **Rulings applied:** both stop-gate questions from §14 were
decided by the implementation brief, and are recorded below.

## 15. The two rulings §14 reserved

| §14 question | Ruling | Where it lands |
|---|---|---|
| **1.** What evidence counts as completing a video lesson? | **Unchanged — honour-based.** *"Do not introduce watch-time thresholds, anti-cheating logic, DRM, or new pedagogical requirements."* | No threshold added. `watched_seconds` remains unwritten. B-2.6 did not decide 80/90/100% |
| **2.** Should an expired or revoked learner keep completing? | **No — writes stop.** *"expired entitlement → denied; revoked entitlement → denied"* | The access seam now gates the write; the record is retained and still readable |

Ruling 2 resolves AI-3 and is what made **S-1** implementable. The chosen shape is exactly the
ratified sentence: *access ends, the transcript is kept.* Writes stop, reads do not.

## 16. What was built — options A **and** C

§11 recommended A alone as sufficient for B-2.6 as scoped, and C as the architecture-consistent fix
for S-1. Both were implemented, because A alone leaves a completion system anyone can write to.

### A — the mode coupling, removed

`LessonNavigation`'s `pilotMode` prop is gone, replaced by **`canComplete`**. All four sites moved:

| Site | Was | Now |
|---|---|---|
| `renderPrimaryCTA` | `if (pilotMode) return null` | `if (!canComplete) return null` |
| "progression sauvegardée" caption | `!pilotMode &&` | `canComplete &&` |
| mobile "Terminer" / "Complétée" | `!pilotMode &&` | `canComplete &&` |
| top-bar "Complétée" badge (player) | `!PILOT_MODE &&` | `userId !== null &&` |

The player passes `canComplete={userId !== null}`. **The authority moved from operating mode to
identity** — which is the whole of the fix. The gate is structurally identical to the one it
replaces, so the only viewer whose experience changes is the one B-2.6 was raised for: an
*authenticated learner in pilot mode*, who previously saw no completion control at all. Anonymous
pilot browsing is untouched, and `PLATFORM_MODE` is now consulted nowhere in the component.

The stale comment at the old `page.tsx:343` (**C-1**) — *"In PILOT_MODE userId is null"* — is
corrected. It was false since UAT-ACCESS-01 and was the residue that made the coupling look
deliberate.

### C — one server-authoritative writer, shared

```
   LESSON PLAYER (client)                    VOICE SESSION (server)
     handleVideoTimeUpdate ─┐                  completeAiSession
     handleVideoEnded ──────┤                    └─ markVoiceLessonComplete
     onMarkComplete ────────┤                         │ lesson from SCENARIO
                            ▼                         ▼
                     completeLesson()          recordLessonCompletion()
                   'use server', Zod,      ◄── lib/learn/completion.ts
                   ONE export                  import 'server-only'
                            │
                            ├─ 1. resolve lesson → module → course  (service role, lookup only)
                            ├─ 2. caller's claimed course must match the resolved one
                            ├─ 3. resolveCourseAccessById()   ◄── THE authority
                            └─ 4. idempotent upsert; already-complete short-circuits
```

`markVoiceLessonComplete` was the better-built writer and the audit said so; generalising it rather
than building a second one means the two cannot drift. **Voice gained an entitlement check it never
had** — a learner with no entitlement who reached a scenario could previously complete its lesson,
exactly as through the player.

The core is a `server-only` library, not a second server action, because **every export of a
`'use server'` module is a callable HTTP endpoint** — a variant skipping the course-match check
would have *been* a weaker public endpoint.

## 17. Files changed

| File | Change |
|---|---|
| `lib/learn/completion.ts` | **NEW** — `recordLessonCompletion()`, the single authority. `server-only` |
| `app/actions/progress.ts` | **NEW** — `completeLesson()`, one export, Zod-validated |
| `supabase/migrations/044_lesson_progress_access_boundary.sql` | **NEW — NOT APPLIED.** RLS split |
| `components/lms/LessonNavigation.tsx` | `pilotMode` → `canComplete` (4 sites) |
| `app/(learn)/…/[lessonId]/page.tsx` | `markComplete` calls the action; optimistic rollback; C-1 fixed |
| `app/actions/ai-practice.ts` | voice routes through the shared authority |
| `lib/validation/schemas.ts` | `LessonCompleteSchema` — both ids required as UUIDs |
| `lib/audit/log.ts` | `progress.completion_denied` event type |
| `scripts/security/verify-xpa-8-b26.mjs` | **NEW** — 29 production checks |
| `__tests__/security/xpa-8-b26-completion-authority.test.ts` | **NEW** — 59 tests |
| `__tests__/learning/xpa-4-quiz-flow.test.ts` | re-pointed + strengthened |
| `__tests__/learning/xpa-5-voice-production.test.ts` | re-pointed |
| `__tests__/learning/xpa-5a-voice-hardening.test.ts` | re-pointed |
| `__tests__/security/xpa-8-b21-instructional-completeness.test.ts` | inverted, comment-proofed |

## 18. Completion authority, after the fix

| Question | Before | After |
|---|---|---|
| Who may assert completion? | any authenticated account | a learner the **entitlement seam** admits |
| Where is it decided? | nowhere | `resolveCourseAccessById()`, server-side |
| Does `PLATFORM_MODE` matter? | it hid the button | **no** — consulted in no writer |
| Does an enrollment suffice? | yes | **no** (Q-L preserved) |
| Expired / revoked? | both wrote | **both denied** |
| Can the browser write? | yes, directly | **no** |
| Transcript retained when access ends? | yes | **yes** — reads deliberately ungated |
| Watch evidence? | none | **still none** — not B-2.6's ruling |

## 19. A–F matrix — measured against production

Six ID-scoped fixtures on C1-F1, fully cleaned (0 strays). `verify-xpa-8-b26.mjs`.

| | Fixture | `has_course_access()` | Application path | Direct API (pre-044) | Direct API (post-044) |
|---|---|---|---|---|---|
| **A** | entitlement + enrollment | `true` | **ALLOWED** ✅ | written ✅ | written ✅ |
| **B** | entitlement, no enrollment | `true` | **ALLOWED** ✅ | written ✅ | written ✅ |
| **C** | enrollment only | `false` | **DENIED** ✅ | ⚠ written | refused |
| **D** | expired entitlement | `false` | **DENIED** ✅ | ⚠ written | refused |
| **E** | revoked entitlement | `false` | **DENIED** ✅ | ⚠ written | refused |
| **F** | neither | `false` | **DENIED** ✅ | ⚠ written | refused |

| Probe | Pre-044 result |
|---|---|
| A → a course A does not hold | ⚠ written (application path denies) |
| A → an **unpublished** course A does not hold | ⚠ written (application path denies) |
| A writes a row with `user_id = F` | **403 `42501`** ✅ refused — identity was always sound |
| Replay of the same completion | **idempotent**, 3 → 3 rows ✅ |
| An **expired** learner reads their own transcript | **200, 1 row** ✅ retained |
| …reads somebody else's | **0 rows** ✅ |

The ⚠ rows are the **direct PostgREST path**, which no application change can close — only a policy
can. That is migration 044, and the verifier fails while they stand.

## 20. Migration 044 — required, written, NOT applied

**Required?** Yes, for S-1. Not for B-2.6-as-scoped, and not for the application to work.

`progress_own FOR ALL` (migration 001) is split by command:

| Command | Rule | Why |
|---|---|---|
| `SELECT` | identity only | *"votre progression … sont conservés"* — access ending freezes the record, never confiscates it |
| `INSERT` | identity **+** `has_course_access(course_of_lesson(lesson_id))` | new progress requires current access |
| `UPDATE` | identity **+** access | so does amending it |
| `DELETE` | identity only | **unchanged** — pre-existing behaviour, not B-2.6's call |

Bolting the access test onto the existing `FOR ALL` policy would have been the obvious move and
would have been quietly wrong: `FOR ALL` covers `SELECT`, so an expired learner would have lost the
ability to read their own transcript.

`course_of_lesson()` is **reused, not redefined** — it has existed since migration 036, and 038
already gates a policy with the identical `has_course_access(course_of_lesson(…))` pair. A drafted
re-declaration proved byte-identical to 036's, which is exactly when redefining buys nothing and
risks something: 036's `lessons_visible`/`quizzes_visible` and 038's `exercises_select` all depend
on it, so a progress migration could have changed content visibility as a side effect. 044 asserts
the dependency exists and refuses to install otherwise.

**⚠ OPERATOR STEP — ordering matters, code first:**

1. Merge `staging` → `main`; let the production deployment finish.
2. Confirm a completion works on `www.xpclient-academy.com`.
3. Run `supabase/migrations/044_lesson_progress_access_boundary.sql` in the Supabase SQL editor.
4. Re-run `node scripts/security/verify-xpa-8-b26.mjs` — it must go from 22/29 to 29/29.

Applying 044 **before** the code is live would stop every learner on the current build from
recording progress: that build writes from the browser, which the policy refuses. The B-2.6 build
writes with the service role, which bypasses RLS, so applying it afterwards changes nothing for a
legitimate learner and closes only the direct-API path.

## 21. Certificate boundary — measured, not redesigned

`certificate/[courseSlug]/page.tsx` is **unmodified**. It consumes the same input: completed
`lesson_progress` rows.

What changed is the input's *trustworthiness*. Pre-B-2.6 a certificate attested that **an account
asserted completion**. Post-B-2.6 (application half) it attests that **a learner the entitlement
seam admitted asserted completion**. Post-044 that holds at the database boundary too.

It still attests nothing about *learning* — no assessment gates any published course,
`watched_seconds` is still written nowhere, and **AI-2 stands unchanged**: 100% self-asserted
progress remains the whole certificate requirement on all five published courses. That is **B-2.3's**
to decide, and B-2.6 deliberately did not.

## 22. Verification totals

| | |
|---|---|
| Existing production verifiers | **274 checks, 8 suites, 0 failures** — unchanged, none weakened |
| New `verify-xpa-8-b26.mjs` | **29 checks — 22 pass, 7 awaiting 044, 0 genuine failures** |
| Vitest | **865 → 924 tests, 31 files, all passing** |
| New B-2.6 suite | **59 tests**, executing the code rather than grepping it |
| Regression proof vs `5856307` | **19 of 19** load-bearing assertions correctly fail pre-fix, **0 blind** |
| `npm run verify` | typecheck · lint · lint:sql · tests · secrets · public-assets — **green** |
| `next build` | **green** — the `'use server'` single-export constraint holds at build time |

## 23. Two measurement errors caught during implementation

Recorded because both would otherwise have been reported as platform defects.

1. **The B-2.1 suite false-passed.** It asserted `if (pilotMode) return null` still existed, against
   **raw** source. The B-2.6 commit *quotes that line in a comment* explaining what replaced it, so
   the assertion passed on the prose. Absence assertions must read stripped source; the test is now
   inverted and comment-proofed, and the same fix was applied to the migration assertions.
2. **The verifier's write detector was wrong.** It scored a write as landed when a completed row
   existed and `before > 0` — which fires whenever the row already exists, regardless of what the
   call did. A's attempt to write F's row was refused with `403 42501`, correctly, and the detector
   reported a successful impersonation. A non-2xx now settles it outright and the row comparison is
   exact. **RLS was right; the probe was wrong.**

A third near-miss is worth the line: the first regression-proof script reported that a migration
already gated `lesson_progress` on access. It had matched a **comment** in 037. Scanning parsed
policy statements instead confirmed the ground truth — exactly one policy on the table pre-fix,
`progress_own FOR ALL`, ungated.

---

**B-2.6 STATUS: IMPLEMENTED on staging — application half complete and verified;
migration 044 written, reviewed, and awaiting the operator. S-1 closes when it is applied.**
