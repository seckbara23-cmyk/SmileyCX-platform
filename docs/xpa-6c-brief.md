# XPA-6C — Commercial Business Evaluation / Trial Access

**Status:** ✅ product ruling received — implementation brief
**Baseline:** `ef2c839` (XPA-6B, XPA-6D, UAT-ROUTE-01/02, UAT-ACCESS-01 all closed)
**Supersedes:** the audit-only draft of this document, which presented three
competing readings of "corporate evaluation" and stopped for a decision.

---

## 1. The ruling

> `BUSINESS_EVALUATION` means a **time-limited commercial evaluation entitlement
> for a prospective corporate customer**. It does **not** mean an employee
> competency-assessment engine.

This confirms what the repository evidence indicated: `BUSINESS_EVALUATION` is an
entitlement **source**, and a source answers *"why does this person have
access?"*. "Their employer is trialling the platform" is such a reason. Being
tested is not.

**Flow:** prospect identified → evaluation access granted → evaluator studies the
selected course(s) → mandatory expiry → access ends automatically, or is revoked
early → activity remains auditable.

---

## 2. Audit result: the architecture already exists

**XPA-6B built this. Nothing about the model needs designing, and no schema
change is required.** Everything below is already in production:

| Requirement | Where it already lives | State |
|---|---|---|
| `BUSINESS_EVALUATION` source | `entitlements.source` CHECK, migration 037 | ✅ applied |
| **Mandatory expiry** | `constraint entitlements_expiry_required` (037) | ✅ enforced by the schema |
| Expiry rule in TypeScript | `EXPIRY_RULES.BUSINESS_EVALUATION = 'required'` | ✅ |
| Expiry validation | `validateExpiry()` — rejects a null expiry for `required` | ✅ |
| Start boundary | `entitlements.starts_at` + `entitlement_accessible()` | ✅ denies before it |
| Timestamp-driven expiry | `entitlement_accessible()` evaluates `expires_at` at read time | ✅ no job needed |
| Grant actor / reason / audit | `granted_by`, `granted_reason`, `entitlement.granted` | ✅ |
| Early revocation | `revokeEntitlement()` + `entitlement.revoked` | ✅ |
| Access seam | `has_course_access()` → `my_course_access` | ✅ source-agnostic |
| One live per learner per course | `entitlements_one_live_per_course_idx` | ✅ |
| Admin listing + controls | `app/(admin)/admin/entitlements/` | ✅ |
| Academic initialisation | `ensureAcademicEnrollment()` (UAT-ACCESS-01) | ✅ |

**The grant form already renders a mandatory-expiry control.** `GrantEntitlementForm`
computes `mustExpire = EXPIRY_RULES[source] === 'required'` and, when true,
renders a `required` date input instead of the never/date radio pair. That branch
was written for exactly this source and has been **unreachable** ever since,
because:

```ts
export const ADMIN_SELECTABLE_SOURCES: readonly EntitlementSource[] = [
  'MANUAL_ADMIN',
  'PROMOTIONAL_GRANT',
]
```

`BUSINESS_EVALUATION` was deliberately withheld, with the reason recorded in the
source: *"issued by systems that do not exist yet — XPA-9 payments, XPA-7
corporate licences, **XPA-6C evaluations**"*.

**XPA-6C is the system that now exists.** The gap between the product objective
and the shipped platform is one entry in one array.

---

## 3. What XPA-6C actually changes

Deliberately small. Anything larger would be rebuilding XPA-6B.

1. **`lib/entitlements/index.ts`** — add `BUSINESS_EVALUATION` to
   `ADMIN_SELECTABLE_SOURCES`. This one line makes the source appear in the admin
   form, makes `grantEntitlement`'s allow-list accept it, and activates the
   mandatory-expiry branch that already exists in both the form and
   `validateExpiry`. `CORPORATE_LICENSE` stays out — it is XPA-7's, and a human
   must not assert a contract that no agreement produced. `INDIVIDUAL_PURCHASE`
   and `MIGRATION` stay out for the same reason.

2. **`GrantEntitlementForm.tsx`** — surface the optional **start date**.
   `grantEntitlement` already accepts `startsAt` and `entitlement_accessible()`
   already denies before it; the form simply never offered the field. An
   evaluation window that begins on an agreed date is the normal commercial case.

3. **Tests + production verifier + documentation.**

**No migration.** The schema, the constraint, the lifecycle, the audit events and
the access seam are all in place and production-verified.

One existing assertion changes as a direct consequence of the ruling:
`xpa-6b-entitlements.test.ts` pins `ADMIN_SELECTABLE_SOURCES` to exactly
`['MANUAL_ADMIN', 'PROMOTIONAL_GRANT']`. It becomes a three-element list. That is
a ratified widening, not a weakening — the test's purpose is to stop sources
being added *casually*, and it will still fail if anyone adds
`CORPORATE_LICENSE`, `INDIVIDUAL_PURCHASE` or `MIGRATION`.

---

## 4. Expiry contract

Mandatory expiry is the defining characteristic, and it is enforced in **three
independent places** — form, server action, and database CHECK. A perpetual
`BUSINESS_EVALUATION` cannot be created by any path.

| Condition | Access |
|---|---|
| `starts_at` in the future | **denied** — not started |
| within `[starts_at, expires_at)` and `ACTIVE` | **allowed** |
| `expires_at` passed | **denied** — expired |
| `status = REVOKED` (early) | **denied** |
| `status = SUSPENDED` | **denied** |
| expired/revoked, but an active enrollment exists | **denied** — enrollment is not authority |

