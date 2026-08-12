# XPA-0 — XP Client Academy Repository, Content & Architecture Audit

**Date:** 2026-07-28 · **Mode:** documentation only — nothing modified, moved, renamed or migrated
**Source of truth read:** `public/Architecture_Catalogues_Parcours_XP-Client-Academy_V4.pdf` (full text extracted) and `public/Voice-Training_F2_EN (1).pdf` (full text extracted)
**Database evidence:** read-only queries against the production Supabase project (no writes)

---

## 1. Executive Findings

1. **The V4 architecture does not exist in the platform in any form.** There is no course-code column, no catalogue entity, no path entity, no N-N relation. The current model identifies courses by `slug` only — exactly the "title as identity" anti-pattern the golden rule forbids. This is a **greenfield build inside a working LMS**, not a refactor.
2. **Content is further along than the data model.** 6 of the 16 coded courses already exist as published DB courses; 5 map to codes by exact title match. But one published course has **zero lessons**, and assessment data was reset: the whole database currently holds **1 quiz (3 questions), 0 attempts, 0 enrollments, 0 progress rows, 0 certificates, 0 exercises**.
3. **Voice Practice is architecturally complete and 1/5 populated.** The Ibrahima scenario (Exercise 3) is live with a real ElevenLabs agent and 11 recorded sessions. The schema (`ai_scenarios` keyed by `lesson_id`, per-scenario `agent_id`) fits the other four scenarios without any schema change — they are content work, not engineering work.
4. **Branding is one rename away from consistent.** Learner-facing UI already says "XP Client Academy"; the residue is infrastructure (`smileycx.com` emails, `academy.smileycx.com` metadataBase, `app:'smileycx'` logger tag, package name) plus the SmileyCX-branded `/app/orgs` B2B product.
5. **The "Lancement Soft" document defining the 7-course launch subset is NOT in the repository.** 6 candidate courses exist; the 7th cannot be identified without that document. Reported as a blocker, not guessed.
6. **Security posture is solid and current** (invite-only, allowlist admin, deploy-time signup gate, 185 tests green), with the known latent RLS items from RELEASE-1 still open.

**GO/NO-GO: GO, with two management inputs required first** (§19, §20).

---

## 2. Repository Architecture

Next.js 14.2.35 App Router · Supabase (Postgres/Auth/Storage) · `@supabase/ssr` 0.3.0 · Vercel (two hostnames: public `www.xpclient-academy.com`, private portal `smiley-cx-platform.vercel.app`) · Pino logging · Vitest (185 tests, 9 files) · Playwright configured but not in CI.

Route groups: `(public)` marketing+catalogue, `(auth)` login/recovery, `(platform)` learner dashboard/checkout/certificates, `(learn)` player, `(admin)` 24-page back office, `app/[orgSlug]` legacy SmileyCX B2B product. 27 SQL migrations. AI stack: `lib/ai`, `components/ai` (9 components), `app/actions/ai-practice.ts` + `ai-coach.ts`, migrations 024–026.

## 3. Public Asset Inventory

**Deployment status (verified against production):** the two PDFs and all four
XP-branded images (`XP Logo.png`, `XPlogo.png`, `A Propos.png`, `Nos Formations.png`)
are **untracked in git** — they exist only in the local working copy and return
**404 in production** (Vercel deploys from GitHub). No code references them, so
nothing is broken; but nothing XP-branded ships either, except `favicon.ico`
(tracked, and byte-identical to `XPlogo.png`). Conversely,
`Certificate of Completion.pptx` **is tracked and publicly downloadable in
production today (verified 200)**.

PDFs (local `public/` root — **not deployed**, see above):

| File | Size | Content |
|---|---|---|
| `Architecture_Catalogues_Parcours_XP-Client-Academy_V4.pdf` | 389 KB | The V4 reference (16 courses, 9 PM, 6 SEC, integrity rules, backlog) |
| `Voice-Training_F2_EN (1).pdf` | 175 KB | The five F2 voice scenarios + prompt-engineering rules |

Images (`public/images`, dimensions read from file headers):

