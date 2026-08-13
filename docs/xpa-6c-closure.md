# XPA-6C — Commercial Business Evaluation / Trial Access: CLOSED

**Status:** ✅ CLOSED — production PASS
**Baseline:** `ef2c839` (UAT-ACCESS-01 closed)
**Migration:** **none** — no schema, RLS, grant, policy or constraint change
**Brief:** [xpa-6c-brief.md](xpa-6c-brief.md)

**Ruling:** `BUSINESS_EVALUATION` is a **time-limited commercial evaluation
entitlement for a prospective corporate customer** — not an employee
competency-assessment engine.

---

## Production verification — 30 checks, 0 failures

`scripts/security/verify-xpa-6c.mjs`, run against `eqoqcxkdcxeosjqaafhs` as a
real learner with a real JWT.

| # | Check | Result |
|---|---|---|
| 1 | no entitlement → `has_course_access` | `false`, content `DENIED_EMPTY` |
| 2 | **`BUSINESS_EVALUATION` without expiry** | **refused by the database** |
| 3 | before `starts_at` | no access, content unreadable |
| 4 | inside the window | **access**, content `ALLOWED` |
| 5 | learner-safe view columns | `course_id, has_access, access_ended` — no commercial detail |
| 6 | evaluator reads `entitlements` | `REFUSED_BY_PRIVILEGE 42501` |
| 7 | evaluator extends expiry / changes source / changes status | `42501` ×3, row **byte-identical** ×3 |
| 8 | evaluator self-grants | `42501` |
| 9 | `correct_answer` / `correct_category_id` | `42501` ×2 — XPA-6D unaffected |
| 10 | active evaluation **+ enrollment** | access |
| 11 | **expired evaluation, enrollment still active** | **access DENIED**, 1 active enrollment row |
| 12 | expired → content | `DENIED_EMPTY` |
| 13 | expiry needed no job | row still `ACTIVE`, unmutated |
| 14 | window reinstated | access returns |
| 15 | revoked before expiry | access DENIED, content unreadable |
| 16 | enrollment-only learner | no access, content unreadable |
| 17 | reads another learner's evaluation | `42501` |
| 18 | fixture cleanup | 0 fixtures left, 0 probe accounts |

**Check 11 is the one that matters.** An expired evaluation denies access while
the academic enrollment is still `active` — the UAT-ACCESS-01 invariant holding
in the direction that would otherwise turn a trial into permanent access.

**Check 13** confirms the expiry is timestamp-driven: access stopped with the
row untouched and no scheduler involved.

**Cleanup is fixture-scoped**, following the corrected XPA-6D pattern. Marième's
six real entitlements and six enrollments are reported informationally and were
never asserted on or touched.

### Other verifiers, re-run

- `verify-xpa-6a.mjs` — **57 checks, 0 failures**
- `verify-xpa-6d.mjs` — **22 checks, 0 failures**

---

## Architecture reused — and how little was needed

XPA-6B had already built this. The audit found every required capability
already in production: the source and its CHECK constraint, the mandatory-expiry
rule in `EXPIRY_RULES` and `validateExpiry`, `starts_at` honoured by
`entitlement_accessible()`, timestamp-driven expiry, `granted_by` /
`granted_reason` / `external_ref`, the grant and revoke audit events, the
one-live-per-course index, the admin listing and controls, the access seam, and
`ensureAcademicEnrollment()` from UAT-ACCESS-01.

**The grant form already rendered a mandatory-expiry control.** It computes
`mustExpire = EXPIRY_RULES[source] === 'required'` and renders a `required` date
instead of the never/date radio pair. That branch was written for this source and
had been unreachable ever since, because:

```ts
export const ADMIN_SELECTABLE_SOURCES = ['MANUAL_ADMIN', 'PROMOTIONAL_GRANT']
```

withheld it, with the reason in the source: *"issued by systems that do not exist
yet — XPA-9 payments, XPA-7 corporate licences, **XPA-6C evaluations**"*.

**XPA-6C is that system.** The gap between the objective and the shipped platform
was one entry in one array.

### Changes

| File | Change |
|---|---|
| `lib/entitlements/index.ts` | `ADMIN_SELECTABLE_SOURCES` += `BUSINESS_EVALUATION` |
| `GrantEntitlementForm.tsx` | optional **start date** surfaced; expiry legend marks the mandatory case |
| `__tests__/entitlements/xpa-6b-entitlements.test.ts` | ratified-sources assertion now three elements |
| `__tests__/entitlements/xpa-6c-business-evaluation.test.ts` | **new** — 32 regressions |
| `scripts/security/verify-xpa-6c.mjs` | **new** — 30-check production verifier |
| `docs/xpa-6c-brief.md`, `docs/xpa-6c-closure.md` | ruling and closure |

