# XPA-6B — Enrollments & Course Entitlements

**Status:** ✅ **CLOSED** — implemented in `fa4164a`; migration 037 applied to
production 2026-08-12; production PASS, 57 checks, 0 failures. Closure record:
[xpa-6b-closure.md](xpa-6b-closure.md).
**Blocked on:** ~~migration 036 applied and `verify-xpa-6a.mjs` green (see §2)~~ — satisfied.
**Inputs:** [XPA-6A audit](xpa-6a-identity-audit.md) · [decision register](xpa-decision-register.md) — D-ACCESS, D-GRANT

---

## 1. Objective

Give the platform a governed way to **grant, suspend and revoke course access**.

XPA-6A built the lock and deliberately shipped no key: `has_course_access()`
requires an ACTIVE enrollment, there are zero enrollments, and the only code that
can create one (`activateEnrollment`) needs a pre-existing `payments` row that
also does not exist. Course material is therefore admin-only today. That is the
ratified posture (decisions 3, 5, 6) — and it is why XPA-6B is the next phase
rather than a later one.

**Out of scope:** automated payments (XPA-9), corporate evaluation (XPA-6C),
content protection (XPA-6D), B2B organizations (XPA-7).

## 2. Hard prerequisite

XPA-6B extends `has_course_access()`. **Do not begin until that function is
proven working**, or the phase builds on an unverified foundation:

```
1. apply migration 036
2. node scripts/security/verify-xpa-6a.mjs     -> must print "XPA-6A PASS"
```

The script proves both directions: an un-enrolled learner is denied, and an
enrolled learner and a platform admin are **allowed**. The second half matters
most here — migration 035 denied everyone, which read as security and was an
outage.

## 3. The state XPA-6B starts from

| Fact | Evidence |
|---|---|
| `has_course_access()` is the single seam | migration 035, all 4 content policies |
| Cross-table lookups go through SECURITY DEFINER resolvers | migration 036 — do not reintroduce subqueries |
| `enrollments` is sound and **empty** | 0 rows; `UNIQUE(user_id, course_id)` |
| `payments` is empty | 0 rows |
| `activateEnrollment` requires a payment row | `admin/payments/actions.ts` |
| No admin UI creates an enrollment | verified across `app/(admin)` |
| Registration grants nothing | XPA-6A, asserted by test |
| Free self-enrollment is closed | `NEXT_PUBLIC_ALLOW_FREE_SELF_ENROLLMENT`, default off |

## 4. Scope

### 4.1 The entitlement model — the decision to make first

`enrollments` already exists and already drives the seam. The question is whether
entitlements are **the same thing** or a **separate lifecycle**:

| Option | Shape | Cost |
|---|---|---|
| **A. Enrollment IS the entitlement** | admin grants/suspends an `enrollments` row | Smallest. Seam already reads it — possibly zero SQL. No expiry, no source-of-grant, no seat accounting |
| **B. Separate `entitlements` table** | enrollment = *pedagogical* record; entitlement = *commercial* right, with source, expiry, revocation | Honours decision 4 fully. Extends `has_course_access()` with one arm. Two concepts to keep in sync |

This is **Q-L**. It is a product decision. Option B is the better fit for
decision 4 (Account ≠ Payment ≠ Enrollment ≠ Access) and for XPA-9's automated
payments, but A is defensible if access is never time-limited.

### 4.2 Admin grant path
Grant, suspend and revoke access for a learner + course, with reason and audit.
This is the manual/admin approval decision 6 anticipates.

### 4.3 Learner surface
The dashboard already shows an honest empty state. It needs the granted case:
active courses, resume, and — if B — expiry.

### 4.4 Seam extension
One arm in `has_course_access()`, one mirrored arm in `resolveCourseAccessById()`.
Both sites are marked `XPA-6B` in the source. **No content policy is edited.**

## 5. Non-negotiable

- **No content policy may query another RLS-protected table.** Use a SECURITY
  DEFINER resolver. This caused a production outage in XPA-6A (42P17).
- **Every new object: REVOKE ALL first, then GRANT, then assert the matrix**
  from `information_schema.role_table_grants` (D-GRANT).
- **Every migration must EXERCISE its policies at apply time**, not merely
  assert their text. Structural checks passed while the tables were unreadable.
- Registration still grants nothing. Granting is an explicit admin act.
- No self-service grant path. `enrollForFree` stays closed.
- Learners see only their own enrollments/entitlements.
- Do not weaken RLS, migration 027, the signup gate or the admin allowlist.
- Do not modify migrations 001–027, or 035/036 once reconciled.

## 6. Files likely to change

| File | Change |
|---|---|
| `supabase/migrations/037_*.sql` | entitlements (if B) + the seam arm |
| `app/(admin)/admin/enrollments/**` | grant / suspend / revoke UI + actions |
| `lib/auth/course-access.ts` | mirrored arm |
| `app/(platform)/dashboard/page.tsx` | granted-access case |

**Must not change:** `has_course_access()`'s existing arms, the four content
policies, `lib/hosts.ts`, admin auth, the registration action.

## 7. Tests

Grant makes exactly one course readable and no other · revoke removes access
immediately · suspend ≠ delete · expiry denies once past (if B) · a learner
cannot grant themselves · a learner cannot read another learner's entitlements ·
admin actions are audited and rate limited · `verify-xpa-6a.mjs` still passes ·
**every new policy is exercised as `anon` and `authenticated` at apply time**.

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Another policy-recursion outage | **High** | SECURITY DEFINER resolvers only; SET ROLE assertion in the migration |
| R-2 | A seam change silently grants too widely | **High** | Test both directions; never assert denial alone |
| R-3 | Entitlement and enrollment drift apart (option B) | Medium | One writer, server-side; enrollment derived from entitlement |
| R-4 | Grant UI becomes a self-service path | Medium | `requirePlatformAdmin()` + audit on every action |

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| **Q-L** | Entitlement model: enrollment-is-entitlement, or a separate lifecycle? | §4.1, the migration |
| Q-M | Is access time-limited (expiry) or perpetual once granted? | Determines Q-L |
| Q-N | Should granting send the learner an email? | §4.2 |
| Q-O | Does an admin grant require a recorded reason/reference? | audit shape |

## 10. GO / NO-GO

**NO GO until §2 is green.** After that, **GO pending Q-L**, which needs an
answer before the migration is written — but unlike XPA-6A's Q-H it has a
defensible default: option **B**, a separate entitlement lifecycle, because it is
what decision 4 describes and what XPA-9 will need. If no answer is given, B is
the recommendation.
