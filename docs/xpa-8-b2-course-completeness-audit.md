# XPA-8 B-2A — Course Completeness Audit

**Status:** audit only. **No production change, no migration, no content authored.**
**Baseline:** B-1, B-3, F-2, F-1 all closed · 207 production checks green · 828 tests
**Question:** what does "complete and launch-ready course content" actually mean here?

---

## 0. The headline

**`content IS NULL` is not a defect, and it never was.** Zero of 102 lessons have a
written body — including the five courses nobody has ever called incomplete. The
platform is **video-first**: 90 of 102 lessons are video-led, `lessons.content` is
optional supplemental text that is conditionally rendered, never validated, and
plays no part in completion.

The real defect is narrower and worse: **12 lessons have no instructional
modality at all**, and because completion is driven by video playback, **those
lessons can never be completed** — which makes three courses permanently
un-completable and their promised certificates unreachable.

---

## 1. Completeness matrix — all six published courses

| | C1-F1 | C1-F2 | C1-F3 | C2-F1 | C2-F2 | C2-F4 |
|---|---|---|---|---|---|---|
| slug | les-fondamentaux-de-l-experience-client | les-fondamentaux-du-service-client | communiquer-…-canaux-digitaux | manager-une-equipe-orientee-client | mesurer-l-experience-client | gerer-les-reclamations-… |
| published | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| price | 9 000 XOF | 9 000 XOF | free | free | free | 15 000 XOF |
| modules | 3 | 4 | 4 | 4 | 4 | 4 |
| lessons | 17 | 18 | 17 | 17 | **20** | 13 |
| duration (sum) | 38 min | 37 min | 35 min | 38 min | 40 min | 28 min |
| **with video** | **17** | **18** | 16 | **17** | **10** | 12 |
| with PDF | 0 | 3 | 0 | 0 | 0 | 0 |
| with subtitle | 0 | 0 | 0 | 0 | 0 | 0 |
| with written `content` | 0 | 0 | 0 | 0 | 0 | 0 |
| **no modality at all** | 0 | 0 | **1** | 0 | **10** | **1** |
| quizzes | 1 (inert) | 0 | 0 | 0 | 0 | 0 |
| exercises | 0 | 0 | 0 | 0 | 0 | 0 |
| voice scenarios | 0 | **5** (1 live) | 0 | 0 | 0 | 0 |
| final exam | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| empty modules | 0 | 0 | 0 | 0 | 0 | 0 |
| missing media | 0 | 0 | 0 | 0 | 0 | 0 |
| duplicate media | 0 | 0 | 0 | 0 | 0 | 0 |
| duplicate slug | 0 | 0 | 0 | 0 | **1 pair** | 0 |
| metadata | complete | complete | complete | complete | complete | complete |
| first lesson resolves | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **completable** | **17/17** | **18/18** | **16/17** | **17/17** | **10/20** | **12/13** |
| certificate reachable | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |

No empty modules, no missing media, no orphan content, no metadata gaps anywhere.

---

## 2. Lesson taxonomy — what the evidence supports

The proposed taxonomy assumed more variety than exists. Measured across all 102:

| Type | Count |
|---|---|
| **video-led** | **90** |
| **placeholder / incomplete** | **12** |
| video + text | 0 |
| text-led | 0 |
| practical exercise | 0 (`exercises` table is empty) |
| voice simulation *(as a lesson type)* | 0 — voice attaches **to** a video-led lesson |
| quiz/assessment *(as a lesson type)* | 0 — the one quiz attaches **to** a video-led lesson |
| downloadable-resource *(as a lesson type)* | 0 — the 3 PDFs attach **to** video-led lessons |

**The real model is one modality plus optional enrichment.** A lesson is a video;
a PDF, a voice scenario or a quiz hangs off it. Nothing in the repository
supports a lesson type that is *only* a PDF, *only* a quiz, or *only* text — and
nothing is authored that way.

So the taxonomy that matters is binary: **has an instructional modality, or is a
placeholder.**

---

## 3. What `lessons.content` actually is

Traced through every consumer:

