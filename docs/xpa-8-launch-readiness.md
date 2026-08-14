# XPA-8 — Production Launch Readiness

**Status:** 🔴 **NO-GO** for the ratified invite-only launch as of 2026-08-13
**Baseline:** `9ccbd77` (XPA-7 closed)
**Scope of this pass:** audit only. No implementation.

**Launch criterion under test:**

> XP Client Academy can safely onboard real learners and real organizations in
> production under the ratified invite-only commercial model, without relying on
> legacy pilot behaviour, hidden stubs, unsafe public assets, stale SmileyCX
> surfaces, or unverified security assumptions.

**Verdict: NO-GO.** Not because the platform is insecure — the security posture
is the strongest part of it, with 141 production checks green across four
verifiers — but because **the ratified operating mode cannot currently be
enabled without locking out every real learner**, one published course is empty,
and an untested legacy product is reachable by any authenticated user.

None of the three blockers is large. All are precise.

> **Update — after W1, W2, W3, F-1 and the B-2A audit.** B-1, B-3, **F-2** and
> **F-1** are all **closed**. The verdict stays **NO-GO** on **B-2** alone —
> but B-2 is no longer "no lesson has a content body". That metric was wrong:
> `lessons.content` is optional and unused by every course, working ones
> included. The real blocker is **12 placeholder lessons with no instructional
> modality**, which make **three courses un-completable** and their promised
> certificates unreachable. See the B-2 section and the full audit.
>
> **Every production verifier is now green — 207 checks, 0 failures:**
> `verify-xpa-6a` **60/60** (re-based onto the invariant), `verify-xpa-6c`
> 30/30, `verify-xpa-6d` 22/22, `verify-xpa-7` 32/32, `verify-xpa-8-w2` 34/34,
> `verify-xpa-8-storage` 29/29.

---

## Score

| Dimension | State |
|---|---|
| Security / access model | 🟢 **Strong** — **207 production checks, 0 failures** across six verifiers |
| Operating mode | ✅ **B-1 closed (W1)** — flip is safe once deployed; not yet flipped |
| Course content | 🔴 **Blocker (B-2)** — 12 placeholder lessons; 3 of 6 courses un-completable; no functioning assessments. `content` is *not* the metric |
| Media protection | ✅ **F-2 closed (W3)** — private bucket + per-request signed delivery; 152 public originals deleted, 93/93 assets deliver, **29/29** in production |
| Legacy surfaces | ✅ **B-3 closed (W2)** — `/app/[orgSlug]` retired, deployed, **34/34 in production** |
| Voice practice | 🟠 **High** — 1 of 5 personas production-wired |
| Email / invitations | 🟠 **High** — sender defaults to the old domain |
| B2B / organizations | 🟡 **Medium** — sound, but MVP-thin |
| Assets / branding | 🟡 **Medium** — guard exists; known debt remains |
| Domain | 🟢 Canonical domain live and correct |
| Migration ledger | 🟡 **Medium** — D-LEDGER drift persists |
| Production data | 🟢 **Clean** — no synthetic residue |

---

## BLOCKERS

### B-1 — Enabling the ratified mode locks out every real learner · ✅ **CLOSED (W1)**

> Closed by XPA-8 W1 — see [xpa-8-w1-operating-mode.md](xpa-8-w1-operating-mode.md).
> The allowlist is deleted; admission now reads `profiles.account_status`. All
> three real accounts are admitted, none hardcoded. The mode also fails closed
> in production, and the public marketing site stays public as ratified.
> **SAFE TO FLIP: YES, after this commit deploys.** Production not yet flipped.

**Original finding, retained as the record:**

`middleware.ts` under `PLATFORM_MODE=private` locks the entire site except
`PRIVATE_MODE_EXEMPT`, requiring an authenticated **and allowlisted** session.
The allowlist is hardcoded in `lib/access-control.ts`:

```ts
export const ALLOWED_PRIVATE_EMAILS = [
  'seckbara23@gmail.com',
  'mariemelly@gmail.com',   // ← not a real account
]
```

Real accounts in production:

| Account | On the allowlist? |
|---|---|
| `seckbara23@gmail.com` | ✅ |
| **`mariemeify@gmail.com`** | ❌ — the list has `mariemelly@`, a different address |
| `bawizee22@gmail.com` | ❌ absent |

