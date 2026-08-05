# XPA — Management Decision Register

Canonical record of ratified decisions for the XP Client Academy programme.
No register existed before; this file is created by XPA-0 and is the single
source of truth for decisions. Superseded entries are struck, never deleted.

**Status key:** ✅ Approved · ⏸ Deferred · 🔴 Open (blocking) · 📋 Ratified requirement

---

## D-Q1 — Seven-course launch subset · 🔴 OPEN (blocking, narrowly)

**Decision:** Do **not** guess the seventh launch course. Do **not** invent launch status.
Schema, catalogues, paths and path↔course relationships may proceed without it.
**Only the launch-status backfill remains blocked.**

**Evidence:** the « Lancement Soft » document is absent from the repository
(searched `public/`, `docs/`, all source). Six coded courses exist in the database.

**Blocks:** XPA-2 status backfill only. Does **not** block XPA-1 or the XPA-2 schema/seed.

---

## D-Q2 — C1-F3 mapping · ✅ APPROVED

**Decision:** map `communiquer-avec-les-clients-sur-les-canaux-digitaux` →
**C1-F3 — Fondamentaux du service client digital**. The code is the stable
technical identity; the displayed title stays editable. Preserve the former
slug/title as history or alias *where the existing architecture supports it*.

**⚠️ Architecture finding — it does not currently support aliases.** Verified:
`next.config.mjs` declares no `redirects`/`rewrites`; there is no slug-history or
alias table; `courses.slug` is a single unique column. Migrations 016 and 017
exist precisely *because* slug changes had to be corrected in place.

**Consequence:** in XPA-2, history is preserved by (a) the immutable `code`
column and (b) leaving `slug` untouched — the current slug simply *becomes* the
historical one. If a title-driven slug change is ever wanted, a `course_slug_history`
table + redirect must be built first. **No slug is renamed in XPA-1 or XPA-2.**

---

## D-Q3 — Empty published C2-F2 · ✅ APPROVED

**Decision:** hide `mesurer-l-experience-client` (published, **0 lessons**) from
public discovery and enrollment until lessons exist. Do not delete. Do not reuse
its code. Preserve as draft/unpublished content.

**Implementation:** `is_published = false`. This is a **data change, not code** —
therefore it belongs to XPA-2 (or an explicit operator action), **not XPA-1**,
whose scope is branding only.

---

## D-Q4 — B2B organizations · ⏸ DEFERRED to XPA-7

**Decision:** preserve the existing `organizations` / `organization_memberships`
tables. Do **not** create a competing B2B model in XPA-1 or XPA-2. Do **not**
extend the legacy SmileyCX organization UI yet.

**XPA-1 consequence:** `app/app/orgs/page.tsx` renders a literal "SmileyCX"
wordmark. Because extending that UI is deferred, XPA-1 performs a **wordmark-only
correction** there — no layout, feature or model change. See risk R-3.

---

## D-Q5 — Public source documents · ✅ APPROVED

**Decision:** reference and commercial-strategy documents must not be publicly
served. Prepare a relocation plan from `public/` into
`docs/source-material/xp-client-academy/`, or a git-ignored private directory
where confidentiality requires it. Add a guard preventing sensitive source-document
formats from being published under `public/`. **Do not move files until the
implementation phase explicitly performs and tests the transition.**

Must not be exposed: architecture source PDFs · pilot strategy documents ·
editable certificate PowerPoints · internal training design documents.

**Audit result for `Certificate of Completion.pptx`:** **not** an intentional
learner download — zero references in `app/`, `components/`, `lib/`. It is tracked
in git and **live in production (verified HTTP 200)**. → remove from public delivery.

**Current exposure (verified):**

| Asset | Tracked? | Production | Action |
|---|---|---|---|
| `Architecture_…_V4.pdf` | No | 404 | Relocate before any `public/` commit |
| `Voice-Training_F2_EN (1).pdf` | No | 404 | Relocate before any `public/` commit |
| `Certificate of Completion.pptx` | **Yes** | **200 — live** | **Remove from public delivery** |

---

## D-Q6 — Canonical logo · ✅ APPROVED (with a contradiction to resolve)

**Decision:** enumerate all candidates; select the **highest-resolution transparent**
version if otherwise visually identical; establish one canonical asset and derive
favicon, Open Graph, email, certificate and square variants from it. Do not maintain
multiple near-identical active imports.

**⚠️ The selection rule cannot be applied as written — neither candidate is transparent.**

| File | Dimensions | Size | Colour | Transparency (measured) | References |
|---|---|---|---|---|---|
| `XP Logo.png` | 245 × 245 | 45,051 B | RGBA, 8-bit | **0 transparent px, 0 semi-transparent** | none |
| `XPlogo.png` | 245 × 246 | 45,508 B | RGBA, 8-bit | **0 transparent px, 0 semi-transparent** | none in code; **byte-identical to `favicon.ico`** |
| `favicon.ico` | — | 45,508 B | **PNG renamed `.ico`** | same as above | `app/layout.tsx` (implicit) |