| File | Dim | Size | Note |
|---|---|---|---|
| `XP Logo.png` | 245×245 | 45,051 B | XP logo, variant A |
| `XPlogo.png` | 245×246 | 45,508 B | XP logo, variant B — **byte-identical to `favicon.ico`** |
| `favicon.ico` | — | 45,508 B | **A PNG renamed .ico** (md5 = XPlogo.png). Works in modern browsers; not a real multi-size ICO |
| `A Propos.png` | 467×304 | 222 KB | About visual |
| `Nos Formations.png` | 277×475 | 204 KB | Formations visual |
| `Marieme.png` | 359×239 | 160 KB | Founder photo |
| `about-laptop.png` | 359×239 | 177 KB | About visual |
| `Elearning.jpeg` | 1289×860 | 97 KB | Largest raster |
| `Formation1.jpg` | 229×141 | 11 KB | Course-card fallback (referenced by `COURSE_META`) |
| `hero-formation.jpg` | 323×215 | 12 KB | Hero |
| `hero-formation.jpng` | — | 173 KB | **Typo'd extension** (`.jpng`) — unreferenceable as-is; likely obsolete duplicate of hero |
| `Picture2/3/5/6/7/8.jpg` | ~200–730px | 14–35 KB | Generic pilot visuals; naming suggests slide exports |
| `screenImg.jpg` | 191×127 | 9 KB | Small screenshot |
| `Certificate of Completion.pptx` | — | 242 KB | **PowerPoint source file in a public folder** — design source, publicly downloadable |

Videos (`public/videos`, 66 MB total): 7 MP4s — two course-level intros and five module/lesson videos for the two F1/F2-era courses. **66 MB of video shipped inside the deployment bundle** (newer content uses Supabase Storage instead — both patterns coexist).

**Intended XP logo:** the pair `XP Logo.png`/`XPlogo.png` are the only candidates; they differ by 1px and content hash. Which is canonical needs a decision (Q6). No SVG/vector logo exists in the repo.

Obsolete/misplaced candidates (inventory only — nothing moved): `hero-formation.jpng`, `Certificate of Completion.pptx`, the `Picture*.jpg` family, and the duplicate logo variant.

## 4. Branding Replacement Inventory

Learner-visible UI (Header, Footer, login, certificates UI, course pages) already reads **XP Client Academy**. Remaining SmileyCX residue:

| Location | Value | Class |
|---|---|---|
| `app/layout.tsx:8` | `metadataBase` fallback `https://academy.smileycx.com` | Metadata/OG — wrong domain |
| `app/actions/enrollment.ts:109` | email base URL fallback `https://smileycx.com` | Email links |
| `lib/email/index.ts:31` | `FROM` fallback `XP Client <noreply@smileycx.com>` | Email sender domain |
| `app/(public)/contact/*`, `Footer.tsx:92`, `terms/page.tsx:36`, `checkout/confirm:97`, `waitlist.ts:21` | `bonjour@smileycx.com` (5 surfaces) | Contact identity |
| `app/app/orgs/page.tsx:24` | Renders literal **"SmileyCX"** wordmark | Legacy B2B product UI |
| `lib/logger.ts:31` | `app: 'smileycx'` | Log tag (operators grep this) |
| `package.json` | name `smileycx-platform` | Cosmetic |
| `PILOT.md` | SmileyCX-era pilot guide, stale flags | Stale doc |
| 3 admin pages | `SITE_URL` fallback `smiley-cx-platform.vercel.app` | Certificate links point at the **private portal** hostname |
| `lib/hosts.ts`, `middleware.ts` | `smiley-cx-platform.vercel.app` as admin host | **Correct — keep** (it *is* the portal hostname) |
| Favicon | XP logo already (see §3) | Done |

Certificates: `lib/pdf/CertificatePDF.tsx` — text-drawn PDF (React-PDF); brand strings live in code, no SmileyCX wordmark found in it; the `.pptx` in public/images appears to be its design source. Emails (`lib/email/index.ts`): French templates, "XP Client" sender name, smileycx.com domain fallbacks. Inactive links: none remaining (the `/admin/login` footer link was fixed in CX-AUTH-2B).