So flipping to the ratified mode today would lock out **Marième — who holds all
six entitlements and is the entire UAT account** — and `bawizee22`.

Structurally worse: an allowlist in source code means **every learner onboarded
requires a code change and a redeploy.** That is incompatible with the launch
criterion. `private` mode was built as a pre-launch lockdown, not as an
onboarding model, and it is being asked to serve as one.

**This must be resolved before the mode can be flipped, and the mode must be
flipped before launch.** The two are locked together.

### F-2 — Course video media has no entitlement check · ✅ **CLOSED (W3)**

All three storage buckets are `public=true` (`course-videos`, `course-media`,
`certificates`). A video URL belonging to a lesson that RLS **correctly hides**
from anonymous callers still returns the file with **no credentials at all** —
measured, three separate lessons, `HTTP 200 · video/mp4 · 13–16 MB`, while the
API returns 0 rows for those same lessons.

90 of 102 lessons carry a `video_url`. `has_course_access()` governs the lesson
**row**, not the **file**. The only thing protecting paid media is that the
bucket is not listable — the URLs are secret, not protected.

This is already live in combination with F-1: the 20 anonymously-readable C2-F2
lessons hand out their own video URLs, so that course's entire video content is
currently downloadable by the public. `certificates` being public also warrants
review — certificates carry learner names.

Standard fix: private bucket + short-lived signed URLs minted server-side behind
`has_course_access()`.

**CLOSED by W3** — see [xpa-8-w3-protected-media.md](xpa-8-w3-protected-media.md).

Two further findings came out of the audit: anon could **enumerate** all 149
videos with the public anon key (so "the URL is secret" was never true), and
018's `cert_service_insert` / `cert_service_update` policies had no `TO` clause,
letting any signed-in learner **write** into another learner's certificate
folder (proved 0 → 1 objects, then cleaned).

**Closure evidence.** The URL that served 4,074,127 bytes anonymously now
returns **400**; **0 of 93** historical lesson URLs still serve; anon
enumeration of `course-media/video` returns **0** objects where it returned 149.
An entitled learner gets **302 → signed URL → 200 · video/mp4 · 14,931,762**
with Range **206**, and **93 of 93 assets deliver platform-wide**. Anonymous
401, unentitled 403, enrollment-only 403, expired 403, revoked 403 — expiry and
revocation flipped in both directions and took effect on the next request.
Certificates: anon 400, other learner 400, owner 200. `course-media` retains
only its 24 marketing covers; 152 private copies retained including the 59
orphans. `verify-xpa-8-storage` **29/29**.

W3 also found and fixed a defect in itself: **Next 14 caches GET fetches**, so
supabase-js reads were being memoised — which would have let a revoked
entitlement keep working and would have weakened `lib/rate-limit.ts`. Both
Supabase clients now pass `cache: 'no-store'`.

### F-1 — C2-F2's content entirely flagged public preview · ✅ **CLOSED**

C2-F2 has been filled with 20 lessons, and **all 20** carry `is_preview = true`
— the only course on the platform with any preview lessons. Migration `001:143`
gives the lessons policy an `OR is_preview = true` arm, so those rows and their
4 parent modules are anonymously readable. Anon sees **exactly** the preview set
(20 lessons, 4 modules), zero non-preview leakage; quizzes, quiz_questions,
exercises and exercise_items still return 0 rows, so XPA-6D holds.

The column defaults to `false`, so this was deliberate — but 20 of 20 is the
blanket-preview pattern migration 035 was written to eliminate.

**CLOSED.** Root cause established by audit: **not** a default, import, script
or migration. The flags were authored in the admin editor — all 20 lessons
created in one 21-minute session, video upload timestamps matching `created_at`,
19/20 slugs matching the editor's `autoSlug(title)`. The checkbox is correctly
labelled *"visible sans inscription"*, defaults unchecked, and the form unmounts
between lessons, so there is no state carry-over: **each flag was an individual
deliberate tick.** Deliberate, but the *purpose* could not be proven from the
data, so the disposition was a product ruling rather than an engineering
deduction.

