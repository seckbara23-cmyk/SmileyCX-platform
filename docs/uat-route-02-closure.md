# UAT-ROUTE-02 — "Commencer gratuitement" does nothing: CLOSED

**Status:** ✅ fix verified in production
**Baseline:** `b98754a` (UAT-ROUTE-01 closed)
**Migration applied:** 039 — applied to `eqoqcxkdcxeosjqaafhs` on 2026-08-12 (second attempt; see §"The failed first apply")

---

## Root cause

The live page rendered:

```html
<a href="/courses/les-fondamentaux-de-l-experience-client">Commencer gratuitement</a>
```

**A link to the page it was already on.** Clicking navigated to the current URL, so nothing appeared to happen. The element was a real anchor with a real href — not disabled, no `onClick`, not blocked by client logic.

Underneath, [courses/[slug]/page.tsx](../app/(public)/courses/[slug]/page.tsx) loaded `modules` and `lessons` with the **learner's session client**. XPA-6A/6B/6D correctly hide those tables from anyone without an entitlement, so an anonymous visitor received zero rows. That produced, in one stroke: `0 modules`, `0 leçons`, and no resolvable first lesson — so `learnEntryHref` degraded, correctly, to the course page.

**The page was reading protected learner content in order to render public catalogue metadata.** A syllabus is marketing copy; lesson bodies are not.

### Did UAT-ROUTE-01 cause this?

**It caused the symptom, not the defect.** Before that fix the CTA was `/learn/…/undefined/undefined` — it navigated, then hit the access gate. UAT-ROUTE-01's fail-safe correctly degrades an unresolvable lesson route to the course page, and on *this* page that degradation is a self-link. The fail-safe worked as designed; the design did not anticipate the fallback landing on the current page.

The underlying defect — protected reads behind public metadata — predates both fixes. UAT-ROUTE-01 replaced a broken URL with an honest dead end and made the real bug visible.

**Lesson recorded:** "fail safe" must not mean "fail inert". A degraded route is a valid destination; it is not automatically a valid *call to action*.

---

## Product policy — answer D, legacy pilot behaviour

The repository settles this:

- [operating-mode.md:3](security/operating-mode.md) — **"Current mode: INVITE-ONLY DEVELOPMENT MODE… the official operating mode until public launch"**, effective 2026-07-25.
- Line 10: *"The pilot phase is complete."* Line 24: access is requested and **provisioned by an administrator**.
- Line 186 lists `NEXT_PUBLIC_PLATFORM_MODE=public` as a **future** launch step.
- [xpa-decision-register.md](xpa-decision-register.md) — `auth.uid() IS NULL` was omitted from the access seam because *"the pilot is over"*; free self-enrollment is *"closed behind a flag that defaults to off."*

And empirically: `resolveCourseAccess` has **no pilot arm**, so `/learn/*` redirects an anonymous visitor to `/login` whatever `PLATFORM_MODE` says. **"Accès libre · Phase pilote · Aucun compte requis" was false against deployed behaviour**, not merely against the documentation.

Corrected on this page to *"Accès sur demande · Compte requis · Activation par un administrateur"*, and the CTA label now derives from `resolveCourseAccess` rather than the mode flag — "Commencer gratuitement" pointing at `/login` is the same false promise in a different place.

**Deliberately not changed** (out of scope by decision): production runs `PLATFORM_MODE=pilot`, and [lib/pilot.ts:19](../lib/pilot.ts) **fail-opens to `'pilot'`** when the variable is unset — the most permissive mode as the default while invite-only is ratified. 17 files consume those flags. Recorded as a standing finding.

---

## The failed first apply — and why the finding was false

The first 039 **aborted and rolled back**:

```
ERROR: P0001: anon can read lessons.content directly — the base table was widened
```

Verified rollback: both views and the helper function returned 404/`PGRST205` afterwards. Nothing partial survived.

**The finding was false, and the defect was the assertion.** Measured against production:

| Column | anon | authenticated, unentitled | service |
|---|---|---|---|
| `content` | 200, **0 rows** | 200, **0 rows** | 206, 82 rows |
| `video_url` | 200, **0 rows** | 200, **0 rows** | 206, 82 rows |
| `subtitle_url` | 200, **0 rows** | 200, **0 rows** | 206, 82 rows |
| `pdf_url` | 200, **0 rows** | 200, **0 rows** | 206, 82 rows |
| `select=*` | 200, **0 rows** | 200, **0 rows** | — |

Two different protection mechanisms exist, and one probe was applied to both:

| Object | Mechanism | Correct answer for an untrusted role |
|---|---|---|
| `lessons.content` | **RLS** (`has_course_access()`) | `200`, 0 rows — reachable, filtered |
| `quiz_questions.correct_answer` | **Column privilege** (038) | `401/403 42501` — no grant |