| Site | Behaviour |
|---|---|
| Learner UI (`learn/…/[lessonId]/page.tsx:650`) | `{lesson.content && (…)}` — **conditional**. Absent → nothing renders, no gap, no error |
| Admin editor | free-text field, `content: …?.trim() \|\| null` — **no validation, no required flag** |
| Completion logic | **not referenced at all** — completion is `handleVideoEnded` / a 2-second-from-end threshold |
| Certificate gate | not referenced |
| Seeds / migrations | 002 and 006 wrote bodies for the pilot course; 035 and later never require it |
| Public projection (039) | **deliberately excluded** from `public_course_lessons` |
| Tests | no test requires a non-null body |

**Verdict: optional supplemental text.** Not mandatory, not legacy-dead (the
render path is live and would work), simply **unused platform-wide today** — 0 of
102 rows populated, including in the four courses that are otherwise complete.

**`content != null` must not be the launch standard.** Applied literally it
condemns all six courses, including the three that work end to end. That metric
is what kept B-2 looking larger and vaguer than it is.

---

## 4. C2-F2 — the original B-2 trigger, re-measured

20 lessons across 4 modules. **The course is exactly half-authored, split cleanly
down the middle of its module order:**

| Module | Lessons | State |
|---|---|---|
| 1. Pourquoi mesurer l'expérience client | 5 | ✅ all video-led |
| 2. Avec quoi mesurer : CSAT, NPS, CES | 5 | ✅ all video-led |
| 3. Comment mesurer : collecter et lire les résultats | 5 | ❌ **all placeholder** |
| 4. Que choisir : sélectionner et piloter ses indicateurs | 5 | ❌ **all placeholder** |

- **Real instructional media:** yes, for modules 1–2 — 10 videos, all resolving in
  the private bucket, all delivering through the F-2 route (verified 10/10).
- **Sequence coherence:** the *titles* form a coherent arc (why → which metric →
  how to collect → how to choose). The **structure is sound; the second half is
  unfilled.**
- **Placeholder-only lessons:** 10 — every lesson of modules 3 and 4. Each has a
  title, an order and a duration estimate, and nothing else.
- **Completable start-to-finish today:** **No.** A learner completes lessons 1–10
  and then hits five consecutive lessons with no video, which the completion
  mechanism cannot mark complete.
- **Does the absence of `content` make it incomplete?** **No.** C1-F1, C1-F2 and
  C2-F1 also have zero `content` and are complete. What makes C2-F2 incomplete is
  that **10 lessons have no modality of any kind**.

**Also found:** two lessons share the same title *and the same slug* —
`cas-pratique-construire-un-tableau-de-bord`, in modules 3 and 4, created 53
seconds apart. Both are placeholders. This looks like an authoring duplicate
rather than a deliberate two-parter.

---

## 5. Assessments — the real state

| | |
|---|---|
| quizzes | **1** |
| quiz_questions | **3** |
| quiz_attempts | **0** — the assessment path has never executed |
| module quizzes | **0** |
| final exams | **0** |
| exercises / exercise_items | **0 / 0** |
| passing threshold | 70 (on the single quiz) |
| retry behaviour | not exercised; no attempts exist |

The single quiz — *"Échauffement — Repérez le niveau"* — is attached to a C1-F1
lesson by `lesson_id` only, with **`course_id` NULL and `module_id` NULL**.

The certificate gate looks for exactly two things:

```
module quizzes : quizzes.module_id IN (module ids)          → module_id is NULL → not found
final exam     : quizzes.course_id = course AND module_id IS NULL → course_id is NULL → not found
```

**So it gates nothing.** No course has a module quiz or a final exam, and the
gate's quiz branch is additionally skipped entirely while `PILOT_MODE` is on.

**Are assessments mandatory for launch?** Not technically — nothing blocks on
them, and courses complete without them. But every public course page promises
**"Certificat inclus"**, and a certificate currently attests only that a learner
played every video to the end. That is a **credibility** decision, not an
engineering one: either the certificate claim is softened, or assessments back it.
They are absent because **authoring is incomplete**, not because the machinery is
missing — the quiz tables, attempt tracking, thresholds and gate logic all exist
and are wired.

---

## 6. Voice-training placement

All five F2 personas **exist** and are attached to real C1-F2 lessons. The earlier
"1 of 5 production-wired" framing was right about the outcome but understated
what is already built.