**Cleared, because they bought nothing and risked something:**

- **no UX depended on them.** The catalogue lists every lesson of every course
  from `public_course_lessons` regardless of preview, and the "GRATUIT" badge is
  `is_preview || FREE_ACCESS_MODE` — in pilot mode all six courses rendered
  identically (measured: **0 lock icons anywhere**). The flags were invisible,
  which is likely why nobody noticed; they would have activated on the `private`
  flip, making C2-F2 the only course advertising 20 free lessons it does not
  deliver.
- **they delivered no sample.** No lesson has a body, the media route refuses an
  unentitled caller (403), and the learn page bounces anonymous to `/login`.
- **they armed a real exposure.** `lessons.content` **is** anon-readable on a
  preview row — null today only because B-2 has not been done. The moment lesson
  bodies are written, 20 lessons' full text would have become public with no
  further change.

**Migration 043** clears them, scoped to C2-F2 only, self-verifying, and
deliberately **not** an unconditional reset — that would erase future deliberate
previews, the mistake 035 warned about. The preview *feature* is untouched.

**Production evidence after 043:** C2-F2 preview 0 of 20; 0 preview lessons
platform-wide; anon and unentitled learners see **0 lesson rows, 0 module rows,
no content, no `video_url`, no `*_object_path`**; the public projections still
serve 23 modules and 102 lesson titles with no protected columns; the C2-F2
public page still lists all 20 titles; and an entitled learner still streams
**10/10** C2-F2 assets with Range `206`. 043 changed nothing but the flag —
102 lessons, 90 video paths, 3 pdf paths, 90 legacy URLs, 23 modules, 6 courses
all unchanged, 0 bodies written or removed.

**The verifier was re-based, not made green.** `verify-xpa-6a` had encoded the
state on the day 035 ran (*preview count is 0*, *anon reads are `DENIED_EMPTY`*)
as though it were the rule. It now asserts the invariant: anon-visible lessons
== exactly the `is_preview` set, exposing no body and no object path, never a
non-preview row; modules visible only when they hold a preview lesson; and no
course flagged wholesale. **Run against the un-remediated database it still
FAILED, 3 of 60**, on substantive checks — 10 rows leaking `video_object_path`
to anon, the same to an unentitled learner, and one course flagged wholesale.
It reports **60/60** only now that the data is actually correct.

Also fixed: the verifier printed `PASS — 0 checks, 0 failures` after throwing
early. A run that asserted nothing now reports **INCONCLUSIVE** and exits
non-zero.

### B-2 — Course completeness · 🔴 **OPEN, now decomposed** (B-2A audit complete)

> Audited in full: **[xpa-8-b2-course-completeness-audit.md](xpa-8-b2-course-completeness-audit.md)**.
> Audit only — no migration, no lesson edit, no assessment created, no
> publication changed.

**The old metric was wrong.** B-2 was tracked as "no lesson has a `content`
body — 0 of 102". That is true and it is **not a defect**: `lessons.content` is
optional supplemental text, conditionally rendered, never validated, and absent
from completion logic. Zero of 102 lessons use it *including the three courses
that work end to end*. Applied literally, `content != null` condemns all six
courses. It is not the standard.

**The real defect is narrower and worse.** 12 lessons have **no instructional
modality at all** — no video, no body, no resource, no voice, no quiz. Because
completion is driven by video playback (the manual "Marquer comme complétée"
button is `if (pilotMode) return null`, and production is in pilot), **those
lessons can never be completed**, so three courses are permanently
un-completable and their promised certificates unreachable.

| Course | Modules | Lessons | With video | No modality | Completable | Certificate |
|---|---|---|---|---|---|---|
| C1-F1 | 3 | 17 | 17 | 0 | **17/17** | ✅ reachable |
| C1-F2 | 4 | 18 | 18 | 0 | **18/18** | ✅ reachable |
| C1-F3 | 4 | 17 | 16 | **1** | 16/17 | ❌ |
| C2-F1 | 4 | 17 | 17 | 0 | **17/17** | ✅ reachable |
| **C2-F2** | 4 | 20 | **10** | **10** | **10/20** | ❌ |
| C2-F4 | 4 | 13 | 12 | **1** | 12/13 | ❌ |