## 5. Existing Data-Model Diagram

```
courses (id, slug UNIQUE, title, title_fr, description(+_fr), thumbnail_url,
         price, currency, is_published, is_free, level, duration_hours,
         language, cover_url, intro_video_url)          ← NO code, NO catalogue
   │ 1-N
modules (id, course_id, slug, title, order_index)
   │ 1-N
lessons (id, module_id, slug, title, title_fr, content, video_url,
         duration_minutes, order_index, is_preview, pdf_url, subtitle_url)
   │ 1-N (exactly one of lesson_id | module_id | course_id)
quizzes (id, lesson_id, module_id, course_id, title, passing_score)
   └─ quiz_questions (question_type incl. drag-match, correct_answer, …)
exercises (23_exercises_system; admin CRUD exists)      ← table EMPTY
enrollments (user_id, course_id, status)                ← 0 rows
lesson_progress (user_id, lesson_id, is_completed)      ← 0 rows
quiz_attempts (user_id, quiz_id, passed, score)         ← 0 rows
certificates (user_id, course_id, certificate_number, pdf_url) ← 0 rows
ai_scenarios (lesson_id FK, slug, persona_name, prompt_template,
              agent_id, self_assessment, is_published)  ← 1 row (Ibrahima)
ai_sessions → ai_turns → ai_feedback / ai_scores / ai_recommendations
profiles (platform_role) · organizations/memberships (legacy B2B) · audit_log
```

**No table represents:** catalogue, course code, professional path, sector path, path↔course relation, path enrollment, or launch/backlog/retired status. The only grouping today is the UI-level `parcours: 'debutant'|'intermediaire'|'avance'` **hardcoded in `data/seed.ts` static config** — conceptually C1/C2/C3, but not a DB fact and matched to DB courses by slug/title heuristics (`app/(public)/courses/page.tsx:75`).

## 6. Gap Analysis vs Required Architecture

| V4 requirement | Current state | Gap |
|---|---|---|
| Stable course code, title = editable label | `slug` doubles as identity; slugs derived from titles (migrations 016/017 exist *because* titles changed) | **New `code` column** (unique, immutable), slug stays for URLs |
| Catalogue C1/C2/C3, course belongs to exactly one | UI-only "parcours" tri-level in static config | New `catalogues` table or enum + FK |
| 9 PM paths, ordered N-N to courses | Nothing | New `paths` + `path_courses(path_id, course_code, position)` |
| 6 SEC paths, socle commun + habillage | Nothing | Same tables, `type='sector'` + habillage metadata (title, visual, sector examples) |
| SEC contextualization ("habillage", no new content) | Nothing | Metadata-only per §9.2 of the PDF — no content tables for paths (golden rule) |
| launch / backlog / retired status | Only `is_published` boolean | New status enum; retired ≠ unpublished (retired codes never reused) |
| C1-F1 first in every path | n/a | Enforceable as an app-level invariant + test; V4 says "recommended first position", not a DB constraint |
| Progress by code, consolidated per path | Progress by lesson/quiz UUIDs per course | Derivable once courses carry codes; needs path-level aggregation view |
| B2B group enrollment in a path | Nothing (legacy org tables exist but belong to the *other* product) | New — decision needed whether to reuse `organizations` (Q4) |
| Next available codes C1-F4 / C2-F7 / C3-F9 | n/a | Record in the catalogue admin, never auto-reuse |

## 7. Course-Code Mapping Table

Evidence-based only. "Exact" = title matches the V4 title verbatim (modulo accents/articles).