Both carry an alpha *channel* but every pixel is fully opaque — the background is
baked in. Measured by decoding the PNG scanlines, not inferred from the header.
Neither is a vector. Both are untracked in git, so **no XP logo currently ships**.

**Consequence — this is a real visual defect, not a nicety:** the footer
(`components/layout/Footer.tsx`) and the admin sidebar (`#0f1117`) are dark
surfaces. An opaque logo renders as a white box on both.

**Resolution required before XPA-1 asset work — see Q-A in §Open Questions.**
Fallback if no master is available: adopt `XPlogo.png` (marginally taller, already
the de-facto favicon), and restrict it to light surfaces only.

---

## D-Q7 — Random quizzes · 📋 RATIFIED (high priority, for XPA-4)

**Decision:** ratified as a real high-priority requirement. Audit and distinguish
the four interpretations; do not silently choose one. Record current support and
the recommended implementation contract for XPA-4.

**⚠️ Source could not be verified.** The decision cites "the pilot corrections
PowerPoint". The only `.pptx` in the repository is
`public/images/Certificate of Completion.pptx` (the certificate design source).
No pilot-corrections deck exists here. The requirement is recorded as ratified on
management authority; the source document is requested (Q-B).

### Current support — all four: **NOT SUPPORTED**

| # | Interpretation | Current state | Evidence |
|---|---|---|---|
| 1 | Random **question ordering** | ❌ Strictly deterministic | both players `.order('order_index', ascending: true)` — `[moduleId]/quiz/page.tsx:172`, `final-exam/page.tsx:127` |
| 2 | Random **answer/option ordering** | ❌ Not implemented — **and blocked by the scoring contract** | `options` is a JSON array; `correct_answer` is an **index into that array**. Shuffling client-side silently breaks scoring. |
| 3 | Random **subset from a question bank** | ❌ No bank concept | no pool/size column on `quizzes`; every question for the quiz is fetched |
| 4 | Random **selection among multiple lesson quizzes** | ❌ Not implemented — **and latently buggy today** | player does `.limit(1).maybeSingle()` with **no `ORDER BY`**; with >1 quiz on a parent, Postgres returns an arbitrary row. Not random — *undefined*. |

### Recommended implementation contract (for XPA-4 ratification)

- **(1) Question order** — safe now. Shuffle after fetch; `order_index` stays the
  authoring order. Per-attempt seed stored on `quiz_attempts` so a review screen
  can replay the same order.
- **(2) Option order** — **requires a contract change first.** Migrate
  `correct_answer` from *positional index* to a **stable option identifier**, or
  shuffle server-side and persist the permutation with the attempt. Do not ship
  option shuffling before this; scoring is server-side (`app/actions/quiz.ts`) and
  would mis-grade.
- **(3) Question bank** — additive: `quizzes.pool_size int null`; when set, select
  N of the available questions per attempt; persist the chosen set on the attempt
  so refresh/review is stable and re-grading is possible.
- **(4) Multiple quizzes per parent** — first make selection *deterministic*
  (add `ORDER BY`), then, if wanted, opt-in random pick recorded on the attempt.
  **Fix the undefined-selection bug regardless of whether randomization ships.**

Cross-cutting: every randomized attempt must persist what the learner actually
saw, or grading, review and appeals become unreproducible.

---

## D-DOMAIN — Official domains · ✅ APPROVED

| Role | Domain |
|---|---|
| **Canonical public production** | `https://www.xpclient-academy.com` |
| Technical deployment / fallback | `https://smiley-cx-platform.vercel.app` |

All user-facing URLs, metadata, certificates, emails and canonical links must use
`www.xpclient-academy.com`. The Vercel domain must not appear as the public brand.

**Explicit carve-out:** `lib/hosts.ts` and `middleware.ts` reference
`smiley-cx-platform.vercel.app` as the **private admin host**. That is correct and
**must not be "corrected"** — it is deployment infrastructure, not branding.

---

## Open questions raised by these decisions

| # | Question | Blocks |
|---|---|---|
| **Q-A** | No XP logo is transparent and none is vector. Provide a transparent PNG or SVG master? Otherwise the logo shows a white box on the dark footer and admin sidebar. | XPA-1 asset derivation |
| **Q-B** | Provide the pilot-corrections PowerPoint that specifies random quizzes, so the intended interpretation(s) can be confirmed rather than inferred. | XPA-4 scope |
| **Q-C** | Contact address: replace `bonjour@smileycx.com` with what? (`bonjour@xpclient-academy.com`?) Must exist and receive mail before XPA-1 ships, or contact/waitlist mail silently breaks. | XPA-1 |
| **Q-D** | Email sending domain: Resend must verify the new sender domain before `EMAIL_FROM` changes, or all transactional mail fails. Who owns DNS for `xpclient-academy.com`? | XPA-1 |