`CORPORATE_LICENSE` stays out — it asserts a signed contract and belongs to
XPA-7. `INDIVIDUAL_PURCHASE` and `MIGRATION` stay out for the original reason: a
human must not record a payment no gateway produced or a history no migration
performed. The updated test still fails if any of the three is added.

The `startsAt` field was already accepted by `grantEntitlement` and already
honoured by `entitlement_accessible()`; only the form never offered it.

---

## Expiry contract

Enforced in **three independent layers**, so a perpetual evaluation cannot be
created by any path:

1. **Form** — `mustExpire` renders a `required` date input.
2. **Server action** — `validateExpiry` rejects a null or past expiry before any write.
3. **Database** — `constraint entitlements_expiry_required`, verified live in
   production (check 2 above).

| Condition | Access |
|---|---|
| before `starts_at` | denied — *not_started* |
| inside `[starts_at, expires_at)` and `ACTIVE` | **allowed** |
| after `expires_at` | denied — *expired* |
| `REVOKED` early | denied |
| `SUSPENDED` | denied |
| expired/revoked with an active enrollment | **denied** |

**On audit events.** `entitlement.granted` and `entitlement.revoked` are real
events with an actor. **Expiry is not an event** — it is a boundary crossing
computed at read time with nobody performing it, so no `expired` audit record is
fabricated. `materialiseExpiredEntitlements()` exists for operator *reporting*
and changes no access.

---

## Admin workflow

Entirely on the existing surface at `app/(admin)/admin/entitlements/`: select
learner and course, choose **Évaluation entreprise**, set the required expiry,
optionally a start date, enter a journalised reason, grant. Status, expiry and a
live/not-live indicator appear in the listing; early revocation uses the existing
control.

Validation, all pre-existing: `requirePlatformAdmin()` on every action, the
source allow-list, `validateExpiry`, the DB CHECK, the one-live partial unique
index, and a per-admin rate limit. Production-verified that a learner cannot
self-grant, extend, revoke, or change source or status — all `42501`, with the
row byte-identical after each attempt. The service-role key is server-only.

---

## Tests

`__tests__/entitlements/xpa-6c-business-evaluation.test.ts` — **32 tests**
covering the source boundary, the three expiry layers, the full window
(not-started / active / expired / revoked / suspended), the source-agnostic
seam, learner containment, course-level scope, the XPA-7 boundary, and
operating-mode independence.

Local suite: **636 tests / 22 files**, up from 604 / 21. Typecheck, lint,
migration lint, secret scan and production build all clean.

---

## Operating-mode independence

`has_course_access()` and `entitlement_accessible()` are SQL and read only the
entitlement row; **no environment variable is an input**. A regression asserts
that none of `PLATFORM_MODE`, `PILOT_MODE`, `FREE_ACCESS_MODE` or
`SELF_ENROLLMENT_OPEN` appears in the grant action, the access seam, or the
domain model.

**Audited effect of the stale `PLATFORM_MODE=pilot` on this workflow: none.** The
admin surface is behind `requirePlatformAdmin()`, the grant path consults no mode
flag, and UAT-ACCESS-01 removed the last place one could influence learner entry.
The variable was **not** changed by XPA-6C and remains a standing finding.

---

## XPA-6C / XPA-7 boundary

**Not built:** company/organization tenants · corporate admins · departments ·
teams · employee rosters · manager hierarchy · corporate dashboards · bulk
upload · organization billing · organization-level licenses ·
`CORPORATE_LICENSE` as admin-selectable.

**Prospect identification reuses `entitlements.external_ref`** — free text with
no FK, placed in 037 precisely so a commercial reference could be recorded before
the system owning it existed. The verifier exercises it
(`external_ref: 'XPA6C-VERIFY-PROSPECT'`). No `companies` table was created.

**Course scope stays course-level.** The model is `(user_id, course_id)` and no
ratified broader abstraction exists; an evaluator needing three courses receives
three explicit evaluation entitlements, each with its own expiry.

### Handoff to XPA-7

Add `organization_id` to `entitlements` and backfill from `external_ref`. No
entitlement is reshaped, no access logic changes, and evaluations issued today
remain valid. `CORPORATE_LICENSE` becomes admin-selectable at that point, under
whatever contract record XPA-7 introduces.

---

## Residual notes

1. **No production evaluation exists yet.** All results come from synthetic
   fixtures, cleaned deterministically.
2. **`PLATFORM_MODE=pilot`** in production while invite-only is ratified, and
   `lib/pilot.ts` fail-opens to `'pilot'`. Unrelated to this phase and unchanged.
3. **Legacy enrollment debt** recorded in
   [uat-access-01-closure.md](uat-access-01-closure.md) is unchanged: checkout
   routing, the course-page `isEnrolled` progress card, and `enrollForFree`.
4. The pre-existing 037 comment edit and the six untracked `public/` assets
   remain uncommitted and untouched.