| Persona | Published | `agent_id` | Parent lesson (C1-F2) |
|---|---|---|---|
| **Ibrahima** | ✅ true | set | Garder son calme et désamorcer la tension |
| Amara | ✗ false | **NULL** | Reformuler pour montrer qu'on a compris 🎤 |
| Fatou | ✗ false | **NULL** | Les mots qui apaisent, les mots à bannir |
| Kader | ✗ false | **NULL** | Dire non sans braquer le client 🎤 |
| Awa | ✗ false | **NULL** | Bien gérer une réclamation, du début à la fin |

The gap is precisely **a missing ElevenLabs `agent_id` per persona** — situation,
objectives, prompt template, briefing and difficulty are already authored.

**Do the missing personas make their parent lessons incomplete?** **No.** All four
parent lessons are video-led and completable; the voice block is enrichment that
renders only when a published scenario exists. Four lessons carry a 🎤 in their
title while offering no microphone, which is a **presentation** inconsistency, not
a completeness failure.

---

## 7. Learner-facing resources

Only three exist, all on C1-F2, all resolving and all delivered through the
protected F-2 route:

| Course | Lesson | Object | Resolves | Safe to deliver |
|---|---|---|---|---|
| C1-F2 | Les mots qui apaisent, les mots à bannir | `pdf/1783524336286-l1gpd7rcfn.pdf` | ✅ | ✅ learner-facing |
| C1-F2 | Bien gérer une réclamation, du début à la fin | `pdf/1783538482616-wbsg6lgryj.pdf` | ✅ | ✅ learner-facing |
| C1-F2 | Dire non sans braquer le client 🎤 | `pdf/1783538611101-y3jtt73ogqo.pdf` | ✅ | ✅ learner-facing |

**No resource is missing** relative to what the data claims — no lesson references
a PDF that does not exist. There is no evidence in the repository of *intended*
resources beyond these three.

**Internal source material stays out.** The six untracked files under `public/`
(the architecture PDF, the voice-training design PDF, brand images) are **not
referenced by any lesson** and are not part of any learner path. They remain
untracked and unpublished, as ruled previously.

---

## 8. Completion and certificate journey

The mechanism, precisely: a lesson is completed when its `<video>` reaches the
end (or within 2 s of it). There is a manual **"Marquer comme complétée"** button
— but it is `if (pilotMode) return null`, and **production runs in pilot mode**.

**Therefore a lesson with no video cannot be completed today.**

The certificate gate then requires **every** lesson of the course to appear in
`lesson_progress` with `is_completed = true`.

| Step | C1-F1 | C1-F2 | C1-F3 | C2-F1 | C2-F2 | C2-F4 |
|---|---|---|---|---|---|---|
| 1. enter first lesson | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2. progress lesson-to-lesson | ✅ | ✅ | ✅ | ✅ | ✅ to L10 | ✅ |
| 3. complete all lessons | ✅ | ✅ | ❌ **1 blocked** | ✅ | ❌ **10 blocked** | ❌ **1 blocked** |
| 4. satisfy quizzes/exams | n/a — none exist | n/a | n/a | n/a | n/a | n/a |
| 5. become course-complete | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| 6. certificate | ✅ reachable | ✅ reachable | ❌ | ✅ reachable | ❌ | ❌ |

**Where each journey stops:** C1-F3 at *"Prioriser et organiser ses réponses"*;
C2-F4 at *"Cas pratique : une réclamation complexe de bout en bout"*; C2-F2 at
*"Concevoir une bonne enquête"* — and then nine more.

Platform-wide state confirms nobody has finished anything: **`lesson_progress` 1
row, `quiz_attempts` 0, `certificates` 0.** The certificate path has never
executed in production.

---

## 9. Proposed launch completeness standard

> A published course is launch-ready only if **all** of the following hold.

1. **Every module has at least one lesson.** *(all 6 pass)*
2. **Every lesson has at least one intentional instructional modality** — a
   video, a written body, a downloadable resource, a published voice scenario, or
   a quiz. *(12 lessons fail)*
3. **No placeholder lesson remains** — no lesson whose only content is a title,
   an order and a duration estimate. *(12 fail)*
4. **Every referenced media object resolves** in `course-content`. *(all pass)*
5. **The course is completable end-to-end by the completion mechanism actually in
   force** — not the one that exists behind a disabled flag. *(3 courses fail)*