**C2-F2 is half-authored, split cleanly by module:** modules 1–2 are complete
(10 videos, all delivering through the F-2 route); modules 3–4 are **entirely
placeholder**. It is published and free while advertising 20 lessons of which 10
cannot be completed.

No empty modules, no missing media, no duplicate media, no orphan content, no
metadata gaps, no broken first-lesson route — all ruled out by measurement.

**Sub-findings**

| ID | Finding | Severity |
|---|---|---|
| **B-2.1** | 12 placeholder lessons (C2-F2 ×10, C1-F3 ×1, C2-F4 ×1) | 🔴 BLOCKER |
| **B-2.2** | 3 courses un-completable → certificates unreachable | 🔴 BLOCKER |
| **B-2.3** | No functioning assessments — the 1 quiz has `course_id` and `module_id` NULL, so it gates nothing; 0 attempts ever | 🟠 HIGH (product decision) |
| **B-2.4** | 4 of 5 voice personas authored but unpublished (missing `agent_id`); parent lessons still completable | 🟡 MEDIUM |
| **B-2.5** | Duplicate lesson slug `cas-pratique-construire-un-tableau-de-bord` in two C2-F2 modules | 🟡 MEDIUM |
| **B-2.6** | Completion depends on a mechanism disabled in the current mode — video is the only path | 🟠 HIGH |

**Recommendation:** unpublish **C2-F2** unless its 10 remaining videos are
imminent — one reversible boolean that removes a broken promise now. Repair
C1-F3 and C2-F4 instead of withdrawing them: each is a single lesson from
complete, and C2-F4 is a paid course. C1-F1, C1-F2 and C2-F1 need nothing.

Certificates deserve a separate ruling: every public course page promises
"Certificat inclus", and a certificate currently attests only that a learner
played every video to the end.

### B-3 — The legacy `/app/[orgSlug]` product is reachable · ✅ **CLOSED (W2)**

- `middleware.ts` lists `/app` under `AUTH_REQUIRED` — so it is reachable by
  **any authenticated user**, not restricted to admins.
- `app/(admin)/layout.tsx:86` links to `/app/orgs` from the admin shell.
- `components/layout/AppSidebar.tsx` offers Dashboard / Feedback / Journeys /
  Actions.
- It now reads `organizations`/`organization_memberships` whose policies XPA-7
  changed, and it has never been tested against them.

**Correction to this audit.** It originally claimed `feedback` and `actions`
"return `PGRST205` — they do not exist" and that the pages could not render.
**That was wrong.** Those were table names invented for the probe from the route
names; the pages query `journeys`, `touchpoints`, `action_plans` and
`feedback_entries`, **all of which exist in production and are empty.** The
pages rendered — they rendered nothing. The disposition is unaffected.

**Closed by W2 (`xpa-8-w2-legacy-org-surface.md`): retired, not guarded.** All
10 routes and 4 exclusive shell components deleted; the admin-shell link
repointed to `/admin/organizations`; a single catch-all handler redirects by
caller identity without ever reading the slug (no existence oracle, no open
redirect). W2 also deleted `requireOrgMembership`, which read
`organization_memberships` with **no `status` filter** — after XPA-7 added the
PENDING/ACTIVE/REMOVED lifecycle, a REMOVED ex-employee would still have passed
it. `verify-xpa-7` remains 32/32.

**Verified in production** against commit `6ee4974`: `verify-xpa-8-w2.mjs`
**34/34, 0 failures** — every legacy route redirects to `/dashboard` with no
rendered page and no legacy markers; an ACTIVE `org_admin` of one organization
gets a response indistinguishable from an invented slug when asking for another
organization's URL; open-redirect and traversal probes terminate on-site; no
redirect loop.

---

## HIGH

**H-1 — No assessments exist anywhere.** Zero quizzes and zero final exams
across all six courses. The single `quizzes` row has **both `course_id` and
`module_id` null**, so it is invisible to the module-quiz route, the final-exam
route, and the certificate completion check. Completion currently reduces to
"all lessons viewed", and no learner has ever completed anything
(`quiz_attempts` 0, `lesson_progress` 0, `certificates` 0). The certificate path
has never executed in production.