**Timestamp-driven, not job-driven.** `entitlement_accessible()` compares
`now()` to the stored boundaries on every read, so access stops at the instant
`expires_at` passes with no scheduler in the loop and no row mutation. The row
remains `ACTIVE` and unmutated after expiry — XPA-6B verified exactly this
("expiry removes access without a cron job", "expired row was NOT mutated").

**On audit events:** `entitlement.granted` and `entitlement.revoked` are real
events with an actor. Expiry is **not** an event — it is a boundary crossing
computed at read time, with nobody performing it. Per §9, that distinction is
documented here rather than papered over with a fabricated `expired` audit
record. (`materialiseExpiredEntitlements()` exists for *reporting* — it relabels
already-inaccessible rows for operators and changes no access.)

---

## 5. Admin workflow

Entirely on the existing surface at `app/(admin)/admin/entitlements/`:

1. Select learner · select course · choose **Évaluation entreprise**.
2. The expiry control becomes a **required** date — the never/date radio pair is
   not offered for this source.
3. Optionally set a start date.
4. Enter an internal reason (`granted_reason`, journalised).
5. Grant → `entitlement.granted` audit with actor, course, source, boundaries.
6. Inspect status in the listing, which already renders source label, status,
   expiry and a live/not-live indicator with the reason.
7. Revoke early via the existing control → `entitlement.revoked` audit.

**Validation, all pre-existing:** `requirePlatformAdmin()` on every action; the
source allow-list rejecting anything not admin-selectable; `validateExpiry`
rejecting a missing or past expiry; the DB CHECK as the backstop; the one-live
partial unique index preventing a duplicate; and a per-admin rate limit.

A learner cannot self-grant, extend, or revoke: `entitlements` holds **no
privilege for any app role** (42501 for reads and writes alike), and every
mutation runs through a server action behind `requirePlatformAdmin()`. The
service-role key is server-only and never reaches the browser.

---

## 6. Security matrix

| Actor | Grant/revoke evaluations | Entitled course content | `entitlements` base table | Answer keys |
|---|---|---|---|---|
| anonymous | denied | denied | **42501** | **42501** |
| authenticated, no evaluation | denied | denied (0 rows) | **42501** | **42501** |
| **active `BUSINESS_EVALUATION`** | denied | **allowed** — learner-safe contracts only | **42501** | **42501** |
| expired / revoked evaluation | denied | **denied** | **42501** | **42501** |
| unrelated learner | denied | denied | **42501** | **42501** |
| authorized admin | **allowed** via server actions | allowed | via service role | via service role |
| service role | trusted server paths only | allowed | allowed | allowed |

XPA-6D's column privileges are untouched: `correct_answer`,
`drag_match_answers`, `explanation` and `correct_category_id` remain revoked from
`anon` and `authenticated` regardless of entitlement source.

---

## 7. XPA-6C / XPA-7 boundary

**Not built here:** company/organization tenant records · corporate admins ·
departments · teams · employee rosters · manager hierarchy · corporate
dashboards · bulk learner upload · organization billing · organization-level
licenses · `CORPORATE_LICENSE` as an admin-selectable source.

**Prospect identification uses the smallest existing mechanism.**
`entitlements.external_ref` is free text with no FK, placed in 037 precisely so a
commercial reference can be recorded before the system that owns it exists. An
evaluation for a prospect is recorded by putting the company reference there and
in `granted_reason`. No `companies` table is created.

**The XPA-7 seam:** when organizations arrive, add `organization_id` to
`entitlements` and backfill from `external_ref`. No entitlement is reshaped, no
access logic changes, and evaluations issued today remain valid.

**Course scope stays course-level.** The entitlement model is
`(user_id, course_id)` and no ratified broader abstraction exists. An evaluator
needing three courses gets three explicit evaluation entitlements, each with its
own expiry, granted through the same idempotent path. Academy-wide evaluation
access is not invented here.

---

## 8. Operating-mode independence

`PLATFORM_MODE` is an application-side flag; `has_course_access()` and
`entitlement_accessible()` are SQL and read only the entitlement row. **No
environment variable is an input to the access decision**, so an evaluation
behaves identically under `pilot`, `private` and `public`.

Audited effect of the stale `PLATFORM_MODE=pilot` on this workflow: **none.**
The admin surface is behind `requirePlatformAdmin()`, the grant path never
consults a mode flag, and UAT-ACCESS-01 removed the last place where one could
influence learner entry. The flag remains a standing finding and is **not**
changed by XPA-6C.

---

## 9. Implementation waves

| Wave | Content |
|---|---|
| **W1** | `ADMIN_SELECTABLE_SOURCES` += `BUSINESS_EVALUATION`; update the XPA-6B ratified-sources assertion |
| **W2** | Optional start-date field in the grant form |
| **W3** | `__tests__/entitlements/xpa-6c-business-evaluation.test.ts` — the §12 regressions |
| **W4** | `scripts/security/verify-xpa-6c.mjs` — fixture-scoped, following the corrected XPA-6D pattern |
| **W5** | Production verification, `docs/xpa-6c-closure.md`, commit |

## 10. Acceptance gates

Full local suite · new XPA-6C regressions · `verify-xpa-6a.mjs` 57/57 ·
`verify-xpa-6d.mjs` 22/22 · UAT-ROUTE-01/02 and UAT-ACCESS-01 green · production
probe with synthetic disposable actors and **fixture-scoped cleanup** (never a
global-empty assertion — Marième holds six real entitlements) · CI green.

**No unresolved product decision remains.**