6. **The certificate path resolves where a certificate is promised.** Every public
   course page says "Certificat inclus", so this applies to all six. *(3 fail)*
7. **No duplicate lesson slug within a course.** *(C2-F2 fails)*
8. **Course metadata is complete** — title, description, cover, level, duration,
   code, language. *(all pass)*
9. **No broken CTA or route** *(closed by UAT-ROUTE-01/02)*

**Explicitly NOT part of the standard:** `lessons.content IS NOT NULL`. §3 shows
the architecture does not require it, and applying it would condemn three
working courses.

**Deliberately left as a product decision, not a technical gate:** whether a
certificate may be awarded with no assessment behind it (§5).

---

## 10. B-2 sub-findings

| ID | Finding | Scope | Severity |
|---|---|---|---|
| **B-2.1** | **12 placeholder lessons** — no modality of any kind | C2-F2 ×10, C1-F3 ×1, C2-F4 ×1 | 🔴 **BLOCKER** |
| **B-2.2** | **Three courses are un-completable**, so their promised certificates are unreachable — a direct consequence of B-2.1 plus a video-only completion mechanism | C1-F3, C2-F2, C2-F4 | 🔴 **BLOCKER** |
| **B-2.3** | **No functioning assessments.** 1 quiz, 3 questions, attached by `lesson_id` only → gates nothing. No module quizzes, no final exams, 0 attempts. Certificates attest only to video playback | platform-wide | 🟠 **HIGH** (product decision) |
| **B-2.4** | **4 of 5 voice personas unpublished** — authored but missing an `agent_id`. Parent lessons remain completable; four titles carry 🎤 with no microphone | C1-F2 | 🟡 **MEDIUM** |
| **B-2.5** | **Duplicate lesson slug** `cas-pratique-construire-un-tableau-de-bord` in two C2-F2 modules, created 53 s apart | C2-F2 | 🟡 **MEDIUM** |
| **B-2.6** | **Completion depends on a mechanism disabled in the current mode** — the manual complete button is hidden in pilot, so video is the only path. Any future non-video lesson is un-completable by construction | platform-wide | 🟠 **HIGH** |

**Not found** — worth recording as ruled out: no empty modules, no missing media,
no duplicate media, no orphan content, no metadata gaps, no broken first-lesson
route, and no course where `content` absence is the actual problem.

---

## 11. Recommended repair waves

| Wave | Content | Gate |
|---|---|---|
| **B-2B** | **Decide C2-F2's disposition** (§12) — this is one decision and it removes the largest blocker | BLOCKER |
| **B-2C** | Author or remove the 2 remaining placeholder lessons in C1-F3 and C2-F4 | BLOCKER |
| **B-2D** | Fix the duplicate C2-F2 slug; re-verify completion end-to-end on one course with a real learner | BLOCKER |
| **B-2E** | Rule on the certificate/assessment question (§5): soften the "Certificat inclus" claim, or author module quizzes and a final exam and re-point the orphan quiz | HIGH |
| **B-2F** | Make completion mode-independent — a lesson should be completable by its own modality, not only by video | HIGH |
| **B-2G** | Wire the four voice `agent_id`s, or remove 🎤 from the four titles until they exist | MEDIUM |

## 12. Should any course be unpublished rather than repaired?

**Yes — C2-F2, unless its remaining 10 videos are imminent.**

It is published, free, and advertises 20 lessons of which **10 cannot be
completed**. A learner who starts it will finish module 2 and stop, with no
explanation and no certificate. Unpublishing is **one boolean**, reversible, and
it removes a broken promise immediately; authoring 10 videos is a content project
with an unknown schedule. Modules 1–2 are genuinely good and lose nothing by
waiting.

**C1-F3 and C2-F4 should be repaired, not unpublished** — each is one lesson away
from complete (16/17 and 12/13), and C2-F4 is a **paid** course at 15 000 XOF, so
withdrawing it has commercial consequences that fixing one lesson does not.

**C1-F1, C1-F2 and C2-F1 need nothing** for completeness. They are complete under
the standard in §9 today.

---

**No production change was made in this pass:** no migration, no lesson edit, no
assessment created, no media moved, no publication changed, no voice work.