**H-2 — Voice practice is one-fifth wired.** Only **Ibrahima** is published with
an `agent_id`. **Amara, Fatou, Kader and Awa have no `agent_id` and are
unpublished.** XPA-5 closed knowing this; for launch it means four of the five
F2 scenarios do not exist for learners. Not assessed here: mobile microphone
behaviour and ElevenLabs failure/fallback states, neither of which has
production evidence.

**H-3 — Outbound email defaults to the wrong domain.**
`lib/email/index.ts:49` — `EMAIL_FROM ?? 'XP Client Academy <noreply@smileycx.com>'`,
and `app/actions/waitlist.ts` the same. If `EMAIL_FROM` is unset in Vercel,
invitations and password resets send from `smileycx.com`, which will not pass
SPF/DKIM for the academy domain. Email is also dry-run whenever `RESEND_API_KEY`
is absent, so **it may be silently sending nothing at all.** Neither variable is
present locally; production must be confirmed.

**H-4 — `lib/pilot.ts` fail-opens.** `PLATFORM_MODE` defaults to `'pilot'` — the
**most permissive** mode — when the variable is unset or misspelled. Every other
security flag in this codebase fails closed (`SELF_ENROLLMENT_OPEN`,
`disable_signup`, the admin allowlist). This one does not.

---

## MEDIUM

**M-1** `public/images/Certificate of Completion.pptx` is tracked and publicly
downloadable. The XPA-1 guard (`check-public-assets.mjs`) exists and carries it
as an accepted baseline item, scheduled for relocation under D-Q5. Not yet done.

**M-2** Two internal PDFs sit untracked in `public/` — the V4 architecture
reference and the Voice F2 source. Not served (untracked ⇒ not deployed), but
**one `git add -A` from exposure.** The guard would catch them at commit time;
they should be relocated regardless.

**M-3** Harvest-and-retry (XPA-6D accepted residual) is currently **moot** —
there are no quizzes to harvest. It becomes live the moment H-1 is addressed,
and should be decided as part of that work rather than after.

**M-4** `lib/logger.ts:31` tags every log line `app: 'smileycx'`. Operators grep
this; XPA-1 W6 flagged it and it is unchanged.

**M-5** Stale pilot copy remains in two files (`Phase pilote`). UAT-ROUTE-02
corrected the course page only.

**M-6** D-LEDGER drift persists. Migrations 037–040 are versioned; the
organization tables 040 reconciles were applied outside `migrations/`, and
001–034 remain unregistered. **`supabase db push` cannot be trusted to
reproduce production today.** Recommendation: `supabase migration repair` per
version after an object-by-object comparison — metadata only, never rewriting
history.

**M-7** B2B is sound but MVP-thin: no production organization exists, invitations
are a status field with no delivery, and org admins have no self-service roster
UI. All are accepted XPA-7 limitations; none is a security gap.

---

## LOW

