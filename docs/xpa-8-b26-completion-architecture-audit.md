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