`anon` holds table-level SELECT on `lessons` (Supabase `ALTER DEFAULT PRIVILEGES` — D-GRANT), which is why PostgREST answers 200 rather than 42501. The original `uat2_probe` returned `ALLOWED` whenever the statement executed without error, and a SELECT returning zero rows executes fine — so **DENIED_EMPTY was scored as ALLOWED**.

That is the **fifth variant** of the family this programme keeps rediscovering, and the inverted one:

| Occurrence | Mistake |
|---|---|
| XPA-6A | scored BROKEN as denied |
| 037 attempt 1 | scored an expected denial as broken |
| 037 attempt 2 | scored a structural refusal as broken |
| XPA-6D | scored an API-layer refusal as broken |
| **039 attempt 1** | **scored DENIED_EMPTY as ALLOWED** |

**Blast radius: zero.** No exposure existed at any point, for any role, on any column. Not caused by pilot configuration, migration drift, or an unintended grant — RLS is enforced in Postgres and `PLATFORM_MODE` is an application-side flag that cannot influence a policy.

**The assertion was strengthened, not weakened.** The original could not detect a real leak at all: it returned `ALLOWED` whether 82 rows came back or zero. `uat2_probe` now **counts rows** and classifies five ways — `ALLOWED_WITH_ROWS` / `DENIED_EMPTY` / `REFUSED_BY_PRIVILEGE` / `NO_SUCH_COLUMN` / `BROKEN` — and every assertion names which outcomes it accepts. `lessons` must not be `ALLOWED_WITH_ROWS`; `correct_answer` must be exactly `REFUSED_BY_PRIVILEGE`. Writes keep error-shaped semantics in a separate helper, because for a write "it ran" *is* the failure.

**Migration boundary:** 039 itself, no new number. It never applied, so there was nothing deployed to correct forward.

---

## The repaired data boundary

Migration 039 adds two read-only projections, following the pattern [031](../supabase/migrations/031_public_discovery_projection.sql) established for public discovery:

| View | Columns |
|---|---|
| `public_course_modules` | `id, course_id, slug, title, order_index` |
| `public_course_lessons` | `+ module_id, title, duration_minutes, is_preview, order_index` |

`content`, `video_url`, `subtitle_url` and `pdf_url` are **structurally absent** — a view cannot return a column it does not select, whatever the caller asks for. Revoke-then-grant is deliberate: D-GRANT means a view is born holding `GRANT ALL` to `anon`, which is the bug migration 034 shipped.

No policy, no base-table grant, no entitlement logic changed.

---

## Production evidence

### Database (post-039, pre-deploy)

| Check | anon | authenticated, unentitled |
|---|---|---|
| `public_course_modules` for the course | **3** | **3** |
| `public_course_lessons` for the course | **17** | **17** |
| `content` / `video_url` / `subtitle_url` / `pdf_url` on the view | `400 42703` ×4 — structurally absent | same |
| PATCH / DELETE through the view | `500 55000` — not updatable | same |
| `lessons.content` on the base table | 200, **0 rows** | 200, **0 rows** |
| `quiz_questions.correct_answer` | `401 42501` | `403 42501` |

Service-role truth: 3 modules. The projection matches reality and adds nothing.

### Security verifiers, re-run after 039

- `verify-xpa-6d.mjs` — **22 checks, 0 failures**
- `verify-xpa-6a.mjs` — **57 checks, 0 failures**

### Deployed page

Recorded below once this commit ships.

---

## Local results

| Gate | Result |
|---|---|
| Typecheck | ✅ |
| Lint | ✅ 0 errors |
| Full suite | ✅ **578 tests / 20 files** (was 564 / 19) |
| Route suites | ✅ **39** — UAT-ROUTE-01's 20 plus UAT-ROUTE-02's 19 |
| Migration lint | ✅ 39 scanned, 4 baseline |
| Secret scan | ✅ |
| Production build | ✅ |

**Six UAT-ROUTE-02 assertions were confirmed to fail against pre-fix `b98754a`** — self-link guard, public projection read, absence of the protected `modules` read, absence of "Aucun compte requis", CTA keyed on real access, and absence of "Commencer gratuitement". A regression that cannot fail on the unfixed code is not a regression.

---

## Residual notes

1. **`PLATFORM_MODE=pilot` in production, and `lib/pilot.ts` fail-opens to it.** Not a data exposure — RLS is unaffected — but the most permissive mode is the default while invite-only is ratified. 17 consumers. Out of scope by decision; needs its own task.
2. **`isEnrolled` still drives the progress card and two section-visibility branches** on this page. The CTA no longer depends on it, but the card remains inert while `enrollments` is empty. Recorded in the XPA-6C brief; belongs in its own change.
3. The pre-existing comment-only edit to `037_entitlements.sql`, the six untracked `public/` assets, and the uncommitted XPA-6C brief were all excluded from this commit.
