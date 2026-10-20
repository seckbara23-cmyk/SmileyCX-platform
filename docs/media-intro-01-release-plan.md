# MEDIA-INTRO-01 — production release plan

**Status: NOT EXECUTED.** This branch ships code, tests and tooling only. No video has been uploaded, no lesson created or modified, no learner progress touched. Every mutating command refuses to run without `--approved`.

| | |
|---|---|
| Baseline | `131375d0928446be40f4cf0f04039d740f7510a5` (`origin/main`) |
| Source videos | `incoming media/` — git-ignored, never committed, never deployed |
| Protected bucket | `course-content` (private) |
| Tool | `scripts/media/intro-release.mjs` |
| Manifest | `docs/media-intro-01-manifest.json` |

---

## 1. Operations

Seven films, seven published courses. `courses.code` is UNIQUE and immutable (migration 028) and is the key every operation is derived from — never the filename alone.

| Code | Source | Operation | Target |
|---|---|---|---|
| C1-F1 | `C1_F1_Intro.mp4` | **REPLACE** | lesson `cd363ae6-40be-4952-9a00-dbc1119be25c` — media reference only |
| C1-F2 | `C1_F2_Intro.mp4` | CREATE | module `04755f91-0a86-4b6a-ac02-18cb605cb1ce` |
| C1-F3 | `C1_F3_Intro.mp4` | CREATE | module `23cbf970-f4f8-4bf3-9f9f-cfddcd3df43b` |
| C2-F1 | `C2_F1_Intro.mp4` | CREATE | module `92d89798-c008-40c6-90a7-b1af2e786c5d` |
| C2-F2 | `C2_F2_Intro.mp4` | CREATE | module `d46aabd6-ce75-4cf1-ba8d-3e925664169d` |
| C2-F4 | `C2_F4_Intro.mp4` | CREATE | module `8137d5b7-11e3-4b76-9582-403e56e43dfb` |
| C2-F5 | `C2_F5_Intro.mp4` | CREATE | module `bac9524d-d227-46db-995d-6bd933a9aa1a` |

**C1-F4 is out of scope** — no video was supplied. **No C2-F3 course exists**: the code is registered in `course_codes` ("Piloter la Voix du Client") but unauthored, which is why there is no seventh-plus file.

### New lesson properties

`title = "Introduction"` · `slug = "introduction"` · `is_preview = false` · `video_source = "protected"` · `order_index = 0`

### Why `order_index = 0` and not a reindex

`lessons.order_index` has no UNIQUE and no CHECK constraint, and **no lesson in the catalogue currently uses 0** (measured 2026-10-20; the lowest in use is 1). Inserting the Introduction at 0 therefore sorts it first in its module **without modifying a single existing lesson row**. The alternative — inserting at 1 and shifting 3–7 instructional lessons per course — would touch 28 rows across six courses to achieve the identical rendered order. Fewer writes, same result, nothing to roll back on the instructional content.

---

## 2. Execution sequence

```bash
# 1. READ-ONLY. Verifies the seven hashes, re-resolves every code against the
#    database, detects existing Introductions, writes the manifest. Exits 1 on
#    any mismatch. Safe to run at any time.
node scripts/media/intro-release.mjs plan

# 2. Upload to the PRIVATE bucket. Each file gets a NEW object path; the old
#    C1-F1 object is left untouched. Verifies the uploaded size against the
#    source and records it in the manifest. Skips anything already uploaded.
node scripts/media/intro-release.mjs upload --approved

# 3. Attach. Six INSERTs + one PATCH of video_object_path. Refuses to run
#    without a verified upload. Re-checks for an existing `introduction` slug
#    immediately before each insert, so a re-run cannot duplicate.
node scripts/media/intro-release.mjs apply --approved

# 4. READ-ONLY verification. Confirms each lesson's object path, protected
#    source, is_preview = false, owning module, that the public storage URL is
#    refused, and that no module carries two Introductions.
node scripts/media/intro-release.mjs verify
```

Steps 2 and 3 are **separately approvable**: uploading bytes to a private bucket changes nothing a learner can see, while `apply` is what alters the catalogue.

## 3. Idempotency

| Re-run of | Behaviour |
|---|---|
| `plan` | recomputes; preserves `newObjectPath` / `uploadVerified` / `applied` already in the manifest |
| `upload` | skips any entry already uploaded **and** verified |
| `apply` (CREATE) | queries `module_id + slug='introduction'` first; if present, adopts the existing lesson id and skips |
| `apply` (REPLACE) | skips when `applied` is already true |
| `verify` | always safe |