| Code | V4 title | DB course (slug) | Evidence | Status |
|---|---|---|---|---|
| C1-F1 | Fondamentaux de l'expérience client | `les-fondamentaux-de-l-experience-client` | **Exact** | Published; 3 modules / 17 lessons |
| C1-F2 | Fondamentaux du service client | `les-fondamentaux-du-service-client` | **Exact** | Published; 4 / 18 |
| C1-F3 | Fondamentaux du service client digital | `communiquer-avec-les-clients-sur-les-canaux-digitaux` | **Probable** — objective matches V4's C1-F3 (email/chat/WhatsApp/réseaux); title differs | Published; 4 / 17 — **needs ratification (Q2)** |
| C2-F1 | Manager une équipe orientée client | `manager-une-equipe-orientee-client` | **Exact** | Published; 4 / 17 |
| C2-F2 | Mesurer l'expérience client | `mesurer-l-experience-client` | **Exact** | Published but **0 lessons** — placeholder |
| C2-F3 | Piloter la Voix du Client | — | none | **Missing** |
| C2-F4 | Gérer les réclamations… | `gerer-les-reclamations-et-transformer-l-insatisfaction-en-opportunite` | **Exact** | Published; 4 / 13 |
| C2-F5 | Développer une culture client | — | none | **Missing** |
| C2-F6 | Expérience digitale & omnicanale | — | none | **Backlog** — confirmed by V4 §10 itself; no later ratified decision found in repo |
| C3-F1…C3-F8 | (8 advanced courses) | — | none | **Missing** (all 8) |

**Seven-course launch subset:** V4 §10 references the « Lancement Soft » document as its definition. **That document is not in the repository** (searched all of `public/`, `docs/`, and source). 6 courses exist; whether the 7th is C2-F3, C2-F5, or something else **cannot be determined from repository evidence — not guessed** (Q1).

Content classes: **active** = C1-F1, C1-F2, C1-F3(probable), C2-F1, C2-F4 · **placeholder** = C2-F2 (published, empty) · **missing** = C2-F3, C2-F5, all C3 · **backlog** = C2-F6.

Also present: static "Coming Soon" placeholder cards in `app/(public)/courses/page.tsx` pad each parcours to 3 cards — pilot-era UX that will collide with real path pages.

## 8. Professional-Path Readiness

All 9 PM compositions are fully specified in the V4 PDF (ordered lists + the §8 matrix). Platform readiness:

- **Data:** nothing exists — §6.
- **Content coverage per path today** (courses that exist / courses the path recommends): PM-CONS 4/4 · PM-OPT 3/3 · PM-COM 3/4 · PM-MAN 3/5 · PM-QVC 3/5 · PM-RH 2/4 · PM-DIG 2/4 · PM-PRO 2/7 · PM-DIR 1/6.
- **PM-CONS and PM-OPT are launchable with existing content alone** (PM-OPT is also V4's flagged B2B entry path for SEC-LOG, "first sector validated by a concrete B2B demand").
- Discovery UX (a "who I am" chooser) does not exist; the current `/courses` page groups by maturity level only.

## 9. Sector-Path Readiness

All 6 SEC compositions specified (socle C1-F1+C1-F2 + complements). Coverage: SEC-TEL 5/6 · SEC-BQA 5/6 (C3-F1 missing) · SEC-LOG 4/5 (C2-F5 missing) · SEC-COM 4/5 · SEC-SAN 3/5 · SEC-ADM 3/5. No habillage assets (sector visuals/examples) exist anywhere in the repo. No "where I work" discovery UX. Two SEC paths embed **PM-OPT as a component** (SEC-LOG, SEC-SAN, SEC-ADM reference it) — the data model must allow a sector path to reference a PM path, not only courses; V4 treats this as a recommendation note, so metadata is sufficient — flagging so it isn't modelled away.

## 10. Learning-Flow Gap Analysis

| Flow item | State | Evidence |
|---|---|---|
| Lesson-linked quizzes | **Supported** (constraint: exactly one of lesson/module/course id; player resolves both) | migrations 021/022; but only **1 quiz exists in the DB (3 questions)** |
| Random quizzes | **Not supported** — no shuffle/randomization anywhere | grep across quiz actions/components: 0 hits |
| Answers & feedback | Server-side scoring with per-question explanations | `app/actions/quiz.ts` — see the XPA-6D correction below |
| Auto progression | Present (`AutoAdvanceBanner`, next-step CTA logic) | `components/lms/`, course detail progress block |
| Exercise completion | System built (migration 023, admin CRUD, `ExerciseBlock`) but **0 exercises exist** | DB count |
| Lesson PDFs | `lessons.pdf_url` exists; **3 lessons have one**. The two voice-scenario PDFs (cheat-sheet on F2-M2-L5, checklist on F2-M4-L2) are **not in the repo** and not verifiably attached | migration 007; DB count |
| Final exam | Supported (course-level quiz) but **0 exist** | migration 022; DB count |
| Certificates | Full pipeline (PDF gen, storage, public verification) but **0 issued** and the pilot's issued data was reset | `api/certificates/[id]/pdf` |
| Learner activity | **All zero** — enrollments, progress, attempts wiped in the reset | DB counts |

The engineering for the learning flow is largely done; the **assessment content layer is empty**.

> **Correction to this audit (XPA-6D, 2026-08-12).** The row above originally
> read "correct answers never sent to client". That was wrong, and the repository
> evidence disproves it: `app/actions/quiz.ts` returns `correctAnswers`,
> `multipleAnswerCorrect`, `dragMatchAnswers` and `explanations`, and the
> final-exam page renders them at four sites (`submissionResult?.correctAnswers?.[q.id]`
> and siblings). Correct answers **are** sent to the client — deliberately, and
> only after submission, as generated feedback.
>
> The distinction the original line was reaching for is real and is now enforced
> at the database boundary by migration 038: a learner may never read the
> authoritative key from `quiz_questions`, but does receive a post-submission
> feedback payload built server-side. Exposure of the reusable key and generation
> of feedback are different things; only the first was ever a defect.
>
> One consequence is **not** closed and is recorded in
> [xpa-6d-closure.md](xpa-6d-closure.md) as a residual risk: that payload covers
> every question in the quiz, and retries are permitted, so a learner may submit
> once, harvest the feedback, and retry. Narrowing it is a product decision that
> XPA-6D deliberately did not make.

## 11. Voice-Practice Reuse Audit

Implementation (phases 1A/1B/2B, all present):

- **Provider:** ElevenLabs Conversational AI via `@11labs/client`; server-side signed URL minting (API key never in bundle); CSP + `microphone=(self)` already configured (`middleware.ts`).
- **Session lifecycle:** `ai_sessions` → buffered `ai_turns` persisted server-side; ownership + rate limits (20/10min create, `rateLimitDb`); status transitions; 11 real sessions / 36 turns recorded.
- **Agent config:** per-scenario `agent_id` column — exactly matches the "five distinct agents" model in the F2 PDF.
- **Feedback:** self-assessment first (`SelfAssessmentForm`), then Claude coach one-shot evaluation (`ClaudeCoachReport`) with idempotency, hallucination-rejecting `turn_index` validation — **qualitative, no numeric score to the learner**, matching the PDF's "no score out of 10" rule.
- **Retry:** present — « Refaire l'exercice » (`ClaudeCoachReport.tsx:173`, `CoachDebrief.tsx`).
- **Lesson integration:** `VoicePracticeBlock` renders when a published scenario exists for the lesson; flags default OFF (`lib/ai/flags.ts`).

Against the five F2 scenarios:

| # | Persona | F2 location | Status |
|---|---|---|---|
| 1 | Amara (confused) | M2-L4 rephrasing | **Missing** |
| 2 | Fatou (frustrated) | M2-L5 words that soothe | **Missing** (+ its cheat-sheet PDF missing) |
| 3 | **Ibrahima (angry)** | M3-L2 defusing | **LIVE** — published, agent `agent_3801…`, sessions recorded |
| 4 | Kader (insistent) | M3-L4 saying no | **Missing** |
| 5 | Awa (F1→F2 loop) | M4-L2 complaint end-to-end | **Missing** |

**Reuse verdict: the entire engine is reusable as-is.** The four missing scenarios are: 4 ElevenLabs agents (prompts per the PDF's validated prompt-engineering rules — strict example-based criteria, no self-resolution incl. disguised closed-question form, 2–4 bounded re-prompts, conditional warm closings), 4 `ai_scenarios` rows, 2 lesson PDFs. One caveat: the PDF's analysis model (success/failure/unknown *per observation criterion* via the agent's Analysis tab) is currently approximated by self-assessment + Claude; whether to also wire ElevenLabs' native analysis is an XPA-phase design choice, not a gap in the recorded requirements.

## 12. Authentication Audit

Current state (post SEC-1→3, HOTFIX-1→3, CX-AUTH-0→2B — all regression-tested, 185/185):

- **Sign-up:** closed at Supabase (`disable_signup=true`, verified; deploy gate in `prebuild` blocks insecure builds). `/signup` is an access-request form.
- **Login/recovery:** Supabase email+password; recovery callback fixed (CX-AUTH-1 F-2). Learner and admin share `/login`; admin authorization = `ADMIN_OWNER_EMAILS` allowlist (2 admins), server-verified at 41 call sites.
- **Profiles/dashboard/progress/certificates:** exist; learner data currently empty (reset).
- **Org/B2B model:** `organizations` + `organization_memberships` + `OrgRole` (5 roles) exist but power the **legacy SmileyCX product** (`/app/[orgSlug]`), untested, and branded SmileyCX.

## 13. B2B Readiness Audit

V4 requires: sector-path storefront + **group subscription of a path for N learners** (case: a logistics firm enrolling all operational staff in PM-OPT). Today: no group enrollment, no path purchase, payments stubbed (`lib/payments/index.ts` all TODO), and the existing org model belongs to the other product. **Decision required** (Q4): repurpose the legacy org tables (they carry SmileyCX semantics and 0% test coverage) or build a minimal `b2b_accounts` model for path subscriptions. No recommendation is baked in here — inventory only, per constraints.

## 14. Security & Privacy Risks (delta view)

Standing controls: invite-only registration (Supabase-side + deploy gate), allowlist admin w/ verified sessions (forged-cookie vector closed in CX-AUTH-1), RLS + migration 027 anti-escalation, audit_log, DB-backed rate limiting, secret/bundle scanners, host-separated portal.

Open items relevant to XPA work:

1. **`payments_update_own` RLS latent bypass** — must fix before any B2B/paid path purchase (baseline: high-latent).
2. **`enrollments_update` no column constraint** — matters the moment path enrollment means something commercial.
3. **Voice-session privacy:** transcripts of real users exist (36 turns). RLS restricts to owner; Claude receives transcripts server-side. If the 4 new agents launch, an explicit retention statement should accompany them (none exists).
4. **Source-document exposure:** the V4 strategy PDF and Voice PDF are **not deployed** (untracked, 404 in production — verified), but they sit in `public/`, so the *next* `git add`-everything commit would publish a commercial-strategy document to the web root. `Certificate of Completion.pptx` **is already publicly downloadable in production** (verified 200). Decide placement before any commit touches `public/` (Q5).
5. **Accessibility:** jsx-a11y enforced at `error` for core rules; several interactive-pattern rules still `warn`. Mobile: responsive throughout (pilot-verified). E2E not in CI.
6. Public cert verification can render learner email (RELEASE-1 F-6) — unresolved.

## 15. Reuse vs Rebuild Matrix

| Area | Verdict |
|---|---|
| Course/module/lesson content model | **Reuse** — add `code`, `catalogue`, `status`; do not rebuild |
| Slugs/URLs | **Reuse** — slug stays the URL key; code becomes the identity key |
| Quiz/exam engine | **Reuse**; add randomization if ratified |
| Exercises engine | **Reuse** (built, empty) |
| Certificates pipeline | **Reuse** (rebrand assets only) |
| Voice engine (sessions/turns/coach/flags) | **Reuse unchanged** — add 4 scenarios as data |
| Learner auth + invite-only | **Reuse unchanged** |
| Admin back office | **Reuse**; extend with catalogue/path CRUD |
| `/courses` page | **Rework** — its static parcours config is superseded by catalogues + path discovery |
| Static seed fallback (`data/seed.ts`, `COURSE_MODULES`, placeholder padding) | **Retire** during XPA (pilot remnant) |
| Legacy `/app/[orgSlug]` product | **Decision** (Q4) — repurpose or fence off |
| Payments | **Build** (stubs only) — prerequisite for commercial paths |

## 16. Proposed Migration Strategy

Additive, zero-downtime, no data rewrite:

1. **New tables, no drops:** `catalogues(code)` fixed C1/C2/C3 · `paths(code, type[pm|sector], title, objective, note, habillage jsonb)` · `path_courses(path_code, course_code, position)` with uniqueness on (path, position) and (path, course).
2. **`courses` gains** `code text UNIQUE NULL`, `catalogue_code FK NULL`, `status enum('launch','backlog','retired') default` — nullable first so existing rows are untouched; backfill the 5–6 ratified mappings **only after Q1/Q2 are answered**; then tighten to NOT NULL for new rows.
3. **Never** migrate identity off `slug` for URLs; code is additive identity. Retired codes: enforced by never deleting a `courses.code` row (status→retired), satisfying "a retired code is never reused".
4. Path pages read exclusively through `path_courses` ordered by `position`; C1-F1-first is a seed-data fact plus a regression test, not a constraint (V4 calls it "recommended").
5. Progress-by-code = existing progress joined through `courses.code`; path consolidation = view over `path_courses`.
6. Seed all 15 launch/backlog codes + 9 PM + 6 SEC + matrix rows **verbatim from the V4 PDF** in one reviewable seed migration.

Rollback: every step additive; dropping the new tables/columns restores today exactly.

## 17. Final Phased Roadmap — REVISED (ratified 2026-07-28)

> **Superseded.** The original XPA-0 proposal led with the catalogue data model.
> Management renumbered the programme to lead with branding. Decisions are
> recorded in [xpa-decision-register.md](xpa-decision-register.md).

| Phase | Scope | Depends on |
|---|---|---|
| **XPA-0** | Audit | ✅ Complete |
| **XPA-1** | **Brand, domain and public-asset migration** — see [xpa-1-brief.md](xpa-1-brief.md) | Q-A/Q-C/Q-D (P-1…P-3 gates) |
| **XPA-2** | **Catalogue and path data foundation** — codes, catalogues, paths, `path_courses`, seed from V4; unpublish C2-F2 (D-Q3) | D-Q2 ✅; **launch-status backfill blocked by D-Q1** |
| **XPA-3** | Catalogue/path discovery experience ("qui je suis" / "où je travaille"); retires the static parcours page | XPA-2 |
| **XPA-4** | Learning-flow corrections — quizzes/final exams/exercises, **random quizzes per the D-Q7 contract**, lesson PDFs | D-Q7 contract ratified; Q-B |
| **XPA-5** | Voice Practice F2 expansion — 4 remaining scenarios (Amara, Fatou, Kader, Awa) | ElevenLabs access |
| **XPA-6** | Authentication and learner accounts | — |
| **XPA-7** | B2B organization enrollment (legacy org tables preserved, D-Q4) | XPA-2, XPA-6 |
| **XPA-8** | Launch readiness — e2e in CI, monitoring, `PLATFORM_MODE=public` per operating-mode.md §6 | All |
| **XPA-9** | Payments — unstub gateways; **must include RLS fixes H-1/H-3** before any money moves | XPA-7 |

Content completion (C2-F2 lessons, C2-F3, C2-F5, C3 courses) runs as a parallel
content-team track feeding XPA-2/3/4; it is not a numbered engineering phase.

## 18. Phase Implementation Brief

> **Renumbered.** The brief below was written as "XPA-1" and is now **XPA-2**
> (catalogue and path data foundation). The current **XPA-1 is brand, domain and
> public-asset migration** — its full brief is [xpa-1-brief.md](xpa-1-brief.md).
>
> Two decisions amend the content below: **D-Q2** approves the C1-F3 mapping
> (Q2 resolved), and **D-Q3** adds unpublishing the empty C2-F2. **D-Q1 remains
> open** and blocks *only* the launch-status backfill — schema, catalogues, paths
> and relationships proceed without it.

### XPA-2 brief (as drafted in XPA-0)

**Goal:** the V4 data model exists, seeded, invisible to learners (no UX change yet).

- Migration 028: `catalogues`, `paths`, `path_courses`; `courses.code/catalogue_code/status` nullable adds; RLS: public read on catalogue/path tables (they are commercial metadata), writes service-role only. Run `npm run lint:sql` — every write policy needs explicit `WITH CHECK` (the linter will enforce).
- Seed migration 029: 3 catalogues; 16 course codes (C2-F6 `backlog`; unmapped codes as code-only rows with `status='backlog'` and **no course row**, or deferred — decide in review); 15 paths; `path_courses` rows exactly per V4 §6/§7/§8 with positions, C1-F1 at position 1 everywhere.
- Backfill (separate, review-gated): map the ratified slugs→codes from §7 of this audit. **C1-F3 mapping is APPROVED (D-Q2)** — no slug rename; the code carries identity and the existing slug becomes the historical one (no alias mechanism exists — see D-Q2). **Launch-status backfill is blocked (D-Q1).**
- Unpublish C2-F2 `mesurer-l-experience-client` (D-Q3): `is_published=false`; not deleted, code not reused.
- Admin: read-only catalogue/paths listing page (no CRUD yet) so the seed is inspectable.
- Tests: code uniqueness/immutability (no UPDATE path changes a code), C1-F1 first in all 15 paths, matrix row count matches §8 of the PDF exactly (16 courses × their path memberships), retired-code non-reuse guard.
- Out of scope: UX, branding, payments, voice, B2B.

## 19. Management Questions & Blockers — RESOLVED 2026-07-28

All seven questions were answered. Canonical record:
[xpa-decision-register.md](xpa-decision-register.md).

| # | Outcome | Residual blocker |
|---|---|---|
| Q1 | 🔴 **Open** — do not guess the 7th course, do not invent launch status | Blocks **only** the XPA-2 launch-status backfill |
| Q2 | ✅ **Approved** — C1-F3 mapping ratified; code is identity, title editable | None. *Finding:* no slug-alias mechanism exists (verified) — history is preserved by keeping the slug and adding the code |
| Q3 | ✅ **Approved** — unpublish empty C2-F2; never delete, never reuse the code | None (executes in XPA-2, data change) |
| Q4 | ⏸ **Deferred to XPA-7** — preserve legacy org tables, no competing model | None |
| Q5 | ✅ **Approved** — relocate source documents, remove the live `.pptx`, add a CI guard | None. *Audit confirms* the `.pptx` is not a learner download (0 references) |
| Q6 | ✅ **Approved** with a contradiction: **neither logo is transparent** (measured: 0 transparent pixels in both) → the "highest-resolution transparent" rule cannot be applied | **Q-A**: supply a transparent/vector master, or accept a light-surfaces-only constraint |
| Q7 | 📋 **Ratified** high-priority; all four interpretations audited — **none supported today** | **Q-B**: the cited pilot-corrections PowerPoint is not in the repo |

New questions raised by the decisions: **Q-A** (logo master), **Q-B** (random-quiz
source), **Q-C** (new contact address), **Q-D** (Resend domain verification).
Q-C and Q-D are hard gates for XPA-1 — both fail silently and outward-facing.

## 20. GO / NO-GO

**XPA-2 (catalogue and path foundation): GO.** D-Q2 is approved, and the schema plus
the seed of 3 catalogues, 16 codes, 15 paths and the §8 matrix are fully specified by
the V4 PDF. D-Q1 blocks only the launch-status backfill, which is a separate,
review-gated step.

**XPA-1 (brand and domain): CONDITIONAL GO** — see [xpa-1-brief.md](xpa-1-brief.md) §8.
Blocked on **Q-C** (contact address) and **Q-D** (verified email domain); both cause
silent, outward-facing failures if guessed. Q-A may be waived with a documented
constraint.

The rest of the roadmap remains additive and reversible, reusing the existing engine
rather than rebuilding it.

**Contradictions found and reported, not resolved:** (a) probable C1-F3 title mismatch (Q2); (b) published-but-empty C2-F2 vs "published" semantics (Q3); (c) the mission's "random quiz support" vs its absence from both source documents (Q7); (d) certificate links defaulting to the private portal hostname while certificates are a public-site feature (§4).

---

*Audit complete. Stopping here per instructions — XPA-1 not begun. Nothing in the repository was modified, moved, renamed, migrated or rebranded; the only artefact of this phase is this document.*