`hero-formation.jpng` (typo'd extension, unreferenceable) · `organizations.plan`
dormant legacy metadata · `bonjour@smileycx.com` as the contact address — this
one is **deliberate and documented** in `lib/brand.ts`: the academy mailbox has
not been confirmed, and inventing an address would be worse.

---

## Security evidence — the strong part

Re-run against production at this baseline:

| Verifier | Result |
|---|---|
| `verify-xpa-6a.mjs` | ✅ **57 / 57** |
| `verify-xpa-6c.mjs` | ✅ **30 / 30** |
| `verify-xpa-6d.mjs` | ✅ **22 / 22** |
| `verify-xpa-7.mjs` | ✅ **32 / 32** |
| **Total** | **141 production checks, 0 failures** |

Local suite: **675 tests / 23 files**. Auth: **`disable_signup: true`** —
invite-only is genuinely enforced at Supabase, not merely in code. Entitlement
authority, answer-key protection, organization isolation and route invariants
are all proved by probe rather than assumed.

One item to confirm: `/auth/v1/settings` reports `mailer_autoconfirm: true`,
which appears to contradict XPA-6A's mandatory email verification. XPA-6A
verified the behaviour directly (`email_not_confirmed` on sign-in), so this is
likely a reporting artefact of the settings endpoint — but it should be
re-probed rather than assumed.

---

## Production data — clean

3 real accounts, **0 synthetic residue**. 6 courses / 23 modules / 82 lessons ·
6 entitlements + 6 enrollments (all Marième, `MANUAL_ADMIN`) · 0 organizations ·
0 exercises, quiz attempts, progress rows, certificates or payments · 5 AI
scenarios, 11 sessions · 6 audit events. Every verifier's fixtures cleaned up.

---

## Required launch UAT

To run against production once the blockers clear.

**Learner:** no access · manual access · evaluation access · corporate access ·
expired · revoked · full completion · certificate issued.
**Platform admin:** create org · add member · grant evaluation · grant corporate
licence · revoke · inspect progress.
**Org admin:** permitted own-org reads · denied cross-org reads · membership ops.
**Security:** self-join denied · self-promotion denied · answer-key denied ·
enrollment-only denied.

The last four are already automated in `verify-xpa-7.mjs` and should run as a
launch-day gate rather than being repeated by hand.

---

## Rollback and recovery — minimum runbook

Currently undocumented and needed before launch: Vercel instant rollback to the
prior deployment; Supabase PITR/backup window (unconfirmed); the fact that
**reverting a migration is not supported** — forward-only fixes only; and the
break-glass path (service-role SQL editor) with who holds it.

---

## Recommended fix waves

| Wave | Content | Gate |
|---|---|---|
| **W1** | **B-1** — replace the source-code allowlist with a data-driven check (entitlement- or profile-based), then prove the `private` flip admits all three real accounts | BLOCKER |
| ~~**W2**~~ | ~~**B-3** — guard or retire `/app/[orgSlug]`~~ · ✅ **DONE** — retired | BLOCKER |
| **W3** | **B-2** — C2-F2 filled but every lesson body is empty; add a published-course completeness check to CI | BLOCKER |
| ~~**W3b**~~ | ~~**F-2** — private media bucket + signed URLs~~ · ✅ **DONE** — closed and verified in production | BLOCKER |
| ~~**W3c**~~ | ~~**F-1** — rule on C2-F2's preview flags; re-base `verify-xpa-6a`~~ · ✅ **DONE** — cleared and verified, 6a now 60/60 | BLOCKER |
| **W4** | **H-3** confirm `EMAIL_FROM` / `RESEND_API_KEY` in Vercel and send a real invitation; **H-4** make `PLATFORM_MODE` fail closed | HIGH |
| **W5** | **H-1** decide the assessment model and the harvest-and-retry policy together; fix the orphan quiz | HIGH |
| **W6** | **H-2** wire the four remaining voice personas, or scope launch to Ibrahima explicitly | HIGH |
| **W7** | **M-1/M-2** relocate the PPTX and the two PDFs; **M-4/M-5** brand tag and pilot copy | MEDIUM |
| **W8** | **M-6** ledger reconciliation; runbook; launch UAT execution | MEDIUM |

**Progress:** B-1 closed (W1), B-3 closed (W2), **F-2 closed (W3)**, **F-1
closed**. The remaining NO-GO set is **B-2 alone** — no lesson body anywhere
(0 of 102) and no assessments (H-1).

Paid media is protected (private bucket, per-request authorization, every
historical public URL dead) and no learner content is anonymously readable.

**New security-hardening item, deliberately NOT bundled into F-1** — the base
`lessons` table exposes more to `anon` than the ratified public projection does:
`content`, `title_fr`, `video_url` and the three `*_object_path` columns are all
reachable on a preview row, while `public_course_lessons` exposes only id,
module_id, course_id, slug, title, duration_minutes, is_preview, order_index.
With no preview designated this is currently unreachable, but it re-arms the
instant anyone legitimately designates one. Restricting those columns for `anon`
touches the public catalogue's read path and needs its own change and its own
verification. **The re-based `verify-xpa-6a` now detects it** and will fail
loudly if a preview row ever exposes a body or an object path.

**W1–W3 are the NO-GO set.** With those closed and W4 confirmed, this becomes a
**CONDITIONAL GO** — conditional on accepting H-1 (no assessments) and H-2
(single voice persona) as launch-scope limitations, which is a product decision,
not an engineering one.