A duplicate Introduction cannot be created even if `apply` is run repeatedly or concurrently with a manual Admin edit, because the check is made against the database immediately before the insert, not against the manifest alone.

## 4. Rollback

```bash
node scripts/media/intro-release.mjs rollback --approved
```

Reverses in reverse order:

- **REPLACE** → `video_object_path` restored to `video/1782748552522-tgh2wbdeljd.mp4`. The lesson id, slug, module and progress history are never altered by either direction.
- **CREATE** → the created lesson is deleted **only if it has zero `lesson_progress` rows**. If a learner has already watched the Introduction, the lesson is **kept** and reported, because deleting it would erase that activity.
- **Storage objects are never deleted.** The bytes stay for forensics, and the old C1-F1 object is still there, which is what makes the media swap a one-statement reversal.

Nothing in rollback touches quizzes, assessments, enrollments, entitlements or certificates.

---

## 5. Learner impact — measured, not estimated

`resolveCertificateEligibility` (`lib/learn/assessment.ts:246`) computes `totalLessons` **live** and refuses a certificate while `completedLessons < totalLessons`. Adding a lesson therefore moves a previously-complete learner to `n/(n+1)`.

**All affected rows belong to a single learner account** (anonymised `L-4ecd69` — the pilot identity).

| Course | Operation | Before | After | Eligible before → after | Certificate |
|---|---|---|---|---|---|
| C1-F1 | REPLACE | 18/18 | **18/18** | true → **true** | issued 2026-09-14 |
| C1-F2 | CREATE | 18/18 | 18/19 | true → **false** | issued 2026-09-09 |
| C2-F2 | CREATE | 21/21 | 21/22 | true → **false** | none |
| C2-F4 | CREATE | 13/13 | 13/14 | true → **false** | none |
| C2-F5 | CREATE | 15/15 | 15/16 | true → **false** | none |
| C2-F1 | CREATE | 17/18 | 17/19 | false → false | none |
| C1-F3 | CREATE | 16/17 | 16/18 | false → false | none |
| C1-F4 | — | 2/8 | 2/8 | false → false | none |

**Four** learner-course pairs lose eligibility, not five: C1-F1 is a REPLACE and adds no lesson, so the course holding one of the two certificates is unaffected.

### Certificates already issued are safe

Verified by reading both routes:

- `/certificates/[certificateId]` checks **ownership only** — no eligibility re-check.
- `/verify-certificate/[certificateId]` is **public** and looks up by id only.

So both issued certificates stay viewable and third-party verifiable. The only degraded surface is `/certificate/[courseSlug]`, which runs eligibility (`:67`) *before* the existing-certificate short-circuit (`:80`) and would refuse a holder who revisits that issuing route.

### Remediation options

1. **Accept (recommended).** One pilot account watches four short films — 1m06s, 1m31s, 1m48s and 1m08s, about 5½ minutes in total. Zero schema change, zero writes, zero new code paths.
2. **Progress backfill — ruled out.** Inserting `lesson_progress` rows would fabricate viewing activity, which the slice brief forbids outright.
3. **Legacy-completion grandfathering — designed, not built.** A `course_completion_baseline` table recording `(user_id, course_id, completed_at, lesson_count_at_completion)` plus a change to `resolveCertificateEligibility` to honour a historical completion. This needs a migration **and** a change to the certificate authority, so under the brief it is documented and stopped for separate approval.

**Recommendation: option 1 for this release, with option 3 revisited before real cohorts exist** — the same arithmetic will affect every future content addition, and at that point one account becomes many.

---

## 6. Unresolved owner decisions

| | Decision |
|---|---|
| **B-1** | Introduction is **enrolled-only** (`is_preview = false`, protected delivery). This plan implements that. If a public marketing teaser is wanted instead, that is a different mechanism (`courses.intro_video_url`, public and hotlinkable) and a different plan. |
| **B-2** | C1-F4 ships without an Introduction, or a video is supplied later. |
| **B-3** | Learner-impact remediation — option 1, 2 or 3 above. |
| **B-4** | `C1_F1_Intro.mp4` is encoded at **1355 kbps** against 319–341 kbps for the other six (same 1920×1080 H.264). 21.35 MiB vs ~2.7–4.1 MiB. Confirm the preset is intended, or re-export. Not blocking — it is well inside the 500 MB bucket limit. |

## 7. Observation outside this slice's scope

`/verify-certificate/[certificateId]` selects `id, certificate_number, issued_at, courses(title), profiles(full_name, email)` and consults neither `revoked_at` nor `status`. A revoked certificate would therefore still verify as genuine. The `certificates` table has both columns. Reported, not changed — it is unrelated to the Introduction work and deserves its own slice.
